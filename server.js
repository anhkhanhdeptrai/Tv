
const express = require("express");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");

const app = express();
const PORT = process.env.PORT || 10000;

// =====================================================
// IPTV-ORG
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
// HLS
// =====================================================

const HLS_DIR =
  path.join(__dirname, "hls");

if (!fs.existsSync(HLS_DIR)) {
  fs.mkdirSync(HLS_DIR, {
    recursive: true
  });
}

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
              new Error(
                "M3U HTTP " + response.statusCode
              )
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

    if (!line.startsWith("#EXTINF")) {
      continue;
    }

    let name =
      line.substring(
        line.lastIndexOf(",") + 1
      ).trim();

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

    if (url.includes(".mpd")) {
      continue;
    }

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
// CHECK ONE STREAM
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
          status === 410
        ) {
          response.destroy();

          done({
            ok: false,
            status,
            error: `HTTP ${status}`
          });
          return;
        }

        if (status >= 500) {
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

      const result =
        await checkStream(channel.url);

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
// STOP FFMPEG
// =====================================================

function stopFFmpeg() {

  if (!ffmpeg) return;

  try {
    ffmpeg.kill("SIGKILL");
  } catch {}

  ffmpeg = null;
}

function stopAudioFFmpeg() {

  if (!ffmpegAudio) {
    audioQueue.length = 0;
    audioQueueBytes = 0;
    return;
  }

  try {
    ffmpegAudio.kill("SIGKILL");
  } catch {}

  ffmpegAudio = null;
  audioQueue.length = 0;
  audioQueueBytes = 0;
}

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

  audioQueue.push(audioChunk);
  audioQueueBytes += audioChunk.length;
}

// =====================================================
// START AUDIO FFMPEG
// =====================================================

function startAudioFFmpeg(channel) {

  if (!channel || !channel.url) return;

  ffmpegAudioGeneration++;

  const generation = ffmpegAudioGeneration;

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

  ffmpegAudio.stderr.on("data", data => {

    const text = data.toString().trim();

    if (text) {
      console.log("[FFmpeg Audio]", text);
    }
  });

  ffmpegAudio.stdout.on("data", chunk => {

    if (generation !== ffmpegAudioGeneration) return;

    queueAudioChunk(chunk);
  });

  ffmpegAudio.on("close", code => {

    if (generation !== ffmpegAudioGeneration) return;

    ffmpegAudio = null;

    setTimeout(() => {

      if (
        generation === ffmpegAudioGeneration &&
        currentChannel
      ) {
        startAudioFFmpeg(currentChannel);
      }

    }, 3000);
  });
}

// =====================================================
// START FFMPEG
// =====================================================

function startFFmpeg(channel) {

  ffmpegGeneration++;

  const generation = ffmpegGeneration;

  console.log("");
  console.log("======================================");
  console.log("ĐANG PHÁT:", channel.name);
  console.log(channel.url);
  console.log("======================================");

  stopFFmpeg();
  stopAudioFFmpeg();

  clearHLS();

  frames.length = 0;
  jpegBuffer = Buffer.alloc(0);

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

  startAudioFFmpeg(channel);

  // =========================================
  // STDERR
  // =========================================

  ffmpeg.stderr.on("data", data => {

    const text = data.toString().trim();

    if (text) {
      console.log("[FFmpeg]", text);
    }
  });

  // =========================================
  // MJPEG FRAME PARSER
  // =========================================

  ffmpeg.stdout.on("data", chunk => {

    if (generation !== ffmpegGeneration) return;

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
        data: jpeg
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

  ffmpeg.on("close", code => {

    console.log("FFmpeg exited:", code);

    if (generation !== ffmpegGeneration) return;

    ffmpeg = null;

    setTimeout(() => {

      if (
        generation === ffmpegGeneration &&
        currentChannel
      ) {
        startFFmpeg(currentChannel);
      }

    }, 3000);
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
// SELECT
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

  currentChannel = channel;

  startFFmpeg(channel);

  res.json({
    ok: true,
    id: channel.id,
    name: channel.name
  });
});

// =====================================================
// HLS PLAYLIST
// =====================================================

app.get("/hls/stream.m3u8", (req, res) => {

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

  const requestedUrl =
    req.query.url ||
    req.query.channelUrl;

  if (requestedUrl) {

    const customChannel = {
      id: "custom",
      name: "Custom stream",
      group: "custom",
      url: requestedUrl,
      checking: false,
      available: true,
      error: null
    };

    currentChannel = customChannel;

    startFFmpeg(customChannel);
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
  res.setHeader("Connection", "keep-alive");

  if (typeof res.flushHeaders === "function") {
    res.flushHeaders();
  }

  let closed = false;
  let lastSentTime = 0;
  let waitingForDrain = false;

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

    // =========================================
    // AUDIO QUEUE
    // =========================================

    if (!waitingForDrain) {

      while (audioQueue.length) {

        const audioChunk = audioQueue.shift();

        audioQueueBytes -= audioChunk.length;

        try {

          res.write("--frame\r\n");

          res.write(
            "Content-Type: audio/L16; rate=44100; channels=1\r\n"
          );

          res.write(
            "Content-Length: " +
            audioChunk.length +
            "\r\n\r\n"
          );

          res.write(audioChunk);
          res.write("\r\n");

        } catch {

          closed = true;
          clearInterval(timer);
          return;
        }

        if (res.writableNeedDrain) {
          waitingForDrain = true;
          break;
        }
      }
    }

    // =========================================
    // MJPEG
    // =========================================

    if (
      waitingForDrain ||
      frames.length === 0
    ) {
      return;
    }

    const target =
      Date.now() - DELAY_SECONDS * 1000;

    let selected = null;

    for (
      let i = frames.length - 1;
      i >= 0;
      i--
    ) {

      if (frames[i].time <= target) {
        selected = frames[i];
        break;
      }
    }

    if (!selected) {
      selected = frames[0];
    }

    if (selected.time === lastSentTime) {
      return;
    }

    lastSentTime = selected.time;

    // =========================================
    // SEND JPEG WITH BACKPRESSURE
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

<meta
name="viewport"
content="width=device-width,initial-scale=1"
>

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

</style>

</head>

<body>

<div class="container">

<h2>🇻🇳 Vietnam TV</h2>

<div id="status">
Đang kiểm tra các kênh...
</div>

<video
id="video"
controls
autoplay
playsinline
></video>

<h3>Danh sách kênh khả dụng</h3>

<input
id="search"
class="search"
placeholder="🔎 Tìm VTV, HTV, SCTV..."
>

<div id="channels"></div>

<h3>ESP32 MJPEG</h3>

<div class="info">
340 × 230 — 10 FPS — MJPEG tối ưu ESP32-S3
</div>

<img
src="/stream"
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

const hlsUrl =
"${hlsUrl}";

let channels = [];
let current = null;
let hls = null;

// =========================================
// LOAD
// =========================================

async function loadChannels() {

  try {

    const r = await fetch("/api/channels");

    const data = await r.json();

    channels = data.channels;
    current = data.current;

    renderChannels();

    const ch = channels.find(
      c => c.id === current
    );

    status.innerText =
      "Đang phát: " +
      (ch ? ch.name : "");

    startHLS();

  } catch {

    status.innerText =
      "Không tải được danh sách";
  }
}

// =========================================
// HLS
// =========================================

function startHLS() {

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

    if (hls) {
      hls.destroy();
    }

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
// RENDER
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
// SELECT
// =========================================

async function selectChannel(id, name) {

  status.innerText =
    "Đang chuyển sang " + name + "...";

  try {

    const r = await fetch(
      "/api/select/" + id
    );

    const data = await r.json();

    if (!data.ok) {
      throw new Error();
    }

    current = id;

    renderChannels();

    status.innerText =
      "Đang phát: " + name;

    setTimeout(startHLS, 1500);

  } catch {

    status.innerText =
      "Kênh này không thể phát";
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

loadChannels();

</script>

</body>

</html>

`);
});

// =====================================================
// START
// =====================================================

app.listen(PORT, "0.0.0.0", async () => {

  console.log("");
  console.log("======================================");
  console.log("VIETNAM TV SERVER");
  console.log("======================================");

  console.log("MJPEG:", WIDTH + "x" + HEIGHT);
  console.log("FPS:", FPS);

  try {

    console.log("Đang tải vn.m3u...");

    const m3u = await downloadM3U(M3U_URL);

    const allChannels = parseM3U(m3u);

    console.log(
      "Tìm thấy:",
      allChannels.length,
      "kênh"
    );

    // =========================================
    // KIỂM TRA URL
    // =========================================

    channels = await checkChannels(allChannels);

    if (channels.length === 0) {

      console.error("Không có kênh khả dụng!");

      process.exit(1);
    }

    // =========================================
    // KÊNH ĐẦU TIÊN
    // =========================================

    currentChannel = channels[0];

    startFFmpeg(currentChannel);

    console.log("");

    console.log(
      "Server:",
      `http://0.0.0.0:${PORT}`
    );

    console.log(
      "Kênh khả dụng:",
      channels.length
    );

  } catch (error) {

    console.error(
      "LỖI:",
      error.message
    );

    process.exit(1);
  }
});
