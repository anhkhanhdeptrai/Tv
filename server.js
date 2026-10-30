
const express = require("express");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");

const app = express();
const PORT = process.env.PORT || 10000;

// =====================================================
// CONFIG
// =====================================================

const M3U_URL =
  "https://raw.githubusercontent.com/iptv-org/iptv/master/streams/vn.m3u";

const WIDTH = 340;
const HEIGHT = 230;
const FPS = 10;

const BUFFER_SECONDS = 3;
const MAX_BUFFER_FRAMES = FPS * BUFFER_SECONDS;

const HLS_TIME = 2;
const HLS_LIST = 8;

const CHECK_TIMEOUT = 7000;
const CHECK_CONCURRENCY = 6;

// =====================================================
// DIRECTORIES
// =====================================================

const HLS_DIR = path.join(__dirname, "hls");

if (!fs.existsSync(HLS_DIR)) {
  fs.mkdirSync(HLS_DIR, { recursive: true });
}

// =====================================================
// GLOBAL STATE
// =====================================================

let channels = [];
let currentChannel = null;

let ffmpeg = null;
let ffmpegGeneration = 0;

let ffmpegAudio = null;
let ffmpegAudioGeneration = 0;

const frames = [];
const audioClients = new Set();

let jpegBuffer = Buffer.alloc(0);

const JPEG_START = Buffer.from([0xff, 0xd8]);
const JPEG_END = Buffer.from([0xff, 0xd9]);

// =====================================================
// DOWNLOAD M3U
// =====================================================

function downloadM3U(url) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith("https")
      ? https
      : http;

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
      name = tvgName || tvgId ||
        `Channel ${result.length + 1}`;
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
          "User-Agent": "Mozilla/5.0",
          "Accept": "*/*",
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
  console.log("========== CHECK STREAM ==========");

  let index = 0;
  const valid = [];

  async function worker() {
    while (true) {
      const i = index++;

      if (i >= list.length) return;

      const channel = list[i];

      console.log(
        `[${i + 1}/${list.length}] ${channel.name}`
      );

      const result = await checkStream(channel.url);

      if (result.ok) {
        channel.available = true;
        channel.error = null;

        valid.push(channel);

        console.log("  OK", result.status);
      } else {
        channel.available = false;
        channel.error = result.error;

        console.log("  FAIL", result.error);
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

  console.log("Kênh hợp lệ:", valid.length);

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
// CLEAR BUFFERS
// =====================================================

function clearStreamData() {
  frames.length = 0;
  jpegBuffer = Buffer.alloc(0);
}

// =====================================================
// STOP VIDEO FFMPEG
// =====================================================

function stopFFmpeg() {
  ffmpegGeneration++;

  const old = ffmpeg;
  ffmpeg = null;

  if (old) {
    try {
      old.kill("SIGKILL");
    } catch {}
  }
}

// =====================================================
// STOP AUDIO FFMPEG
// =====================================================

function stopAudioFFmpeg() {
  ffmpegAudioGeneration++;

  const old = ffmpegAudio;
  ffmpegAudio = null;

  if (old) {
    try {
      old.kill("SIGKILL");
    } catch {}
  }
}

// =====================================================
// CLOSE AUDIO CLIENTS
// =====================================================

function closeAudioClients() {
  for (const client of audioClients) {
    try {
      client.end();
    } catch {}
  }

  audioClients.clear();
}

// =====================================================
// START AUDIO FFMPEG
// Audio is separate from MJPEG.
// =====================================================

function startAudioFFmpeg(channel) {
  if (!channel || !channel.url) return;

  stopAudioFFmpeg();

  const generation = ffmpegAudioGeneration;

  ffmpegAudio = spawn("ffmpeg", [
    "-hide_banner",
    "-loglevel", "warning",

    "-reconnect", "1",
    "-reconnect_streamed", "1",
    "-reconnect_delay_max", "5",

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
      console.log("[Audio]", message);
    }
  });

  processAudio.stdout.on("data", chunk => {
    if (
      generation !== ffmpegAudioGeneration ||
      processAudio !== ffmpegAudio
    ) {
      return;
    }

    // Broadcast raw PCM to audio clients.
    // Never send audio through /stream.
    for (const client of audioClients) {
      if (client.destroyed || client.writableEnded) {
        audioClients.delete(client);
        continue;
      }

      if (client.writableNeedDrain) {
        continue;
      }

      try {
        client.write(chunk);
      } catch {
        audioClients.delete(client);
      }
    }
  });

  processAudio.on("close", code => {
    if (
      generation !== ffmpegAudioGeneration ||
      processAudio !== ffmpegAudio
    ) {
      return;
    }

    ffmpegAudio = null;

    console.log("[Audio] FFmpeg exited:", code);

    // Không tự khởi động lại.
  });
}

// =====================================================
// START VIDEO FFMPEG
// HLS + PURE MJPEG
// =====================================================

function startFFmpeg(channel) {
  if (!channel || !channel.url) return;

  console.log("");
  console.log("================================");
  console.log("CHUYỂN KÊNH:", channel.name);
  console.log("================================");

  // Ngăn callback cũ được sử dụng.
  currentChannel = null;

  // Dừng tiến trình cũ.
  stopFFmpeg();
  stopAudioFFmpeg();

  // Đóng client audio cũ.
  closeAudioClients();

  // Xóa dữ liệu cũ.
  clearStreamData();
  clearHLS();

  // Chỉ định kênh mới.
  currentChannel = channel;

  const generation = ffmpegGeneration;

  const playlist =
    path.join(HLS_DIR, "stream.m3u8");

  const segment =
    path.join(HLS_DIR, "seg-%05d.ts");

  ffmpeg = spawn("ffmpeg", [
    "-hide_banner",
    "-loglevel", "warning",

    "-reconnect", "1",
    "-reconnect_streamed", "1",
    "-reconnect_delay_max", "5",

    "-fflags", "nobuffer",

    "-i", channel.url,

    // =====================================
    // OUTPUT 1: HLS FOR WEB
    // =====================================

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

    // =====================================
    // OUTPUT 2: PURE MJPEG FOR ESP32
    // =====================================

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

  // Audio process riêng.
  startAudioFFmpeg(channel);

  // =====================================
  // STDERR
  // =====================================

  processVideo.stderr.on("data", data => {
    if (generation !== ffmpegGeneration) return;

    const message = data.toString().trim();

    if (message) {
      console.log("[Video]", message);
    }
  });

  // =====================================
  // READ JPEG FRAMES
  // =====================================

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

      if (jpeg.length < 100) continue;

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

  // =====================================
  // VIDEO CLOSE
  // =====================================

  processVideo.on("close", code => {
    console.log("[Video] FFmpeg exited:", code);

    if (
      generation !== ffmpegGeneration ||
      processVideo !== ffmpeg
    ) {
      return;
    }

    ffmpeg = null;

    frames.length = 0;
    jpegBuffer = Buffer.alloc(0);

    // Không tự phát lại.
  });
}

// =====================================================
// API: CHANNEL LIST
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
// API: SELECT CHANNEL
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

  startFFmpeg(channel);

  res.json({
    ok: true,
    id: channel.id,
    name: channel.name
  });
});

// =====================================================
// API: STOP CHANNEL
// =====================================================

app.get("/api/stop", (req, res) => {
  currentChannel = null;

  stopFFmpeg();
  stopAudioFFmpeg();

  closeAudioClients();

  clearStreamData();
  clearHLS();

  res.json({
    ok: true,
    message: "Đã dừng phát"
  });
});

// =====================================================
// HLS PLAYLIST FOR WEB
// =====================================================

app.get("/hls/stream.m3u8", (req, res) => {
  if (!currentChannel) {
    return res.status(503).send("Chưa chọn kênh");
  }

  const playlist =
    path.join(HLS_DIR, "stream.m3u8");

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
// PURE MJPEG STREAM FOR ESP32
// NO AUDIO DATA HERE
// =====================================================

app.get("/stream", (req, res) => {
  if (!currentChannel || !ffmpeg) {
    return res.status(503).send("Chưa chọn kênh");
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
  let waitingForDrain = false;
  let lastSentTime = 0;

  let timer = null;

  req.on("close", () => {
    closed = true;

    if (timer) {
      clearInterval(timer);
    }
  });

  res.on("drain", () => {
    waitingForDrain = false;
  });

  timer = setInterval(() => {
    if (closed || res.destroyed) {
      clearInterval(timer);
      return;
    }

    if (!currentChannel || !ffmpeg) return;

    if (waitingForDrain) return;

    // Lấy frame mới nhất thuộc đúng tiến trình hiện tại.
    let selected = null;

    for (let i = frames.length - 1; i >= 0; i--) {
      if (
        frames[i].generation === ffmpegGeneration
      ) {
        selected = frames[i];
        break;
      }
    }

    if (!selected) return;

    if (selected.time === lastSentTime) return;

    lastSentTime = selected.time;

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
// AUDIO STREAM - RAW PCM SEPARATE
// =====================================================

app.get("/audio", (req, res) => {
  if (!currentChannel || !ffmpegAudio) {
    return res.status(503).send("Chưa có audio");
  }

  res.statusCode = 200;

  res.setHeader(
    "Content-Type",
    "audio/L16; rate=44100; channels=1"
  );

  res.setHeader(
    "Cache-Control",
    "no-cache, no-store"
  );

  res.setHeader("Connection", "keep-alive");

  if (typeof res.flushHeaders === "function") {
    res.flushHeaders();
  }

  audioClients.add(res);

  req.on("close", () => {
    audioClients.delete(res);
  });
});

// =====================================================
// HEALTH
// =====================================================

app.get("/health", (req, res) => {
  res.json({
    status: "ok",

    channelCount: channels.length,

    currentChannel: currentChannel
      ? {
          id: currentChannel.id,
          name: currentChannel.name
        }
      : null,

    playing: !!ffmpeg,

    mjpeg: {
      endpoint: "/stream",
      width: WIDTH,
      height: HEIGHT,
      fps: FPS,
      frames: frames.length
    },

    hls: "/hls/stream.m3u8",
    audio: "/audio"
  });
});

// =====================================================
// WEB PLAYER
// WEB USES HLS ONLY
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

<meta name="viewport"
content="width=device-width,initial-scale=1">

<title>Vietnam TV</title>

<style>

body {
  margin: 0;
  padding: 15px;
  background: #111;
  color: white;
  font-family: Arial, sans-serif;
}

.container {
  max-width: 900px;
  margin: auto;
}

video {
  width: 100%;
  background: black;
  aspect-ratio: 16 / 9;
}

.search {
  width: 100%;
  box-sizing: border-box;
  padding: 12px;
  margin: 15px 0;
  background: #222;
  border: 1px solid #444;
  color: white;
  border-radius: 6px;
}

.channel {
  padding: 12px;
  margin: 5px 0;
  background: #222;
  border-radius: 6px;
  cursor: pointer;
}

.channel:hover {
  background: #333;
}

.channel.active {
  background: #075e9b;
}

#status {
  margin: 10px 0;
  color: #4caf50;
}

.stop {
  padding: 10px 18px;
  background: #a52222;
  border: 0;
  border-radius: 6px;
  color: white;
  cursor: pointer;
  margin-top: 12px;
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
placeholder="Tìm VTV, HTV, SCTV..."
>

<div id="channels"></div>

<button class="stop" onclick="stopChannel()">
DỪNG PHÁT
</button>

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

// =====================================
// LOAD CHANNELS
// =====================================

async function loadChannels() {
  try {
    const response = await fetch("/api/channels");
    const data = await response.json();

    channels = data.channels;
    current = data.current;

    renderChannels();

    if (current === null) {
      status.innerText =
        "Server đang chờ chọn kênh";

      return;
    }

    const channel = channels.find(
      ch => ch.id === current
    );

    status.innerText =
      "Đang phát: " +
      (channel ? channel.name : "");

    startHLS();

  } catch (error) {
    status.innerText =
      "Không tải được danh sách kênh";
  }
}

// =====================================
// START HLS
// =====================================

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

    hls.on(
      Hls.Events.ERROR,
      (event, data) => {
        if (data.fatal) {
          status.innerText =
            "Lỗi phát HLS: " + data.type;
        }
      }
    );
  }
}

// =====================================
// RENDER CHANNELS
// =====================================

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

// =====================================
// SELECT CHANNEL
// =====================================

async function selectChannel(id, name) {
  status.innerText =
    "Đang chuyển sang " + name + "...";

  // Ngắt video cũ trên trình duyệt.
  video.pause();
  video.removeAttribute("src");
  video.load();

  if (hls) {
    hls.destroy();
    hls = null;
  }

  try {
    const response = await fetch(
      "/api/select/" + id
    );

    const data = await response.json();

    if (!data.ok) {
      throw new Error(
        data.error || "Không thể chọn kênh"
      );
    }

    current = id;

    renderChannels();

    status.innerText =
      "Đang chuẩn bị: " + name;

    // Đợi HLS tạo playlist và segment.
    setTimeout(() => {
      if (current !== id) return;

      status.innerText =
        "Đang phát: " + name;

      startHLS();
    }, 2000);

  } catch (error) {
    status.innerText =
      error.message || "Lỗi chọn kênh";
  }
}

// =====================================
// STOP CHANNEL
// =====================================

async function stopChannel() {
  video.pause();
  video.removeAttribute("src");
  video.load();

  if (hls) {
    hls.destroy();
    hls = null;
  }

  try {
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

// =====================================
// SEARCH
// =====================================

search.addEventListener(
  "input",
  renderChannels
);

// =====================================
// START
// =====================================

// Chỉ tải danh sách.
// Không tự phát kênh.
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
  console.log("================================");
  console.log("VIETNAM TV SERVER");
  console.log("================================");

  console.log("PORT:", PORT);
  console.log("MJPEG:", `${WIDTH}x${HEIGHT}`);
  console.log("FPS:", FPS);

  console.log("Web: HLS only");
  console.log("ESP32: /stream");
  console.log("Audio: /audio");

  console.log("Auto play: OFF");

  clearHLS();
  clearStreamData();

  try {
    console.log("Đang tải playlist...");

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
      return;
    }

    // Không tự phát kênh đầu tiên.
    currentChannel = null;

    console.log("");
    console.log("================================");
    console.log("SERVER SẴN SÀNG");
    console.log("================================");

    console.log("Kênh:", channels.length);
    console.log("Đang chờ chọn kênh.");

  } catch (error) {
    console.error(
      "Lỗi tải playlist:",
      error.message
    );
  }
});
