const express = require("express");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");

const app = express();
const PORT = process.env.PORT || 10000;

const M3U_URL =
  "https://raw.githubusercontent.com/iptv-org/iptv/master/streams/vn.m3u";

const WIDTH = 320;
const HEIGHT = 240;
const FPS = 10;

const BUFFER_SECONDS = 12;
const MAX_BUFFER_FRAMES = FPS * BUFFER_SECONDS;

const HLS_TIME = 2;
const HLS_LIST = 8;

const HLS_DIR = path.join(__dirname, "hls");

if (!fs.existsSync(HLS_DIR)) {
  fs.mkdirSync(HLS_DIR, { recursive: true });
}

// =====================================================
// DOWNLOAD M3U
// =====================================================

function downloadM3U(url) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith("https") ? https : http;

    const request = protocol.get(
      url,
      { headers: { "User-Agent": "Mozilla/5.0" } },
      response => {
        if (
          response.statusCode >= 300 &&
          response.statusCode < 400 &&
          response.headers.location
        ) {
          response.resume();

          const redirectUrl = new URL(
            response.headers.location,
            url
          ).toString();

          downloadM3U(redirectUrl).then(resolve).catch(reject);
          return;
        }

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
            reject(new Error("HTTP " + response.statusCode));
            return;
          }

          resolve(data);
        });
      }
    );

    request.setTimeout(15000, () => {
      request.destroy(new Error("Request timeout"));
    });

    request.on("error", reject);
  });
}

// =====================================================
// PARSE M3U - LẤY TẤT CẢ KÊNH, KHÔNG CHECK
// =====================================================

function parseM3U(text) {
  const lines = text.split(/\r?\n/).map(x => x.trim());
  const result = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (!line.startsWith("#EXTINF")) continue;

    let name = line.substring(line.lastIndexOf(",") + 1).trim();

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
      if (!lines[j]) continue;
      if (lines[j].startsWith("#")) continue;

      url = lines[j];
      break;
    }

    if (!url) continue;

    if (!name) {
      name = tvgName || tvgId || `Channel ${result.length + 1}`;
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
// CHỌN NGUỒN HLS <=720P NẾU CÓ
// =====================================================

async function select720pOrLower(url) {
  if (!url || !/^https?:/i.test(url)) return url;
  if (!/\.m3u8(?:$|\?)/i.test(url)) return url;

  try {
    const text = await downloadM3U(url);

    if (!/#EXT-X-STREAM-INF/i.test(text)) {
      return url;
    }

    const lines = text.split(/\r?\n/).map(x => x.trim());
    const variants = [];

    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].startsWith("#EXT-X-STREAM-INF")) continue;

      const match = lines[i].match(/RESOLUTION=(\d+)x(\d+)/i);
      if (!match) continue;

      const width = Number(match[1]);
      const height = Number(match[2]);

      let j = i + 1;

      while (
        j < lines.length &&
        (!lines[j] || lines[j].startsWith("#"))
      ) {
        j++;
      }

      if (j >= lines.length) continue;

      let variantUrl;

      try {
        variantUrl = new URL(lines[j], url).toString();
      } catch {
        variantUrl = lines[j];
      }

      if (width <= 1280 && height <= 720) {
        variants.push({ url: variantUrl, width, height });
      }
    }

    if (!variants.length) return url;

    variants.sort(
      (a, b) => b.width * b.height - a.width * a.height
    );

    console.log(
      "Nguồn được chọn:",
      variants[0].width + "x" + variants[0].height
    );

    return variants[0].url;
  } catch (error) {
    console.log("Không đọc được master playlist:", error.message);
    return url;
  }
}

// =====================================================
// GLOBAL
// =====================================================

let channels = [];
let currentChannel = null;

let hlsFFmpeg = null;
let mjpegFFmpeg = null;

let generation = 0;

let frames = [];
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

function stopProcesses() {
  if (hlsFFmpeg) {
    try {
      hlsFFmpeg.kill("SIGKILL");
    } catch {}
    hlsFFmpeg = null;
  }

  if (mjpegFFmpeg) {
    try {
      mjpegFFmpeg.kill("SIGKILL");
    } catch {}
    mjpegFFmpeg = null;
  }
}

// =====================================================
// START HLS FFMPEG - VIDEO + AUDIO
// =====================================================

function startHLSFFmpeg(sourceUrl, currentGeneration) {
  const playlist = path.join(HLS_DIR, "stream.m3u8");
  const segment = path.join(HLS_DIR, "seg-%05d.ts");

  const args = [
    "-hide_banner",
    "-loglevel", "warning",

    "-reconnect", "1",
    "-reconnect_streamed", "1",
    "-reconnect_delay_max", "5",

    "-i", sourceUrl,

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
    playlist
  ];

  hlsFFmpeg = spawn("ffmpeg", args);

  hlsFFmpeg.stderr.on("data", data => {
    console.log("[HLS]", data.toString().trim());
  });

  hlsFFmpeg.on("close", code => {
    console.log("HLS FFmpeg stopped:", code);

    if (currentGeneration === generation) {
      hlsFFmpeg = null;
    }
  });
}

// =====================================================
// START MJPEG FFMPEG - CHỈ VIDEO JPEG
// =====================================================

function startMJPEGFFmpeg(sourceUrl, currentGeneration) {
  const args = [
    "-hide_banner",
    "-loglevel", "warning",

    "-reconnect", "1",
    "-reconnect_streamed", "1",
    "-reconnect_delay_max", "5",

    "-i", sourceUrl,

    "-map", "0:v:0",
    "-an",

    "-vf",
    `fps=${FPS},scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=decrease,pad=${WIDTH}:${HEIGHT}:(ow-iw)/2:(oh-ih)/2`,

    "-c:v", "mjpeg",
    "-q:v", "8",
    "-f", "image2pipe",
    "pipe:1"
  ];

  mjpegFFmpeg = spawn("ffmpeg", args);

  mjpegFFmpeg.stderr.on("data", data => {
    console.log("[MJPEG]", data.toString().trim());
  });

  mjpegFFmpeg.stdout.on("data", chunk => {
    if (currentGeneration !== generation) return;

    jpegBuffer = Buffer.concat([jpegBuffer, chunk]);

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

      const jpeg = Buffer.from(jpegBuffer.slice(0, end + 2));
      jpegBuffer = jpegBuffer.slice(end + 2);

      if (jpeg.length < 100) continue;

      frames.push({
        time: Date.now(),
        data: jpeg
      });

      while (frames.length > MAX_BUFFER_FRAMES) {
        frames.shift();
      }
    }
  });

  mjpegFFmpeg.on("close", code => {
    console.log("MJPEG FFmpeg stopped:", code);

    if (currentGeneration === generation) {
      mjpegFFmpeg = null;
    }
  });
}

// =====================================================
// START BOTH PROCESS
// =====================================================

async function startFFmpeg(channel) {
  generation++;
  const thisGeneration = generation;

  stopProcesses();
  clearHLS();

  frames = [];
  jpegBuffer = Buffer.alloc(0);

  console.log("Đang khởi động:", channel.name);

  const sourceUrl = await select720pOrLower(channel.url);

  if (thisGeneration !== generation) return;

  channel.playUrl = sourceUrl;

  console.log("Nguồn phát:", sourceUrl);

  // Hai tiến trình độc lập
  startHLSFFmpeg(sourceUrl, thisGeneration);
  startMJPEGFFmpeg(sourceUrl, thisGeneration);
}

// =====================================================
// API CHANNELS
// =====================================================

app.get("/api/channels", (req, res) => {
  res.json({
    count: channels.length,
    current: currentChannel ? currentChannel.id : null,

    channels: channels.map(ch => ({
      id: ch.id,
      name: ch.name,
      tvgId: ch.tvgId,
      tvgName: ch.tvgName,
      logo: ch.logo,
      group: ch.group
    }))
  });
});

// =====================================================
// SELECT CHANNEL
// =====================================================

app.get("/api/select/:id", async (req, res) => {
  const channel = channels.find(
    ch => ch.id === String(req.params.id)
  );

  if (!channel) {
    return res.status(404).json({
      ok: false,
      error: "Không tìm thấy kênh"
    });
  }

  currentChannel = channel;

  // Trả kết quả ngay, FFmpeg chạy nền
  res.json({
    ok: true,
    id: channel.id,
    name: channel.name
  });

  startFFmpeg(channel).catch(error => {
    console.error("Lỗi khởi động:", error);
  });
});

// =====================================================
// HLS PLAYLIST
// =====================================================

app.get("/hls/stream.m3u8", (req, res) => {
  const playlist = path.join(HLS_DIR, "stream.m3u8");

  if (!fs.existsSync(playlist)) {
    return res.status(404).send("Chưa có kênh đang phát");
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
// MJPEG STREAM - THUẦN JPEG
// =====================================================

app.get("/stream", (req, res) => {
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

  const timer = setInterval(() => {
    if (closed) return;

    if (!frames.length) return;

    const selected = frames[frames.length - 1];

    if (selected.time === lastSentTime) return;

    lastSentTime = selected.time;

    try {
      res.write("--frame\r\n");
      res.write("Content-Type: image/jpeg\r\n");
      res.write(
        "Content-Length: " + selected.data.length + "\r\n\r\n"
      );
      res.write(selected.data);
      res.write("\r\n");
    } catch {
      closed = true;
      clearInterval(timer);
    }
  }, 1000 / FPS);

  req.on("close", () => {
    closed = true;
    clearInterval(timer);
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
      ? currentChannel.name
      : null,

    hlsRunning: !!hlsFFmpeg,
    mjpegRunning: !!mjpegFFmpeg,

    mjpeg: {
      width: WIDTH,
      height: HEIGHT,
      fps: FPS,
      frames: frames.length
    }
  });
});

// =====================================================
// WEB PLAYER
// =====================================================

app.get("/", (req, res) => {
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
  color:white;
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
#status {
  margin:10px 0;
  color:#4caf50;
}
</style>
</head>

<body>
<div class="container">

<h2>🇻🇳 Vietnam TV</h2>

<div id="status">Hãy chọn kênh để phát</div>

<video id="video" controls playsinline></video>

<h3>Danh sách kênh</h3>

<input
  id="search"
  class="search"
  placeholder="Tìm kiếm kênh..."
>

<div id="channels"></div>

</div>

<script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>

<script>
const video = document.getElementById("video");
const channelBox = document.getElementById("channels");
const search = document.getElementById("search");
const status = document.getElementById("status");

const hlsUrl = "/hls/stream.m3u8";

let channels = [];
let current = null;
let hls = null;

async function loadChannels() {
  try {
    const response = await fetch("/api/channels");
    const data = await response.json();

    channels = data.channels;
    current = data.current;

    renderChannels();

    if (current !== null) {
      const ch = channels.find(c => c.id === current);

      if (ch) {
        status.innerText = "Đang phát: " + ch.name;
        startHLS();
      }
    } else {
      status.innerText = "Hãy chọn kênh để phát";
    }
  } catch (error) {
    status.innerText = "Không tải được danh sách kênh";
  }
}

function startHLS() {
  if (hls) {
    hls.destroy();
    hls = null;
  }

  video.pause();
  video.removeAttribute("src");
  video.load();

  if (
    video.canPlayType("application/vnd.apple.mpegurl")
  ) {
    video.src = hlsUrl;
    video.play().catch(() => {});
    return;
  }

  if (window.Hls && Hls.isSupported()) {
    hls = new Hls({
      enableWorker: true,
      liveSyncDurationCount: 3,
      liveMaxLatencyDurationCount: 6
    });

    hls.loadSource(hlsUrl);
    hls.attachMedia(video);

    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      video.play().catch(() => {});
    });

    hls.on(Hls.Events.ERROR, (event, data) => {
      if (data.fatal) {
        console.log("HLS error:", data);
      }
    });
  }
}

function renderChannels() {
  const keyword = search.value.toLowerCase().trim();

  channelBox.innerHTML = "";

  channels
    .filter(ch => ch.name.toLowerCase().includes(keyword))
    .forEach(ch => {
      const div = document.createElement("div");

      div.className =
        "channel" + (ch.id === current ? " active" : "");

      div.innerText = ch.name;

      div.onclick = () => selectChannel(ch.id, ch.name);

      channelBox.appendChild(div);
    });
}

async function selectChannel(id, name) {
  status.innerText = "Đang chuyển kênh: " + name;

  try {
    const response = await fetch("/api/select/" + id);
    const data = await response.json();

    if (!data.ok) throw new Error("Select failed");

    current = id;
    renderChannels();

    // Chờ FFmpeg tạo playlist và segment
    status.innerText = "Đang khởi động: " + name;

    setTimeout(() => {
      startHLS();
      status.innerText = "Đang phát: " + name;
    }, 3500);

  } catch (error) {
    status.innerText = "Không thể chọn kênh";
  }
}

search.addEventListener("input", renderChannels);

loadChannels();
</script>

</div>
</body>
</html>
  `);
});

// =====================================================
// START SERVER
// =====================================================

app.listen(PORT, "0.0.0.0", async () => {
  console.log("Server running on port", PORT);

  try {
    console.log("Đang tải playlist...");

    const m3u = await downloadM3U(M3U_URL);

    channels = parseM3U(m3u);

    console.log("Tổng số kênh:", channels.length);
    console.log("Không kiểm tra stream.");
    console.log("Không lọc Geo-blocked.");
    console.log("Không tự phát kênh đầu tiên.");

  } catch (error) {
    console.error("Lỗi tải playlist:", error.message);
  }
});
