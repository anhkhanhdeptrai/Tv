const express = require("express");
const { spawn } = require("child_process");
const https = require("https");
const http = require("http");

const app = express();
const PORT = process.env.PORT || 10000;

const M3U_URL =
  "https://raw.githubusercontent.com/iptv-org/iptv/master/streams/vn.m3u";

// =====================================================
// VIDEO
// =====================================================

const WIDTH = 340;
const HEIGHT = 230;
const FPS = 8;

// Chỉ giữ 2 frame mới nhất.
// Không tích lũy frame cũ.
const FRAME_BUFFER_SIZE = 2;

const JPEG_QUALITY = 8;

// =====================================================
// AUDIO
// =====================================================

const AUDIO_SAMPLE_RATE = 41000;
const AUDIO_CHANNELS = 1;
const AUDIO_BYTES_PER_SAMPLE = 2;

// ~100 ms audio
const AUDIO_BUFFER_MAX =
  AUDIO_SAMPLE_RATE *
  AUDIO_CHANNELS *
  AUDIO_BYTES_PER_SAMPLE *
  0.6;

// 20 ms audio mỗi lần gửi
const AUDIO_CHUNK_SIZE =
  AUDIO_SAMPLE_RATE *
  AUDIO_CHANNELS *
  AUDIO_BYTES_PER_SAMPLE *
  0.04;

// =====================================================
// NETWORK
// =====================================================

const M3U_TIMEOUT = 10000;

// =====================================================
// STATE
// =====================================================

let channels = [];

let currentChannel = null;

let ffmpeg = null;

// Generation dùng để loại hoàn toàn dữ liệu
// từ FFmpeg cũ.
let ffmpegGeneration = 0;

// =====================================================
// VIDEO BUFFER
// =====================================================

let jpegBuffer = Buffer.alloc(0);

const frames = [];

const JPEG_START = Buffer.from([
  0xff,
  0xd8
]);

const JPEG_END = Buffer.from([
  0xff,
  0xd9
]);

// =====================================================
// AUDIO BUFFER
// =====================================================

let audioBuffer = Buffer.alloc(0);

// =====================================================
// DOWNLOAD M3U
// =====================================================

function downloadM3U(url) {
  return new Promise((resolve, reject) => {
    const protocol =
      url.startsWith("https:")
        ? https
        : http;

    const request = protocol.get(
      url,
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0",
          "Accept": "*/*"
        }
      },
      response => {
        let data = "";

        response.setEncoding("utf8");

        response.on(
          "data",
          chunk => {
            data += chunk;
          }
        );

        response.on(
          "end",
          () => {
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
          }
        );
      }
    );

    request.setTimeout(
      M3U_TIMEOUT,
      () => {
        request.destroy(
          new Error(
            "M3U timeout"
          )
        );
      }
    );

    request.on(
      "error",
      reject
    );
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

  for (
    let i = 0;
    i < lines.length;
    i++
  ) {
    const line = lines[i];

    if (
      !line.startsWith(
        "#EXTINF"
      )
    ) {
      continue;
    }

    let name =
      line
        .substring(
          line.lastIndexOf(",") + 1
        )
        .trim();

    const tvgId =
      (
        line.match(
          /tvg-id="([^"]*)"/i
        ) || []
      )[1] || "";

    const tvgName =
      (
        line.match(
          /tvg-name="([^"]*)"/i
        ) || []
      )[1] || "";

    const logo =
      (
        line.match(
          /tvg-logo="([^"]*)"/i
        ) || []
      )[1] || "";

    const group =
      (
        line.match(
          /group-title="([^"]*)"/i
        ) || []
      )[1] || "";

    let url = "";

    for (
      let j = i + 1;
      j < lines.length;
      j++
    ) {
      if (
        !lines[j].startsWith("#")
      ) {
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

    // Bỏ Geo-blocked
    if (
      line.includes(
        "[Geo-blocked]"
      ) ||
      name.includes(
        "[Geo-blocked]"
      )
    ) {
      continue;
    }

    // Không hỗ trợ DASH
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
      tvgName,
      logo,
      group,
      url
    });
  }

  return result;
}

// =====================================================
// CLEAR VIDEO
// =====================================================

function clearVideoBuffer() {
  frames.length = 0;
  jpegBuffer = Buffer.alloc(0);
}

// =====================================================
// CLEAR AUDIO
// =====================================================

function clearAudioBuffer() {
  audioBuffer = Buffer.alloc(0);
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
  // Vô hiệu hóa ngay dữ liệu của process cũ.
  ffmpegGeneration++;

  const oldFFmpeg = ffmpeg;

  ffmpeg = null;

  if (oldFFmpeg) {
    try {
      oldFFmpeg.kill(
        "SIGKILL"
      );
    } catch {}
  }

  clearAllBuffers();
}

// =====================================================
// START FFMPEG
// =====================================================

function startFFmpeg(channel) {
  if (
    !channel ||
    !channel.url
  ) {
    return false;
  }

  console.log("");
  console.log(
    "======================================"
  );
  console.log(
    "START CHANNEL:",
    channel.name
  );
  console.log(
    "URL:",
    channel.url
  );
  console.log(
    "======================================"
  );

  // ---------------------------------------------------
  // Xóa hoàn toàn kênh cũ trước khi mở kênh mới
  // ---------------------------------------------------

  currentChannel = null;

  stopFFmpeg();

  currentChannel = channel;

  const generation =
    ffmpegGeneration;

  // ---------------------------------------------------
  // FFMPEG
  // ---------------------------------------------------

  const args = [
    "-hide_banner",

    "-loglevel",
    "warning",

    // HTTP/HLS reconnect
    "-reconnect",
    "1",

    "-reconnect_streamed",
    "1",

    "-reconnect_delay_max",
    "3",

    // Input
    "-i",
    channel.url,

    // =================================================
    // VIDEO OUTPUT
    // =================================================

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

    // =================================================
    // AUDIO OUTPUT
    // =================================================

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

  const processFFmpeg =
    spawn(
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

  ffmpeg =
    processFFmpeg;

  // =================================================
  // STDERR
  // =================================================

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
        data
          .toString()
          .trim();

      if (message) {
        console.log(
          "[FFmpeg]",
          message
        );
      }
    }
  );

  // =================================================
  // VIDEO
  // =================================================

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

      jpegBuffer =
        Buffer.concat([
          jpegBuffer,
          chunk
        ]);

      while (true) {
        const start =
          jpegBuffer.indexOf(
            JPEG_START
          );

        if (start === -1) {
          // Không cho parser phình RAM
          if (
            jpegBuffer.length >
            512 * 1024
          ) {
            jpegBuffer =
              Buffer.alloc(0);
          }

          break;
        }

        // Bỏ dữ liệu trước JPEG
        if (start > 0) {
          jpegBuffer =
            jpegBuffer.slice(
              start
            );
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

        // Kiểm tra JPEG
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

        // ------------------------------------------------
        // Chỉ giữ frame mới
        // ------------------------------------------------

        frames.push({
          data: jpeg,
          time: Date.now(),
          generation
        });

        while (
          frames.length >
          FRAME_BUFFER_SIZE
        ) {
          frames.shift();
        }
      }
    }
  );

  // =================================================
  // AUDIO
  // =================================================

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

      audioBuffer =
        Buffer.concat([
          audioBuffer,
          chunk
        ]);

      // ------------------------------------------------
      // QUAN TRỌNG:
      // Không bao giờ để audio buffer tăng vô hạn.
      // Chỉ giữ ~100ms gần nhất.
      // ------------------------------------------------

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

  // =================================================
  // PROCESS CLOSE
  // =================================================

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

      clearAllBuffers();
    }
  );

  // =================================================
  // PROCESS ERROR
  // =================================================

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

// =====================================================
// API CHANNELS
// =====================================================

app.get(
  "/api/channels",
  (req, res) => {
    res.json({
      count:
        channels.length,

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

// =====================================================
// API SELECT
// =====================================================

app.get(
  "/api/select/:id",
  (req, res) => {
    const channel =
      channels.find(
        ch =>
          ch.id ===
          String(
            req.params.id
          )
      );

    if (!channel) {
      return res
        .status(404)
        .json({
          ok: false,
          error:
            "Không tìm thấy kênh"
        });
    }

    const started =
      startFFmpeg(channel);

    if (!started) {
      return res
        .status(500)
        .json({
          ok: false,
          error:
            "Không thể khởi động FFmpeg"
        });
    }

    res.json({
      ok: true,

      id: channel.id,

      name: channel.name,

      video:
        "/stream",

      audio:
        "/audio",

      format: {
        video:
          `${WIDTH}x${HEIGHT} ${FPS}fps`,

        audio:
          "PCM S16LE",

        sampleRate:
          AUDIO_SAMPLE_RATE,

        channels:
          AUDIO_CHANNELS,

        bits:
          16
      }
    });
  }
);

// =====================================================
// API STOP
// =====================================================

app.get(
  "/api/stop",
  (req, res) => {
    currentChannel =
      null;

    stopFFmpeg();

    clearAllBuffers();

    res.json({
      ok: true,
      message:
        "Đã dừng phát"
    });
  }
);

// =====================================================
// VIDEO MJPEG
// =====================================================

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
      setInterval(
        () => {
          if (
            closed ||
            res.destroyed
          ) {
            clearInterval(
              timer
            );
            return;
          }

          if (
            !currentChannel ||
            !ffmpeg
          ) {
            return;
          }

          if (
            waitingForDrain
          ) {
            return;
          }

          // Luôn lấy frame mới nhất
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
              frame =
                frames[i];
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
        },
        1000 / FPS
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

        clearInterval(
          timer
        );
      }
    );

    res.on(
      "close",
      () => {
        closed = true;

        clearInterval(
          timer
        );
      }
    );
  }
);

// =====================================================
// AUDIO PCM
// =====================================================

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
     * PCM S16LE
     *
     * 16000 Hz
     * Mono
     * 16 bit
     */

    res.setHeader(
      "Content-Type",
      "application/octet-stream"
    );

    res.setHeader(
      "X-Audio-Codec",
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
      "Pragma",
      "no-cache"
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

    const timer =
      setInterval(
        () => {
          if (
            closed ||
            res.destroyed
          ) {
            clearInterval(
              timer
            );
            return;
          }

          if (
            !currentChannel ||
            !ffmpeg
          ) {
            return;
          }

          if (
            waitingForDrain
          ) {
            return;
          }

          if (
            audioBuffer.length <
            AUDIO_CHUNK_SIZE
          ) {
            return;
          }

          // Lấy audio mới nhất
          const chunk =
            audioBuffer.slice(
              0,
              AUDIO_CHUNK_SIZE
            );

          audioBuffer =
            audioBuffer.slice(
              AUDIO_CHUNK_SIZE
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

            clearInterval(
              timer
            );
          }
        },
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

        clearInterval(
          timer
        );
      }
    );

    res.on(
      "close",
      () => {
        closed = true;

        clearInterval(
          timer
        );
      }
    );
  }
);

// =====================================================
// HEALTH
// =====================================================

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

      memory: {
        videoFrames:
          frames.length,

        videoBufferBytes:
          jpegBuffer.length,

        audioBufferBytes:
          audioBuffer.length,

        audioBufferMax:
          AUDIO_BUFFER_MAX
      },

      video: {
        width: WIDTH,
        height: HEIGHT,
        fps: FPS,
        quality:
          JPEG_QUALITY,
        buffer:
          FRAME_BUFFER_SIZE,
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
        endpoint:
          "/audio"
      }
    });
  }
);

// =====================================================
// SERVER
// =====================================================

app.listen(
  PORT,
  "0.0.0.0",
  async () => {
    console.log("");

    console.log(
      "======================================"
    );

    console.log(
      "ESP32 IPTV SERVER"
    );

    console.log(
      "LOW CACHE / LOW LATENCY"
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
      `Audio: PCM ${AUDIO_SAMPLE_RATE}Hz Mono 16-bit`
    );

    console.log(
      "Disk cache: OFF"
    );

    console.log(
      "HLS cache: OFF"
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
        "Channels:",
        channels.length
      );

      console.log(
        "Chưa phát kênh nào."
      );

      console.log(
        `API: http://SERVER:${PORT}/api/channels`
      );

      console.log(
        `Video: http://SERVER:${PORT}/stream`
      );

      console.log(
        `Audio: http://SERVER:${PORT}/audio`
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
