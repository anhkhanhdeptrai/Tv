const express = require("express");
const { spawn } = require("child_process");
const https = require("https");
const http = require("http");

const app = express();
const PORT = process.env.PORT || 10000;

const M3U_URL =
  "https://raw.githubusercontent.com/iptv-org/iptv/master/streams/vn.m3u";

// ==============================
// VIDEO
// ==============================

const WIDTH = 340;
const HEIGHT = 230;
const FPS = 10;

const JPEG_QUALITY = 8;
const FRAME_BUFFER_SIZE = 3;

// ==============================
// AUDIO
// ==============================

const AUDIO_SAMPLE_RATE = 16000;
const AUDIO_CHANNELS = 1;
const AUDIO_BYTES_PER_SAMPLE = 2;

// giữ tối đa khoảng 0.5 giây audio
const AUDIO_BUFFER_MAX =
  AUDIO_SAMPLE_RATE *
  AUDIO_CHANNELS *
  AUDIO_BYTES_PER_SAMPLE *
  0.5;

// ==============================
// NETWORK
// ==============================

const CHECK_TIMEOUT = 7000;

// ==============================
// STATE
// ==============================

let channels = [];

let currentChannel = null;

let ffmpeg = null;
let ffmpegGeneration = 0;

// ==============================
// VIDEO BUFFER
// ==============================

let jpegBuffer = Buffer.alloc(0);

const frames = [];

const JPEG_START = Buffer.from([0xff, 0xd8]);
const JPEG_END = Buffer.from([0xff, 0xd9]);

// ==============================
// AUDIO BUFFER
// ==============================

let audioBuffer = Buffer.alloc(0);

// ==============================
// DOWNLOAD M3U
// ==============================

function downloadM3U(url) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith("https:") ? https : http;

    const request = protocol.get(
      url,
      {
        headers: {
          "User-Agent": "Mozilla/5.0",
          "Accept": "*/*"
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
                `M3U HTTP ${response.statusCode}`
              )
            );

            return;
          }

          resolve(data);
        });
      }
    );

    request.setTimeout(CHECK_TIMEOUT, () => {
      request.destroy(
        new Error("M3U timeout")
      );
    });

    request.on("error", reject);
  });
}

// ==============================
// PARSE M3U
// ==============================

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
      line
        .substring(line.lastIndexOf(",") + 1)
        .trim();

    const tvgId =
      (line.match(
        /tvg-id="([^"]*)"/i
      ) || [])[1] || "";

    const tvgName =
      (line.match(
        /tvg-name="([^"]*)"/i
      ) || [])[1] || "";

    const logo =
      (line.match(
        /tvg-logo="([^"]*)"/i
      ) || [])[1] || "";

    const group =
      (line.match(
        /group-title="([^"]*)"/i
      ) || [])[1] || "";

    let url = "";

    for (
      let j = i + 1;
      j < lines.length;
      j++
    ) {
      if (!lines[j].startsWith("#")) {
        url = lines[j];
        break;
      }
    }

    if (!url) {
      continue;
    }

    if (!name) {
      name =
        tvgName ||
        tvgId ||
        `Channel ${result.length + 1}`;
    }

    // Bỏ geo-blocked
    if (
      line.includes("[Geo-blocked]") ||
      name.includes("[Geo-blocked]")
    ) {
      continue;
    }

    // Bỏ DASH
    if (
      url
        .toLowerCase()
        .includes(".mpd")
    ) {
      continue;
    }

    result.push({
      id: String(result.length),
      name,
      tvgId,
      logo,
      group,
      url
    });
  }

  return result;
}

// ==============================
// CLEAR VIDEO
// ==============================

function clearFrames() {
  frames.length = 0;

  jpegBuffer = Buffer.alloc(0);
}

// ==============================
// CLEAR AUDIO
// ==============================

function clearAudio() {
  audioBuffer = Buffer.alloc(0);
}

// ==============================
// STOP FFMPEG
// ==============================

function stopFFmpeg() {
  // tăng generation trước
  // để dữ liệu process cũ bị vô hiệu hóa
  ffmpegGeneration++;

  const oldFFmpeg = ffmpeg;

  ffmpeg = null;

  if (oldFFmpeg) {
    try {
      oldFFmpeg.kill("SIGKILL");
    } catch {}
  }
}

// ==============================
// START FFMPEG
// ==============================

function startFFmpeg(channel) {
  if (!channel || !channel.url) {
    return false;
  }

  console.log("");
  console.log(
    "================================"
  );
  console.log(
    "PHÁT:",
    channel.name
  );
  console.log(
    "URL:",
    channel.url
  );
  console.log(
    "================================"
  );

  // khóa dữ liệu kênh cũ
  currentChannel = null;

  // dừng process cũ
  stopFFmpeg();

  // xóa frame cũ
  clearFrames();

  // xóa audio cũ
  clearAudio();

  // đặt kênh mới
  currentChannel = channel;

  const generation = ffmpegGeneration;

  /*
   * stdout = video JPEG
   * pipe:3 = audio PCM
   */

  const args = [
    "-hide_banner",

    "-loglevel",
    "warning",

    // reconnect HTTP/HLS
    "-reconnect",
    "1",

    "-reconnect_streamed",
    "1",

    "-reconnect_delay_max",
    "3",

    // input
    "-i",
    channel.url,

    // ==========================
    // VIDEO
    // ==========================

    "-map",
    "0:v:0",

    "-an",

    "-vf",
    `fps=${FPS}:round=down,scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=decrease:flags=fast_bilinear,pad=${WIDTH}:${HEIGHT}:(ow-iw)/2:(oh-ih)/2,format=yuvj420p`,

    "-c:v",
    "mjpeg",

    "-q:v",
    String(JPEG_QUALITY),

    "-threads",
    "2",

    "-pix_fmt",
    "yuvj420p",

    "-fps_mode",
    "cfr",

    "-f",
    "image2pipe",

    "pipe:1",

    // ==========================
    // AUDIO
    // ==========================

    "-map",
    "0:a:0?",

    "-vn",

    "-ac",
    String(AUDIO_CHANNELS),

    "-ar",
    String(AUDIO_SAMPLE_RATE),

    "-c:a",
    "pcm_s16le",

    "-f",
    "s16le",

    "pipe:3"
  ];

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

  // ==============================
  // FFMPEG STDERR
  // ==============================

  processFFmpeg.stderr.on(
    "data",
    data => {
      if (
        generation !==
        ffmpegGeneration
      ) {
        return;
      }

      const message =
        data.toString().trim();

      if (message) {
        console.log(
          "[FFmpeg]",
          message
        );
      }
    }
  );

  // ==============================
  // VIDEO STDOUT
  // ==============================

  processFFmpeg.stdout.on(
    "data",
    chunk => {
      if (
        generation !==
          ffmpegGeneration ||
        processFFmpeg !== ffmpeg
      ) {
        return;
      }

      jpegBuffer = Buffer.concat([
        jpegBuffer,
        chunk
      ]);

      while (true) {
        const start =
          jpegBuffer.indexOf(
            JPEG_START
          );

        if (start === -1) {
          if (
            jpegBuffer.length >
            512 * 1024
          ) {
            jpegBuffer =
              Buffer.alloc(0);
          }

          break;
        }

        if (start > 0) {
          jpegBuffer =
            jpegBuffer.slice(start);
        }

        const end =
          jpegBuffer.indexOf(
            JPEG_END,
            2
          );

        if (end === -1) {
          break;
        }

        const jpeg =
          Buffer.from(
            jpegBuffer.slice(
              0,
              end + 2
            )
          );

        jpegBuffer =
          jpegBuffer.slice(
            end + 2
          );

        if (
          jpeg.length < 100 ||
          jpeg[0] !== 0xff ||
          jpeg[1] !== 0xd8 ||
          jpeg[
            jpeg.length - 2
          ] !== 0xff ||
          jpeg[
            jpeg.length - 1
          ] !== 0xd9
        ) {
          continue;
        }

        frames.push({
          data: jpeg,
          time: Date.now(),
          generation
        });

        // chỉ giữ frame mới
        while (
          frames.length >
          FRAME_BUFFER_SIZE
        ) {
          frames.shift();
        }
      }
    }
  );

  // ==============================
  // AUDIO PIPE
  // ==============================

  processFFmpeg.stdio[3].on(
    "data",
    chunk => {
      if (
        generation !==
          ffmpegGeneration ||
        processFFmpeg !== ffmpeg
      ) {
        return;
      }

      audioBuffer = Buffer.concat([
        audioBuffer,
        chunk
      ]);

      // Không cho audio buffer
      // phình ra gây delay
      if (
        audioBuffer.length >
        AUDIO_BUFFER_MAX
      ) {
        audioBuffer =
          audioBuffer.slice(
            audioBuffer.length -
              AUDIO_BUFFER_MAX
          );
      }
    }
  );

  // ==============================
  // CLOSE
  // ==============================

  processFFmpeg.on(
    "close",
    code => {
      console.log(
        "FFmpeg exited:",
        code
      );

      if (
        generation !==
          ffmpegGeneration ||
        processFFmpeg !== ffmpeg
      ) {
        return;
      }

      ffmpeg = null;

      clearFrames();
      clearAudio();
    }
  );

  processFFmpeg.on(
    "error",
    error => {
      console.log(
        "FFmpeg error:",
        error.message
      );
    }
  );

  return true;
}

// ==================================================
// API CHANNELS
// ==================================================

app.get(
  "/api/channels",
  (req, res) => {
    res.json({
      count: channels.length,

      current:
        currentChannel
          ? currentChannel.id
          : null,

      channels:
        channels.map(
          channel => ({
            id: channel.id,
            name: channel.name,
            group: channel.group,
            logo: channel.logo
          })
        )
    });
  }
);

// ==================================================
// API SELECT
// ==================================================

app.get(
  "/api/select/:id",
  (req, res) => {
    const channel =
      channels.find(
        ch =>
          ch.id ===
          String(req.params.id)
      );

    if (!channel) {
      return res.status(404).json({
        ok: false,
        error:
          "Không tìm thấy kênh"
      });
    }

    const started =
      startFFmpeg(channel);

    if (!started) {
      return res.status(500).json({
        ok: false,
        error:
          "Không thể khởi động FFmpeg"
      });
    }

    res.json({
      ok: true,

      id: channel.id,

      name: channel.name,

      video: "/stream",

      audio: "/audio",

      audioFormat: {
        codec: "PCM S16LE",
        sampleRate:
          AUDIO_SAMPLE_RATE,
        channels:
          AUDIO_CHANNELS,
        bits: 16
      }
    });
  }
);

// ==================================================
// API STOP
// ==================================================

app.get(
  "/api/stop",
  (req, res) => {
    currentChannel = null;

    stopFFmpeg();

    clearFrames();

    clearAudio();

    res.json({
      ok: true,
      message:
        "Đã dừng phát"
    });
  }
);

// ==================================================
// VIDEO MJPEG
// ==================================================

app.get(
  "/stream",
  (req, res) => {
    if (
      !currentChannel ||
      !ffmpeg
    ) {
      return res
        .status(503)
        .send(
          "Chua chon kenh"
        );
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

    res.setHeader(
      "Pragma",
      "no-cache"
    );

    res.setHeader(
      "Connection",
      "keep-alive"
    );

    res.removeHeader(
      "Content-Encoding"
    );

    if (
      typeof res.flushHeaders ===
      "function"
    ) {
      res.flushHeaders();
    }

    let closed = false;

    let waitingForDrain =
      false;

    let lastFrameTime = 0;

    const timer =
      setInterval(() => {
        if (
          closed ||
          res.destroyed
        ) {
          clearInterval(timer);
          return;
        }

        if (
          !currentChannel ||
          !ffmpeg
        ) {
          return;
        }

        if (waitingForDrain) {
          return;
        }

        let frame = null;

        for (
          let i =
            frames.length - 1;
          i >= 0;
          i--
        ) {
          if (
            frames[i]
              .generation ===
            ffmpegGeneration
          ) {
            frame = frames[i];
            break;
          }
        }

        if (!frame) {
          return;
        }

        if (
          frame.time ===
          lastFrameTime
        ) {
          return;
        }

        lastFrameTime =
          frame.time;

        try {
          const header =
            Buffer.from(
              "--frame\r\n" +
                "Content-Type: image/jpeg\r\n" +
                "Content-Length: " +
                frame.data.length +
                "\r\n\r\n"
            );

          res.write(header);

          res.write(
            frame.data
          );

          res.write(
            "\r\n"
          );

          if (
            res.writableNeedDrain
          ) {
            waitingForDrain =
              true;
          }
        } catch {
          closed = true;

          clearInterval(
            timer
          );
        }
      }, 1000 / FPS);

    req.on(
      "close",
      () => {
        closed = true;

        clearInterval(
          timer
        );
      }
    );

    res.on(
      "drain",
      () => {
        waitingForDrain =
          false;
      }
    );
  }
);

// ==================================================
// AUDIO PCM
// ==================================================

app.get(
  "/audio",
  (req, res) => {
    if (
      !currentChannel ||
      !ffmpeg
    ) {
      return res
        .status(503)
        .send(
          "Chua chon kenh"
        );
    }

    res.statusCode = 200;

    /*
     * Raw PCM:
     *
     * signed 16-bit
     * little endian
     * mono
     * 16000 Hz
     */

    res.setHeader(
      "Content-Type",
      "audio/L16"
    );

    res.setHeader(
      "X-Audio-Format",
      "PCM_S16LE"
    );

    res.setHeader(
      "X-Audio-Sample-Rate",
      String(
        AUDIO_SAMPLE_RATE
      )
    );

    res.setHeader(
      "X-Audio-Channels",
      String(
        AUDIO_CHANNELS
      )
    );

    res.setHeader(
      "X-Audio-Bits",
      "16"
    );

    res.setHeader(
      "Cache-Control",
      "no-cache, no-store, must-revalidate"
    );

    res.setHeader(
      "Connection",
      "keep-alive"
    );

    if (
      typeof res.flushHeaders ===
      "function"
    ) {
      res.flushHeaders();
    }

    let closed = false;

    let waitingForDrain =
      false;

    let timer = null;

    function sendAudio() {
      if (
        closed ||
        res.destroyed
      ) {
        return;
      }

      if (
        !currentChannel ||
        !ffmpeg
      ) {
        return;
      }

      if (waitingForDrain) {
        return;
      }

      /*
       * Gửi tối đa 20ms audio
       *
       * 16000 Hz
       * 16 bit
       * mono
       *
       * 20ms =
       * 320 samples
       *
       * 320 * 2 =
       * 640 bytes
       */

      const chunkSize =
        640;

      if (
        audioBuffer.length <
        chunkSize
      ) {
        return;
      }

      const chunk =
        audioBuffer.slice(
          0,
          chunkSize
        );

      audioBuffer =
        audioBuffer.slice(
          chunkSize
        );

      try {
        const ok =
          res.write(chunk);

        if (!ok) {
          waitingForDrain =
            true;
        }
      } catch {
        closed = true;

        if (timer) {
          clearInterval(timer);
        }
      }
    }

    timer = setInterval(
      sendAudio,
      20
    );

    res.on(
      "drain",
      () => {
        waitingForDrain =
          false;
      }
    );

    req.on(
      "close",
      () => {
        closed = true;

        if (timer) {
          clearInterval(timer);
        }
      }
    );

    res.on(
      "close",
      () => {
        closed = true;

        if (timer) {
          clearInterval(timer);
        }
      }
    );
  }
);

// ==================================================
// HEALTH
// ==================================================

app.get(
  "/health",
  (req, res) => {
    res.json({
      status: "ok",

      channels:
        channels.length,

      current:
        currentChannel
          ? {
              id:
                currentChannel.id,

              name:
                currentChannel.name
            }
          : null,

      playing:
        !!ffmpeg,

      video: {
        width: WIDTH,
        height: HEIGHT,
        fps: FPS,
        buffer:
          frames.length,
        endpoint:
          "/stream"
      },

      audio: {
        codec:
          "PCM S16LE",

        sampleRate:
          AUDIO_SAMPLE_RATE,

        channels:
          AUDIO_CHANNELS,

        bits: 16,

        bufferBytes:
          audioBuffer.length,

        endpoint:
          "/audio"
      }
    });
  }
);

// ==================================================
// START SERVER
// ==================================================

app.listen(
  PORT,
  "0.0.0.0",
  async () => {
    console.log("");

    console.log(
      "======================================"
    );

    console.log(
      "ESP32 IPTV MJPEG + AUDIO SERVER"
    );

    console.log(
      "======================================"
    );

    console.log(
      `Port: ${PORT}`
    );

    console.log(
      `Video: ${WIDTH}x${HEIGHT} @ ${FPS} FPS`
    );

    console.log(
      "Video: MJPEG"
    );

    console.log(
      `Audio: PCM S16LE ${AUDIO_SAMPLE_RATE}Hz Mono`
    );

    console.log(
      "Auto play: OFF"
    );

    console.log(
      "Web UI: OFF"
    );

    console.log(
      "======================================"
    );

    try {
      console.log(
        "Đang tải playlist..."
      );

      const m3u =
        await downloadM3U(
          M3U_URL
        );

      channels =
        parseM3U(m3u);

      console.log(
        "Tổng kênh:",
        channels.length
      );

      console.log("");

      console.log(
        "======================================"
      );

      console.log(
        "SERVER READY"
      );

      console.log(
        "Kênh:",
        channels.length
      );

      console.log(
        "Chờ API chọn kênh."
      );

      console.log(
        `Video: http://SERVER:${PORT}/stream`
      );

      console.log(
        `Audio: http://SERVER:${PORT}/audio`
      );

      console.log(
        `API: http://SERVER:${PORT}/api/channels`
      );

      console.log(
        "======================================"
      );
    } catch (error) {
      console.error(
        "LỖI:",
        error.message
      );
    }
  }
);
