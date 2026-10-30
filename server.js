const express = require("express");
const { spawn } = require("child_process");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";

const CHANNELS_URL =
  process.env.CHANNELS_URL ||
  "https://raw.githubusercontent.com/iptv-org/iptv/master/streams/vn.m3u";

const WIDTH = Number(process.env.WIDTH || 340);
const HEIGHT = Number(process.env.HEIGHT || 230);
const FPS = Number(process.env.FPS || 15);
const JPEG_QUALITY = Number(process.env.JPEG_QUALITY || 8);

const AUDIO_RATE = 44100;
const AUDIO_CHANNELS = 1;
const AUDIO_CHUNK_MS = 20;
const AUDIO_CHUNK_SIZE =
  (AUDIO_RATE * AUDIO_CHANNELS * 2 * AUDIO_CHUNK_MS) / 1000;

const FALLBACK_CHANNEL = {
  id: "can-tho-tv1",
  name: "Cần Thơ TV1",
  url: "https://live.canthotv.vn/live/tv/chunklist.m3u8",
};

let channels = [];
let selectedChannel = null;

let generation = 0;
let videoProcess = null;
let audioProcess = null;

let latestFrame = null;
let frameSequence = 0;
let lastVideoFrameAt = 0;
let lastAudioDataAt = 0;

let videoBuffer = Buffer.alloc(0);
let audioBuffer = Buffer.alloc(0);

let videoRestartTimer = null;
let audioRestartTimer = null;
let videoWatchdogTimer = null;

let videoRestartCount = 0;
let audioRestartCount = 0;

const clients = {
  video: new Set(),
  audio: new Set(),
};

const stats = {
  videoFrames: 0,
  videoFps: 0,
  audioBytes: 0,
  videoStartedAt: null,
  audioStartedAt: null,
  lastVideoError: null,
  lastAudioError: null,
};

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function slugify(text) {
  return String(text)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

async function loadChannels() {
  try {
    log("Loading channel list...");

    const response = await fetch(CHANNELS_URL);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const text = await response.text();
    const lines = text.split(/\r?\n/);

    const result = [];
    let currentName = "";

    for (const rawLine of lines) {
      const line = rawLine.trim();

      if (line.startsWith("#EXTINF:")) {
        const comma = line.lastIndexOf(",");
        currentName =
          comma >= 0 ? line.substring(comma + 1).trim() : "Unknown";
      } else if (
        line &&
        !line.startsWith("#") &&
        /^https?:\/\//i.test(line)
      ) {
        const name = currentName || "Unknown channel";

        result.push({
          id: `${slugify(name)}-${result.length}`,
          name,
          url: line,
        });

        currentName = "";
      }
    }

    // Bổ sung kênh Cần Thơ TV1 nếu danh sách không có URL này.
    if (!result.some((item) => item.url === FALLBACK_CHANNEL.url)) {
      result.unshift(FALLBACK_CHANNEL);
    }

    channels = result;

    log(`Loaded ${channels.length} channels`);
    return channels;
  } catch (error) {
    log("Cannot load playlist:", error.message);

    channels = [FALLBACK_CHANNEL];
    return channels;
  }
}

function clearRestartTimers() {
  if (videoRestartTimer) clearTimeout(videoRestartTimer);
  if (audioRestartTimer) clearTimeout(audioRestartTimer);
  if (videoWatchdogTimer) clearTimeout(videoWatchdogTimer);

  videoRestartTimer = null;
  audioRestartTimer = null;
  videoWatchdogTimer = null;
}

function stopChild(child) {
  if (child && !child.killed) {
    try {
      child.kill("SIGTERM");
    } catch (error) {
      log("Cannot stop FFmpeg:", error.message);
    }
  }
}

function stopPipeline() {
  generation++;

  clearRestartTimers();

  stopChild(videoProcess);
  stopChild(audioProcess);

  videoProcess = null;
  audioProcess = null;

  videoBuffer = Buffer.alloc(0);
  audioBuffer = Buffer.alloc(0);

  latestFrame = null;
  lastVideoFrameAt = 0;
  lastAudioDataAt = 0;

  videoRestartCount = 0;
  audioRestartCount = 0;

  stats.videoFps = 0;
  stats.videoStartedAt = null;
  stats.audioStartedAt = null;
}

function armVideoWatchdog(gen) {
  if (videoWatchdogTimer) {
    clearTimeout(videoWatchdogTimer);
  }

  videoWatchdogTimer = setTimeout(() => {
    if (gen !== generation || !selectedChannel) return;

    const elapsed = Date.now() - lastVideoFrameAt;

    if (lastVideoFrameAt && elapsed < 30000) {
      armVideoWatchdog(gen);
      return;
    }

    log("VIDEO WATCHDOG: no frame for 30 seconds");

    stopChild(videoProcess);
    videoProcess = null;

    scheduleRestart("video", gen);
  }, 30000);
}

function scheduleRestart(type, gen) {
  if (gen !== generation || !selectedChannel) return;

  const isVideo = type === "video";
  const currentTimer = isVideo ? videoRestartTimer : audioRestartTimer;

  if (currentTimer) return;

  const attempt = isVideo ? videoRestartCount++ : audioRestartCount++;
  const delay = Math.min(1000 * Math.pow(2, attempt), 15000);

  log(`${type.toUpperCase()}: restarting in ${delay / 1000}s`);

  const timer = setTimeout(() => {
    if (gen !== generation || !selectedChannel) return;

    if (isVideo) {
      videoRestartTimer = null;
      startVideo(gen);
    } else {
      audioRestartTimer = null;
      startAudio(gen);
    }
  }, delay);

  if (isVideo) {
    videoRestartTimer = timer;
  } else {
    audioRestartTimer = timer;
  }
}

function parseJpegFrames(data, gen) {
  if (gen !== generation) return;

  videoBuffer = Buffer.concat([videoBuffer, data]);

  // Không cho bộ đệm tăng vô hạn nếu nguồn bị lỗi.
  if (videoBuffer.length > 5 * 1024 * 1024) {
    const soi = videoBuffer.lastIndexOf(Buffer.from([0xff, 0xd8]));

    if (soi >= 0) {
      videoBuffer = videoBuffer.subarray(soi);
    } else {
      videoBuffer = Buffer.alloc(0);
    }
  }

  const SOI = Buffer.from([0xff, 0xd8]);
  const EOI = Buffer.from([0xff, 0xd9]);

  while (true) {
    const start = videoBuffer.indexOf(SOI);

    if (start < 0) {
      videoBuffer = Buffer.alloc(0);
      return;
    }

    if (start > 0) {
      videoBuffer = videoBuffer.subarray(start);
    }

    const end = videoBuffer.indexOf(EOI, 2);

    if (end < 0) return;

    const frame = videoBuffer.subarray(0, end + 2);
    videoBuffer = videoBuffer.subarray(end + 2);

    latestFrame = frame;
    frameSequence++;

    stats.videoFrames++;
    lastVideoFrameAt = Date.now();

    // Có frame mới thì reset watchdog.
    armVideoWatchdog(gen);
  }
}

function broadcastAudio(data) {
  if (!data || data.length === 0) return;

  audioBuffer = Buffer.concat([audioBuffer, data]);

  // Giới hạn bộ đệm audio tối đa khoảng 1 giây.
  const maxBuffer = AUDIO_RATE * 2 * 2;

  if (audioBuffer.length > maxBuffer) {
    audioBuffer = audioBuffer.subarray(
      audioBuffer.length - maxBuffer
    );
  }

  while (audioBuffer.length >= AUDIO_CHUNK_SIZE) {
    const chunk = audioBuffer.subarray(0, AUDIO_CHUNK_SIZE);
    audioBuffer = audioBuffer.subarray(AUDIO_CHUNK_SIZE);

    for (const client of clients.audio) {
      if (client.destroyed || client.writableEnded) {
        clients.audio.delete(client);
        continue;
      }

      // Client đọc chậm: bỏ chunk cũ, không để hàng đợi tăng vô hạn.
      if (client.writableLength > 65536) {
        continue;
      }

      try {
        client.write(chunk);
      } catch {
        clients.audio.delete(client);
      }
    }
  }
}

function startVideo(gen) {
  if (gen !== generation || !selectedChannel) return;

  const channel = selectedChannel;

  log("======================================");
  log(`START VIDEO: ${channel.name}`);
  log(`URL: ${channel.url}`);
  log("======================================");

  videoBuffer = Buffer.alloc(0);
  lastVideoFrameAt = Date.now();
  stats.videoStartedAt = new Date().toISOString();

  const args = [
    "-hide_banner",
    "-loglevel", "warning",

    // Tự chọn số luồng giải mã.
    "-threads:v", "0",
    "-filter_threads", "2",

    "-rw_timeout", "15000000",
    "-analyzeduration", "5000000",
    "-probesize", "5000000",

    "-i", channel.url,

    "-map", "0:v:0",
    "-an",
    "-sn",
    "-dn",

    "-vf",
    `fps=${FPS},scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=decrease:flags=fast_bilinear,pad=${WIDTH}:${HEIGHT}:(ow-iw)/2:(oh-ih)/2:black,format=yuvj420p`,

    "-c:v", "mjpeg",
    "-q:v", String(JPEG_QUALITY),

    // Luồng encode riêng, không khóa decoder.
    "-threads:v", "2",

    "-flush_packets", "1",
    "-f", "image2pipe",
    "pipe:1",
  ];

  let child;

  try {
    child = spawn(FFMPEG, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    stats.lastVideoError = error.message;
    log("VIDEO SPAWN ERROR:", error.message);
    scheduleRestart("video", gen);
    return;
  }

  videoProcess = child;

  child.stdout.on("data", (data) => {
    if (gen !== generation) return;
    parseJpegFrames(data, gen);
  });

  child.stderr.on("data", (data) => {
    if (gen !== generation) return;

    const message = data.toString().trim();

    if (message) {
      stats.lastVideoError = message;
      log("[FFmpeg VIDEO]", message);
    }
  });

  child.on("error", (error) => {
    if (gen !== generation) return;

    stats.lastVideoError = error.message;
    log("VIDEO PROCESS ERROR:", error.message);
  });

  child.on("close", (code, signal) => {
    if (gen !== generation) return;

    log(`VIDEO FFmpeg exited: code=${code}, signal=${signal}`);

    if (videoProcess === child) {
      videoProcess = null;
    }

    if (videoWatchdogTimer) {
      clearTimeout(videoWatchdogTimer);
      videoWatchdogTimer = null;
    }

    scheduleRestart("video", gen);
  });

  armVideoWatchdog(gen);
}

function startAudio(gen) {
  if (gen !== generation || !selectedChannel) return;

  const channel = selectedChannel;

  log(`START AUDIO: ${channel.name}`);

  audioBuffer = Buffer.alloc(0);
  stats.audioStartedAt = new Date().toISOString();

  const args = [
    "-hide_banner",
    "-loglevel", "warning",

    "-threads:a", "0",
    "-rw_timeout", "15000000",
    "-analyzeduration", "5000000",
    "-probesize", "5000000",

    "-i", channel.url,

    "-map", "0:a:0?",
    "-vn",
    "-sn",
    "-dn",

    "-ac", String(AUDIO_CHANNELS),
    "-ar", String(AUDIO_RATE),

    "-c:a", "pcm_s16le",
    "-flush_packets", "1",
    "-f", "s16le",
    "pipe:1",
  ];

  let child;

  try {
    child = spawn(FFMPEG, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    stats.lastAudioError = error.message;
    log("AUDIO SPAWN ERROR:", error.message);
    scheduleRestart("audio", gen);
    return;
  }

  audioProcess = child;

  child.stdout.on("data", (data) => {
    if (gen !== generation) return;

    lastAudioDataAt = Date.now();
    stats.audioBytes += data.length;
    audioRestartCount = 0;

    broadcastAudio(data);
  });

  child.stderr.on("data", (data) => {
    if (gen !== generation) return;

    const message = data.toString().trim();

    if (message) {
      stats.lastAudioError = message;
      log("[FFmpeg AUDIO]", message);
    }
  });

  child.on("error", (error) => {
    if (gen !== generation) return;

    stats.lastAudioError = error.message;
    log("AUDIO PROCESS ERROR:", error.message);
  });

  child.on("close", (code, signal) => {
    if (gen !== generation) return;

    log(`AUDIO FFmpeg exited: code=${code}, signal=${signal}`);

    if (audioProcess === child) {
      audioProcess = null;
    }

    scheduleRestart("audio", gen);
  });
}

function selectChannel(channel) {
  if (!channel) return false;

  stopPipeline();

  selectedChannel = channel;

  const gen = generation;

  log(`SELECT CHANNEL: ${channel.name}`);

  startVideo(gen);
  startAudio(gen);

  return true;
}

// ===============================
// API: CHANNEL LIST
// ===============================

app.get("/api/channels", (req, res) => {
  res.json({
    success: true,
    count: channels.length,
    channels,
    selected: selectedChannel,
  });
});

// ===============================
// API: SELECT CHANNEL
// ===============================

app.get("/api/select/:id", (req, res) => {
  const channel = channels.find(
    (item) => item.id === req.params.id
  );

  if (!channel) {
    return res.status(404).json({
      success: false,
      error: "Channel not found",
    });
  }

  selectChannel(channel);

  res.json({
    success: true,
    message: "Channel selected",
    channel,
  });
});

// Hỗ trợ cả POST nếu client đang dùng POST.
app.post("/api/select/:id", (req, res) => {
  const channel = channels.find(
    (item) => item.id === req.params.id
  );

  if (!channel) {
    return res.status(404).json({
      success: false,
      error: "Channel not found",
    });
  }

  selectChannel(channel);

  res.json({
    success: true,
    message: "Channel selected",
    channel,
  });
});

// ===============================
// API: STOP
// ===============================

app.get("/api/stop", (req, res) => {
  stopPipeline();
  selectedChannel = null;

  res.json({
    success: true,
    message: "Stopped",
  });
});

app.post("/api/stop", (req, res) => {
  stopPipeline();
  selectedChannel = null;

  res.json({
    success: true,
    message: "Stopped",
  });
});

// ===============================
// MJPEG STREAM
// ===============================

app.get("/stream", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "multipart/x-mixed-replace; boundary=frame",
    "Cache-Control": "no-cache, no-store, must-revalidate",
    Pragma: "no-cache",
    Expires: "0",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });

  let lastSentSequence = -1;

  const timer = setInterval(() => {
    if (res.destroyed || res.writableEnded) {
      clearInterval(timer);
      return;
    }

    if (!latestFrame || frameSequence === lastSentSequence) {
      return;
    }

    // ESP32 đọc chậm thì không xếp hàng frame cũ.
    if (res.writableLength > 512 * 1024) {
      return;
    }

    lastSentSequence = frameSequence;

    try {
      res.write("--frame\r\n");
      res.write("Content-Type: image/jpeg\r\n");
      res.write(`Content-Length: ${latestFrame.length}\r\n\r\n`);
      res.write(latestFrame);
      res.write("\r\n");
    } catch {
      clearInterval(timer);
      res.destroy();
    }
  }, Math.max(10, Math.floor(1000 / FPS)));

  res.on("close", () => {
    clearInterval(timer);
  });
});

// ===============================
// PCM AUDIO STREAM
// ===============================

app.get("/audio", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "application/octet-stream",
    "Cache-Control": "no-cache, no-store, must-revalidate",
    Pragma: "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
    "X-Audio-Format": "S16LE",
    "X-Sample-Rate": String(AUDIO_RATE),
    "X-Channels": String(AUDIO_CHANNELS),
    "X-Bits-Per-Sample": "16",
  });

  clients.audio.add(res);

  res.on("close", () => {
    clients.audio.delete(res);
  });
});

// ===============================
// HEALTH / STATUS
// ===============================

app.get("/health", (req, res) => {
  res.json({
    success: true,
    status: "online",
    uptime: process.uptime(),
    selected: selectedChannel,
    video: {
      running: !!videoProcess && !videoProcess.killed,
      width: WIDTH,
      height: HEIGHT,
      targetFps: FPS,
      frames: stats.videoFrames,
      fps: stats.videoFps,
      lastFrameAgoMs: lastVideoFrameAt
        ? Date.now() - lastVideoFrameAt
        : null,
      clients: 0,
      restartCount: videoRestartCount,
      lastError: stats.lastVideoError,
    },
    audio: {
      running: !!audioProcess && !audioProcess.killed,
      sampleRate: AUDIO_RATE,
      channels: AUDIO_CHANNELS,
      bytes: stats.audioBytes,
      lastDataAgoMs: lastAudioDataAt
        ? Date.now() - lastAudioDataAt
        : null,
      clients: clients.audio.size,
      restartCount: audioRestartCount,
      lastError: stats.lastAudioError,
    },
  });

app.get("/api/status", (req, res) => {
  res.json({
    selected: selectedChannel,
    videoRunning: !!videoProcess && !videoProcess.killed,
    audioRunning: !!audioProcess && !audioProcess.killed,
    videoFps: stats.videoFps,
    frames: stats.videoFrames,
    videoClients: clients.video.size,
    audioClients: clients.audio.size,
    lastVideoFrameAt,
    lastAudioDataAt,
    videoRestartCount,
    audioRestartCount,
    lastVideoError: stats.lastVideoError,
    lastAudioError: stats.lastAudioError,
  });
});

// ===============================
// FPS COUNTER
// ===============================

let previousFrameCount = 0;

setInterval(() => {
  const current = stats.videoFrames;

  stats.videoFps = current - previousFrameCount;
  previousFrameCount = current;
}, 1000);

// ===============================
// START SERVER
// ===============================

async function main() {
  await loadChannels();

  app.listen(PORT, "0.0.0.0", () => {
    log(`Server listening on port ${PORT}`);
    log(`Video: ${WIDTH}x${HEIGHT} @ ${FPS} FPS`);
    log(`Audio: ${AUDIO_RATE} Hz mono S16LE`);
  });

  const defaultChannel =
    channels.find((item) => item.id === "can-tho-tv1") ||
    channels.find((item) =>
      item.name.toLowerCase().includes("cần thơ tv1")
    ) ||
    channels[0];

  if (defaultChannel) {
    selectChannel(defaultChannel);
  }
}

process.on("SIGTERM", () => {
  log("SIGTERM received");
  stopPipeline();
  process.exit(0);
});

process.on("SIGINT", () => {
  log("SIGINT received");
  stopPipeline();
  process.exit(0);
});

main().catch((error) => {
  log("SERVER START ERROR:", error);
  process.exit(1);
});
