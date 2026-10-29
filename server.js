const express = require("express");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 10000;
const DEFAULT_URL =
"https://amagi-live.ondemandkorea.com/amgplt0456.m3u8";

const DELAY_SECONDS = Math.max(
0,
parseInt(process.env.DELAY_SECONDS || "15", 10) || 0
);

const SEGMENT_SECONDS = 4;
const HLS_LIST_SIZE = 20;
const MAX_FRAME_BYTES = 20 * 1024 * 1024;

const sessions = new Map();

function getSource(req) {
const value = req.query.url || DEFAULT_URL;

try {
const u = new URL(value);
if (u.protocol !== "http:" && u.protocol !== "https:") return null;
return u.href;
} catch {
return null;
}
}

function getId(source) {
return crypto.createHash("sha256").update(source).digest("hex").slice(0, 16);
}

function createSession(source) {
const id = getId(source);

if (sessions.has(id)) {
const s = sessions.get(id);
s.lastAccess = Date.now();
return s;
}

const dir = path.join(os.tmpdir(), "tv-" + id);
fs.mkdirSync(dir, { recursive: true });

const s = {
id,
source,
dir,
lastAccess: Date.now(),
frames: [],
frameBytes: 0,
sequence: 0,
jpegBuffer: Buffer.alloc(0),
videoProcess: null,
hlsProcess: null,
error: null
};

sessions.set(id, s);

// Process 1: create HLS with video and audio for the web.
const hlsArgs = [
"-hide_banner",
"-loglevel", "warning",
"-nostdin",
"-user_agent", "Mozilla/5.0 TV-Server/1.0",
"-allowed_extensions", "ALL",
"-allowed_segment_extensions", "ALL",
"-rw_timeout", "20000000",
"-i", source,

"-map", "0:v:0",
"-map", "0:a:0?",
"-c:v", "copy",
"-c:a", "aac",
"-b:a", "96k",
"-ac", "2",
"-f", "hls",
"-hls_time", String(SEGMENT_SECONDS),
"-hls_list_size", String(HLS_LIST_SIZE),
"-hls_delete_threshold", "10",
"-hls_flags", "delete_segments+append_list",
"-hls_segment_filename", path.join(dir, "seg_%06d.ts"),
path.join(dir, "index.m3u8")

];

console.log("Starting HLS with audio:", source);

const hls = spawn("ffmpeg", hlsArgs, {
stdio: ["ignore", "ignore", "pipe"]
});

s.hlsProcess = hls;

hls.stderr.on("data", d => {
console.error("[HLS]", d.toString().trim());
});

hls.on("error", e => {
s.error = e.message;
console.error("[HLS spawn error]", e.message);
});

hls.on("close", code => {
console.log("HLS FFmpeg exited:", code);
if (code !== 0) s.error = "HLS FFmpeg exited with code " + code;
});

// Process 2: create MJPEG for the ESP32-S3.
const mjpegArgs = [
"-hide_banner",
"-loglevel", "warning",
"-nostdin",
"-user_agent", "Mozilla/5.0 TV-Server/1.0",
"-allowed_extensions", "ALL",
"-allowed_segment_extensions", "ALL",
"-rw_timeout", "20000000",
"-i", source,
"-map", "0:v:0",
"-an",
"-sn",
"-dn",
"-vf",
"fps=8,scale=320:240:force_original_aspect_ratio=decrease,pad=320:240:(ow-iw)/2:(oh-ih)/2",
"-q:v", "8",
"-f", "image2pipe",
"-vcodec", "mjpeg",
"pipe:1"
];

console.log("Starting MJPEG:", source);

const video = spawn("ffmpeg", mjpegArgs, {
stdio: ["ignore", "pipe", "pipe"]
});

s.videoProcess = video;

video.stdout.on("data", chunk => {
s.jpegBuffer = Buffer.concat([s.jpegBuffer, chunk]);

while (true) {
  const start = s.jpegBuffer.indexOf(Buffer.from([0xff, 0xd8]));

  if (start < 0) {
    s.jpegBuffer = s.jpegBuffer.slice(-1);
    break;
  }

  const end = s.jpegBuffer.indexOf(
    Buffer.from([0xff, 0xd9]),
    start + 2
  );

  if (end < 0) {
    if (start > 0) s.jpegBuffer = s.jpegBuffer.slice(start);
    break;
  }

  const jpeg = Buffer.from(s.jpegBuffer.subarray(start, end + 2));
  s.jpegBuffer = s.jpegBuffer.subarray(end + 2);

  s.sequence++;
  s.frames.push({
    seq: s.sequence,
    time: Date.now(),
    data: jpeg
  });
  s.frameBytes += jpeg.length;

  const cutoff = Date.now() - Math.max(30000, (DELAY_SECONDS + 15) * 1000);

  while (
    s.frames.length &&
    (s.frames[0].time < cutoff || s.frameBytes > MAX_FRAME_BYTES)
  ) {
    const old = s.frames.shift();
    s.frameBytes -= old.data.length;
  }

  if (s.sequence === 1) {
    console.log("First MJPEG frame:", jpeg.length, "bytes");
  }
}

});

video.stderr.on("data", d => {
console.error("[MJPEG]", d.toString().trim());
});

video.on("error", e => {
s.error = e.message;
console.error("[MJPEG spawn error]", e.message);
});

video.on("close", code => {
console.log("MJPEG FFmpeg exited:", code);
});

return s;
}

function delayedPlaylist(s) {
const file = path.join(s.dir, "index.m3u8");
if (!fs.existsSync(file)) return null;

let lines;

try {
lines = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
} catch {
return null;
}

const segmentLineIndexes = [];

for (let i = 0; i < lines.length; i++) {
if (!lines[i].startsWith("#")) segmentLineIndexes.push(i);
}

const delayCount = Math.ceil(DELAY_SECONDS / SEGMENT_SECONDS);

// Hide the newest segments to introduce a playback delay.
if (delayCount > 0 && segmentLineIndexes.length > delayCount + 2) {
const keepCount = segmentLineIndexes.length - delayCount;
lines = lines.slice(0, segmentLineIndexes[keepCount - 1] + 1);
}

return lines.map(line => {
if (line.startsWith("#")) return line;

const filename = path.basename(line);
return "/hls-segment/" + s.id + "/" + encodeURIComponent(filename);

}).join("\n") + "\n";
}

app.get("/health", (req, res) => {
res.json({
ok: true,
delaySeconds: DELAY_SECONDS,
sessions: sessions.size
});
});

app.get("/", (req, res) => {
const source = getSource(req) || DEFAULT_URL;
const safeSource = source.replace(/&/g, "&").replace(/"/g, """);

res.type("html").send(`<!doctype html>

<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>TV Online</title>
<style>
body{background:#111;color:#eee;font-family:Arial,sans-serif;text-align:center;margin:0}
main{max-width:800px;margin:auto;padding:16px}
video{width:100%;background:#000}
input{box-sizing:border-box;width:100%;padding:12px}
button{padding:12px;margin:8px}
</style>
</head>
<body>
<main>
<h2>TV Online</h2>
<form id="form">
<input id="url" value="${safeSource}">
<button type="submit">Mở kênh</button>
</form>
<video id="video" controls playsinline></video>
<p id="status">Đang tải playlist...</p>
<p>Độ trễ mục tiêu: ${DELAY_SECONDS} giây</p>
<p><a style="color:#8cf" href="/stream?url=${encodeURIComponent(source)}">Luồng MJPEG cho ESP32</a></p>
</main>
<script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>
<script>
const video = document.getElementById("video");
const input = document.getElementById("url");
const statusText = document.getElementById("status");
let player = null;function startTV() {
const source = input.value.trim();

if (!(source.startsWith("https://") || source.startsWith("http://"))) {
statusText.textContent = "URL không hợp lệ";
return;
}

if (player) {
player.destroy();
player = null;
}

video.pause();
video.removeAttribute("src");
video.load();

const playlist = "/hls?url=" + encodeURIComponent(source);

if (window.Hls && Hls.isSupported()) {
player = new Hls({
lowLatencyMode: false,
liveSyncDurationCount: 8,
maxBufferLength: 30,
backBufferLength: 30
});

player.loadSource(playlist);
player.attachMedia(video);

player.on(Hls.Events.MANIFEST_PARSED, () => {
  statusText.textContent = "Đã tải luồng. Nhấn Play để nghe tiếng.";
});

player.on(Hls.Events.ERROR, (event, data) => {
  if (data.fatal) {
    statusText.textContent = "Lỗi HLS: " + data.details;
  }
});

} else if (video.canPlayType("application/vnd.apple.mpegurl")) {
video.src = playlist;
} else {
statusText.textContent = "Trình duyệt không hỗ trợ HLS.";
}
}

document.getElementById("form").addEventListener("submit", event => {
event.preventDefault();
startTV();
});

startTV();
</script>

</body>
</html>`);
});app.get("/hls", (req, res) => {
const source = getSource(req);
if (!source) return res.status(400).send("Invalid stream URL");

const s = createSession(source);
s.lastAccess = Date.now();

const playlist = delayedPlaylist(s);

res.setHeader("Cache-Control", "no-cache, no-store");
res.setHeader("Access-Control-Allow-Origin", "*");

if (!playlist) {
res.setHeader("Retry-After", "2");
return res.status(503).type("text").send(
s.error || "Đang chờ FFmpeg tạo playlist..."
);
}

res.type("application/vnd.apple.mpegurl").send(playlist);
});

app.get("/hls-segment/:id/:file", (req, res) => {
const s = sessions.get(req.params.id);
if (!s) return res.status(404).send("Session not found");

const filename = path.basename(req.params.file);

if (!/^seg_[0-9]+.ts$/.test(filename)) {
return res.status(400).send("Invalid segment name");
}

const file = path.join(s.dir, filename);
if (!fs.existsSync(file)) return res.status(404).send("Segment not ready");

s.lastAccess = Date.now();
res.setHeader("Content-Type", "video/mp2t");
res.setHeader("Cache-Control", "public, max-age=1");
res.sendFile(file);
});

app.get("/stream", (req, res) => {
const source = getSource(req);
if (!source) return res.status(400).send("Invalid stream URL");

const s = createSession(source);
s.lastAccess = Date.now();

res.writeHead(200, {
"Content-Type": "multipart/x-mixed-replace; boundary=frame",
"Cache-Control": "no-cache, no-store",
"Access-Control-Allow-Origin": "*",
"Connection": "keep-alive"
});

let lastSeq = -1;

const timer = setInterval(() => {
if (res.destroyed || res.writableEnded) {
clearInterval(timer);
return;
}

const targetTime = Date.now() - DELAY_SECONDS * 1000;
let selected = null;

for (let i = s.frames.length - 1; i >= 0; i--) {
  if (s.frames[i].time <= targetTime) {
    selected = s.frames[i];
    break;
  }
}

if (!selected || selected.seq <= lastSeq) return;

lastSeq = selected.seq;
s.lastAccess = Date.now();

res.write("--frame\r\n");
res.write("Content-Type: image/jpeg\r\n");
res.write("Content-Length: " + selected.data.length + "\r\n\r\n");
res.write(selected.data);
res.write("\r\n");

}, 100);

res.on("close", () => clearInterval(timer));
});

setInterval(() => {
const now = Date.now();

for (const [id, s] of sessions.entries()) {
if (now - s.lastAccess < 5 * 60 * 1000) continue;

for (const child of [s.videoProcess, s.hlsProcess]) {
  if (child && child.exitCode === null) child.kill("SIGTERM");
}

try {
  fs.rmSync(s.dir, { recursive: true, force: true });
} catch (e) {
  console.error("Cleanup error:", e.message);
}

sessions.delete(id);

}
}, 60000).unref();

app.listen(PORT, "0.0.0.0", () => {
console.log("TV server listening on port", PORT);
console.log("Default stream:", DEFAULT_URL);
console.log("Delay:", DELAY_SECONDS, "seconds");
});
