
const express = require("express");
const { spawn } = require("child_process");

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json());

// =====================================================
// CONFIG
// =====================================================

const M3U_URL =
  "https://iptv-org.github.io/iptv/countries/vn.m3u";

const VIDEO_WIDTH = 320;
const VIDEO_HEIGHT = 180;
const VIDEO_FPS = 8;
const JPEG_QUALITY = 8;
const VIDEO_INTERVAL = Math.round(1000 / VIDEO_FPS);

const AUDIO_SAMPLE_RATE = 16000;
const AUDIO_CHANNELS = 1;
const AUDIO_BYTES_PER_SAMPLE = 2;

// 20ms PCM = 640 bytes
const AUDIO_FRAME_MS = 20;
const AUDIO_FRAME_BYTES =
  AUDIO_SAMPLE_RATE *
  AUDIO_CHANNELS *
  AUDIO_BYTES_PER_SAMPLE *
  AUDIO_FRAME_MS / 1000;

// Chỉ giữ tối đa 100ms audio mới nhất
const AUDIO_BUFFER_MS = 100;
const AUDIO_BUFFER_MAX =
  AUDIO_SAMPLE_RATE *
  AUDIO_CHANNELS *
  AUDIO_BYTES_PER_SAMPLE *
  AUDIO_BUFFER_MS / 1000;

const AUDIO_INTERVAL = AUDIO_FRAME_MS;

// Watchdog
const WATCHDOG_INTERVAL = 5000;
const VIDEO_TIMEOUT = 30000;
const RESTART_DELAY = 3000;

// =====================================================
// GLOBAL STATE
// =====================================================

let channels = [];
let currentChannel = null;

let ffmpeg = null;
let generation = 0;

let latestFrame = null;
let frameSequence = 0;

let audioBuffer = Buffer.alloc(0);

let audioClient = null;
let audioTimer = null;
let audioBlocked = false;
let audioBlockedSince = 0;

let watchdogTimer = null;
let restartTimer = null;

let lastVideoFrameTime = 0;
let restarting = false;

// =====================================================
// M3U PARSER
// =====================================================

function parseM3U(content) {
  const lines = content.split(/\r?\n/);
  const result = [];

  let currentInfo = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    if (!line) continue;

    if (line.startsWith("#EXTINF:")) {
      currentInfo = line;
      continue;
    }

    if (line.startsWith("#")) {
      continue;
    }

    if (!currentInfo) continue;

    const url = line;

    if (!/^https?:\/\//i.test(url)) {
      currentInfo = null;
      continue;
    }

    if (/\.mpd($|\?)/i.test(url)) {
      currentInfo = null;
      continue;
    }

    if (/geo[\s_-]*blocked/i.test(currentInfo)) {
      currentInfo = null;
      continue;
    }

    let name = currentInfo.split(",").pop().trim();

    if (!name) {
      name = "Unknown channel";
    }

    const groupMatch =
      currentInfo.match(/group-title="([^"]*)"/i);

    const logoMatch =
      currentInfo.match(/tvg-logo="([^"]*)"/i);

    const idMatch =
      currentInfo.match(/tvg-id="([^"]*)"/i);

    result.push({
      id: String(result.length),
      name,
      group: groupMatch ? groupMatch[1] : "",
      logo: logoMatch ? logoMatch[1] : "",
      tvgId: idMatch ? idMatch[1] : "",
      url
    });

    currentInfo = null;
  }

  return result;
}

// =====================================================
// LOAD CHANNELS
// =====================================================

async function loadChannels() {
  try {
    console.log("[M3U] Loading playlist...");

    const response = await fetch(M3U_URL, {
      headers: {
        "User-Agent": "Mozilla/5.0"
      },
      signal: AbortSignal.timeout(20000)
    });

    if (!response.ok) {
      throw new Error("HTTP " + response.status);
    }

    const content = await response.text();

    channels = parseM3U(content);

    console.log("--------------------------------");
    console.log("M3U URL:", M3U_URL);
    console.log("TOTAL CHANNELS:", channels.length);
    console.log("--------------------------------");

    return channels;
  } catch (error) {
    console.error("[M3U ERROR]", error.message);
    throw error;
  }
}

// =====================================================
// AUDIO BUFFER
// =====================================================

function clearAudioBuffer() {
  audioBuffer = Buffer.alloc(0);
}

function disconnectAudioClient() {
  if (audioTimer) {
    clearInterval(audioTimer);
    audioTimer = null;
  }

  if (audioClient) {
    try {
      audioClient.destroy();
    } catch (_) {}
  }

  audioClient = null;
  audioBlocked = false;
  audioBlockedSince = 0;

  clearAudioBuffer();
}

function pushAudioBuffer(chunk) {
  if (!chunk || chunk.length === 0) return;

  // PCM 16-bit phải luôn có số byte chẵn
  if (chunk.length % 2 !== 0) {
    chunk = chunk.subarray(0, chunk.length - 1);
  }

  if (chunk.length === 0) return;

  audioBuffer = Buffer.concat([
    audioBuffer,
    chunk
  ]);

  // Không để audio tồn đọng quá 100ms
  if (audioBuffer.length > AUDIO_BUFFER_MAX) {
    const excess =
      audioBuffer.length - AUDIO_BUFFER_MAX;

    const dropBytes = excess + (excess % 2);

    audioBuffer = audioBuffer.subarray(dropBytes);

    console.log(
      "[AUDIO] Dropped old PCM:",
      dropBytes,
      "bytes"
    );
  }
}

function getAudioFrame() {
  if (audioBuffer.length >= AUDIO_FRAME_BYTES) {
    const frame =
      audioBuffer.subarray(0, AUDIO_FRAME_BYTES);

    audioBuffer =
      audioBuffer.subarray(AUDIO_FRAME_BYTES);

    return frame;
  }

  // Không phát lại frame cũ.
  // Nếu thiếu dữ liệu, phần thiếu được điền bằng silence.
  const frame = Buffer.alloc(AUDIO_FRAME_BYTES);

  if (audioBuffer.length > 0) {
    audioBuffer.copy(frame, 0);

    audioBuffer = Buffer.alloc(0);
  }

  return frame;
}

// =====================================================
// AUDIO REAL-TIME OUTPUT
// =====================================================

function startAudioTimer() {
  if (audioTimer) {
    clearInterval(audioTimer);
  }

  audioTimer = setInterval(() => {
    if (!audioClient || audioClient.destroyed) {
      disconnectAudioClient();
      return;
    }

    // Nếu TCP đang nghẽn thì không đẩy thêm dữ liệu
    if (audioBlocked) {
      if (Date.now() - audioBlockedSince > 1000) {
        console.log("[AUDIO] Client too slow, disconnect");

        disconnectAudioClient();
      }

      return;
    }

    const frame = getAudioFrame();

    try {
      const canContinue = audioClient.write(frame);

      if (!canContinue) {
        audioBlocked = true;
        audioBlockedSince = Date.now();

        audioClient.once("drain", () => {
          audioBlocked = false;
          audioBlockedSince = 0;
        });
      }
    } catch (error) {
      console.error("[AUDIO WRITE]", error.message);
      disconnectAudioClient();
    }
  }, AUDIO_INTERVAL);
}

// =====================================================
// VIDEO JPEG PARSER
// =====================================================

let jpegPending = Buffer.alloc(0);

function clearVideoBuffer() {
  jpegPending = Buffer.alloc(0);
  latestFrame = null;
  frameSequence = 0;
}

function processVideoData(chunk, currentGeneration) {
  if (currentGeneration !== generation) return;

  jpegPending = Buffer.concat([
    jpegPending,
    chunk
  ]);

  // Tránh bộ nhớ tăng vô hạn nếu nguồn bị lỗi
  if (jpegPending.length > 4 * 1024 * 1024) {
    const start = jpegPending.lastIndexOf(
      Buffer.from([0xff, 0xd8])
    );

    if (start >= 0) {
      jpegPending = jpegPending.subarray(start);
    } else {
      jpegPending = Buffer.alloc(0);
    }
  }

  while (true) {
    const start = jpegPending.indexOf(
      Buffer.from([0xff, 0xd8])
    );

    if (start < 0) {
      jpegPending = Buffer.alloc(0);
      return;
    }

    const end = jpegPending.indexOf(
      Buffer.from([0xff, 0xd9]),
      start + 2
    );

    if (end < 0) {
      if (start > 0) {
        jpegPending = jpegPending.subarray(start);
      }

      return;
    }

    const jpeg = jpegPending.subarray(
      start,
      end + 2
    );

    latestFrame = Buffer.from(jpeg);

    frameSequence++;

    lastVideoFrameTime = Date.now();

    jpegPending = jpegPending.subarray(end + 2);
  }
}

// =====================================================
// STOP FFMPEG
// =====================================================

function stopFFmpeg() {
  generation++;

  if (watchdogTimer) {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
  }

  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }

  disconnectAudioClient();

  clearVideoBuffer();

  if (ffmpeg) {
    try {
      ffmpeg.kill("SIGKILL");
    } catch (_) {}

    ffmpeg = null;
  }

  restarting = false;
}

// =====================================================
// START FFMPEG
// =====================================================

function startFFmpeg(channel) {
  if (!channel || !channel.url) {
    console.log("[FFMPEG] Invalid channel");
    return;
  }

  stopFFmpeg();

  currentChannel = channel;

  const currentGeneration = generation;

  console.log("");
  console.log("======================================");
  console.log("START CHANNEL:", channel.name);
  console.log("URL:", channel.url);
  console.log("GENERATION:", currentGeneration);
  console.log("VIDEO:", VIDEO_WIDTH + "x" + VIDEO_HEIGHT);
  console.log("FPS:", VIDEO_FPS);
  console.log("AUDIO:", AUDIO_SAMPLE_RATE, "Hz");
  console.log("======================================");

  lastVideoFrameTime = Date.now();

  const args = [
    "-hide_banner",
    "-loglevel", "warning",

    // Reconnect HTTP/HLS
    "-reconnect", "1",
    "-reconnect_streamed", "1",
    "-reconnect_at_eof", "1",
    "-reconnect_delay_max", "5",
    "-rw_timeout", "15000000",

    "-user_agent",
    "Mozilla/5.0",

    "-i", channel.url,

    // =================================
    // VIDEO OUTPUT
    // =================================

    "-map", "0:v:0?",
    "-an",

    "-vf",
    `fps=${VIDEO_FPS},scale=${VIDEO_WIDTH}:${VIDEO_HEIGHT}:force_original_aspect_ratio=decrease,pad=${VIDEO_WIDTH}:${VIDEO_HEIGHT}:(ow-iw)/2:(oh-ih)/2`,

    "-q:v", String(JPEG_QUALITY),
    "-threads", "2",
    "-f", "image2pipe",
    "-vcodec", "mjpeg",
    "pipe:1",

    // =================================
    // AUDIO OUTPUT
    // =================================

    "-map", "0:a:0?",
    "-vn",

    "-af",
    `aresample=${AUDIO_SAMPLE_RATE}:async=1:first_pts=0,asetpts=N/SR/TB`,

    "-ac", String(AUDIO_CHANNELS),
    "-ar", String(AUDIO_SAMPLE_RATE),
    "-c:a", "pcm_s16le",
    "-f", "s16le",
    "pipe:3"
  ];

  ffmpeg = spawn("ffmpeg", args, {
    stdio: [
      "ignore",
      "pipe",
      "pipe",
      "pipe"
    ]
  });

  const processRef = ffmpeg;

  // VIDEO PIPE
  processRef.stdout.on("data", chunk => {
    processVideoData(chunk, currentGeneration);
  });

  // AUDIO PIPE
  if (processRef.stdio[3]) {
    processRef.stdio[3].on("data", chunk => {
      if (currentGeneration !== generation) return;

      pushAudioBuffer(chunk);
    });
  }

  // STDERR
  processRef.stderr.on("data", data => {
    const message = data.toString().trim();

    if (message) {
      console.log("[FFmpeg]", message);
    }
  });

  processRef.on("error", error => {
    console.error("[FFMPEG ERROR]", error.message);
  });

  processRef.on("close", (code, signal) => {
    console.log(
      "[FFmpeg] Exited:",
      code,
      "signal:",
      signal
    );

    if (currentGeneration !== generation) return;

    ffmpeg = null;

    clearAudioBuffer();

    clearVideoBuffer();

    scheduleRestart();
  });

  // WATCHDOG
  watchdogTimer = setInterval(() => {
    if (currentGeneration !== generation) return;

    if (!ffmpeg) return;

    const elapsed =
      Date.now() - lastVideoFrameTime;

    if (elapsed > VIDEO_TIMEOUT) {
      console.log(
        "[WATCHDOG] No video frame:",
        elapsed,
        "ms"
      );

      scheduleRestart();
    }
  }, WATCHDOG_INTERVAL);
}

// =====================================================
// RESTART
// =====================================================

function scheduleRestart() {
  if (restarting) return;

  restarting = true;

  console.log(
    "[RESTART] Restarting in",
    RESTART_DELAY,
    "ms"
  );

  disconnectAudioClient();

  clearVideoBuffer();

  if (watchdogTimer) {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
  }

  if (ffmpeg) {
    const old = ffmpeg;
    ffmpeg = null;

    try {
      old.kill("SIGKILL");
    } catch (_) {}
  }

  if (restartTimer) {
    clearTimeout(restartTimer);
  }

  restartTimer = setTimeout(() => {
    restartTimer = null;
    restarting = false;

    if (currentChannel) {
      startFFmpeg(currentChannel);
    }
  }, RESTART_DELAY);
}

// =====================================================
// VIDEO STREAM
// =====================================================

app.get("/stream", (req, res) => {
  res.writeHead(200, {
    "Content-Type":
      "multipart/x-mixed-replace; boundary=frame",

    "Cache-Control":
      "no-cache, no-store, must-revalidate",

    "Pragma": "no-cache",
    "Connection": "keep-alive"
  });

  let lastSentSequence = -1;
  let blocked = false;
  let blockedSince = 0;

  const timer = setInterval(() => {
    if (res.destroyed) {
      clearInterval(timer);
      return;
    }

    if (blocked) {
      if (Date.now() - blockedSince > 2000) {
        clearInterval(timer);
        res.destroy();
      }

      return;
    }

    if (!latestFrame) return;

    // Không gửi lại frame cũ
    if (frameSequence === lastSentSequence) {
      return;
    }

    const frame = latestFrame;

    lastSentSequence = frameSequence;

    const header =
      "--frame\r\n" +
      "Content-Type: image/jpeg\r\n" +
      "Content-Length: " + frame.length + "\r\n\r\n";

    try {
      const ok1 = res.write(header);
      const ok2 = res.write(frame);
      const ok3 = res.write("\r\n");

      if (!ok1 || !ok2 || !ok3) {
        blocked = true;
        blockedSince = Date.now();

        res.once("drain", () => {
          blocked = false;
          blockedSince = 0;
        });
      }
    } catch (error) {
      clearInterval(timer);
      res.destroy();
    }
  }, VIDEO_INTERVAL);

  req.on("close", () => {
    clearInterval(timer);
  });
});

// =====================================================
// AUDIO STREAM
// =====================================================

app.get("/audio", (req, res) => {
  // Chỉ cho một ESP32 nhận audio tại một thời điểm
  disconnectAudioClient();

  clearAudioBuffer();

  audioClient = res;

  res.statusCode = 200;

  res.setHeader(
    "Content-Type",
    "application/octet-stream"
  );

  res.setHeader(
    "Cache-Control",
    "no-cache, no-store, must-revalidate"
  );

  res.setHeader("Pragma", "no-cache");
  res.setHeader("Connection", "keep-alive");

  // Không nén PCM
  res.setHeader("Content-Encoding", "identity");

  console.log("[AUDIO] Client connected");

  startAudioTimer();

  req.on("close", () => {
    if (audioClient === res) {
      console.log("[AUDIO] Client disconnected");

      disconnectAudioClient();
    }
  });
});

// =====================================================
// API CHANNELS
// =====================================================

app.get("/api/channels", (req, res) => {
  res.json({
    success: true,
    channels
  });
});

// =====================================================
// API SELECT CHANNEL
// =====================================================

app.get("/api/select/:id", (req, res) => {
  const id = decodeURIComponent(req.params.id);

  const channel = channels.find(c =>
    c.id === id ||
    c.name.toLowerCase() === id.toLowerCase()
  );

  if (!channel) {
    return res.status(404).json({
      success: false,
      error: "Channel not found"
    });
  }

  startFFmpeg(channel);

  res.json({
    success: true,
    channel: channel.name
  });
});

app.post("/api/select/:id", (req, res) => {
  const id = decodeURIComponent(req.params.id);

  const channel = channels.find(c =>
    c.id === id ||
    c.name.toLowerCase() === id.toLowerCase()
  );

  if (!channel) {
    return res.status(404).json({
      success: false,
      error: "Channel not found"
    });
  }

  startFFmpeg(channel);

  res.json({
    success: true,
    channel: channel.name
  });
});

// =====================================================
// API STOP
// =====================================================

app.get("/api/stop", (req, res) => {
  stopFFmpeg();

  currentChannel = null;

  res.json({
    success: true,
    message: "Stopped"
  });
});

app.post("/api/stop", (req, res) => {
  stopFFmpeg();

  currentChannel = null;

  res.json({
    success: true,
    message: "Stopped"
  });
});

// =====================================================
// API RELOAD PLAYLIST
// =====================================================

app.get("/api/reload", async (req, res) => {
  try {
    await loadChannels();

    res.json({
      success: true,
      count: channels.length
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// =====================================================
// HEALTH
// =====================================================

app.get("/health", (req, res) => {
  res.json({
    status: "running",

    channelCount: channels.length,

    currentChannel: currentChannel
      ? currentChannel.name
      : null,

    ffmpegRunning: !!ffmpeg,

    videoWidth: VIDEO_WIDTH,
    videoHeight: VIDEO_HEIGHT,
    videoFPS: VIDEO_FPS,

    audioSampleRate: AUDIO_SAMPLE_RATE,
    audioChannels: AUDIO_CHANNELS,
    audioFrameBytes: AUDIO_FRAME_BYTES,
    audioBufferBytes: audioBuffer.length,
    audioBufferMax: AUDIO_BUFFER_MAX,

    audioClientConnected:
      !!audioClient && !audioClient.destroyed,

    generation
  });
});

// =====================================================
// ROOT
// =====================================================

app.get("/", (req, res) => {
  res.send(`
    <h2>IPTV Streaming Server</h2>
    <p>Channels: ${channels.length}</p>
    <p>Video: ${VIDEO_WIDTH}x${VIDEO_HEIGHT} @ ${VIDEO_FPS} FPS</p>
    <p>Audio: ${AUDIO_SAMPLE_RATE}Hz PCM</p>
    <p><a href="/api/channels">Channels</a></p>
    <p><a href="/health">Health</a></p>
  `);
});

// =====================================================
// START SERVER
// =====================================================

async function main() {
  try {
    await loadChannels();
  } catch (error) {
    console.log(
      "[STARTUP] Playlist load failed:",
      error.message
    );
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log("--------------------------------");
    console.log("IPTV SERVER RUNNING");
    console.log("PORT:", PORT);
    console.log("CHANNELS:", channels.length);
    console.log("--------------------------------");
  });
}

main();
