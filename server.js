const express = require("express");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 10000;
const DEFAULT_URL = "https://dethich.pw/vtv3/index.m3u8";

const DELAY_SECONDS = Math.max(
0,
Number.parseInt(process.env.DELAY_SECONDS || "15", 10) || 0
);

const SEGMENT_SECONDS = 2;
const HLS_LIST_SIZE = 30;
const HLS_DELAY_SEGMENTS = Math.ceil(
DELAY_SECONDS / SEGMENT_SECONDS
);

const MAX_FRAME_BYTES = 20 * 1024 * 1024;
const MAX_FRAME_AGE_MS = Math.max(30000, (DELAY_SECONDS + 15) * 1000);

const sessions = new Map();

function getSource(req) {
const source = req.query.url || DEFAULT_URL;

try {
const parsed = new URL(source);

if (!["http:", "https:"].includes(parsed.protocol)) {
  return null;
}

return parsed.href;

} catch {
return null;
}
}

function getSessionId(source) {
return crypto
.createHash("sha256")
.update(source)
.digest("hex")
.slice(0, 16);
}

function escapeHtml(value) {
return String(value).replace(/[&<>"']/g, ch => ({
"&": "&",
"<": "<",
">": ">",
'"': """,
"'": "'"
})[ch]);
}

function logError(data) {
const message = data.toString().trim();

if (message) {
console.error("[ffmpeg]", message);
}
}

function addJpegFrames(session, chunk) {
session.jpegBuffer = Buffer.concat([
session.jpegBuffer,
chunk
]);

while (true) {
const start = session.jpegBuffer.indexOf(
Buffer.from([0xff, 0xd8])
);

if (start < 0) {
  session.jpegBuffer = session.jpegBuffer.slice(
    Math.max(0, session.jpegBuffer.length - 1)
  );
  break;
}

const end = session.jpegBuffer.indexOf(
  Buffer.from([0xff, 0xd9]),
  start + 2
);

if (end < 0) {
  if (start > 0) {
    session.jpegBuffer = session.jpegBuffer.slice(start);
  }
  break;
}

const jpeg = Buffer.from(
  session.jpegBuffer.subarray(start, end + 2)
);

session.jpegBuffer = session.jpegBuffer.subarray(end + 2);

session.frameSequence++;
session.frames.push({
  seq: session.frameSequence,
  time: Date.now(),
  data: jpeg
});

session.frameBytes += jpeg.length;

if (session.frameSequence === 1) {
  console.log(
    "First JPEG frame:",
    jpeg.length,
    "bytes"
  );
}

}

const cutoff = Date.now() - MAX_FRAME_AGE_MS;

while (
session.frames.length > 0 &&
(
session.frames[0].time < cutoff ||
session.frameBytes > MAX_FRAME_BYTES
)
) {
const old = session.frames.shift();
session.frameBytes -= old.data.length;
}
}

async function createSession(source) {
const id = getSessionId(source);

if (sessions.has(id)) {
const existing = sessions.get(id);
existing.lastAccess = Date.now();
return existing;
}

const dir = path.join(os.tmpdir(), "tv-mjpeg-" + id);
fs.mkdirSync(dir, { recursive: true });

const session = {
id,
source,
dir,
lastAccess: Date.now(),
frames: [],
frameBytes: 0,
frameSequence: 0,
jpegBuffer: Buffer.alloc(0),
process: null,
stopped: false,
ready: false
};

sessions.set(id, session);

const outputPlaylist = path.join(dir, "index.m3u8");
const outputSegment = path.join(dir, "seg_%06d.ts");

const args = [
"-hide_banner",
"-loglevel", "warning",
"-nostdin",

"-user_agent", "Mozilla/5.0 TV-Stream-Server/1.0",
"-allowed_extensions", "ALL",
"-allowed_segment_extensions", "ALL",
"-rw_timeout", "20000000",

"-i", source,

// Output 1: delayed MJPEG for ESP32.
"-map", "0:v:0",
"-an",
"-sn",
"-dn",
"-vf",
"fps=10,scale=320:240:force_original_aspect_ratio=decrease,pad=320:240:(ow-iw)/2:(oh-ih)/2",
"-q:v", "8",
"-f", "image2pipe",
"-vcodec", "mjpeg",
"pipe:1",

// Output 2: HLS with video and audio for web browsers.
"-map", "0:v:0",
"-map", "0:a:0?",
"-sn",
"-dn",
"-vf",
"scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2",
"-c:v", "libx264",
"-preset", "veryfast",
"-tune", "zerolatency",
"-pix_fmt", "yuv420p",
"-r", "25",
"-g", "50",
"-sc_threshold", "0",
"-c:a", "aac",
"-b:a", "96k",
"-ac", "2",
"-f", "hls",
"-hls_time", String(SEGMENT_SECONDS),
"-hls_list_size", String(HLS_LIST_SIZE),
"-hls_delete_threshold", "10",
"-hls_flags", "delete_segments+append_list+independent_segments",
"-hls_segment_filename", outputSegment,
outputPlaylist

];

console.log("Starting TV source:", source);
console.log("Session:", id, "delay:", DELAY_SECONDS, "seconds");

const ffmpeg = spawn("ffmpeg", args, {
stdio: ["ignore", "pipe", "pipe"]
});

session.process = ffmpeg;

ffmpeg.stdout.on("data", chunk => {
if (!session.stopped) {
addJpegFrames(session, chunk);
}
});

ffmpeg.stderr.on("data", logError);

ffmpeg.on("error", err => {
console.error("FFmpeg error:", err.message);
session.error = err.message;
});

ffmpeg.on("close", (code, signal) => {
session.stopped = true;

console.log(
  `FFmpeg closed: id=${id}, code=${code}, signal=${signal}`
);

if (code !== 0) {
  session.error = `FFmpeg exited with code ${code}`;
}

});

return session;
}

function getDelayedPlaylist(session) {
const playlistPath = path.join(session.dir, "index.m3u8");

if (!fs.existsSync(playlistPath)) {
return null;
}

let content;

try {
content = fs.readFileSync(playlistPath, "utf8");
} catch {
return null;
}

const lines = content
.split(/\r?\n/)
.filter(line => line.length > 0);

const segmentIndexes = [];

for (let i = 0; i < lines.length; i++) {
if (!lines[i].startsWith("#")) {
segmentIndexes.push(i);
}
}

// Hide the newest segments to create a playback delay.
if (
DELAY_SECONDS > 0 &&
segmentIndexes.length > HLS_DELAY_SEGMENTS + 2
) {
const keepCount = segmentIndexes.length - HLS_DELAY_SEGMENTS;
const lastKeptIndex = segmentIndexes[keepCount - 1];

lines.splice(lastKeptIndex + 1);

}

const rewritten = lines.map(line => {
if (line.startsWith("#")) {
return line;
}

const filename = path.basename(line);

return `/hls-segment/${session.id}/${encodeURIComponent(filename)}`;

});

return rewritten.join("\n") + "\n";
}

app.get("/health", (req, res) => {
res.json({
ok: true,
service: "TV MJPEG + HLS Audio",
delaySeconds: DELAY_SECONDS,
activeSessions: sessions.size
});
});

app.get("/", (req, res) => {
const source = getSource(req) || DEFAULT_URL;

res.type("html").send(`<!doctype html>

<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>TV Online</title>
<style>
body{background:#111;color:#eee;font-family:Arial,sans-serif;margin:0;text-align:center}
main{max-width:800px;margin:auto;padding:16px}
video{width:100%;background:#000;max-height:65vh}
input{box-sizing:border-box;width:100%;padding:12px}
button{padding:12px 18px;margin:8px;cursor:pointer}
small{color:#aaa}
</style>
</head>
<body>
<main>
<h2>TV Online</h2>
<form id="form">
<input id="url" value="${escapeHtml(source)}" placeholder="URL M3U8">
<button type="submit">Mở kênh</button>
</form>
<video id="video" controls playsinline></video>
<p id="status">Đang chuẩn bị luồng TV...</p>
<p><small>Độ trễ mục tiêu: ${DELAY_SECONDS} giây. Hình và tiếng dùng chung HLS.</small></p>
<p><a href="/stream?url=${encodeURIComponent(source)}" style="color:#8cf">Mở luồng MJPEG cho ESP32</a></p>
</main><script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script><script>
const video = document.getElementById("video");
const input = document.getElementById("url");
const statusText = document.getElementById("status");
let hls = null;

function startTV() {
  const source = input.value.trim();

  if (!/^https?:\\/\\//i.test(source)) {
    statusText.textContent = "URL không hợp lệ";
    return;
  }

  if (hls) {
    hls.destroy();
    hls = null;
  }

  video.pause();
  video.removeAttribute("src");
  video.load();

  const playlist = "/hls?url=" + encodeURIComponent(source) +
    "&t=" + Date.now();

  if (window.Hls && Hls.isSupported()) {
    hls = new Hls({
      enableWorker: true,
      lowLatencyMode: false,
      liveSyncDurationCount: 8,
      liveMaxLatencyDurationCount: 15,
      maxBufferLength: 30,
      backBufferLength: 30
    });

    hls.loadSource(playlist);
    hls.attachMedia(video);

    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      statusText.textContent =
        "Đã tải playlist. Nhấn Play để phát hình và tiếng.";
    });

    hls.on(Hls.Events.ERROR, (event, data) => {
      if (data.fatal) {
        statusText.textContent =
          "Lỗi phát HLS: " + data.type + " / " + data.details;
      }
    });
  } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
    video.src = playlist;
    statusText.textContent = "Nhấn Play để phát TV.";
  } else {
    statusText.textContent = "Trình duyệt không hỗ trợ HLS.";
  }
}

document.getElementById("form").addEventListener("submit", e => {
  e.preventDefault();
  startTV();
});

startTV();
</script></body>
</html>`);
});app.get("/hls", async (req, res) => {
const source = getSource(req);

if (!source) {
return res.status(400).send("Invalid stream URL");
}

try {
const session = await createSession(source);
session.lastAccess = Date.now();

const playlist = getDelayedPlaylist(session);

res.setHeader("Cache-Control", "no-cache, no-store");
res.setHeader("Access-Control-Allow-Origin", "*");

if (!playlist) {
  res.setHeader("Retry-After", "2");
  return res.status(503).type("text").send(
    session.error || "Đang chờ FFmpeg tạo playlist HLS..."
  );
}

res.type("application/vnd.apple.mpegurl").send(playlist);

} catch (err) {
console.error("HLS route error:", err);
res.status(500).send("Unable to start HLS");
}
});

app.get("/hls-segment/:id/:file", (req, res) => {
const session = sessions.get(req.params.id);

if (!session) {
return res.status(404).send("Stream session not found");
}

const filename = path.basename(req.params.file);

if (!/^seg_[0-9]+.ts$/.test(filename)) {
return res.status(400).send("Invalid segment filename");
}

const filePath = path.join(session.dir, filename);
session.lastAccess = Date.now();

if (!fs.existsSync(filePath)) {
return res.status(404).send("Segment not ready or expired");
}

res.setHeader("Content-Type", "video/mp2t");
res.setHeader("Cache-Control", "public, max-age=1");
res.sendFile(filePath);
});

app.get("/stream", async (req, res) => {
const source = getSource(req);

if (!source) {
return res.status(400).send("Invalid stream URL");
}

let session;

try {
session = await createSession(source);
} catch (err) {
console.error(err);
return res.status(500).send("Unable to start stream");
}

session.lastAccess = Date.now();

res.writeHead(200, {
"Content-Type": "multipart/x-mixed-replace; boundary=frame",
"Cache-Control": "no-cache, no-store, must-revalidate",
"Pragma": "no-cache",
"Access-Control-Allow-Origin": "*",
"Connection": "keep-alive"
});

let lastSequence = -1;
let timer;

timer = setInterval(() => {
if (res.destroyed || res.writableEnded) {
clearInterval(timer);
return;
}

session.lastAccess = Date.now();

const targetTime = Date.now() - DELAY_SECONDS * 1000;

let selected = null;

for (let i = session.frames.length - 1; i >= 0; i--) {
  const frame = session.frames[i];

  if (frame.time <= targetTime) {
    selected = frame;
    break;
  }
}

if (!selected || selected.seq <= lastSequence) {
  return;
}

lastSequence = selected.seq;

res.write("--frame\r\n");
res.write("Content-Type: image/jpeg\r\n");
res.write(`Content-Length: ${selected.data.length}\r\n\r\n`);
res.write(selected.data);
res.write("\r\n");

}, 100);

res.on("close", () => {
clearInterval(timer);
});
});

// Stop unused sessions and remove their temporary files.
setInterval(() => {
const now = Date.now();

for (const [id, session] of sessions.entries()) {
if (now - session.lastAccess < 5 * 60 * 1000) {
continue;
}

console.log("Cleaning idle stream:", id);

if (session.process && session.process.exitCode === null) {
  session.process.kill("SIGTERM");
}

try {
  fs.rmSync(session.dir, { recursive: true, force: true });
} catch (err) {
  console.error("Cleanup error:", err.message);
}

sessions.delete(id);

}
}, 60 * 1000).unref();

app.listen(PORT, "0.0.0.0", () => {
console.log("TV server listening on ${PORT}");
console.log("Configured delay: ${DELAY_SECONDS}s");
});
