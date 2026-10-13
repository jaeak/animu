const http = require("node:http");
const https = require("node:https");
const fs = require("node:fs");
const path = require("node:path");

const host = "127.0.0.1";
const port = Number(process.env.PORT || 8000);
const root = __dirname;
const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml"
};

function respond(res, status, message) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(message);
}

// AnimeThemes' video host only allows a few requests in quick succession (then answers 503), and the
// browser makes several range requests per video. So each video is downloaded once, in one request,
// into video-cache/, and every browser request is served from that file, even while it's downloading.
const videoCacheDir = path.join(root, "video-cache");
const videoCacheLimitBytes = 3 * 1024 ** 3;
const upstreamSpacingMs = 1500;
const retryDelaysMs = [2000, 3000, 5000, 8000, 12000];
const downloads = new Map();
const upstreamQueue = [];
let lastUpstreamAt = 0;
let upstreamTimer = null;

fs.mkdirSync(videoCacheDir, { recursive: true });
for (const name of fs.readdirSync(videoCacheDir)) {
  if (name.endsWith(".part")) fs.rmSync(path.join(videoCacheDir, name), { force: true });
}

// `background` is for videos fetched ahead of time (songs coming up in the queue); anything the browser is
// actually playing jumps ahead of those.
function videoDownload(filename, { background = false } = {}) {
  if (downloads.has(filename)) {
    const existing = downloads.get(filename);
    if (!background && existing.background) {
      existing.background = false;
      pumpUpstream();
    }
    return existing;
  }
  const state = {
    filename,
    background,
    file: path.join(videoCacheDir, filename),
    part: path.join(videoCacheDir, `${filename}.part`),
    size: null,
    received: 0,
    done: false,
    error: null,
    attempt: 0,
    events: new (require("node:events").EventEmitter)()
  };
  state.events.setMaxListeners(0);
  downloads.set(filename, state);
  try {
    const stats = fs.statSync(state.file);
    state.size = stats.size;
    state.received = stats.size;
    state.done = true;
  } catch {
    upstreamQueue.push(state);
    pumpUpstream();
  }
  return state;
}

// Which queued download goes next: videos being played first, newest first (the song you just switched to);
// otherwise one ahead-of-time download at a time, in queue order, so they never crowd out what you're watching.
function nextQueuedIndex() {
  for (let index = upstreamQueue.length - 1; index >= 0; index--) {
    if (!upstreamQueue[index].background) return index;
  }
  const backgroundBusy = [...downloads.values()].some(state => state.background && state.started && !state.done && !state.error);
  return backgroundBusy ? -1 : upstreamQueue.findIndex(state => state.background);
}

// Starts queued downloads, spaced out to stay under the video host's limit (more widely for ahead-of-time ones,
// leaving room for a song you skip to).
function pumpUpstream() {
  if (upstreamTimer) return;
  const index = nextQueuedIndex();
  if (index < 0) return;
  const spacing = upstreamQueue[index].background ? upstreamSpacingMs * 2 : upstreamSpacingMs;
  const wait = lastUpstreamAt + spacing - Date.now();
  if (wait > 0) {
    upstreamTimer = setTimeout(() => {
      upstreamTimer = null;
      pumpUpstream();
    }, wait);
    return;
  }
  lastUpstreamAt = Date.now();
  startDownload(upstreamQueue.splice(index, 1)[0]);
  pumpUpstream();
}

function failDownload(state, message) {
  console.error(`AnimeThemes video ${state.filename} failed: ${message}`);
  state.error = message;
  downloads.delete(state.filename);
  fs.rm(state.part, { force: true }, () => {});
  state.events.emit("progress");
  pumpUpstream();
}

function retryDownload(state, reason) {
  const delay = retryDelaysMs[state.attempt++];
  if (delay === undefined) {
    failDownload(state, reason);
    return;
  }
  setTimeout(() => {
    upstreamQueue.push(state);
    pumpUpstream();
  }, delay);
}

function startDownload(state) {
  const request = https.get({
    hostname: "v.animethemes.moe",
    path: `/${encodeURIComponent(state.filename)}`,
    headers: { "User-Agent": "animu (local anime visualizer)" }
  }, response => {
    if (response.statusCode === 429 || response.statusCode >= 500) {
      response.resume();
      retryDownload(state, `status ${response.statusCode}`);
      return;
    }
    if (response.statusCode !== 200) {
      response.resume();
      failDownload(state, `status ${response.statusCode}`);
      return;
    }
    state.started = true;
    state.size = Number(response.headers["content-length"]) || null;
    if (!state.size) {
      response.resume();
      failDownload(state, "missing content length");
      return;
    }
    const out = fs.createWriteStream(state.part);
    const size = state.size;
    // Waiting requests are only told the size once the file exists on disk, so they can open it.
    state.size = null;
    out.on("open", () => {
      state.size = size;
      state.events.emit("progress");
    });
    response.on("data", chunk => {
      out.write(chunk, () => {
        state.received += chunk.length;
        state.events.emit("progress");
      });
    });
    response.on("end", () => out.end(() => {
      if (state.received !== state.size) {
        failDownload(state, "incomplete download");
        return;
      }
      fs.rename(state.part, state.file, error => {
        if (error) state.file = state.part;
        state.done = true;
        state.events.emit("progress");
        trimVideoCache();
        pumpUpstream();
      });
    }));
    response.on("error", error => {
      out.destroy();
      failDownload(state, error.message);
    });
  });
  request.setTimeout(30000, () => request.destroy(new Error("timed out")));
  request.on("error", error => {
    if (state.started) return;
    retryDownload(state, error.message);
  });
}

// Keeps the cache under its size limit by deleting the least recently watched videos.
function trimVideoCache() {
  const files = fs.readdirSync(videoCacheDir)
    .filter(name => !name.endsWith(".part"))
    .map(name => ({ name, stats: fs.statSync(path.join(videoCacheDir, name)) }))
    .sort((a, b) => a.stats.mtimeMs - b.stats.mtimeMs);
  let total = files.reduce((sum, file) => sum + file.stats.size, 0);
  for (const file of files) {
    if (total <= videoCacheLimitBytes) break;
    fs.rmSync(path.join(videoCacheDir, file.name), { force: true });
    downloads.delete(file.name);
    total -= file.stats.size;
  }
}

// Romanizes Japanese song titles (足跡 → "ashiato") so they can be matched against AnimeThemes, which only
// lists romanized titles. Kanji have several possible readings, so this uses a dictionary-based analyzer.
let tokenizerPromise = null;

function japaneseTokenizer() {
  if (!tokenizerPromise) {
    const kuromoji = require("kuromoji");
    tokenizerPromise = new Promise((resolve, reject) => {
      kuromoji.builder({ dicPath: path.join(path.dirname(require.resolve("kuromoji")), "..", "dict") })
        .build((error, tokenizer) => (error ? reject(error) : resolve(tokenizer)));
    });
    tokenizerPromise.catch(() => { tokenizerPromise = null; });
  }
  return tokenizerPromise;
}

async function romanizeOnce(text) {
  const { toRomaji } = require("wanakana");
  const tokens = (await japaneseTokenizer()).tokenize(text);
  const words = tokens.map(token => {
    // The particles は and へ are pronounced (and romanized) "wa" and "e".
    if (token.pos === "助詞" && token.surface_form === "は") return "wa";
    if (token.pos === "助詞" && token.surface_form === "へ") return "e";
    return toRomaji(token.reading && token.reading !== "*" ? token.reading : token.surface_form);
  });
  return words.join(" ").replace(/\s+([!?,.、。！？])/g, "$1").replace(/\s+/g, " ").trim();
}

// Returns the main reading plus alternatives. Titles written all in katakana (カワキヲアメク) come out as one
// unbroken word, so they're also read as hiragana, which splits them into words ("kawaki wo ame ku").
async function romanize(text) {
  const { toHiragana } = require("wanakana");
  const readings = [await romanizeOnce(text)];
  if (/[゠-ヿ]/.test(text)) readings.push(await romanizeOnce(toHiragana(text, { passRomaji: true })));
  return [...new Set(readings.filter(Boolean))];
}

function serveRomanization(res, requestUrl) {
  const text = (requestUrl.searchParams.get("text") || "").slice(0, 200);
  romanize(text).then(variants => {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=86400" });
    res.end(JSON.stringify({ text, romaji: variants[0] || "", variants }));
  }, error => {
    console.error("Romanization failed:", error);
    respond(res, 500, "Romanization is unavailable.");
  });
}

// Which of the given romanized titles a Japanese title could be read as (see kanji-readings.js).
function serveReadingMatch(res, requestUrl) {
  const text = (requestUrl.searchParams.get("text") || "").slice(0, 100);
  const candidates = requestUrl.searchParams.getAll("candidate").slice(0, 60).map(value => value.slice(0, 120));
  try {
    const matches = require("./kanji-readings").matchReadings(text, candidates);
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ text, matches }));
  } catch (error) {
    console.error("Reading match failed:", error);
    respond(res, 500, "Reading match is unavailable.");
  }
}

function parseRange(header, size) {
  if (!header) return { start: 0, end: size - 1, partial: false };
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2])) return null;
  let start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  let end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  if (start >= size || start > end) return null;
  return { start, end, partial: true };
}

function streamAnimeVideo(req, res, filename) {
  if (!/^[\w-]+\.(?:webm|mp4)$/i.test(filename)) {
    respond(res, 400, "Invalid anime video filename.");
    return;
  }
  const state = videoDownload(filename);
  let closed = false;
  let fd = null;
  let position = 0;
  let range = null;
  const wake = () => pump();
  res.on("close", () => {
    closed = true;
    state.events.removeListener("progress", wake);
    if (fd !== null) fs.close(fd, () => {});
  });

  function begin() {
    if (state.error) {
      if (!res.headersSent) respond(res, 502, "AnimeThemes video is unavailable right now.");
      return;
    }
    if (!state.size) {
      state.events.once("progress", wake);
      return;
    }
    range = parseRange(req.headers.range, state.size);
    if (!range) {
      res.writeHead(416, { "Content-Range": `bytes */${state.size}` });
      res.end();
      return;
    }
    res.writeHead(range.partial ? 206 : 200, {
      "Content-Type": filename.toLowerCase().endsWith(".mp4") ? "video/mp4" : "video/webm",
      "Content-Length": range.end - range.start + 1,
      "Accept-Ranges": "bytes",
      // A video never changes under the same name, so the browser may keep it too.
      "Cache-Control": "public, max-age=604800, immutable",
      ...(range.partial ? { "Content-Range": `bytes ${range.start}-${range.end}/${state.size}` } : {})
    });
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    position = range.start;
    const now = new Date();
    fs.utimes(state.file, now, now, () => {});
    fs.open(state.done ? state.file : state.part, "r", (error, opened) => {
      if (error && !state.done) {
        // The download finished and was renamed between the check and the open.
        fs.open(state.file, "r", (retryError, retried) => {
          if (retryError) res.destroy(retryError);
          else start(retried);
        });
        return;
      }
      if (error) res.destroy(error);
      else start(opened);
    });
  }

  function start(opened) {
    if (closed) {
      fs.close(opened, () => {});
      return;
    }
    fd = opened;
    pump();
  }

  // Sends whatever part of the requested range is on disk, then waits for the download to bring more.
  function pump() {
    if (closed) return;
    if (!range) {
      begin();
      return;
    }
    if (fd === null) return;
    if (position > range.end) {
      res.end();
      return;
    }
    if (state.error && !state.done) {
      res.destroy();
      return;
    }
    const available = state.done ? state.size : state.received;
    if (available <= position) {
      state.events.once("progress", wake);
      return;
    }
    const length = Math.min(range.end + 1, available, position + 256 * 1024) - position;
    fs.read(fd, Buffer.allocUnsafe(length), 0, length, position, (error, bytesRead, buffer) => {
      if (closed) return;
      if (error || !bytesRead) {
        res.destroy(error || undefined);
        return;
      }
      position += bytesRead;
      if (res.write(buffer.subarray(0, bytesRead))) setImmediate(pump);
      else res.once("drain", pump);
    });
  }

  begin();
}

const server = http.createServer((req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    respond(res, 405, "Method not allowed.");
    return;
  }

  const requestUrl = new URL(req.url, `http://${host}:${port}`);
  if (requestUrl.pathname === "/api/romanize") {
    serveRomanization(res, requestUrl);
    return;
  }
  if (requestUrl.pathname === "/api/reads-as") {
    serveReadingMatch(res, requestUrl);
    return;
  }
  const videoPrefix = "/anime-video/";
  if (requestUrl.pathname.startsWith(videoPrefix)) {
    const filename = decodeURIComponent(requestUrl.pathname.slice(videoPrefix.length));
    // "?prefetch" only asks for the video to be downloaded ahead of time, at low priority.
    if (requestUrl.searchParams.has("prefetch")) {
      if (/^[\w-]+\.(?:webm|mp4)$/i.test(filename)) videoDownload(filename, { background: true });
      res.writeHead(204);
      res.end();
      return;
    }
    streamAnimeVideo(req, res, filename);
    return;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(requestUrl.pathname);
  } catch {
    respond(res, 400, "Invalid URL path.");
    return;
  }
  if (pathname === "/") pathname = "/index.html";
  const filename = path.resolve(root, `.${pathname}`);
  if (filename !== root && !filename.startsWith(`${root}${path.sep}`)) {
    respond(res, 403, "Forbidden.");
    return;
  }

  fs.stat(filename, (error, stats) => {
    if (error || !stats.isFile()) {
      respond(res, 404, "Not found.");
      return;
    }
    res.writeHead(200, {
      "Content-Length": stats.size,
      "Cache-Control": "no-cache",
      "Content-Type": mimeTypes[path.extname(filename).toLowerCase()] || "application/octet-stream"
    });
    if (req.method === "HEAD") res.end();
    else fs.createReadStream(filename).pipe(res);
  });
});

server.listen(port, host, () => {
  console.log(`animu is running at http://${host}:${port}/`);
  japaneseTokenizer().catch(error => console.error("Japanese dictionary failed to load:", error));
  setTimeout(() => {
    try {
      const readings = require("./kanji-readings");
      readings.loadReadings();
      readings.loadWords();
    } catch (error) {
      console.error("Kanji readings failed to load:", error);
    }
  }, 0);
});
