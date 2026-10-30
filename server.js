
"use strict";

const express = require("express");
const { spawn } = require("child_process");
const http = require("http");
const https = require("https");

const app = express();

// =====================================================
// CONFIGURATION
// =====================================================

const PORT = process.env.PORT || 10000;

const M3U_URL =
  "https://raw.githubusercontent.com/iptv-org/iptv/master/streams/vn.m3u";

// VIDEO
const WIDTH = 340;
const HEIGHT = 230;
const FPS = 8;
const JPEG_QUALITY = 8;

const MAX_JPEG_SIZE = 2 * 1024 * 1024;

// AUDIO
const AUDIO_SAMPLE_RATE = 44100;
const AUDIO_CHANNELS = 1;
const AUDIO_BITS = 16;

const AUDIO_BYTES_PER_SAMPLE = 2;

const AUDIO_CHUNK_MS = 20;

const AUDIO_CHUNK_SIZE =
  AUDIO_SAMPLE_RATE *
  AUDIO_CHANNELS *
  AUDIO_BYTES_PER_SAMPLE *
  AUDIO_CHUNK_MS / 1000;

// 200ms audio buffer
const AUDIO_BUFFER_MAX =
  AUDIO_SAMPLE_RATE *
  AUDIO_CHANNELS *
  AUDIO_BYTES_PER_SAMPLE *
  0.2;

// NETWORK
const M3U_TIMEOUT = 10000;
const M3U_MAX_SIZE = 10 * 1024 * 1024;

const VIDEO_INTERVAL = 1000 / FPS;

// =====================================================
// EXPRESS
// =====================================================

app.disable("x-powered-by");
app.set("etag", false);

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  next();
});

// =====================================================
// GLOBAL STATE
// =====================================================

let channels = [];

let currentChannel = null;

let ffmpeg = null;

let ffmpegGeneration = 0;

let frameSequence = 0;

let latestFrame = null;

let jpegBuffer = Buffer.alloc(0);

// =====================================================
// AUDIO RING BUFFER
// =====================================================

// Không dùng Buffer.concat liên tục.
// Dùng vòng đệm cố định để giảm cấp phát RAM.

const audioRing = Buffer.alloc(AUDIO_BUFFER_MAX);

let audioWritePosition = 0;

let audioGeneration = 0;

// =====================================================
// STATISTICS
// =====================================================

const stats = {
  videoFrames: 0,
  audioBytes: 0,
  droppedFrames: 0,
  ffmpegErrors: 0,
  startedAt: Date.now()
};

// =====================================================
// M3U DOWNLOAD
// =====================================================

function downloadM3U(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) {
      return reject(
        new Error("Too many redirects")
      );
    }

    let parsed;

    try {
      parsed = new URL(url);
    } catch {
      return reject(
        new Error("Invalid M3U URL")
      );
    }

    const protocol =
      parsed.protocol === "https:"
        ? https
        : http;

    const request = protocol.get(
      parsed,
      {
        headers: {
          "User-Agent": "ESP32-IPTV/2.0",
          "Accept": "*/*"
        }
      },
      response => {
        const status = response.statusCode || 0;

        // Redirect
        if (
          [301, 302, 303, 307, 308].includes(status) &&
          response.headers.location
        ) {
          response.resume();

          const nextURL = new URL(
            response.headers.location,
            parsed
          ).toString();

          return resolve(
            downloadM3U(
              nextURL,
              redirects + 1
            )
          );
        }

        if (status < 200 || status >= 300) {
          response.resume();

          return reject(
            new Error(`M3U HTTP ${status}`)
          );
        }

        let data = "";
        let totalSize = 0;

        response.setEncoding("utf8");

        response.on("data", chunk => {
          totalSize += Buffer.byteLength(chunk);

          if (totalSize > M3U_MAX_SIZE) {
            request.destroy(
              new Error("M3U file too large")
            );

            return;
          }

          data += chunk;
        });

        response.on("end", () => {
          resolve(data);
        });

        response.on("error", reject);
      }
    );

    request.setTimeout(
      M3U_TIMEOUT,
      () => {
        request.destroy(
          new Error("M3U timeout")
        );
      }
    );

    request.on("error", reject);
  });
}

// =====================================================
// M3U PARSER
// =====================================================

function parseM3U(text) {
  const lines = text.split(/\r?\n/);

  const result = [];

  let pendingInfo = null;

  function getAttribute(line, name) {
    const regex = new RegExp(
      name + '="([^"]*)"',
      "i"
    );

    return (line.match(regex) || [])[1] || "";
  }

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (!line) continue;

    if (line.startsWith("#EXTINF")) {
      pendingInfo = {
        line,

        name: line.substring(
          line.lastIndexOf(",") + 1
        ).trim(),

        tvgId: getAttribute(line, "tvg-id"),
        tvgName: getAttribute(line, "tvg-name"),
        logo: getAttribute(line, "tvg-logo"),
        group: getAttribute(line, "group-title")
      };

      continue;
    }

    if (line.startsWith("#")) {
      continue;
    }

    if (!pendingInfo) {
      continue;
    }

    const info = pendingInfo;

    pendingInfo = null;

    const url = line;

    const name =
      info.name ||
      info.tvgName ||
      info.tvgId ||
      `Channel ${result.length + 1}`;

    // Remove geo-blocked channels
    if (
      info.line.toLowerCase().includes("[geo-blocked]") ||
      name.toLowerCase().includes("[geo-blocked]")
    ) {
      continue;
    }

    // DASH unsupported
    if (url.toLowerCase().includes(".mpd")) {
      continue;
    }

    result.push({
      id: String(result.length),
      name,
      tvgId: info.tvgId,
      tvgName: info.tvgName,
      logo: info.logo,
      group: info.group,
      url
    });
  }

  return result;
}

// =====================================================
// CLEAR VIDEO
// =====================================================

function clearVideoBuffer() {
  latestFrame = null;
  jpegBuffer = Buffer.alloc(0);
}

// =====================================================
// CLEAR AUDIO
// =====================================================

function clearAudioBuffer() {
  audioGeneration++;

  audioRing.fill(0);

  audioWritePosition = 0;
}

// =====================================================
// CLEAR EVERYTHING
// =====================================================

function clearAllBuffers() {
  clearVideoBuffer();
  clearAudioBuffer();
}

// =====================================================
// STOP FFMPEG
// =====================================================

function stopFFmpeg() {
  ffmpegGeneration++;

  const oldProcess = ffmpeg;

  ffmpeg = null;
  currentChannel = null;

  clearAllBuffers();

  if (oldProcess) {
    try {
      oldProcess.kill("SIGKILL");
    } catch {}
  }
}

// =====================================================
// AUDIO RING WRITE
// =====================================================

function pushAudio(chunk) {
  if (!chunk || chunk.length === 0) {
    return;
  }

  let data = chunk;

  // Nếu một chunk lớn hơn toàn bộ buffer,
  // chỉ giữ phần mới nhất.
  if (data.length > AUDIO_BUFFER_MAX) {
    const skip =
      data.length - AUDIO_BUFFER_MAX;

    audioWritePosition += skip;

    data = data.subarray(skip);
  }

  const offset =
    audioWritePosition % AUDIO_BUFFER_MAX;

  const firstLength = Math.min(
    data.length,
    AUDIO_BUFFER_MAX - offset
  );

  data.copy(
    audioRing,
    offset,
    0,
    firstLength
  );

  const remaining =
    data.length - firstLength;

  if (remaining > 0) {
    data.copy(
      audioRing,
      0,
      firstLength
    );
  }

  audioWritePosition += data.length;

  stats.audioBytes += data.length;
}

// =====================================================
// AUDIO RING READ
// =====================================================

function readAudio(client) {
  if (
    client.audioGeneration !== audioGeneration
  ) {
    client.audioGeneration = audioGeneration;
    client.audioPosition = audioWritePosition;

    return null;
  }

  let position = client.audioPosition;

  // Client quá chậm: bỏ audio cũ.
  if (
    audioWritePosition - position >
    AUDIO_BUFFER_MAX
  ) {
    position =
      audioWritePosition - AUDIO_BUFFER_MAX;

    // PCM 16-bit phải giữ căn chỉnh sample.
    if (position % 2 !== 0) {
      position++;
    }

    client.audioPosition = position;
  }

  const available =
    audioWritePosition - position;

  if (available < AUDIO_CHUNK_SIZE) {
    return null;
  }

  const output = Buffer.allocUnsafe(
    AUDIO_CHUNK_SIZE
  );

  const offset =
    position % AUDIO_BUFFER_MAX;

  const firstLength = Math.min(
    AUDIO_CHUNK_SIZE,
    AUDIO_BUFFER_MAX - offset
  );

  audioRing.copy(
    output,
    0,
    offset,
    offset + firstLength
  );

  const remaining =
    AUDIO_CHUNK_SIZE - firstLength;

  if (remaining > 0) {
    audioRing.copy(
      output,
      firstLength,
      0,
      remaining
    );
  }

  client.audioPosition += AUDIO_CHUNK_SIZE;

  return output;
}

// =====================================================
// START FFMPEG
// =====================================================

function startFFmpeg(channel) {
  if (!channel || !channel.url) {
    return false;
  }

  console.log("");
  console.log("================================");
  console.log("START CHANNEL:", channel.name);
  console.log("================================");

  // Stop old process
  stopFFmpeg();

  currentChannel = channel;

  const generation = ffmpegGeneration;

  // ===================================================
  // FFMPEG ARGUMENTS
  // ===================================================

  const args = [
    "-hide_banner",
    "-nostdin",
    "-loglevel", "error",

    // Reconnect
    "-reconnect", "1",
    "-reconnect_streamed", "1",
    "-reconnect_delay_max", "3",

    // Timeout
    "-rw_timeout", "15000000",

    // Low latency
    "-fflags", "+genpts+discardcorrupt",
    "-flags", "low_delay",

    // Input
    "-i", channel.url,

    // =================================================
    // VIDEO OUTPUT
    // =================================================

    "-map", "0:v:0",
    "-an",

    "-vf",
    `scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=decrease:flags=fast_bilinear,pad=${WIDTH}:${HEIGHT}:(ow-iw)/2:(oh-ih)/2,fps=${FPS},format=yuvj420p`,

    "-c:v", "mjpeg",
    "-q:v", String(JPEG_QUALITY),
    "-threads", "2",
    "-pix_fmt", "yuvj420p",

    "-fps_mode", "cfr",
    "-flush_packets", "1",

    "-f", "image2pipe",
    "pipe:1",

    // =================================================
    // AUDIO OUTPUT
    // =================================================

    "-map", "0:a:0?",
    "-vn",

    "-ac", String(AUDIO_CHANNELS),
    "-ar", String(AUDIO_SAMPLE_RATE),

    "-c:a", "pcm_s16le",
    "-flush_packets", "1",

    "-f", "s16le",
    "pipe:3"
  ];

  // ===================================================
  // SPAWN
  // ===================================================

  const processFFmpeg = spawn(
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

  ffmpeg = processFFmpeg;

  // ===================================================
  // STDERR
  // ===================================================

  processFFmpeg.stderr.on("data", data => {
    if (
      generation !== ffmpegGeneration ||
      processFFmpeg !== ffmpeg
    ) {
      return;
    }

    const message = data.toString().trim();

    if (message) {
      console.error("[FFmpeg]", message);
    }
  });

  // ===================================================
  // VIDEO PARSER
  // ===================================================

  const JPEG_START = Buffer.from([0xff, 0xd8]);
  const JPEG_END = Buffer.from([0xff, 0xd9]);

  processFFmpeg.stdout.on("data", chunk => {
    if (
      generation !== ffmpegGeneration ||
      processFFmpeg !== ffmpeg
    ) {
      return;
    }

    // Giới hạn parser buffer.
    if (
      jpegBuffer.length + chunk.length >
      MAX_JPEG_SIZE * 2
    ) {
      jpegBuffer = Buffer.alloc(0);
    }

    jpegBuffer = Buffer.concat([
      jpegBuffer,
      chunk
    ]);

    while (jpegBuffer.length >= 4) {
      const start = jpegBuffer.indexOf(
        JPEG_START
      );

      if (start === -1) {
        // Giữ lại byte FF cuối để xử lý marker
        // bị chia giữa hai chunk.
        const keep =
          jpegBuffer[jpegBuffer.length - 1] === 0xff
            ? jpegBuffer.subarray(-1)
            : Buffer.alloc(0);

        jpegBuffer = keep;

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
        if (jpegBuffer.length > MAX_JPEG_SIZE) {
          stats.droppedFrames++;
          jpegBuffer = Buffer.alloc(0);
        }

        break;
      }

      const frameLength = end + 2;

      if (
        frameLength < 100 ||
        frameLength > MAX_JPEG_SIZE
      ) {
        stats.droppedFrames++;

        jpegBuffer = jpegBuffer.subarray(2);

        continue;
      }

      const jpeg = Buffer.from(
        jpegBuffer.subarray(0, frameLength)
      );

      jpegBuffer = jpegBuffer.subarray(
        frameLength
      );

      if (
        jpeg[0] !== 0xff ||
        jpeg[1] !== 0xd8 ||
        jpeg[jpeg.length - 2] !== 0xff ||
        jpeg[jpeg.length - 1] !== 0xd9
      ) {
        stats.droppedFrames++;
        continue;
      }

      // Chỉ giữ frame mới nhất.
      latestFrame = {
        data: jpeg,
        sequence: ++frameSequence,
        time: Date.now(),
        generation
      };

      stats.videoFrames++;
    }
  });

  // ===================================================
  // AUDIO INPUT
  // ===================================================

  processFFmpeg.stdio[3].on("data", chunk => {
    if (
      generation !== ffmpegGeneration ||
      processFFmpeg !== ffmpeg
    ) {
      return;
    }

    pushAudio(chunk);
  });

  // ===================================================
  // ERROR
  // ===================================================

  processFFmpeg.on("error", error => {
    if (generation !== ffmpegGeneration) {
      return;
    }

    stats.ffmpegErrors++;

    console.error(
      "[FFmpeg ERROR]",
      error.message
    );
  });

  // ===================================================
  // CLOSE
  // ===================================================

  processFFmpeg.on("close", code => {
    console.log("FFmpeg exited:", code);

    if (
      generation !== ffmpegGeneration ||
      processFFmpeg !== ffmpeg
    ) {
      return;
    }

    ffmpeg = null;
    currentChannel = null;

    clearAllBuffers();
  });

  return true;
}

// =====================================================
// JSON ERROR
// =====================================================

function jsonError(res, status, message) {
  return res.status(status).json({
    ok: false,
    error: message
  });
}

// =====================================================
// API CHANNELS
// =====================================================

app.get("/api/channels", (req, res) => {
  res.setHeader("Cache-Control", "no-store");

  res.json({
    ok: true,

    count: channels.length,

    current: currentChannel
      ? currentChannel.id
      : null,

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
    return jsonError(
      res,
      404,
      "Không tìm thấy kênh"
    );
  }

  const started = startFFmpeg(channel);

  if (!started) {
    return jsonError(
      res,
      500,
      "Không thể khởi động FFmpeg"
    );
  }

  res.setHeader("Cache-Control", "no-store");

  res.json({
    ok: true,

    id: channel.id,
    name: channel.name,

    video: "/stream",
    audio: "/audio",

    format: {
      video: `${WIDTH}x${HEIGHT} ${FPS}fps`,
      videoCodec: "MJPEG",

      audio: "PCM S16LE",
      sampleRate: AUDIO_SAMPLE_RATE,
      channels: AUDIO_CHANNELS,
      bits: AUDIO_BITS,

      chunkMs: AUDIO_CHUNK_MS
    }
  });
});

// =====================================================
// API STOP
// =====================================================

app.get("/api/stop", (req, res) => {
  stopFFmpeg();

  res.json({
    ok: true,
    message: "Đã dừng phát"
  });
});

// =====================================================
// STREAM HEADERS
// =====================================================

function setStreamHeaders(res, contentType) {
  res.status(200);

  res.setHeader("Content-Type", contentType);

  res.setHeader(
    "Cache-Control",
    "no-cache, no-store, must-revalidate"
  );

  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");

  res.setHeader("Connection", "keep-alive");

  res.setHeader("X-Accel-Buffering", "no");

  res.removeHeader("Content-Encoding");

  if (typeof res.flushHeaders === "function") {
    res.flushHeaders();
  }
}

// =====================================================
// VIDEO MJPEG STREAM
// =====================================================

app.get("/stream", (req, res) => {
  if (!currentChannel || !ffmpeg) {
    return res.status(503).send("Chua chon kenh");
  }

  setStreamHeaders(
    res,
    "multipart/x-mixed-replace; boundary=frame"
  );

  const client = {
    closed: false,
    waitingForDrain: false,
    lastSequence: 0,
    timer: null
  };

  function cleanup() {
    if (client.closed) return;

    client.closed = true;

    clearInterval(client.timer);
  }

  // ===================================================
  // VIDEO LOOP
  // ===================================================

  client.timer = setInterval(() => {
    if (
      client.closed ||
      res.destroyed ||
      res.writableEnded
    ) {
      cleanup();
      return;
    }

    if (
      !currentChannel ||
      !ffmpeg ||
      client.waitingForDrain
    ) {
      return;
    }

    const frame = latestFrame;

    if (!frame) return;

    if (frame.generation !== ffmpegGeneration) {
      return;
    }

    if (frame.sequence === client.lastSequence) {
      return;
    }

    client.lastSequence = frame.sequence;

    // Gộp header + JPEG + CRLF
    // thành một packet.
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

      if (!ok || res.writableNeedDrain) {
        client.waitingForDrain = true;
      }
    } catch {
      cleanup();

      if (!res.destroyed) {
        res.destroy();
      }
    }
  }, VIDEO_INTERVAL);

  // ===================================================
  // BACKPRESSURE
  // ===================================================

  res.on("drain", () => {
    client.waitingForDrain = false;
  });

  req.on("aborted", cleanup);

  res.on("close", cleanup);

  res.on("error", cleanup);
});

// =====================================================
// AUDIO PCM STREAM
// =====================================================

app.get("/audio", (req, res) => {
  if (!currentChannel || !ffmpeg) {
    return res.status(503).send("Chua chon kenh");
  }

  setStreamHeaders(
    res,
    "application/octet-stream"
  );

  res.setHeader(
    "X-Audio-Codec",
    "PCM_S16LE"
  );

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
    "X-Audio-Chunk-Ms",
    String(AUDIO_CHUNK_MS)
  );

  const client = {
    closed: false,
    waitingForDrain: false,

    audioGeneration,
    audioPosition: audioWritePosition,

    timer: null
  };

  // ===================================================
  // AUDIO LOOP
  // ===================================================

  client.timer = setInterval(() => {
    if (
      client.closed ||
      res.destroyed ||
      res.writableEnded
    ) {
      cleanup();
      return;
    }

    if (
      !currentChannel ||
      !ffmpeg ||
      client.waitingForDrain
    ) {
      return;
    }

    const chunk = readAudio(client);

    if (!chunk) return;

    try {
      const ok = res.write(chunk);

      if (!ok || res.writableNeedDrain) {
        client.waitingForDrain = true;
      }
    } catch {
      cleanup();

      if (!res.destroyed) {
        res.destroy();
      }
    }
  }, AUDIO_CHUNK_MS);

  // ===================================================
  // CLEANUP
  // ===================================================

  function cleanup() {
    if (client.closed) return;

    client.closed = true;

    clearInterval(client.timer);
  }

  // ===================================================
  // BACKPRESSURE
  // ===================================================

  res.on("drain", () => {
    client.waitingForDrain = false;
  });

  req.on("aborted", cleanup);

  res.on("close", cleanup);

  res.on("error", cleanup);
});

// =====================================================
// HEALTH API
// =====================================================

app.get("/health", (req, res) => {
  const audioBuffered = Math.min(
    AUDIO_BUFFER_MAX,
    Math.max(
      0,
      audioWritePosition
    )
  );

  res.setHeader("Cache-Control", "no-store");

  res.json({
    status: "ok",

    uptime: Math.floor(
      (Date.now() - stats.startedAt) / 1000
    ),

    channels: channels.length,

    current: currentChannel
      ? {
          id: currentChannel.id,
          name: currentChannel.name
        }
      : null,

    playing: !!ffmpeg,

    generation: ffmpegGeneration,

    memory: {
      latestFrameBytes: latestFrame
        ? latestFrame.data.length
        : 0,

      jpegParserBytes: jpegBuffer.length,

      audioRingBytes: AUDIO_BUFFER_MAX,

      audioBufferedBytes: audioBuffered
    },

    statistics: {
      videoFrames: stats.videoFrames,
      droppedFrames: stats.droppedFrames,
      audioBytes: stats.audioBytes,
      ffmpegErrors: stats.ffmpegErrors
    },

    video: {
      codec: "MJPEG",
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
      bits: AUDIO_BITS,
      chunkMs: AUDIO_CHUNK_MS,
      bufferMs: 200,
      mode: "SHARED RING / INDEPENDENT CLIENT CURSORS",
      endpoint: "/audio"
    }
  });
});

// =====================================================
// 404
// =====================================================

app.use((req, res) => {
  res.status(404).json({
    ok: false,
    error: "API không tồn tại"
  });
});

// =====================================================
// SERVER START
// =====================================================

const server = app.listen(
  PORT,
  "0.0.0.0",
  async () => {
    console.log("");
    console.log("======================================");
    console.log("       ESP32 IPTV STREAM SERVER");
    console.log("======================================");

    console.log("Port:", PORT);
    console.log("Video:", `${WIDTH}x${HEIGHT}`);
    console.log("FPS:", FPS);
    console.log("Codec: MJPEG");
    console.log(
      "Audio: PCM S16LE",
      AUDIO_SAMPLE_RATE,
      "Hz"
    );

    console.log("Audio buffer:", "200ms");
    console.log("Video buffer:", "1 frame");
    console.log("Disk cache: OFF");
    console.log("Auto play: OFF");

    console.log("======================================");

    try {
      console.log("Downloading M3U...");

      const m3u = await downloadM3U(M3U_URL);

      channels = parseM3U(m3u);

      console.log("Channels:", channels.length);

      console.log("");
      console.log("======================================");
      console.log("SERVER READY");
      console.log("======================================");

      console.log(
        `Channels: http://SERVER:${PORT}/api/channels`
      );

      console.log(
        `Select: http://SERVER:${PORT}/api/select/ID`
      );

      console.log(
        `Stop: http://SERVER:${PORT}/api/stop`
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
      console.error(
        "M3U ERROR:",
        error.message
      );
    }
  }
);

// =====================================================
// SERVER TIMEOUTS
// =====================================================

// Không đặt timeout ngắn cho các kết nối stream dài.
server.requestTimeout = 30000;
server.headersTimeout = 35000;
server.keepAliveTimeout = 65000;

// =====================================================
// GRACEFUL SHUTDOWN
// =====================================================

function shutdown(signal) {
  console.log("Shutdown:", signal);

  stopFFmpeg();

  server.close(() => {
    console.log("Server stopped");
    process.exit(0);
  });

  // Bảo vệ khi client stream chưa đóng.
  setTimeout(() => {
    process.exit(1);
  }, 5000).unref();
}

process.on("SIGTERM", () => {
  shutdown("SIGTERM");
});

process.on("SIGINT", () => {
  shutdown("SIGINT");
});
