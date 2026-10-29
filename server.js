const express = require("express");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 10000;
const DELAY_SECONDS = Math.max(
0,
Number.parseInt(process.env.DELAY_SECONDS || "15", 10) || 0
);
const SEGMENT_SECONDS = 2;
const HLS_LIST_SIZE = 30;
const sessions = new Map();

const DEFAULT_URL = "https://dethich.pw/vtv3/index.m3u8";

function getSource(req) {
const value = req.query.url || DEFAULT_URL;

try {
const parsed = new URL(value);
if (!["http:", "https:"].includes(parsed.protocol)) return null;
return parsed.href;
} catch {
return null;
}
}

function makeId(source) {
return crypto.createHash("sha256").update(source).digest("hex").slice(0, 16);
}

function startSession(source) {
const id = makeId(source);
if (sessions.has(id)) {
sessions.get(id).lastAccess = Date.now();
return sessions.get(id);
}

const dir = path.join(os.tmpdir(), "tv-" + id);
fs.mkdirSync(dir, { recursive: true });

const session = {
id,
source,
dir,
lastAccess: Date.now(),
frames: [],
frameBytes: 0,
sequence: 0,
jpegBuffer: Buffer.alloc(0),
process: null,
error: null
};

sessions.set(id, session);

const playlist = path.join(dir, "index.m3u8");
const segment = path.join(dir, "seg_%06d.ts");

const args = [
"-hide_banner",
"-loglevel", "warning",
"-nostdin",
"-user_agent", "Mozilla/5.0 TV-Server/1.0",
"-allowed_extensions", "ALL",
"-allowed_segment_extensions", "ALL",
"-rw_timeout", "20000000",
"-i", source,

// MJPEG for ESP32-S3
"-map", "0:v:0",
"-an",
"-vf", "fps=10,scale=320:240:force_original_aspect_ratio=decrease,pad=320:240:(ow-iw)/2:(oh-ih)/2",
"-q:v", "8",
"-f", "image2pipe",
"-vcodec", "mjpeg",
"pipe:1",

// HLS with audio for the browser
"-map", "0:v:0",
"-map", "0:a:0?",
"-vf", "scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2",
"-c:v", "libx264",
"-preset", "veryfast",
"-pix_fmt", "yuv420p",
"-g", "50",
"-sc_threshold", "0",
"-c:a", "aac",
"-b:a", "96k",
"-f", "hls",
"-hls_time", String(SEGMENT_SECONDS),
"-hls_list_size", String(HLS_LIST_SIZE),
"-hls_flags", "delete_segments+append_list+independent_segments",
"-hls_segment_filename", segment,
playlist

];

console.log("Starting source:", source);

const child = spawn("ffmpeg", args, {
stdio: ["ignore", "pipe", "pipe"]
});

session.process = child;

child.stdout.on("data", chunk => {
session.jpegBuffer = Buffer.concat([session.jpegBuffer, chunk]);

while (true) {
  const start = session.jpegBuffer.indexOf(Buffer.from([255, 216]));
  if (start < 0) {
    session.jpegBuffer = session.jpegBuffer.slice(-1);
    break;
  }

  const end = session.jpegBuffer.indexOf(
    Buffer.from([255, 217]),
    start + 2
  );

  if (end < 0) {
    session.jpegBuffer = session.jpegBuffer.slice(start);
    break;
  }

  const jpeg = Buffer.from(session.jpegBuffer.subarray(start, end + 2));
  session.jpegBuffer = session.jpegBuffer.subarray(end + 2);

  session.sequence++;
  session.frames.push({
    seq: session.sequence,
    time: Date.now(),
    data: jpeg
  });
  session.frameBytes += jpeg.length;

  const cutoff = Date.now() - Math.max(30000, (DELAY_SECONDS + 15) * 1000);

  while (
    session.frames.length &&
    (session.frames[0].time < cutoff || session.frameBytes > 20 * 1024 * 1024)
  ) {
    const old = session.frames.shift();
    session.frameBytes -= old.data.length;
  }
}

});

child.stderr.on("data", data => {
console.error("[ffmpeg]", data.toString().trim());
});

child.on("error", error => {
session.error = error.message;
console.error("FFmpeg error:", error.message);
});

child.on("close", code => {
if (code !== 0) {
session.error = "FFmpeg exited with code " + code;
}
console.log("FFmpeg stopped:", id, code);
});

return session;
}

function getDelayedPlaylist(session) {
const filename = path.join(session.dir, "index.m3u8");
if (!fs.existsSync(filename)) return null;

const text = fs.readFileSync(filename, "utf8");
const lines = text.split(/\r?\n/).filter(Boolean);
const indexes = [];

for (let i = 0; i < lines.length; i++) {
if (!lines[i].startsWith("#")) indexes.push(i);
}

const delaySegments = Math.ceil(DELAY_SECONDS / SEGMENT_SECONDS);

if (indexes.length > delaySegments + 2) {
const keep = indexes.length - delaySegments;
lines.splice(indexes[keep - 1] + 1);
}

return lines.map(line => {
if (line.startsWith("#")) return line;
return "/hls-segment/" + session.id + "/" + encodeURIComponent(path.basename(line));
}).join("\n") + "\n";
}

app.get("/health", (req, res) => {
res.json({
ok: true,
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
body{background:#111;color:#eee;font-family:Arial;text-align:center;margin:0}
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
<input id="url" value="${source.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}">
<button type="submit">Mở kênh</button>
</form>
<video id="video" controls playsinline></video>
<p id="status">Nhấn Play để xem và nghe TV.</p>
<p>Độ trễ cấu hình: ${DELAY_SECONDS} giây</p>
<p><a style="color:#8cf" href="/stream?url=${encodeURIComponent(source)}">Luồng MJPEG cho ESP32</a></p>
</main>
<script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>
<script>
const video = document.getElementById("video");
const input = document.getElementById("url");
const status = document.getElementById("status");
let player = null;function startTV() {
const source = input.value.trim();
if (!/^https?:\/\//i.test(source)) {
status.textContent = "URL không hợp lệ";
return;
}

if (player) {
player.destroy();
player = null;
}

const url = "/hls?url=" + encodeURIComponent(source);

if (window.Hls && Hls.isSupported()) {
player = new Hls({
lowLatencyMode: false,
liveSyncDurationCount: 8,
maxBufferLength: 30
});

player.loadSource(url);
player.attachMedia(video);
player.on(Hls.Events.MANIFEST_PARSED, function() {
  status.textContent = "Đã tải luồng. Nhấn Play để nghe tiếng.";
});
player.on(Hls.Events.ERROR, function(event, data) {
  if (data.fatal) status.textContent = "Lỗi HLS: " + data.details;
});

} else {
video.src = url;
}
}

document.getElementById("form").addEventListener("submit", function(event) {
event.preventDefault();
startTV();
});

startTV();
</script>

</body>
</html>`);
});app.get("/hls", (req, res) => {
const source = getSource(req);
if (!source) return res.status(400).send("Invalid URL");

const session = startSession(source);
session.lastAccess = Date.now();

const playlist = getDelayedPlaylist(session);
res.setHeader("Access-Control-Allow-Origin", "*");
res.setHeader("Cache-Control", "no-cache, no-store");

if (!playlist) {
res.setHeader("Retry-After", "2");
return res.status(503).send(session.error || "Waiting for HLS playlist...");
}

res.type("application/vnd.apple.mpegurl").send(playlist);
});

app.get("/hls-segment/:id/:file", (req, res) => {
const session = sessions.get(req.params.id);
if (!session) return res.status(404).send("Session not found");

const filename = path.basename(req.params.file);
if (!/^seg_[0-9]+.ts$/.test(filename)) {
return res.status(400).send("Invalid segment");
}

const file = path.join(session.dir, filename);
if (!fs.existsSync(file)) return res.status(404).send("Segment not ready");

session.lastAccess = Date.now();
res.setHeader("Content-Type", "video/mp2t");
res.setHeader("Cache-Control", "public, max-age=1");
res.sendFile(file);
});

app.get("/stream", (req, res) => {
const source = getSource(req);
if (!source) return res.status(400).send("Invalid URL");

const session = startSession(source);
session.lastAccess = Date.now();

res.writeHead(200, {
"Content-Type": "multipart/x-mixed-replace; boundary=frame",
"Cache-Control": "no-cache, no-store",
"Access-Control-Allow-Origin": "*"
});

let lastSequence = -1;

const timer = setInterval(() => {
if (res.destroyed || res.writableEnded) {
clearInterval(timer);
return;
}

const target = Date.now() - DELAY_SECONDS * 1000;
let selected = null;

for (let i = session.frames.length - 1; i >= 0; i--) {
  if (session.frames[i].time <= target) {
    selected = session.frames[i];
    break;
  }
}

if (!selected || selected.seq <= lastSequence) return;

lastSequence = selected.seq;
session.lastAccess = Date.now();

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

for (const [id, session] of sessions.entries()) {
if (now - session.lastAccess < 5 * 60 * 1000) continue;

if (session.process && session.process.exitCode === null) {
  session.process.kill("SIGTERM");
}

try {
  fs.rmSync(session.dir, { recursive: true, force: true });
} catch (error) {
  console.error("Cleanup error:", error.message);
}

sessions.delete(id);

}
}, 60000).unref();

app.listen(PORT, "0.0.0.0", () => {
console.log("TV server listening on port", PORT);
console.log("Delay:", DELAY_SECONDS, "seconds");
});
