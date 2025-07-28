"use strict";

/**
 * Music Terminal UI
 * • Shows current track (auto-refresh 1 s)
 * • Playback, volume, seek controls
 * • Playlists → tracks → play selected
 *
 * Requirements: macOS + Music.app + Node.js + osascript
 * Quick install: npm i
 */

const blessed = require("blessed");
const chalk = require("chalk");
const { exec } = require("child_process");
let openai = null;
try {
  const OpenAI = require("openai");
  openai = new OpenAI();
} catch(e){
  openai = null;
}

// Optional Markdown rendering (marked + marked-terminal)
let mdConvert = (txt) => {
  // strip ``` fences
  const stripped = txt.replace(/^```(?:\w+)?\n/, "").replace(/\n```$/, "");
  return stripped;
};
try {
  const marked = require("marked");
  const TerminalRenderer = require("marked-terminal");
  marked.setOptions({ renderer: new TerminalRenderer() });
  mdConvert = (txt) => {
    const stripped = txt.replace(/^```(?:\w+)?\n/, "").replace(/\n```$/, "");
    return marked.parse(stripped);
  };
} catch {
  // marked or marked-terminal not available – fallback to plain text
  mdConvert = (txt) => {
    const stripped = txt.replace(/^```(?:\w+)?\n/, "").replace(/\n```$/, "");
    // simple bold for headings
    return stripped.split("\n").map(line => {
      // headings
      if (/^##?\s+/.test(line)) {
        const txt = line.replace(/^##?\s+/, "");
        return chalk.green.bold(txt);
      }
      // bold **text**
      line = line.replace(/\*\*(.*?)\*\*/g, (_, g) => chalk.yellowBright.bold(g));
      // italics *text*
      line = line.replace(/\*(.*?)\*/g, (_, g) => chalk.cyan(g));
      return line;
    }).join("\n");
  };
}
// ---------- AI trivia ----------
const triviaCache = new Map();
async function fetchTrivia(title, artist) {
  const key = `${title}::${artist}`;
  if (triviaCache.has(key)) return triviaCache.get(key);
  if (!openai) {
    const msg = "OpenAI unavailable";
    triviaCache.set(key, msg);
    return msg;
  }
  try {
    const prompt = `Write a detailed and engaging description in Markdown format about the song "${title}" by ${artist}. Include historical context, lyrical themes, impact, and any notable facts about the artist related to the track. The response should be at least 5-10 sentences and formatted with proper Markdown (e.g. headings, italics, bold if needed).`;
    const resp = await openai.responses.create({
      model: "gpt-4.1-mini",
      input: prompt
    });
    const text = resp.output_text?.trim() || "(no trivia)";
    triviaCache.set(key, text);
    return text;
  } catch (e) {
    const err = "(AI error)";
    triviaCache.set(key, err);
    return err;
  }
}

// Force simpler terminfo capabilities to avoid "Setulc" parsing issues on some systems
if (process.env.TERM && process.env.TERM.includes("256color")) {
  process.env.TERM = process.env.TERM.replace("256color", "color");
}

// Banner removed – we now use frame label only
const HEADER_HEIGHT = 0; // no extra header box
const US = String.fromCharCode(31); // unit separator
const RS = String.fromCharCode(30); // record separator

// bigger buffer for large playlists
function execp(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, { maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(err);
      resolve({ stdout, stderr });
    });
  });
}

const REFRESH_MS = 1000;

// ----- utils -----
function timeFmt(sec) {
  if (!Number.isFinite(sec) || sec < 0) return "--:--";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

async function osa(cmd) { // run single-line AppleScript
  const { stdout } = await execp(`osascript -e '${cmd.replace(/'/g, "\\'")}'`);
  return stdout.trim();
}
async function osaMulti(script) {
  const { stdout } = await execp(`osascript <<'OSA'\n${script}\nOSA`);
  return stdout.trim();
}
async function safe(cmd, def = "") { try { return await osa(cmd); } catch { return def; } }

// ---------- Apple Music actions ----------
async function ensureMusicLaunched() {
  const running = await safe(
    `tell application "System Events" to (name of processes) contains "Music"`,
    "false"
  );
  if (running !== "true") {
    await safe(`tell application "Music" to launch`);
    await new Promise(r => setTimeout(r, 500));
  }
}

async function play()        { await safe(`tell application "Music" to play`); }
async function pause()       { await safe(`tell application "Music" to pause`); }
async function nextTrack()   { await safe(`tell application "Music" to next track`); }
async function prevTrack()   { await safe(`tell application "Music" to previous track`); }
async function getVolume()   { return parseInt(await safe(`tell application "Music" to get sound volume`, "0"), 10) || 0; }
async function setVolume(v)  { await safe(`tell application "Music" to set sound volume to ${Math.max(0, Math.min(100, v|0))}`); }
async function seekRel(d) {
  const pos = parseFloat(await safe(`tell application "Music" to get player position`, "0")) || 0;
  await safe(`tell application "Music" to set player position to ${Math.max(0, Math.floor(pos + d))}`);
}
async function toggleShuffle() {
  const sh = await safe(`tell application "Music" to get shuffle enabled`, "false");
  await safe(`tell application "Music" to set shuffle enabled to ${sh === "true" ? "false" : "true"}`);
}
async function cycleRepeat() {
  const cur = await safe(`tell application "Music" to get song repeat`, "none");
  const order = ["none", "one", "all"];
  const next = order[(Math.max(0, order.indexOf(cur)) + 1) % order.length];
  await safe(`tell application "Music" to set song repeat to ${next}`);
}

async function getPlaylists() {
  // Return all playlist names (user + system)
  const script = `
  tell application "Music"
    set rs to (ASCII character 30)
    set outText to ""
    try
      set pls to every playlist
      repeat with p in pls
        try
          set nm to (name of p) as text
          if nm is not "" then set outText to outText & nm & rs
        end try
      end repeat
    on error
      -- w razie czego zwróć pusty ciąg
    end try
    return outText
  end tell`;
  const raw = await osaMulti(script);
  if (!raw) return [];
  // split + trim + deduplikacja + sort
  const items = raw.split(String.fromCharCode(30)).map(s => s.trim()).filter(Boolean);
  return Array.from(new Set(items)).sort((a, b) => a.localeCompare(b));
}

async function playPlaylistByName(name) {
  const n = name.replace(/"/g, '\\"');
  await osaMulti(`
  tell application "Music"
    try
      play (first user playlist whose name is "${n}")
    on error
      play (first playlist whose name is "${n}")
    end try
  end tell`);
}

// Utwory z playlisty + odtwarzanie od indeksu
async function getTracksOfPlaylist(name) {
  const n = name.replace(/"/g, '\\"');
  const script = `
  tell application "Music"
    set PL to missing value
    -- try user playlist first
    try
      set PL to (first user playlist whose name is "${n}")
    end try
    -- fallback to any playlist
    if PL is missing value then
      try
        set PL to (first playlist whose name is "${n}")
      end try
    end if
    if PL is missing value then return ""

    set us to (ASCII character 31)
    set rs to (ASCII character 30)
    set outText to ""

    set cnt to (count of tracks of PL)
    repeat with i from 1 to cnt
      set t to track i of PL

      set nm to "" as text
      try
        set nm to (name of t) as text
      end try

      set ar to "" as text
      try
        set ar to (artist of t) as text
      end try

      set al to "" as text
      try
        set al to (album of t) as text
      end try

      set outText to outText & (i as text) & us & nm & us & ar & us & al & rs
    end repeat

    return outText
  end tell`;
  const raw = await osaMulti(script);
  if (!raw) return [];
  return raw
    .split(String.fromCharCode(30)) // RS
    .filter(Boolean)
    .map(row => {
      const parts = row.split(String.fromCharCode(31)); // US
      return {
        index: parseInt(parts[0], 10) || 1,
        name: parts[1] || "",
        artist: parts[2] || "",
        album: parts[3] || ""
      };
    });
}

async function playTrackInPlaylist(name, index) {
  const n = name.replace(/"/g, '\\"');
  const i = Math.max(1, parseInt(index, 10) || 1);
  await osaMulti(`
  tell application "Music"
    try
      play track ${i} of (first user playlist whose name is "${n}")
    on error
      play track ${i} of (first playlist whose name is "${n}")
    end try
  end tell`);
}

// ---------- Player state ----------
async function getState() {
  const state = await safe(`tell application "Music" to get player state`, "stopped");
  let name = "", artist = "", album = "", duration = 0, position = 0;

  if (state === "playing" || state === "paused") {
    const [nm, ar, al, du, ps] = await Promise.all([
      safe(`tell application "Music" to get name of current track`, ""),
      safe(`tell application "Music" to get artist of current track`, ""),
      safe(`tell application "Music" to get album of current track`, ""),
      safe(`tell application "Music" to get duration of current track`, "0"),
      safe(`tell application "Music" to get player position`, "0")
    ]);
    name = nm; artist = ar; album = al;
    duration = parseFloat(du) || 0; position = parseFloat(ps) || 0;
  }

  const [shuffleStr, repeat, volStr, nextNm, nextAr] = await Promise.all([
    safe(`tell application "Music" to get shuffle enabled`, "false"),
    safe(`tell application "Music" to get song repeat`, "none"),
    safe(`tell application "Music" to get sound volume`, "0"),
    safe(`tell application "Music" to get name of next track`, ""),
    safe(`tell application "Music" to get artist of next track`, "")
  ]);

  return {
    name, artist, album, duration, position, state,
    shuffle: (shuffleStr === "true"),
    repeat,
    volume: parseInt(volStr, 10) || 0,
    nextName: nextNm,
    nextArtist: nextAr
  };
}

// ---------- UI ----------
const screen = blessed.screen({ smartCSR: true, title: "Apple Music TUI" });

// Outer frame for the whole UI
const outer = blessed.box({
  top: 0, left: 0, width: "100%", height: "100%",
  border: "line", label: " Music Terminal UI ", style: { border: { fg: "blue" } }
});
screen.append(outer);

const BASE_TOP = 1; // start inside outer border
// Header box removed; infoBox moves up
const infoBox = blessed.box({
  top: BASE_TOP, left: 1, width: "98%", height: 5, tags: true,
  border: "line", label: " Now playing ", style: { border: { fg: "blue" } }
});
const progressBox = blessed.box({
  top: BASE_TOP + 5, left: 1, width: "48%", height: 3, tags: true,
  border: "line", label: " Progress ", style: { border: { fg: "blue" } }
});
// Command definitions with UTF icons (no emoji)
const commandDefs = [
  { label: chalk.green("⏯")  + "  Play/Pause",     cmd: "Play/Pause" },
  { label: chalk.cyan("⏭")   + "  Next Track",     cmd: "Next >>" },
  { label: chalk.cyan("⏮")   + "  Previous Track", cmd: "Previous <<" },
  { label: chalk.yellow("▲") + "  Volume +",       cmd: "Volume +" },
  { label: chalk.yellow("▼") + "  Volume -",       cmd: "Volume -" },
  { label: chalk.green("≫")  + "  Seek +10s",      cmd: "Seek +10s ->" },
  { label: chalk.green("≪")  + "  Seek -10s",      cmd: "Seek -10s <-" },
  { label: chalk.magenta("⇌")+ "  Toggle Shuffle", cmd: "Toggle Shuffle" },
  { label: chalk.magenta("⟳")+ "  Cycle Repeat",   cmd: "Cycle Repeat" },
  { label: chalk.blue("♫")   + "  Playlists...",   cmd: "Show Playlists..." },
  { label: chalk.red("✕")    + "  Quit",           cmd: "Quit" }
];
const list = blessed.list({
  top: BASE_TOP + 8, left: 1, width: "48%", bottom: 3,
  items: commandDefs.map(c => c.label), keys: true, mouse: true,
  border: "line", label: " Commands ",
  tags: true,
  style: {
    selected: { bg: "blue", fg: "white" },
    border: { fg: "blue" },
    item: { hover: { fg: "yellow" } }
  }
});

const triviaBox = blessed.box({
  top: BASE_TOP, left: "50%", right: 1, bottom: 3,
  border: "line", label: " Trivia ", tags: true,
  scrollable: true, alwaysScroll: true, keys: true, mouse: true,
  scrollbar: { ch: " ", track: { bg: "gray" }, style: { bg: "green" } },
  style: { border: { fg: "green" } },
  content: openai ? "Fetching trivia…" : "Set OPENAI_API_KEY to show trivia."
});
// allow focus switching
triviaBox.key(["pageup","pagedown","up","down"], function(ch, key) {
  if (key.name === "up") this.scroll(-1);
  else if (key.name === "down") this.scroll(1);
  else if (key.name === "pageup") this.scroll(-this.height + 1);
  else if (key.name === "pagedown") this.scroll(this.height - 1);
  screen.render();
});

const helpContent = "{cyan-fg}Space{/cyan-fg}=Play/Pause  {yellow-fg}←/→{/yellow-fg}=Seek ±10s  {green-fg}+/-{/green-fg}=Vol ±5  {magenta-fg}S{/magenta-fg}=Shuffle  {cyan-fg}R{/cyan-fg}=Repeat  {blue-fg}P{/blue-fg}=Playlists  {red-fg}Q{/red-fg}=Quit";

const help = blessed.box({
  bottom: 1, left: 1, width: "100%-3", height: 1, tags: true,
  content: helpContent,
  style: { fg: "white" }
});

outer.append(infoBox);
outer.append(progressBox);
outer.append(list);
outer.append(triviaBox);
outer.append(help);
list.focus();

// Modal: playlisty
const modalPl = blessed.box({
  top: "center", left: "center", width: "70%", height: "70%",
  border: "line", label: " Playlists ", style: { border: { fg: "yellow" } }, hidden: true
});
const modalPlList = blessed.list({
  parent: modalPl, top: 1, left: 1, right: 1, bottom: 1, keys: true, mouse: true,
  style: { selected: { bg: "green", fg: "black" } }
});
screen.append(modalPl);

// Modal: utwory
const modalTr = blessed.box({
  top: "center", left: "center", width: "80%", height: "80%",
  border: "line", label: " Tracks ", style: { border: { fg: "magenta" } }, hidden: true
});
const modalTrList = blessed.list({
  parent: modalTr, top: 1, left: 1, right: 1, bottom: 1, keys: true, mouse: true,
  style: { selected: { bg: "cyan", fg: "black" } }
});
screen.append(modalTr);

function showMessage(msg = "") {
  outer.setLabel(msg ? ` Music Terminal UI - ${msg} ` : " Music Terminal UI ");
}

function drawProgress(position, duration) {
  const width = progressBox.width - 4;
  const barWidth = Math.max(10, width - 20);
  const ratio = duration > 0 ? Math.min(1, Math.max(0, position / duration)) : 0;
  const filled = Math.floor(barWidth * ratio);
  const bar = "[" +
    chalk.green("█".repeat(filled)) +
    chalk.gray("░".repeat(Math.max(0, barWidth - filled))) +
    "]";
  progressBox.setContent(` ${timeFmt(position)} ${bar} ${timeFmt(duration)}`);
}

let currentState = null; // ostatni znany stan odtwarzacza

function renderState(s) {
  if (!s) return;
  const status =
    s.state === "playing" ? chalk.green("PLAY") :
    s.state === "paused"  ? chalk.yellow("PAUSE") :
                            chalk.gray("STOP");

  const line1 = s.name ? `{bold}${s.name}{/bold}` : chalk.gray("(no track)");
  const line2 = [s.artist, s.album].filter(Boolean).join(" - ");
  const nextLine = s.nextName ? `Next: ${s.nextName}${s.nextArtist ? " - " + s.nextArtist : ""}` : "";
  const shuffle = s.shuffle ? chalk.green("on") : chalk.gray("off");
  const repeat = chalk.cyan(s.repeat || "none");
  const vol = `${s.volume}%`;

  const lines = [
    line1,
    line2,
    nextLine,
    `State: ${status}   Shuffle: ${shuffle}   Repeat: ${repeat}   Volume: ${vol}`
  ].filter(Boolean);

  infoBox.setContent(lines.join("\n"));

  // trigger trivia fetch if track changed
  if (s.name && (triviaBox._lastKey !== `${s.name}::${s.artist}`)) {
    triviaBox._lastKey = `${s.name}::${s.artist}`;
    triviaBox.setContent(openai ? "Fetching trivia…" : "Set OPENAI_API_KEY to show trivia.");
    fetchTrivia(s.name, s.artist).then(txt => {
      // ensure same track still
      if (triviaBox._lastKey === `${s.name}::${s.artist}`) {
        triviaBox.setContent(mdConvert(txt));
        screen.render();
      }
    });
  }
  drawProgress(s.position, s.duration);
  screen.render();
}

let refreshing = false;
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    await ensureMusicLaunched();
    const s = await getState();
    currentState = s;
    renderState(s);
  } catch {
    infoBox.setContent(chalk.magenta("Music.app access denied or AppleScript error."));
    showMessage("Error fetching state.");
    screen.render();
  } finally {
    refreshing = false;
  }
}

async function handleCommand(cmd) {
  try {
    switch (cmd) {
      case "Play/Pause": {
        // optimistic update
        if (currentState) {
          currentState.state = currentState.state === "playing" ? "paused" : "playing";
          renderState(currentState);
        }
        const st = await safe(`tell application "Music" to get player state`, "stopped");
        if (st === "playing") await pause(); else await play();
        break;
      }
      case "Next >>": {
        if (currentState) { currentState.name = "(loading...)"; renderState(currentState); }
        await nextTrack();
        await play();
        if (currentState) { currentState.state = "playing"; }
        break;
      }
      case "Previous <<": {
        if (currentState) { currentState.name = "(loading...)"; renderState(currentState); }
        await prevTrack();
        await play();
        if (currentState) { currentState.state = "playing"; }
        break;
      }
      case "Volume +": {
        if (currentState) { currentState.volume = Math.min(100, (currentState.volume || 0) + 5); renderState(currentState); }
        const v = await getVolume(); await setVolume(Math.min(100, v + 5)); break; }
      case "Volume -": {
        if (currentState) { currentState.volume = Math.max(0, (currentState.volume || 0) - 5); renderState(currentState); }
        const v = await getVolume(); await setVolume(Math.max(0, v - 5)); break; }
      case "Seek +10s ->": {
        if (currentState) { currentState.position = (currentState.position || 0) + 10; renderState(currentState); }
        await seekRel(10); break; }
      case "Seek -10s <-": {
        if (currentState) { currentState.position = Math.max(0, (currentState.position || 0) - 10); renderState(currentState); }
        await seekRel(-10); break; }
      case "Toggle Shuffle": {
        if (currentState) { currentState.shuffle = !currentState.shuffle; renderState(currentState); }
        await toggleShuffle(); break; }
      case "Cycle Repeat": {
        if (currentState) {
          const order = ["none","one","all"];
          const next = order[(order.indexOf(currentState.repeat)||0)+1 & 0b11];
          currentState.repeat = next; renderState(currentState);
        }
        await cycleRepeat(); break; }
      case "Show Playlists...": return openPlaylistsModal();
      case "Quit": process.exit(0);
    }
  } finally {
    refresh();
  }
}

async function openPlaylistsModal() {
  const pls = await getPlaylists();
  if (!pls.length) { showMessage("No playlists."); return; }
  modalPlList.setItems(pls);
  modalPl.show(); modalPlList.focus(); screen.render();
}

async function openTracksModalFor(playlistName) {
  showMessage(`Loading: ${playlistName}...`);
  const tracks = await getTracksOfPlaylist(playlistName);
  if (!tracks.length) { showMessage("Empty playlist or error."); return; }

  modalTrList.clearItems();
  tracks.forEach(t => {
    const label =
      `${String(t.index).padStart(3," ")}  ${t.name}` +
      (t.artist ? ` - ${t.artist}` : "") +
      (t.album ? `  [${t.album}]` : "");
    modalTrList.addItem(label);
  });
  modalTrList._tracks = tracks;
  modalTrList._playlist = playlistName;
  modalTr.setLabel(` Tracks - ${playlistName} `);
  modalTr.show(); modalTrList.focus(); screen.render();
}

// list handlers
list.on("select", (item, idx) => handleCommand(commandDefs[idx].cmd));

// shortcuts
screen.key(["q","C-c"], () => process.exit(0));
screen.key(["space"], () => handleCommand("Play/Pause"));
screen.key(["right"], () => handleCommand("Seek +10s ->"));
screen.key(["left"],  () => handleCommand("Seek -10s <-"));
screen.key(["+"],     () => handleCommand("Volume +"));
screen.key(["-"],     () => handleCommand("Volume -"));
screen.key(["s"],     () => handleCommand("Toggle Shuffle"));
screen.key(["r"],     () => handleCommand("Cycle Repeat"));
screen.key(["p"],     () => handleCommand("Show Playlists..."));

// modals
modalPlList.on("select", (item) => {
  const playlistName = item.getText();
  modalPl.hide(); screen.render();
  openTracksModalFor(playlistName);
});

modalTrList.on("select", async (item, idx) => {
  const tracks = modalTrList._tracks || [];
  const plName = modalTrList._playlist || "";
  const t = tracks[idx];
  if (t) {
    await playTrackInPlaylist(plName, t.index);
    modalTr.hide(); list.focus(); screen.render();
    refresh();
  }
});

// ESC closes active modal
screen.key(["escape"], () => {
  if (!modalTr.hidden) { modalTr.hide(); list.focus(); screen.render(); return; }
  if (!modalPl.hidden) { modalPl.hide(); list.focus(); screen.render(); return; }
});

// start + auto‑refresh co 1 s
(async () => {
  // showMessage("Start…");
  screen.render();
  await refresh();
  setInterval(refresh, REFRESH_MS);
})();
