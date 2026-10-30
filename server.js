const express = require("express");
const { spawn } = require("child_process");
const https = require("https");
const http = require("http");

const app = express();
const PORT = process.env.PORT || 10000;

const M3U_URL =
"https://raw.githubusercontent.com/iptv-org/iptv/master/streams/vn.m3u";

// =====================================================
// VIDEO CONFIG
// =====================================================

const WIDTH = 320;
const HEIGHT = 180;
const FPS = 8;
const JPEG_QUALITY = 10;

const MAX_JPEG_BUFFER = 1024 * 1024;
const FRAME_TIMEOUT = 15000;

// =====================================================
// AUDIO CONFIG - LOW LOAD PCM U8
// =====================================================

const AUDIO_SAMPLE_RATE = 16000;
const AUDIO_CHANNELS = 1;
const AUDIO_BITS = 8;
const AUDIO_BYTES_PER_SAMPLE = 1;

const AUDIO_CHUNK_MS = 20;

const AUDIO_CHUNK_SIZE =
AUDIO_SAMPLE_RATE *
AUDIO_CHANNELS *
AUDIO_BYTES_PER_SAMPLE *
AUDIO_CHUNK_MS / 1000;

const AUDIO_BUFFER_MAX =
AUDIO_SAMPLE_RATE *
AUDIO_CHANNELS *
AUDIO_BYTES_PER_SAMPLE *
0.15;

// =====================================================
// NETWORK
// =====================================================

const M3U_TIMEOUT = 15000;
const FFMPEG_RESTART_DELAY = 3000;

// =====================================================
// STATE
// =====================================================

let channels = [];
let currentChannel = null;
let ffmpeg = null;

let ffmpegGeneration = 0;
let restartTimer = null;
let watchdogTimer = null;

// =====================================================
// VIDEO BUFFER
// =====================================================

let latestFrame = null;
let jpegBuffer = Buffer.alloc(0);

let lastVideoFrameTime = 0;

const JPEG_START = Buffer.from([0xff, 0xd8]);
const JPEG_END = Buffer.from([0xff, 0xd9]);

// =====================================================
// AUDIO BUFFER
// =====================================================

let audioBuffer = Buffer.alloc(0);

// =====================================================
// DOWNLOAD M3U
// =====================================================

function downloadM3U(url) {
return new Promise((resolve, reject) => {
const protocol = url.startsWith("https:")
? https
: http;

const request = protocol.get(
  url,
  {
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Accept": "*/*"
    }
  },
  response => {
    if (
      response.statusCode < 200 ||
      response.statusCode >= 300
    ) {
      response.resume();

      reject(
        new Error(`M3U HTTP ${response.statusCode}`)
      );

      return;
    }

    let data = "";

    response.setEncoding("utf8");

    response.on("data", chunk => {
      data += chunk;

      if (data.length > 20 * 1024 * 1024) {
        request.destroy(
          new Error("M3U quá lớn")
        );
      }
    });

    response.on("end", () => {
      resolve(data);
    });
  }
);

request.setTimeout(M3U_TIMEOUT, () => {
  request.destroy(new Error("M3U timeout"));
});

request.on("error", reject);

});
}

// =====================================================
// PARSE M3U
// =====================================================

function parseM3U(text) {
const lines = text
.split(/\r?\n/)
.map(x => x.trim())
.filter(Boolean);

const result = [];

for (let i = 0; i < lines.length; i++) {
const line = lines[i];

if (!line.startsWith("#EXTINF")) {
  continue;
}

let name = line
  .substring(line.lastIndexOf(",") + 1)
  .trim();

const tvgId =
  (line.match(/tvg-id="([^"]*)"/i) || [])[1] || "";

const tvgName =
  (line.match(/tvg-name="([^"]*)"/i) || [])[1] || "";

const logo =
  (line.match(/tvg-logo="([^"]*)"/i) || [])[1] || "";

const group =
  (line.match(/group-title="([^"]*)"/i) || [])[1] || "";

let url = "";

for (let j = i + 1; j < lines.length; j++) {
  if (!lines[j].startsWith("#")) {
    url = lines[j];
    break;
  }
}

if (!url) continue;

if (!name) {
  name =
    tvgName ||
    tvgId ||
    `Channel ${result.length + 1}`;
}

if (
  line.includes("[Geo-blocked]") ||
  name.includes("[Geo-blocked]")
) {
  continue;
}

if (url.toLowerCase().includes(".mpd")) {
  continue;
}

result.push({
  id: String(result.length),
  name,
  tvgId,
  tvgName,
  logo,
  group,
  url
});

}

return result;
}

// =====================================================
// CLEAR BUFFERS
// =====================================================

function clearVideoBuffer() {
latestFrame = null;
jpegBuffer = Buffer.alloc(0);
lastVideoFrameTime = 0;
}

function clearAudioBuffer() {
audioBuffer = Buffer.alloc(0);
}

function clearAllBuffers() {
clearVideoBuffer();
clearAudioBuffer();
}

// =====================================================
// STOP WATCHDOG
// =====================================================

function stopWatchdog() {
if (watchdogTimer) {
clearInterval(watchdogTimer);
watchdogTimer = null;
}
}

// =====================================================
// STOP FFMPEG
// =====================================================

function stopFFmpeg(clearChannel = true) {
ffmpegGeneration++;

if (restartTimer) {
clearTimeout(restartTimer);
restartTimer = null;
}

stopWatchdog();

const oldFFmpeg = ffmpeg;
ffmpeg = null;

if (clearChannel) {
currentChannel = null;
}

if (oldFFmpeg) {
try {
oldFFmpeg.kill("SIGKILL");
} catch (error) {
console.log(
"Không thể dừng FFmpeg:",
error.message
);
}
}

clearAllBuffers();
}

// =====================================================
// SCHEDULE RESTART
// =====================================================

function scheduleRestart(channel, generation) {
if (
generation !== ffmpegGeneration ||
!currentChannel ||
currentChannel.id !== channel.id
) {
return;
}

if (restartTimer) {
return;
}

console.log(
"FFmpeg thử kết nối lại sau ${FFMPEG_RESTART_DELAY / 1000}s"
);

restartTimer = setTimeout(() => {
restartTimer = null;

if (
  generation !== ffmpegGeneration ||
  !currentChannel ||
  currentChannel.id !== channel.id ||
  ffmpeg
) {
  return;
}

console.log("ĐANG KẾT NỐI LẠI IPTV...");

launchFFmpeg(channel);

}, FFMPEG_RESTART_DELAY);
}

// =====================================================
// FFMPEG WATCHDOG
// =====================================================

function startWatchdog(channel, generation) {
stopWatchdog();

watchdogTimer = setInterval(() => {
if (
generation !== ffmpegGeneration ||
!ffmpeg ||
ffmpeg.exitCode !== null
) {
return;
}

if (!lastVideoFrameTime) {
  return;
}

const elapsed =
  Date.now() - lastVideoFrameTime;

if (elapsed > FRAME_TIMEOUT) {
  console.log(
    "VIDEO TIMEOUT:",
    elapsed,
    "ms"
  );

  const old = ffmpeg;

  ffmpeg = null;

  stopWatchdog();

  clearAllBuffers();

  try {
    old.kill("SIGKILL");
  } catch {}

  scheduleRestart(channel, generation);
}

}, 5000);
}

// =====================================================
// START FFMPEG
// =====================================================

function launchFFmpeg(channel) {
if (!channel || !channel.url) {
return false;
}

const generation = ffmpegGeneration;

console.log("");
console.log("======================================");
console.log("START CHANNEL:", channel.name);
console.log("URL:", channel.url);
console.log("GENERATION:", generation);
console.log("======================================");

const args = [
"-hide_banner",
"-loglevel", "warning",

// INPUT THREAD
"-thread_queue_size", "512",
"-threads", "2",

// NETWORK RECONNECT
"-reconnect", "1",
"-reconnect_streamed", "1",
"-reconnect_at_eof", "1",
"-reconnect_delay_max", "5",
"-rw_timeout", "15000000",
"-user_agent", "Mozilla/5.0",

// TIMESTAMP / PACKETS
"-fflags", "+genpts+discardcorrupt",
"-err_detect", "ignore_err",

// INPUT
"-i", channel.url,

// =============================================
// OUTPUT 1: VIDEO MJPEG
// =============================================

"-map", "0:v:0",
"-an",

"-vf",
`fps=${FPS},scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=decrease:flags=fast_bilinear,pad=${WIDTH}:${HEIGHT}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,format=yuvj420p`,

"-c:v", "mjpeg",
"-q:v", String(JPEG_QUALITY),
"-threads:v", "1",
"-pix_fmt", "yuvj420p",

"-flush_packets", "1",
"-f", "image2pipe",
"pipe:1",

// =============================================
// OUTPUT 2: AUDIO PCM U8
// =============================================

"-map", "0:a:0?",
"-vn",

"-ac", String(AUDIO_CHANNELS),
"-ar", String(AUDIO_SAMPLE_RATE),

"-c:a", "pcm_u8",
"-threads:a", "1",

"-flush_packets", "1",

"-f", "u8",
"pipe:3"

];

let processFFmpeg;

try {
processFFmpeg = spawn(
"ffmpeg",
args,
{
stdio: [
"ignore",
"pipe",
"pipe",
"pipe"
]
}
);
} catch (error) {
console.log(
"FFMPEG SPAWN ERROR:",
error.message
);

return false;

}

ffmpeg = processFFmpeg;

lastVideoFrameTime = Date.now();

startWatchdog(channel, generation);

// =================================================
// STDERR
// =================================================

processFFmpeg.stderr.on("data", data => {
if (
generation !== ffmpegGeneration ||
processFFmpeg !== ffmpeg
) {
return;
}

const message = data.toString().trim();

if (message) {
  console.log("[FFmpeg]", message);
}

});

// =================================================
// VIDEO JPEG PARSER
// =================================================

processFFmpeg.stdout.on("data", chunk => {
if (
generation !== ffmpegGeneration ||
processFFmpeg !== ffmpeg
) {
return;
}

jpegBuffer = Buffer.concat([
  jpegBuffer,
  chunk
]);

while (jpegBuffer.length >= 4) {
  const start = jpegBuffer.indexOf(JPEG_START);

  if (start === -1) {
    const last =
      jpegBuffer[jpegBuffer.length - 1];

    jpegBuffer = last === 0xff
      ? Buffer.from([0xff])
      : Buffer.alloc(0);

    break;
  }

  if (start > 0) {
    jpegBuffer = jpegBuffer.subarray(start);
  }

  const end = jpegBuffer.indexOf(
    JPEG_END,
    2
  );

  if (end === -1) {
    if (jpegBuffer.length > MAX_JPEG_BUFFER) {
      const next = jpegBuffer.indexOf(
        JPEG_START,
        2
      );

      if (next >= 0) {
        jpegBuffer = jpegBuffer.subarray(next);
      } else {
        jpegBuffer = Buffer.alloc(0);
      }
    }

    break;
  }

  const jpeg = Buffer.from(
    jpegBuffer.subarray(0, end + 2)
  );

  jpegBuffer = jpegBuffer.subarray(end + 2);

  if (jpeg.length < 100) {
    continue;
  }

  if (
    jpeg[0] !== 0xff ||
    jpeg[1] !== 0xd8 ||
    jpeg[jpeg.length - 2] !== 0xff ||
    jpeg[jpeg.length - 1] !== 0xd9
  ) {
    continue;
  }

  // FRAME MỚI NHẤT
  const now = Date.now();

  latestFrame = {
    data: jpeg,
    time: now,
    generation
  };

  lastVideoFrameTime = now;
}

});

processFFmpeg.stdout.on("error", error => {
if (generation === ffmpegGeneration) {
console.log(
"[VIDEO PIPE ERROR]",
error.message
);
}
});

// =================================================
// AUDIO PCM U8
// =================================================

processFFmpeg.stdio[3].on("data", chunk => {
if (
generation !== ffmpegGeneration ||
processFFmpeg !== ffmpeg
) {
return;
}

audioBuffer = Buffer.concat([
  audioBuffer,
  chunk
]);

// GIỮ TỐI ĐA 150MS
if (audioBuffer.length > AUDIO_BUFFER_MAX) {
  audioBuffer = audioBuffer.subarray(
    audioBuffer.length - AUDIO_BUFFER_MAX
  );
}

});

processFFmpeg.stdio[3].on("error", error => {
if (generation === ffmpegGeneration) {
console.log(
"[AUDIO PIPE ERROR]",
error.message
);
}
});

// =================================================
// PROCESS ERROR
// =================================================

processFFmpeg.on("error", error => {
if (generation !== ffmpegGeneration) {
return;
}

console.log("FFMPEG PROCESS ERROR:", error.message);

});

// =================================================
// PROCESS CLOSE
// =================================================

processFFmpeg.on("close", (code, signal) => {
if (
generation !== ffmpegGeneration ||
processFFmpeg !== ffmpeg
) {
return;
}

console.log("======================================");
console.log("FFMPEG CLOSED");
console.log("Exit code:", code);
console.log("Signal:", signal);
console.log("Channel:", channel.name);
console.log("======================================");

ffmpeg = null;

stopWatchdog();

clearAllBuffers();

scheduleRestart(channel, generation);

});

return true;
}

// =====================================================
// SELECT CHANNEL
// =====================================================

function startFFmpeg(channel) {
if (!channel || !channel.url) {
return false;
}

if (
currentChannel &&
currentChannel.id === channel.id &&
ffmpeg &&
ffmpeg.exitCode === null
) {
console.log(
"Channel already playing:",
channel.name
);

return true;

}

stopFFmpeg(true);

currentChannel = channel;

return launchFFmpeg(channel);
}

// =====================================================
// API CHANNELS
// =====================================================

app.get("/api/channels", (req, res) => {
res.json({
count: channels.length,

current: currentChannel
  ? currentChannel.id
  : null,

playing: !!ffmpeg,

channels: channels.map(channel => ({
  id: channel.id,
  name: channel.name,
  group: channel.group,
  logo: channel.logo
}))

});
});

// =====================================================
// API SELECT
// =====================================================

app.get("/api/select/:id", (req, res) => {
const channel = channels.find(
ch => ch.id === String(req.params.id)
);

if (!channel) {
return res.status(404).json({
ok: false,
error: "Không tìm thấy kênh"
});
}

const started = startFFmpeg(channel);

if (!started) {
return res.status(500).json({
ok: false,
error: "Không thể khởi động FFmpeg"
});
}

res.json({
ok: true,

id: channel.id,
name: channel.name,

video: "/stream",
audio: "/audio",

format: {
  video: `${WIDTH}x${HEIGHT} ${FPS}fps`,

  audio: "PCM U8",

  sampleRate: AUDIO_SAMPLE_RATE,

  channels: AUDIO_CHANNELS,

  bits: AUDIO_BITS,

  bitrate: 128000
}

});
});

// =====================================================
// API STOP
// =====================================================

app.get("/api/stop", (req, res) => {
stopFFmpeg(true);

res.json({
ok: true,
message: "Đã dừng phát"
});
});

// =====================================================
// VIDEO MJPEG STREAM
// =====================================================

app.get("/stream", (req, res) => {
if (!currentChannel || !ffmpeg) {
return res.status(503).send("Chua chon kenh");
}

res.statusCode = 200;

res.setHeader(
"Content-Type",
"multipart/x-mixed-replace; boundary=frame"
);

res.setHeader(
"Cache-Control",
"no-cache, no-store, must-revalidate"
);

res.setHeader("Pragma", "no-cache");
res.setHeader("Expires", "0");
res.setHeader("Connection", "keep-alive");

res.removeHeader("Content-Encoding");

if (req.socket) {
req.socket.setNoDelay(true);
req.socket.setKeepAlive(true);
}

res.flushHeaders();

let closed = false;
let waitingForDrain = false;
let lastFrameTime = 0;

const timer = setInterval(() => {
if (closed || res.destroyed) {
cleanup();
return;
}

if (!currentChannel || !ffmpeg) {
  return;
}

if (waitingForDrain) {
  return;
}

const frame = latestFrame;

if (!frame) {
  return;
}

if (frame.generation !== ffmpegGeneration) {
  return;
}

if (frame.time === lastFrameTime) {
  return;
}

lastFrameTime = frame.time;

const header = Buffer.from(
  "--frame\r\n" +
  "Content-Type: image/jpeg\r\n" +
  "Content-Length: " +
  frame.data.length +
  "\r\n\r\n"
);

const packet = Buffer.concat([
  header,
  frame.data,
  Buffer.from("\r\n")
]);

try {
  const ok = res.write(packet);

  if (!ok) {
    waitingForDrain = true;
  }
} catch (error) {
  cleanup();
}

}, 1000 / FPS);

function cleanup() {
if (closed) return;

closed = true;

clearInterval(timer);

if (!res.destroyed) {
  res.end();
}

}

res.on("drain", () => {
waitingForDrain = false;
});

res.on("close", () => {
closed = true;
clearInterval(timer);
});

res.on("error", () => {
cleanup();
});
});

// =====================================================
// AUDIO PCM U8 STREAM
// =====================================================

app.get("/audio", (req, res) => {
if (!currentChannel || !ffmpeg) {
return res.status(503).send("Chua chon kenh");
}

res.statusCode = 200;

res.setHeader(
"Content-Type",
"application/octet-stream"
);

res.setHeader("X-Audio-Codec", "PCM_U8");

res.setHeader(
"X-Audio-Sample-Rate",
String(AUDIO_SAMPLE_RATE)
);

res.setHeader(
"X-Audio-Channels",
String(AUDIO_CHANNELS)
);

res.setHeader(
"X-Audio-Bits",
String(AUDIO_BITS)
);

res.setHeader(
"Cache-Control",
"no-cache, no-store, must-revalidate"
);

res.setHeader("Pragma", "no-cache");
res.setHeader("Expires", "0");
res.setHeader("Connection", "keep-alive");

if (req.socket) {
req.socket.setNoDelay(true);
req.socket.setKeepAlive(true);
}

res.flushHeaders();

let closed = false;
let waitingForDrain = false;

const timer = setInterval(() => {
if (closed || res.destroyed) {
cleanup();
return;
}

if (!currentChannel || !ffmpeg) {
  return;
}

if (waitingForDrain) {
  return;
}

if (audioBuffer.length < AUDIO_CHUNK_SIZE) {
  return;
}

// ĐỌC 20MS AUDIO
const chunk = audioBuffer.subarray(
  0,
  AUDIO_CHUNK_SIZE
);

audioBuffer = audioBuffer.subarray(
  AUDIO_CHUNK_SIZE
);

try {
  const ok = res.write(chunk);

  if (!ok) {
    waitingForDrain = true;
  }
} catch (error) {
  cleanup();
}

}, AUDIO_CHUNK_MS);

function cleanup() {
if (closed) return;

closed = true;

clearInterval(timer);

if (!res.destroyed) {
  res.end();
}

}

res.on("drain", () => {
waitingForDrain = false;
});

res.on("close", () => {
closed = true;
clearInterval(timer);
});

res.on("error", () => {
cleanup();
});
});

// =====================================================
// HEALTH
// =====================================================

app.get("/health", (req, res) => {
res.json({
status: "ok",

channels: channels.length,

current: currentChannel
  ? {
      id: currentChannel.id,
      name: currentChannel.name
    }
  : null,

playing: !!ffmpeg,

restarting: !!restartTimer,

generation: ffmpegGeneration,

ffmpegPid: ffmpeg
  ? ffmpeg.pid
  : null,

memory: {
  latestFrameBytes: latestFrame
    ? latestFrame.data.length
    : 0,

  jpegParserBytes: jpegBuffer.length,

  audioBufferBytes: audioBuffer.length,

  audioBufferMax: AUDIO_BUFFER_MAX
},

video: {
  width: WIDTH,
  height: HEIGHT,
  fps: FPS,
  quality: JPEG_QUALITY,
  mode: "LATEST FRAME ONLY",
  endpoint: "/stream"
},

audio: {
  codec: "PCM_U8",
  sampleRate: AUDIO_SAMPLE_RATE,
  channels: AUDIO_CHANNELS,
  bits: AUDIO_BITS,
  bitrate: 128000,
  chunkMs: AUDIO_CHUNK_MS,
  bufferMs: 150,
  endpoint: "/audio"
}

});
});

// =====================================================
// SERVER
// =====================================================

app.listen(PORT, "0.0.0.0", async () => {
console.log("");

console.log("======================================");
console.log("ESP32 IPTV SERVER");
console.log("LOW LATENCY MODE");
console.log("======================================");

console.log("Port: ${PORT}");

console.log(
"Video: ${WIDTH}x${HEIGHT} @ ${FPS} FPS"
);

console.log("Video: MJPEG");

console.log(
"Audio: PCM U8 ${AUDIO_SAMPLE_RATE}Hz Mono"
);

console.log("Audio: 8-bit unsigned");
console.log("Audio bitrate: 128 kbps");

console.log("Video buffer: 1 latest frame");
console.log("Audio buffer: 150ms");

console.log("Disk cache: OFF");
console.log("Auto restart: ON");
console.log("Web UI: OFF");

console.log("======================================");

try {
console.log("Đang tải playlist...");

const m3u = await downloadM3U(M3U_URL);

channels = parseM3U(m3u);

console.log("Tổng kênh:", channels.length);

console.log("");

console.log("======================================");
console.log("SERVER READY");

console.log("Channels:", channels.length);

console.log("Chưa phát kênh nào.");

console.log(
  `API: http://SERVER:${PORT}/api/channels`
);

console.log(
  `Select: http://SERVER:${PORT}/api/select/ID`
);

console.log(
  `Video: http://SERVER:${PORT}/stream`
);

console.log(
  `Audio: http://SERVER:${PORT}/audio`
);

console.log(
  `Health: http://SERVER:${PORT}/health`
);

console.log("======================================");

} catch (error) {
console.error("LỖI:", error.message);
}
});
