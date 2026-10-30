
const express = require("express");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");

const app = express();
const PORT = process.env.PORT || 10000;

// =====================================================
// IPTV
// =====================================================

const M3U_URL =
  "https://raw.githubusercontent.com/iptv-org/iptv/master/streams/vn.m3u";

// =====================================================
// CONFIG
// =====================================================

const WIDTH = 340;
const HEIGHT = 230;
const FPS = 10;

const DELAY_SECONDS = 0.3;
const BUFFER_SECONDS = 3;

const MAX_BUFFER_FRAMES =
  FPS * BUFFER_SECONDS;

const HLS_TIME = 2;
const HLS_LIST = 8;

const CHECK_TIMEOUT = 7000;
const CHECK_CONCURRENCY = 6;

// =====================================================
// HLS DIRECTORY
// =====================================================

const HLS_DIR = path.join(__dirname, "hls");

if (!fs.existsSync(HLS_DIR)) {
  fs.mkdirSync(HLS_DIR, { recursive: true });
}

// =====================================================
// GLOBAL
// =====================================================

let channels = [];

let currentChannel = null;

let ffmpeg = null;
let ffmpegGeneration = 0;

let ffmpegAudio = null;
let ffmpegAudioGeneration = 0;

const frames = [];

const audioQueue = [];
let audioQueueBytes = 0;

const MAX_AUDIO_QUEUE_BYTES =
  2 * 1024 * 1024;

let jpegBuffer = Buffer.alloc(0);

const JPEG_START = Buffer.from([0xff, 0xd8]);
const JPEG_END = Buffer.from([0xff, 0xd9]);

// =====================================================
// DOWNLOAD M3U
// =====================================================

function downloadM3U(url) {

  return new Promise((resolve, reject) => {

    const protocol =
      url.startsWith("https") ? https : http;

    const request = protocol.get(
      url,
      {
        headers: {
          "User-Agent": "Mozilla/5.0"
        }
      },
      response => {

        let data = "";

        response.setEncoding("utf8");

        response.on("data", chunk => {
          data += chunk;
        });

        response.on("end", () => {

          if (
            response.statusCode < 200 ||
            response.statusCode >= 300
          ) {
            reject(
              new Error("M3U HTTP " + response.statusCode)
            );
            return;
          }

          resolve(data);
        });
      }
    );

    request.setTimeout(CHECK_TIMEOUT, () => {
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

    if (!line.startsWith("#EXTINF")) continue;

    let name =
      line.substring(line.lastIndexOf(",") + 1).trim();

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
      name = tvgName || tvgId || `Channel ${result.length + 1}`;
    }

    if (
      line.includes("[Geo-blocked]") ||
      name.includes("[Geo-blocked]")
    ) {
      continue;
    }

    if (url.includes(".mpd")) continue;

    result.push({
      id: String(result.length),
      name,
      tvgId,
      logo,
      group,
      url,
      checking: true,
      available: false,
      error: null
    });
  }

  return result;
}

// =====================================================
// CHECK STREAM
// =====================================================

function checkStream(url) {

  return new Promise(resolve => {

    let finished = false;

    function done(result) {
      if (finished) return;
      finished = true;
      resolve(result);
    }

    let parsed;

    try {
      parsed = new URL(url);
    } catch {
      done({
        ok: false,
        status: 0,
        error: "Invalid URL"
      });
      return;
    }

    const protocol =
      parsed.protocol === "https:" ? https : http;

    const request = protocol.get(
      parsed,
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36",
          "Accept": "*/*",
          "Accept-Language": "en-US,en;q=0.9",
          "Connection": "close",
          "Range": "bytes=0-2047"
        }
      },
      response => {

        const status = response.statusCode || 0;

        if (
          status === 401 ||
          status === 403 ||
          status === 404 ||
          status === 410 ||
          status >= 500
        ) {

          response.destroy();

          done({
            ok: false,
            status,
            error: `HTTP ${status}`
          });

          return;
        }

        if (status >= 300 && status < 400) {

          response.destroy();

          done({
            ok: true,
            status,
            error: null
          });

          return;
        }

        if (status === 200 || status === 206) {

          let received = 0;

          response.on("data", chunk => {

            received += chunk.length;

            if (received > 2048) {

              response.destroy();

              done({
                ok: true,
                status,
                error: null
              });
            }
          });

          response.on("end", () => {
            done({
              ok: true,
              status,
              error: null
            });
          });

          response.on("close", () => {
            done({
              ok: true,
              status,
              error: null
            });
          });

          return;
        }

        response.destroy();

        done({
          ok: false,
          status,
          error: `HTTP ${status}`
        });
      }
    );

    request.setTimeout(CHECK_TIMEOUT, () => {

      request.destroy();

      done({
        ok: false,
        status: 0,
        error: "TIMEOUT"
      });
    });

    request.on("error", error => {

      done({
        ok: false,
        status: 0,
        error: error.message
      });
    });
  });
}

// =====================================================
// CHECK ALL CHANNELS
// =====================================================

async function checkChannels(list) {

  console.log("");
  console.log("======================================");
  console.log("KIỂM TRA STREAM");
  console.log("Tổng:", list.length);
  console.log("======================================");

  let index = 0;
  const valid = [];

  async function worker() {

    while (true) {

      const i = index++;

      if (i >= list.length) return;

      const channel = list[i];

      console.log(
        `[${i + 1}/${list.length}]`,
        channel.name
      );

      const result = await checkStream(channel.url);

      if (result.ok) {

        channel.available = true;
        channel.checking = false;

        valid.push(channel);

        console.log("  ✓ OK", result.status);

      } else {

        channel.available = false;
        channel.checking = false;
        channel.error = result.error;

        console.log("  ✗ BỎ", result.error);
      }
    }
  }

  const workers = [];

  for (let i = 0; i < CHECK_CONCURRENCY; i++) {
    workers.push(worker());
  }

  await Promise.all(workers);

  valid.forEach((channel, i) => {
    channel.id = String(i);
  });

  console.log("");
  console.log("======================================");
  console.log("KÊNH HỢP LỆ:", valid.length);
  console.log("KÊNH BỊ LOẠI:", list.length - valid.length);
  console.log("======================================");

  return valid;
}

// =====================================================
// CLEAR HLS
// =====================================================

function clearHLS() {

  if (!fs.existsSync(HLS_DIR)) return;

  for (const file of fs.readdirSync(HLS_DIR)) {

    try {
      fs.unlinkSync(path.join(HLS_DIR, file));
    } catch {}
  }
}

// =====================================================
// CLEAR OLD DATA
// =====================================================

function clearStreamData() {

  frames.length = 0;

  audioQueue.length = 0;
  audioQueueBytes = 0;

  jpegBuffer = Buffer.alloc(0);
}

// =====================================================
// STOP VIDEO FFMPEG
// =====================================================

function stopFFmpeg() {

  if (!ffmpeg) return;

  const old = ffmpeg;
  ffmpeg = null;

  try {
    old.kill("SIGKILL");
  } catch {}
}

// =====================================================
// STOP AUDIO FFMPEG
// =====================================================

function stopAudioFFmpeg() {

  if (!ffmpegAudio) {

    audioQueue.length = 0;
    audioQueueBytes = 0;

    return;
  }

  const old = ffmpegAudio;
  ffmpegAudio = null;

  try {
    old.kill("SIGKILL");
  } catch {}

  audioQueue.length = 0;
  audioQueueBytes = 0;
}

// =====================================================
// AUDIO QUEUE
// =====================================================

function queueAudioChunk(chunk) {

  if (!chunk || chunk.length === 0) return;

  const audioChunk = Buffer.from(chunk);

  while (
    audioQueueBytes + audioChunk.length >
      MAX_AUDIO_QUEUE_BYTES &&
    audioQueue.length
  ) {

    const removed = audioQueue.shift();

    audioQueueBytes -= removed.length;
  }

  if (audioChunk.length > MAX_AUDIO_QUEUE_BYTES) return;

  audioQueue.push(audioChunk);

  audioQueueBytes += audioChunk.length;
}

// =====================================================
// START AUDIO FFMPEG
// =====================================================

function startAudioFFmpeg(channel) {

  if (!channel || !channel.url) return;

  const generation = ++ffmpegAudioGeneration;

  stopAudioFFmpeg();

  ffmpegAudio = spawn("ffmpeg", [

    "-hide_banner",
    "-loglevel", "warning",

    "-reconnect", "1",
    "-reconnect_streamed", "1",
    "-reconnect_delay_max", "5",

    "-fflags", "nobuffer",

    "-i", channel.url,

    "-vn",
    "-ac", "1",
    "-ar", "44100",

    "-c:a", "pcm_s16le",
    "-f", "s16le",

    "pipe:1"
  ]);

  const processAudio = ffmpegAudio;

  processAudio.stderr.on("data", data => {

    const message = data.toString().trim();

    if (message) {
      console.log("[FFmpeg Audio]", message);
    }
  });

  processAudio.stdout.on("data", chunk => {

    if (
      generation !== ffmpegAudioGeneration ||
      processAudio !== ffmpegAudio
    ) {
      return;
    }

    queueAudioChunk(chunk);
  });

  processAudio.on("close", code => {

    if (
      generation !== ffmpegAudioGeneration ||
      processAudio !== ffmpegAudio
    ) {
      return;
    }

    ffmpegAudio = null;

    console.log("Audio FFmpeg exited:", code);

    // Không tự khởi động lại âm thanh.
  });
}

// =====================================================
// START VIDEO FFMPEG
// =====================================================

function startFFmpeg(channel) {

  if (!channel || !channel.url) return;

  // Tăng generation trước khi dừng tiến trình cũ.
  // Dữ liệu đến muộn từ tiến trình cũ sẽ bị loại.
  const generation = ++ffmpegGeneration;

  console.log("");
  console.log("======================================");
  console.log("CHUYỂN KÊNH:", channel.name);
  console.log(channel.url);
  console.log("======================================");

  // DỪNG HOÀN TOÀN KÊNH CŨ
  stopFFmpeg();
  stopAudioFFmpeg();

  // XÓA DỮ LIỆU CŨ
  clearStreamData();
  clearHLS();

  // Chỉ định kênh được chọn
  currentChannel = channel;

  const playlist = path.join(HLS_DIR, "stream.m3u8");
  const segment = path.join(HLS_DIR, "seg-%05d.ts");

  ffmpeg = spawn("ffmpeg", [

    "-hide_banner",
    "-loglevel", "warning",

    "-reconnect", "1",
    "-reconnect_streamed", "1",
    "-reconnect_delay_max", "5",

    "-fflags", "nobuffer",

    "-i", channel.url,

    // =========================================
    // HLS
    // =========================================

    "-map", "0:v:0",
    "-map", "0:a:0?",

    "-c:v", "copy",
    "-c:a", "aac",
    "-b:a", "96k",

    "-f", "hls",

    "-hls_time", String(HLS_TIME),
    "-hls_list_size", String(HLS_LIST),
    "-hls_delete_threshold", "4",

    "-hls_flags",
    "delete_segments+append_list+independent_segments",

    "-hls_segment_filename", segment,
    playlist,

    // =========================================
    // MJPEG 340x230 - 10 FPS
    // =========================================

    "-map", "0:v:0",
    "-an",

    "-vf",
    `fps=${FPS}:round=down,scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=decrease:flags=fast_bilinear,pad=${WIDTH}:${HEIGHT}:(ow-iw)/2:(oh-ih)/2,format=yuvj420p`,

    "-c:v", "mjpeg",
    "-q:v", "8",

    "-threads", "2",
    "-pix_fmt", "yuvj420p",

    "-fps_mode", "cfr",

    "-f", "image2pipe",
    "pipe:1"
  ]);

  const processVideo = ffmpeg;

  // Audio cùng kênh được chọn
  startAudioFFmpeg(channel);

  // =========================================
  // STDERR
  // =========================================

  processVideo.stderr.on("data", data => {

    if (generation !== ffmpegGeneration) return;

    const message = data.toString().trim();

    if (message) {
      console.log("[FFmpeg]", message);
    }
  });

  // =========================================
  // MJPEG FRAME
  // =========================================

  processVideo.stdout.on("data", chunk => {

    if (
      generation !== ffmpegGeneration ||
      processVideo !== ffmpeg
    ) {
      return;
    }

    jpegBuffer = Buffer.concat([
      jpegBuffer,
      chunk
    ]);

    while (true) {

      const start = jpegBuffer.indexOf(JPEG_START);

      if (start === -1) {

        if (jpegBuffer.length > 2 * 1024 * 1024) {
          jpegBuffer = Buffer.alloc(0);
        }

        break;
      }

      if (start > 0) {
        jpegBuffer = jpegBuffer.slice(start);
      }

      const end = jpegBuffer.indexOf(JPEG_END, 2);

      if (end === -1) break;

      const jpeg = Buffer.from(
        jpegBuffer.slice(0, end + 2)
      );

      jpegBuffer = jpegBuffer.slice(end + 2);

      if (
        jpeg.length < 100 ||
        jpeg[0] !== 0xff ||
        jpeg[1] !== 0xd8 ||
        jpeg[jpeg.length - 2] !== 0xff ||
        jpeg[jpeg.length - 1] !== 0xd9
      ) {
        continue;
      }

      const now = Date.now();

      frames.push({
        time: now,
        data: jpeg,
        generation
      });

      const oldest =
        now - BUFFER_SECONDS * 1000;

      while (
        frames.length &&
        frames[0].time < oldest
      ) {
        frames.shift();
      }

      while (frames.length > MAX_BUFFER_FRAMES) {
        frames.shift();
      }
    }
  });

  // =========================================
  // CLOSE
  // =========================================

  processVideo.on("close", code => {

    console.log("FFmpeg exited:", code);

    if (
      generation !== ffmpegGeneration ||
      processVideo !== ffmpeg
    ) {
      return;
    }

    ffmpeg = null;

    // Xóa frame còn lại khi stream lỗi.
    frames.length = 0;
    jpegBuffer = Buffer.alloc(0);

    // Không tự khởi động lại.
    // Chờ người dùng chọn kênh.
  });
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

    channels: channels.map(ch => ({

      id: ch.id,
      name: ch.name,
      group: ch.group,
      logo: ch.logo

    }))
  });
});

// =====================================================
// SELECT CHANNEL
// =====================================================

app.get("/api/select/:id", (req, res) => {

  const channel = channels.find(
    ch => ch.id === String(req.params.id)
  );

  if (!channel) {

    return res.status(404).json({
      error: "Không tìm thấy kênh"
    });
  }

  // startFFmpeg sẽ dừng và xóa dữ liệu kênh cũ.
  startFFmpeg(channel);

  res.json({

    ok: true,
    id: channel.id,
    name: channel.name

  });
});

// =====================================================
// STOP CHANNEL
// =====================================================

app.get("/api/stop", (req, res) => {

  // Vô hiệu hóa tất cả callback cũ.
  ffmpegGeneration++;
  ffmpegAudioGeneration++;

  stopFFmpeg();
  stopAudioFFmpeg();

  currentChannel = null;

  clearStreamData();
  clearHLS();

  res.json({
    ok: true,
    message: "Đã dừng phát"
  });
});

// =====================================================
// HLS PLAYLIST
// =====================================================

app.get("/hls/stream.m3u8", (req, res) => {

  if (!currentChannel) {
    return res.status(503).send("Chưa chọn kênh");
  }

  const playlist = path.join(HLS_DIR, "stream.m3u8");

  if (!fs.existsSync(playlist)) {
    return res.status(404).send("HLS chưa sẵn sàng");
  }

  try {

    let data = fs.readFileSync(playlist, "utf8");

    data = data.replace(
      /^([^#\r\n]+\.ts)$/gm,
      "/hls-segment/$1"
    );

    res.setHeader(
      "Content-Type",
      "application/vnd.apple.mpegurl"
    );

    res.setHeader(
      "Cache-Control",
      "no-cache, no-store, must-revalidate"
    );

    res.send(data);

  } catch {

    res.status(500).send("HLS error");
  }
});

// =====================================================
// HLS SEGMENTS
// =====================================================

app.get("/hls-segment/:file", (req, res) => {

  if (!currentChannel) {
    return res.status(503).end();
  }

  const file = path.basename(req.params.file);

  const filePath = path.join(HLS_DIR, file);

  if (!fs.existsSync(filePath)) {
    return res.status(404).end();
  }

  res.setHeader("Content-Type", "video/mp2t");
  res.setHeader("Cache-Control", "no-cache");

  fs.createReadStream(filePath).pipe(res);
});

// =====================================================
// MJPEG STREAM
// =====================================================

app.get("/stream", (req, res) => {

  // Không tự động chọn URL hoặc kênh khi truy cập /stream.
  // Chỉ API chọn kênh mới được phép bắt đầu phát.

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
  res.setHeader("Connection", "keep-alive");

  if (typeof res.flushHeaders === "function") {
    res.flushHeaders();
  }

  let closed = false;
  let waitingForDrain = false;
  let lastSentTime = 0;

  req.on("close", () => {
    closed = true;
    clearInterval(timer);
  });

  res.on("drain", () => {
    waitingForDrain = false;
  });

  const timer = setInterval(() => {

    if (closed || res.destroyed) {
      clearInterval(timer);
      return;
    }

    // Chưa chọn kênh: không gửi bất cứ frame nào.
    if (!currentChannel || !ffmpeg) {
      return;
    }

    if (waitingForDrain) {
      return;
    }

    // =========================================
    // AUDIO CÙNG KÊNH
    // =========================================

    while (audioQueue.length) {

      const audioChunk = audioQueue.shift();

      audioQueueBytes -= audioChunk.length;

      try {

        const header = Buffer.from(
          "--frame\r\n" +
          "Content-Type: audio/L16; rate=44100; channels=1\r\n" +
          "Content-Length: " +
          audioChunk.length +
          "\r\n\r\n"
        );

        res.write(header);
        res.write(audioChunk);
        res.write("\r\n");

        if (res.writableNeedDrain) {
          waitingForDrain = true;
          return;
        }

      } catch {

        closed = true;
        clearInterval(timer);
        return;
      }
    }

    // =========================================
    // MJPEG
    // =========================================

    if (frames.length === 0) return;

    const target =
      Date.now() - DELAY_SECONDS * 1000;

    let selected = null;

    for (
      let i = frames.length - 1;
      i >= 0;
      i--
    ) {

      if (
        frames[i].generation === ffmpegGeneration &&
        frames[i].time <= target
      ) {
        selected = frames[i];
        break;
      }
    }

    if (!selected) {

      for (
        let i = frames.length - 1;
        i >= 0;
        i--
      ) {

        if (frames[i].generation === ffmpegGeneration) {
          selected = frames[i];
          break;
        }
      }
    }

    if (!selected) return;

    if (selected.time === lastSentTime) return;

    lastSentTime = selected.time;

    // =========================================
    // SEND JPEG
    // =========================================

    try {

      const header = Buffer.from(
        "--frame\r\n" +
        "Content-Type: image/jpeg\r\n" +
        "Content-Length: " +
        selected.data.length +
        "\r\n\r\n"
      );

      res.write(header);
      res.write(selected.data);
      res.write("\r\n");

      if (res.writableNeedDrain) {
        waitingForDrain = true;
      }

    } catch {

      closed = true;
      clearInterval(timer);
    }

  }, 1000 / FPS);
});

// =====================================================
// HEALTH
// =====================================================

app.get("/health", (req, res) => {

  res.json({

    status: "ok",

    playlist: M3U_URL,

    channelCount: channels.length,

    currentChannel: currentChannel
      ? {
          id: currentChannel.id,
          name: currentChannel.name
        }
      : null,

    playing: !!ffmpeg,

    mjpeg: {
      url: "/stream",
      width: WIDTH,
      height: HEIGHT,
      fps: FPS,
      delaySeconds: DELAY_SECONDS,
      bufferSeconds: BUFFER_SECONDS,
      currentFrames: frames.length
    }
  });
});

// =====================================================
// WEB
// =====================================================

app.get("/", (req, res) => {

  const host = req.get("host");

  const protocol =
    req.headers["x-forwarded-proto"] ||
    req.protocol;

  const hlsUrl =
    `${protocol}://${host}/hls/stream.m3u8`;

  res.send(`

<!DOCTYPE html>

<html>

<head>

<meta charset="UTF-8">

<meta name="viewport" content="width=device-width,initial-scale=1">

<title>Vietnam TV</title>

<style>

body {
  margin:0;
  padding:15px;
  background:#111;
  color:white;
  font-family:Arial;
}

.container {
  max-width:900px;
  margin:auto;
}

video {
  width:100%;
  background:#000;
}

.search {
  width:100%;
  box-sizing:border-box;
  padding:12px;
  margin:15px 0;
  background:#222;
  border:1px solid #444;
  color:#fff;
  border-radius:6px;
}

.channel {
  padding:12px;
  margin:5px 0;
  background:#222;
  border-radius:6px;
  cursor:pointer;
}

.channel:hover {
  background:#333;
}

.channel.active {
  background:#075e9b;
}

.info {
  color:#aaa;
  font-size:14px;
  margin:8px 0;
}

.mjpeg {
  width:340px;
  height:230px;
  background:#000;
  object-fit:contain;
}

#status {
  margin:10px 0;
  color:#4caf50;
}

.stop {
  padding:10px 18px;
  background:#a52222;
  border:0;
  border-radius:6px;
  color:white;
  cursor:pointer;
}

</style>

</head>

<body>

<div class="container">

<h2>🇻🇳 Vietnam TV</h2>

<div id="status">
Server đang chờ chọn kênh...
</div>

<video
id="video"
controls
playsinline
></video>

<h3>Danh sách kênh</h3>

<input
id="search"
class="search"
placeholder="🔎 Tìm VTV, HTV, SCTV..."
>

<div id="channels"></div>

<button class="stop" onclick="stopChannel()">
DỪNG PHÁT
</button>

<h3>ESP32 MJPEG</h3>

<div class="info">
340 × 230 — 10 FPS — MJPEG
</div>

<img
id="mjpeg"
class="mjpeg"
width="340"
height="230"
>

</div>

<script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>

<script>

const video =
document.getElementById("video");

const channelBox =
document.getElementById("channels");

const search =
document.getElementById("search");

const status =
document.getElementById("status");

const mjpeg =
document.getElementById("mjpeg");

const hlsUrl =
"${hlsUrl}";

let channels = [];
let current = null;
let hls = null;

// =========================================
// LOAD CHANNELS
// =========================================

async function loadChannels() {

  try {

    const r = await fetch("/api/channels");

    const data = await r.json();

    channels = data.channels;

    current = data.current;

    renderChannels();

    if (current === null) {

      status.innerText =
        "Server đang chờ chọn kênh";

      return;
    }

    const ch = channels.find(
      c => c.id === current
    );

    status.innerText =
      "Đang phát: " + (ch ? ch.name : "");

    startHLS();

    startMJPEG();

  } catch {

    status.innerText =
      "Không tải được danh sách";
  }
}

// =========================================
// START HLS
// =========================================

function startHLS() {

  if (hls) {
    hls.destroy();
    hls = null;
  }

  if (
    video.canPlayType(
      "application/vnd.apple.mpegurl"
    )
  ) {

    video.src = hlsUrl;

    video.play().catch(() => {});

    return;
  }

  if (
    typeof Hls !== "undefined" &&
    Hls.isSupported()
  ) {

    hls = new Hls({
      lowLatencyMode: false,
      liveSyncDurationCount: 4,
      liveMaxLatencyDurationCount: 8
    });

    hls.loadSource(hlsUrl);

    hls.attachMedia(video);

    hls.on(
      Hls.Events.MANIFEST_PARSED,
      () => {
        video.play().catch(() => {});
      }
    );
  }
}

// =========================================
// START MJPEG
// =========================================

function startMJPEG() {

  mjpeg.src = "/stream?t=" + Date.now();
}

// =========================================
// RENDER CHANNELS
// =========================================

function renderChannels() {

  const keyword =
    search.value.toLowerCase().trim();

  channelBox.innerHTML = "";

  channels
    .filter(ch =>
      ch.name.toLowerCase().includes(keyword)
    )
    .forEach(ch => {

      const div =
        document.createElement("div");

      div.className =
        "channel" +
        (ch.id === current ? " active" : "");

      div.innerText = ch.name;

      div.onclick = () =>
        selectChannel(ch.id, ch.name);

      channelBox.appendChild(div);
    });
}

// =========================================
// SELECT CHANNEL
// =========================================

async function selectChannel(id, name) {

  status.innerText =
    "Đang chuyển sang " + name + "...";

  // Ngắt dữ liệu hình ảnh cũ ở trình duyệt
  mjpeg.removeAttribute("src");

  video.pause();
  video.removeAttribute("src");
  video.load();

  if (hls) {
    hls.destroy();
    hls = null;
  }

  try {

    const r = await fetch("/api/select/" + id);

    const data = await r.json();

    if (!data.ok) {
      throw new Error("Không thể chọn kênh");
    }

    current = id;

    renderChannels();

    status.innerText =
      "Đang phát: " + name;

    // Chờ FFmpeg tạo dữ liệu mới
    setTimeout(() => {

      if (current !== id) return;

      startHLS();
      startMJPEG();

    }, 2000);

  } catch (error) {

    status.innerText =
      error.message || "Không thể phát kênh";
  }
}

// =========================================
// STOP CHANNEL
// =========================================

async function stopChannel() {

  try {

    mjpeg.removeAttribute("src");

    video.pause();
    video.removeAttribute("src");
    video.load();

    if (hls) {
      hls.destroy();
      hls = null;
    }

    await fetch("/api/stop");

    current = null;

    renderChannels();

    status.innerText =
      "Đã dừng phát. Chờ chọn kênh.";

  } catch {

    status.innerText =
      "Không thể dừng phát";
  }
}

// =========================================
// SEARCH
// =========================================

search.addEventListener(
  "input",
  renderChannels
);

// =========================================
// START
// =========================================

// Chỉ tải danh sách.
// KHÔNG tự động phát kênh.

loadChannels();

</script>

</body>

</html>

`);
});

// =====================================================
// START SERVER
// =====================================================

app.listen(PORT, "0.0.0.0", async () => {

  console.log("");
  console.log("======================================");
  console.log("VIETNAM TV SERVER");
  console.log("======================================");

  console.log("MJPEG:", WIDTH + "x" + HEIGHT);
  console.log("FPS:", FPS);

  console.log("Chế độ: MANUAL SELECT");
  console.log("Tự động phát: OFF");

  try {

    console.log("Đang tải vn.m3u...");

    const m3u = await downloadM3U(M3U_URL);

    const allChannels = parseM3U(m3u);

    console.log(
      "Tìm thấy:",
      allChannels.length,
      "kênh"
    );

    channels = await checkChannels(allChannels);

    if (channels.length === 0) {

      console.error("Không có kênh khả dụng!");

      process.exit(1);
    }

    // Không tự động phát kênh đầu tiên.
    currentChannel = null;

    clearStreamData();

    console.log("");
    console.log("======================================");
    console.log("SERVER SẴN SÀNG");
    console.log("======================================");

    console.log(
      "Server:",
      `http://0.0.0.0:${PORT}`
    );

    console.log(
      "Kênh khả dụng:",
      channels.length
    );

    console.log("Đang chờ người dùng chọn kênh.");

  } catch (error) {

    console.error("LỖI:", error.message);

    process.exit(1);
  }
});
