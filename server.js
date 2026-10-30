const express = require("express");
const { spawn } = require("child_process");
const https = require("https");
const http = require("http");

const app = express();

const PORT = process.env.PORT || 10000;

// =====================================================
// IPTV PLAYLIST
// =====================================================

const M3U_URL =
  "https://raw.githubusercontent.com/iptv-org/iptv/master/streams/vn.m3u";

// =====================================================
// ESP32 MJPEG CONFIG
// =====================================================

const WIDTH = 340;
const HEIGHT = 230;
const FPS = 10;

// Chỉ giữ khoảng 1 giây frame.
// Không để buffer dài vì sẽ gây delay.
const FRAME_BUFFER_SIZE = 10;

// JPEG quality.
// 8 = chất lượng vừa, kích thước khá nhỏ.
const JPEG_QUALITY = 8;

// =====================================================
// STREAM CHECK
// =====================================================

const CHECK_TIMEOUT = 7000;
const CHECK_CONCURRENCY = 6;

// =====================================================
// GLOBAL
// =====================================================

let channels = [];

let currentChannel = null;

let ffmpeg = null;
let ffmpegGeneration = 0;

let jpegBuffer = Buffer.alloc(0);

const frames = [];

const JPEG_START = Buffer.from([0xff, 0xd8]);
const JPEG_END = Buffer.from([0xff, 0xd9]);

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

    request.setTimeout(
      CHECK_TIMEOUT,
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

    if (!line.startsWith("#EXTINF")) {
      continue;
    }

    let name =
      line
        .substring(
          line.lastIndexOf(",") + 1
        )
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

    if (!url) continue;

    if (!name) {
      name =
        tvgName ||
        tvgId ||
        `Channel ${result.length + 1}`;
    }

    // Bỏ Geo-blocked
    if (
      line.includes("[Geo-blocked]") ||
      name.includes("[Geo-blocked]")
    ) {
      continue;
    }

    // Bỏ DASH
    if (
      url.toLowerCase().includes(".mpd")
    ) {
      continue;
    }

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
      parsed.protocol === "https:"
        ? https
        : http;

    const request = protocol.get(

      parsed,

      {
        headers: {
          "User-Agent":
            "Mozilla/5.0",

          "Accept":
            "*/*",

          "Connection":
            "close",

          "Range":
            "bytes=0-2047"
        }
      },

      response => {

        const status =
          response.statusCode || 0;

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

        if (
          status >= 300 &&
          status < 400
        ) {

          response.destroy();

          done({
            ok: true,
            status,
            error: null
          });

          return;
        }

        if (
          status === 200 ||
          status === 206
        ) {

          let received = 0;

          response.on(
            "data",
            chunk => {

              received +=
                chunk.length;

              if (
                received >= 2048
              ) {

                response.destroy();

                done({
                  ok: true,
                  status,
                  error: null
                });
              }
            }
          );

          response.on(
            "end",
            () => {

              done({
                ok: true,
                status,
                error: null
              });
            }
          );

          return;
        }

        response.destroy();

        done({
          ok: false,
          status,
          error:
            `HTTP ${status}`
        });
      }
    );

    request.setTimeout(
      CHECK_TIMEOUT,
      () => {

        request.destroy();

        done({
          ok: false,
          status: 0,
          error: "TIMEOUT"
        });
      }
    );

    request.on(
      "error",
      error => {

        done({
          ok: false,
          status: 0,
          error: error.message
        });
      }
    );
  });
}

// =====================================================
// CHECK CHANNELS
// =====================================================

async function checkChannels(list) {

  console.log(
    `Kiểm tra ${list.length} stream...`
  );

  let index = 0;

  const valid = [];

  async function worker() {

    while (true) {

      const i = index++;

      if (i >= list.length) {
        return;
      }

      const channel = list[i];

      console.log(
        `[${i + 1}/${list.length}] ${channel.name}`
      );

      const result =
        await checkStream(channel.url);

      if (result.ok) {

        channel.available = true;

        channel.error = null;

        valid.push(channel);

        console.log(
          "  OK"
        );

      } else {

        channel.available = false;

        channel.error =
          result.error;

        console.log(
          "  FAIL:",
          result.error
        );
      }
    }
  }

  const workers = [];

  for (
    let i = 0;
    i < CHECK_CONCURRENCY;
    i++
  ) {
    workers.push(worker());
  }

  await Promise.all(workers);

  // Sắp lại ID
  valid.forEach(
    (channel, i) => {
      channel.id =
        String(i);
    }
  );

  return valid;
}

// =====================================================
// CLEAR FRAME BUFFER
// =====================================================

function clearFrames() {

  frames.length = 0;

  jpegBuffer =
    Buffer.alloc(0);
}

// =====================================================
// STOP FFMPEG
// =====================================================

function stopFFmpeg() {

  // Vô hiệu hóa toàn bộ dữ liệu
  // từ process cũ.
  ffmpegGeneration++;

  const oldFFmpeg =
    ffmpeg;

  ffmpeg = null;

  if (oldFFmpeg) {

    try {
      oldFFmpeg.kill(
        "SIGKILL"
      );
    } catch {}
  }
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

  // =============================================
  // DỪNG KÊNH CŨ
  // =============================================

  currentChannel = null;

  stopFFmpeg();

  clearFrames();

  // =============================================
  // KÊNH MỚI
  // =============================================

  currentChannel =
    channel;

  const generation =
    ffmpegGeneration;

  // =============================================
  // FFMPEG
  // =============================================

  ffmpeg = spawn(
    "ffmpeg",
    [

      "-hide_banner",

      "-loglevel",
      "warning",

      // =====================================
      // NETWORK
      // =====================================

      "-reconnect",
      "1",

      "-reconnect_streamed",
      "1",

      "-reconnect_delay_max",
      "3",

      // =====================================
      // INPUT
      // =====================================

      "-i",
      channel.url,

      // =====================================
      // VIDEO
      // =====================================

      "-an",

      "-vf",

      `fps=${FPS}:round=down,` +
      `scale=${WIDTH}:${HEIGHT}:` +
      `force_original_aspect_ratio=decrease:` +
      `flags=fast_bilinear,` +
      `pad=${WIDTH}:${HEIGHT}:` +
      `(ow-iw)/2:(oh-ih)/2,` +
      `format=yuvj420p`,

      // =====================================
      // MJPEG
      // =====================================

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

      // =====================================
      // OUTPUT
      // =====================================

      "-f",
      "image2pipe",

      "pipe:1"
    ]
  );

  const processFFmpeg =
    ffmpeg;

  // =============================================
  // STDERR
  // =============================================

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

  // =============================================
  // JPEG DATA
  // =============================================

  processFFmpeg.stdout.on(
    "data",
    chunk => {

      // Process cũ -> bỏ ngay.
      if (
        generation !==
          ffmpegGeneration ||
        processFFmpeg !==
          ffmpeg
      ) {
        return;
      }

      jpegBuffer =
        Buffer.concat([
          jpegBuffer,
          chunk
        ]);

      while (true) {

        // Tìm đầu JPEG
        const start =
          jpegBuffer.indexOf(
            JPEG_START
          );

        if (start === -1) {

          // Không để buffer phình.
          if (
            jpegBuffer.length >
            512 * 1024
          ) {

            jpegBuffer =
              Buffer.alloc(0);
          }

          break;
        }

        // Bỏ dữ liệu rác trước JPEG.
        if (start > 0) {

          jpegBuffer =
            jpegBuffer.slice(
              start
            );
        }

        // Tìm cuối JPEG.
        const end =
          jpegBuffer.indexOf(
            JPEG_END,
            2
          );

        if (end === -1) {
          break;
        }

        // Lấy nguyên frame JPEG.
        const jpeg =
          Buffer.from(
            jpegBuffer.slice(
              0,
              end + 2
            )
          );

        // Xóa frame khỏi buffer.
        jpegBuffer =
          jpegBuffer.slice(
            end + 2
          );

        // Kiểm tra JPEG.
        if (
          jpeg.length < 100 ||
          jpeg[0] !== 0xff ||
          jpeg[1] !== 0xd8 ||
          jpeg[jpeg.length - 2] !== 0xff ||
          jpeg[jpeg.length - 1] !== 0xd9
        ) {
          continue;
        }

        // =====================================
        // CHỈ GIỮ FRAME MỚI
        // =====================================

        frames.push({

          data: jpeg,

          time: Date.now(),

          generation
        });

        // Không giữ quá nhiều.
        while (
          frames.length >
          FRAME_BUFFER_SIZE
        ) {

          frames.shift();
        }
      }
    }
  );

  // =============================================
  // CLOSE
  // =============================================

  processFFmpeg.on(
    "close",
    code => {

      console.log(
        "FFmpeg exited:",
        code
      );

      // Process cũ -> bỏ qua.
      if (
        generation !==
          ffmpegGeneration ||
        processFFmpeg !==
          ffmpeg
      ) {
        return;
      }

      ffmpeg = null;

      clearFrames();

      // Không tự restart.
    }
  );

  return true;
}

// =====================================================
// API - CHANNEL LIST
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

            id:
              channel.id,

            name:
              channel.name,

            group:
              channel.group,

            logo:
              channel.logo
          })
        )
    });
  }
);

// =====================================================
// API - SELECT
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

    startFFmpeg(channel);

    res.json({

      ok: true,

      id:
        channel.id,

      name:
        channel.name,

      stream:
        "/stream"
    });
  }
);

// =====================================================
// API - STOP
// =====================================================

app.get(
  "/api/stop",
  (req, res) => {

    currentChannel = null;

    stopFFmpeg();

    clearFrames();

    res.json({

      ok: true,

      message:
        "Đã dừng phát"
    });
  }
);

// =====================================================
// MJPEG STREAM FOR ESP32
// =====================================================

app.get(
  "/stream",
  (req, res) => {

    // =========================================
    // KHÔNG CÓ KÊNH
    // =========================================

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

    // =========================================
    // MJPEG HEADERS
    // =========================================

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

    // Không nén.
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

    // =========================================
    // CLIENT DISCONNECT
    // =========================================

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

    // =========================================
    // SEND LOOP
    // =========================================

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

          // ===================================
          // LẤY FRAME MỚI NHẤT
          // ===================================

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

          // Không gửi lại frame.
          if (
            frame.time ===
            lastFrameTime
          ) {

            return;
          }

          lastFrameTime =
            frame.time;

          // ===================================
          // SEND
          // ===================================

          try {

            const header =
              Buffer.from(

                "--frame\r\n" +

                "Content-Type: image/jpeg\r\n" +

                "Content-Length: " +
                frame.data.length +
                "\r\n\r\n"
              );

            res.write(
              header
            );

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

        // 10 FPS
        1000 / FPS
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

      status:
        "ok",

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

      mjpeg: {

        width:
          WIDTH,

        height:
          HEIGHT,

        fps:
          FPS,

        buffer:
          frames.length,

        endpoint:
          "/stream"
      }
    });
  }
);

// =====================================================
// START SERVER
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
      "ESP32 IPTV MJPEG SERVER"
    );

    console.log(
      "======================================"
    );

    console.log(
      `Port: ${PORT}`
    );

    console.log(
      `MJPEG: ${WIDTH}x${HEIGHT}`
    );

    console.log(
      `FPS: ${FPS}`
    );

    console.log(
      "Auto play: OFF"
    );

    console.log(
      "Web UI: OFF"
    );

    console.log(
      "HLS: OFF"
    );

    console.log(
      "Audio: OFF"
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

      const allChannels =
        parseM3U(m3u);

      console.log(
        "Tổng kênh:",
        allChannels.length
      );

      channels =
        await checkChannels(
          allChannels
        );

      console.log("");
      console.log(
        "======================================"
      );

      console.log(
        "SERVER READY"
      );

      console.log(
        "Kênh khả dụng:",
        channels.length
      );

      console.log(
        "Chờ API chọn kênh."
      );

      console.log(
        `MJPEG: http://SERVER:${PORT}/stream`
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
