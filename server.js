
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

const WIDTH = 340;
const HEIGHT = 230;
const FPS = 8;
const JPEG_QUALITY = 8;

const MAX_JPEG_BUFFER = 2 * 1024 * 1024;

// =====================================================
// AUDIO CONFIG
// =====================================================

const AUDIO_SAMPLE_RATE = 44100;
const AUDIO_CHANNELS = 1;
const AUDIO_BYTES_PER_SAMPLE = 2;

const AUDIO_BUFFER_MAX =
  AUDIO_SAMPLE_RATE *
  AUDIO_CHANNELS *
  AUDIO_BYTES_PER_SAMPLE *
  0.2;

const AUDIO_CHUNK_SIZE =
  AUDIO_SAMPLE_RATE *
  AUDIO_CHANNELS *
  AUDIO_BYTES_PER_SAMPLE *
  0.02;

// =====================================================
// NETWORK / RESTART
// =====================================================

const M3U_TIMEOUT = 15000;

const WATCHDOG_INTERVAL = 5000;
const VIDEO_TIMEOUT = 30000;
const STARTUP_TIMEOUT = 45000;
const RESTART_DELAY = 5000;

// =====================================================
// STATE
// =====================================================

let channels = [];
let currentChannel = null;
let ffmpeg = null;

let ffmpegGeneration = 0;
let restartTimer = null;
let watchdogTimer = null;

let ffmpegStartedAt = 0;
let lastFrameReceivedAt = 0;
let restartCount = 0;

// =====================================================
// VIDEO BUFFER
// =====================================================

let latestFrame = null;
let jpegBuffer = Buffer.alloc(0);

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
            new Error(
              `M3U HTTP ${response.statusCode}`
            )
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
      request.destroy(
        new Error("M3U timeout")
      );
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

      if (lines[j].startsWith("#EXTINF")) {
        break;
      }

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

  lastFrameReceivedAt = 0;
}

function clearAudioBuffer() {
  audioBuffer = Buffer.alloc(0);
}

function clearAllBuffers() {
  clearVideoBuffer();
  clearAudioBuffer();
}

// =====================================================
// STOP FFMPEG
// =====================================================

function stopFFmpeg(clearChannel = true) {

  // Vô hiệu hóa tiến trình cũ

  ffmpegGeneration++;

  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }

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
        "FFmpeg stop error:",
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

  if (restartTimer) return;

  if (!channel || !currentChannel) return;

  console.log("");
  console.log("======================================");
  console.log("SCHEDULE FFMPEG RESTART");
  console.log("CHANNEL:", channel.name);
  console.log("DELAY:", RESTART_DELAY);
  console.log("======================================");

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

    console.log("RECONNECT IPTV:", channel.name);

    restartCount++;

    launchFFmpeg(channel);

  }, RESTART_DELAY);
}

// =====================================================
// LAUNCH FFMPEG
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

    // =================================
    // HTTP
    // =================================

    "-rw_timeout", "20000000",

    "-user_agent", "Mozilla/5.0",

    // =================================
    // HLS LIVE
    // =================================

    "-live_start_index", "-3",

    "-http_persistent", "1",

    "-http_multiple", "1",

    "-max_reload", "1000",

    // =================================
    // TIMESTAMP
    // =================================

    "-fflags", "+genpts+discardcorrupt",

    // =================================
    // INPUT
    // =================================

    "-i", channel.url,

    // =================================
    // OUTPUT 1: VIDEO MJPEG
    // =================================

    "-map", "0:v:0",
    "-an",

    "-vf",
    `fps=${FPS},scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=decrease:flags=fast_bilinear,pad=${WIDTH}:${HEIGHT}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,format=yuvj420p`,

    "-c:v", "mjpeg",

    "-q:v", String(JPEG_QUALITY),

    "-threads:v", "1",

    "-pix_fmt", "yuvj420p",

    "-color_range", "pc",

    "-f", "image2pipe",

    "pipe:1",

    // =================================
    // OUTPUT 2: AUDIO PCM
    // =================================

    "-map", "0:a:0?",

    "-vn",

    "-ac", String(AUDIO_CHANNELS),

    "-ar", String(AUDIO_SAMPLE_RATE),

    "-c:a", "pcm_s16le",

    "-threads:a", "1",

    "-f", "s16le",

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

  ffmpegStartedAt = Date.now();

  lastFrameReceivedAt = 0;

  // ===============================================
  // STDERR
  // ===============================================

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

  // ===============================================
  // VIDEO
  // ===============================================

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

    // Giới hạn RAM

    if (jpegBuffer.length > MAX_JPEG_BUFFER) {

      const start =
        jpegBuffer.lastIndexOf(JPEG_START);

      if (start >= 0) {
        jpegBuffer = jpegBuffer.slice(start);
      } else {
        jpegBuffer = Buffer.alloc(0);
      }
    }

    while (true) {

      const start =
        jpegBuffer.indexOf(JPEG_START);

      if (start === -1) {
        jpegBuffer = Buffer.alloc(0);
        break;
      }

      if (start > 0) {
        jpegBuffer = jpegBuffer.slice(start);
      }

      const end =
        jpegBuffer.indexOf(JPEG_END, 2);

      if (end === -1) {
        break;
      }

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

      latestFrame = {
        data: jpeg,
        time: Date.now(),
        generation
      };

      lastFrameReceivedAt = Date.now();
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

  // ===============================================
  // AUDIO
  // ===============================================

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

    if (audioBuffer.length > AUDIO_BUFFER_MAX) {

      audioBuffer = audioBuffer.slice(
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

  // ===============================================
  // PROCESS ERROR
  // ===============================================

  processFFmpeg.on("error", error => {

    if (generation !== ffmpegGeneration) {
      return;
    }

    console.log("======================================");
    console.log("FFMPEG PROCESS ERROR");
    console.log(error.message);
    console.log("======================================");
  });

  // ===============================================
  // PROCESS CLOSE
  // ===============================================

  processFFmpeg.on("close", (code, signal) => {

    if (
      generation !== ffmpegGeneration ||
      processFFmpeg !== ffmpeg
    ) {
      return;
    }

    console.log("======================================");
    console.log("FFMPEG CLOSED");
    console.log("EXIT CODE:", code);
    console.log("SIGNAL:", signal);
    console.log("CHANNEL:", channel.name);
    console.log("======================================");

    ffmpeg = null;

    clearAllBuffers();

    scheduleRestart(
      channel,
      generation
    );
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

  // Không khởi động lại cùng kênh

  if (
    currentChannel &&
    currentChannel.id === channel.id &&
    ffmpeg
  ) {
    return true;
  }

  stopFFmpeg(true);

  currentChannel = channel;

  restartCount = 0;

  return launchFFmpeg(channel);
}

// =====================================================
// WATCHDOG
// =====================================================

function startWatchdog() {

  if (watchdogTimer) {
    clearInterval(watchdogTimer);
  }

  watchdogTimer = setInterval(() => {

    if (!currentChannel || !ffmpeg) {
      return;
    }

    const now = Date.now();

    const referenceTime =
      lastFrameReceivedAt || ffmpegStartedAt;

    const timeout =
      lastFrameReceivedAt
        ? VIDEO_TIMEOUT
        : STARTUP_TIMEOUT;

    const elapsed = now - referenceTime;

    if (elapsed <= timeout) {
      return;
    }

    console.log("");
    console.log("======================================");
    console.log("VIDEO STREAM STALLED");
    console.log("CHANNEL:", currentChannel.name);
    console.log("NO FRAME:", elapsed, "ms");
    console.log("RESTARTING FFMPEG");
    console.log("======================================");

    const channel = currentChannel;

    // Dừng tiến trình cũ và tăng generation

    stopFFmpeg(false);

    // Giữ nguyên kênh

    currentChannel = channel;

    // Khởi động lại

    restartCount++;

    launchFFmpeg(channel);

  }, WATCHDOG_INTERVAL);
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

      audio: "PCM S16LE",

      sampleRate: AUDIO_SAMPLE_RATE,

      channels: AUDIO_CHANNELS,

      bits: 16
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
// VIDEO MJPEG
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

  if (typeof res.flushHeaders === "function") {
    res.flushHeaders();
  }

  let closed = false;
  let waitingForDrain = false;
  let lastFrameTime = 0;

  const timer = setInterval(() => {

    if (closed || res.destroyed) {
      clearInterval(timer);
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

    try {

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

      const ok = res.write(packet);

      if (!ok || res.writableNeedDrain) {
        waitingForDrain = true;
      }

    } catch (error) {

      closed = true;

      clearInterval(timer);

      try {
        res.end();
      } catch {}
    }

  }, 1000 / FPS);

  res.on("drain", () => {
    waitingForDrain = false;
  });

  req.on("close", () => {

    closed = true;

    clearInterval(timer);
  });

  res.on("close", () => {

    closed = true;

    clearInterval(timer);
  });

  res.on("error", () => {

    closed = true;

    clearInterval(timer);
  });
});

// =====================================================
// AUDIO PCM
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

  res.setHeader("X-Audio-Codec", "PCM_S16LE");

  res.setHeader(
    "X-Audio-Sample-Rate",
    String(AUDIO_SAMPLE_RATE)
  );

  res.setHeader(
    "X-Audio-Channels",
    String(AUDIO_CHANNELS)
  );

  res.setHeader("X-Audio-Bits", "16");

  res.setHeader(
    "Cache-Control",
    "no-cache, no-store, must-revalidate"
  );

  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.setHeader("Connection", "keep-alive");

  if (typeof res.flushHeaders === "function") {
    res.flushHeaders();
  }

  let closed = false;
  let waitingForDrain = false;

  const timer = setInterval(() => {

    if (closed || res.destroyed) {
      clearInterval(timer);
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

    const chunkSize =
      AUDIO_CHUNK_SIZE -
      (AUDIO_CHUNK_SIZE % 2);

    const chunk = audioBuffer.subarray(
      0,
      chunkSize
    );

    audioBuffer = audioBuffer.subarray(
      chunkSize
    );

    try {

      const ok = res.write(chunk);

      if (!ok || res.writableNeedDrain) {
        waitingForDrain = true;
      }

    } catch (error) {

      closed = true;

      clearInterval(timer);

      try {
        res.end();
      } catch {}
    }

  }, 20);

  res.on("drain", () => {
    waitingForDrain = false;
  });

  req.on("close", () => {

    closed = true;

    clearInterval(timer);
  });

  res.on("close", () => {

    closed = true;

    clearInterval(timer);
  });

  res.on("error", () => {

    closed = true;

    clearInterval(timer);
  });
});

// =====================================================
// HEALTH
// =====================================================

app.get("/health", (req, res) => {

  const now = Date.now();

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

    restartCount,

    ffmpegPid: ffmpeg
      ? ffmpeg.pid
      : null,

    videoAgeMs: lastFrameReceivedAt
      ? now - lastFrameReceivedAt
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

      codec: "PCM S16LE",

      sampleRate: AUDIO_SAMPLE_RATE,

      channels: AUDIO_CHANNELS,

      bits: 16,

      chunkMs: 20,

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
  console.log("HLS LIVE / MJPEG / PCM");
  console.log("======================================");

  console.log("Port:", PORT);

  console.log(
    `Video: ${WIDTH}x${HEIGHT} @ ${FPS} FPS`
  );

  console.log("Video: MJPEG");

  console.log(
    `Audio: PCM ${AUDIO_SAMPLE_RATE}Hz Mono 16-bit`
  );

  console.log("Frame cache: 1 frame");

  console.log("Audio cache: 200ms");

  console.log("HLS reconnect: DEMUXER");

  console.log("Watchdog: ON");

  console.log("Video timeout:", VIDEO_TIMEOUT);

  console.log("Auto restart: ON");

  console.log("Disk cache: OFF");

  console.log("======================================");

  // Khởi động watchdog

  startWatchdog();

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
