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
const JPEG_QUALITY = 8;

// Buffer tối đa.
// Không bao giờ cho video tích quá số frame này.
const VIDEO_BUFFER_SECONDS = 5;

const VIDEO_MAX_FRAMES =
  FPS * VIDEO_BUFFER_SECONDS;

// Khi backlog quá lớn, bỏ frame cũ.
// Mục tiêu là luôn ở gần live.
const VIDEO_KEEP_SECONDS = 4;

const VIDEO_KEEP_FRAMES =
  FPS * VIDEO_KEEP_SECONDS;

// =====================================================
// AUDIO
// =====================================================

const AUDIO_SAMPLE_RATE = 44100;
const AUDIO_CHANNELS = 1;
const AUDIO_BYTES_PER_SAMPLE = 2;

// Buffer audio tối đa 5 giây.
const AUDIO_BUFFER_SECONDS = 5;

const AUDIO_BUFFER_MAX =
  AUDIO_SAMPLE_RATE *
  AUDIO_CHANNELS *
  AUDIO_BYTES_PER_SAMPLE *
  AUDIO_BUFFER_SECONDS;

// Phát PCM 20ms/lần.
const AUDIO_CHUNK_MS = 20;

const AUDIO_CHUNK_SIZE =
  Math.floor(
    AUDIO_SAMPLE_RATE *
      AUDIO_CHANNELS *
      AUDIO_BYTES_PER_SAMPLE *
      AUDIO_CHUNK_MS /
      1000
  );

// Giữ khoảng 4 giây khi cần drop cache cũ.
const AUDIO_KEEP_SECONDS = 4;

const AUDIO_KEEP_BYTES =
  AUDIO_SAMPLE_RATE *
  AUDIO_CHANNELS *
  AUDIO_BYTES_PER_SAMPLE *
  AUDIO_KEEP_SECONDS;

// =====================================================
// PREBUFFER
// =====================================================

// Không phát ngay khi FFmpeg mới bắt đầu.
// Chờ khoảng 5 giây dữ liệu.
const PREBUFFER_SECONDS = 5;

const PREBUFFER_VIDEO_FRAMES =
  VIDEO_MAX_FRAMES;

const PREBUFFER_AUDIO_BYTES =
  AUDIO_BUFFER_MAX;

// =====================================================
// BACKPRESSURE
// =====================================================

const MAX_BACKPRESSURE = 20;

// =====================================================
// STATE
// =====================================================

let channels = [];

let currentChannel = null;

let ffmpeg = null;

let generation = 0;

// =====================================================
// VIDEO RING BUFFER
// =====================================================

const videoRing =
  new Array(VIDEO_MAX_FRAMES);

let videoWrite = 0;
let videoCount = 0;

// =====================================================
// AUDIO RING BUFFER
// =====================================================

const audioRing =
  Buffer.alloc(AUDIO_BUFFER_MAX);

let audioWrite = 0;
let audioRead = 0;
let audioSize = 0;

// =====================================================
// PARSER
// =====================================================

let jpegBuffer =
  Buffer.alloc(0);

let audioInputBuffer =
  Buffer.alloc(0);

const JPEG_START =
  Buffer.from([0xff, 0xd8]);

const JPEG_END =
  Buffer.from([0xff, 0xd9]);

// =====================================================
// VIDEO RESET
// =====================================================

function clearVideo() {
  for (
    let i = 0;
    i < videoRing.length;
    i++
  ) {
    videoRing[i] = null;
  }

  videoWrite = 0;
  videoCount = 0;
}

// =====================================================
// AUDIO RESET
// =====================================================

function clearAudio() {
  audioWrite = 0;
  audioRead = 0;
  audioSize = 0;

  audioInputBuffer =
    Buffer.alloc(0);
}

// =====================================================
// CLEAR ALL
// =====================================================

function clearBuffers() {
  clearVideo();
  clearAudio();

  jpegBuffer =
    Buffer.alloc(0);
}

// =====================================================
// VIDEO PUSH
// =====================================================

function pushVideo(frame) {
  if (!frame) {
    return;
  }

  // Buffer đầy:
  // ghi đè frame cũ nhất.
  videoRing[videoWrite] =
    frame;

  videoWrite =
    (
      videoWrite + 1
    ) %
    VIDEO_MAX_FRAMES;

  if (
    videoCount <
    VIDEO_MAX_FRAMES
  ) {
    videoCount++;
  }
}

// =====================================================
// VIDEO OLDEST INDEX
// =====================================================

function videoOldestIndex() {
  return (
    videoWrite -
    videoCount +
    VIDEO_MAX_FRAMES
  ) %
  VIDEO_MAX_FRAMES;
}

// =====================================================
// VIDEO POP
// =====================================================

function popVideo() {
  if (
    videoCount <= 0
  ) {
    return null;
  }

  const index =
    videoOldestIndex();

  const frame =
    videoRing[index];

  videoRing[index] =
    null;

  videoCount--;

  return frame;
}

// =====================================================
// DROP VIDEO OLD CACHE
// =====================================================

function dropOldVideo() {
  while (
    videoCount >
    VIDEO_KEEP_FRAMES
  ) {
    popVideo();
  }
}

// =====================================================
// AUDIO PUSH
// =====================================================

function pushAudio(data) {
  if (
    !data ||
    data.length === 0
  ) {
    return;
  }

  let offset = 0;

  while (
    offset <
    data.length
  ) {
    const remaining =
      data.length - offset;

    // Nếu một chunk lớn hơn toàn bộ ring,
    // chỉ lấy phần cuối.
    if (
      remaining >=
      AUDIO_BUFFER_MAX
    ) {
      data.copy(
        audioRing,
        0,
        data.length -
          AUDIO_BUFFER_MAX
      );

      audioRead = 0;
      audioWrite = 0;
      audioSize =
        AUDIO_BUFFER_MAX;

      return;
    }

    // Nếu không đủ chỗ,
    // bỏ audio cũ nhất.
    const free =
      AUDIO_BUFFER_MAX -
      audioSize;

    if (
      free <
      remaining
    ) {
      const drop =
        remaining - free;

      audioRead =
        (
          audioRead +
          drop
        ) %
        AUDIO_BUFFER_MAX;

      audioSize -= drop;
    }

    const first =
      Math.min(
        remaining,
        AUDIO_BUFFER_MAX -
          audioWrite
      );

    data.copy(
      audioRing,
      audioWrite,
      offset,
      offset + first
    );

    audioWrite =
      (
        audioWrite +
        first
      ) %
      AUDIO_BUFFER_MAX;

    audioSize += first;

    offset += first;

    if (
      offset <
      data.length
    ) {
      const second =
        data.length -
        offset;

      data.copy(
        audioRing,
        audioWrite,
        offset,
        offset + second
      );

      audioWrite =
        (
          audioWrite +
          second
        ) %
        AUDIO_BUFFER_MAX;

      audioSize += second;

      offset += second;
    }
  }
}

// =====================================================
// AUDIO READ
// =====================================================

function readAudio(size) {
  if (
    audioSize <
    size
  ) {
    return null;
  }

  const result =
    Buffer.allocUnsafe(size);

  const first =
    Math.min(
      size,
      AUDIO_BUFFER_MAX -
        audioRead
    );

  audioRing.copy(
    result,
    0,
    audioRead,
    audioRead + first
  );

  if (
    first <
    size
  ) {
    audioRing.copy(
      result,
      first,
      0,
      size - first
    );
  }

  audioRead =
    (
      audioRead +
      size
    ) %
    AUDIO_BUFFER_MAX;

  audioSize -= size;

  return result;
}

// =====================================================
// DROP AUDIO OLD CACHE
// =====================================================

function dropOldAudio() {
  if (
    audioSize >
    AUDIO_KEEP_BYTES
  ) {
    const drop =
      audioSize -
      AUDIO_KEEP_BYTES;

    audioRead =
      (
        audioRead +
        drop
      ) %
      AUDIO_BUFFER_MAX;

    audioSize =
      AUDIO_KEEP_BYTES;
  }
}

// =====================================================
// DOWNLOAD M3U
// =====================================================

function downloadM3U(url) {
  return new Promise(
    (resolve, reject) => {
      const protocol =
        url.startsWith("https:")
          ? https
          : http;

      const request =
        protocol.get(
          url,
          {
            headers: {
              "User-Agent":
                "Mozilla/5.0",
              Accept:
                "*/*"
            }
          },
          response => {
            let data = "";

            response.setEncoding(
              "utf8"
            );

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
                  response.statusCode <
                    200 ||
                  response.statusCode >=
                    300
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
        10000,
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
    }
  );
}

// =====================================================
// PARSE M3U
// =====================================================

function parseM3U(text) {
  const lines =
    text
      .split(/\r?\n/)
      .map(x =>
        x.trim()
      )
      .filter(Boolean);

  const result = [];

  for (
    let i = 0;
    i < lines.length;
    i++
  ) {
    const line =
      lines[i];

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
          line.lastIndexOf(",") +
            1
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
        url =
          lines[j];

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

    if (
      url
        .toLowerCase()
        .includes(".mpd")
    ) {
      continue;
    }

    result.push({
      id: String(
        result.length
      ),
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
// STOP FFMPEG
// =====================================================

function stopFFmpeg() {
  // Vô hiệu hóa process cũ trước.
  generation++;

  const old =
    ffmpeg;

  ffmpeg = null;

  // Xóa toàn bộ cache NGAY.
  clearBuffers();

  if (old) {
    try {
      old.kill(
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
    "======================================"
  );

  console.log(
    "START:",
    channel.name
  );

  console.log(
    channel.url
  );

  console.log(
    "======================================"
  );

  // Quan trọng:
  // không giữ bất kỳ dữ liệu cũ nào.
  stopFFmpeg();

  currentChannel =
    channel;

  const myGeneration =
    generation;

  // ===================================================
  // FFMPEG
  // ===================================================

  const args = [
    "-hide_banner",

    "-loglevel",
    "warning",

    // ================================================
    // HTTP/HLS RECONNECT
    // ================================================

    "-reconnect",
    "1",

    "-reconnect_streamed",
    "1",

    "-reconnect_at_eof",
    "1",

    "-reconnect_on_network_error",
    "1",

    "-reconnect_on_http_error",
    "4xx,5xx",

    "-reconnect_delay_max",
    "2",

    // ================================================
    // INPUT
    // ================================================

    "-fflags",
    "+genpts+discardcorrupt",

    "-flags",
    "low_delay",

    "-i",
    channel.url,

    // ================================================
    // VIDEO
    // ================================================

    "-map",
    "0:v:0",

    "-an",

    "-vf",
    `scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=decrease:flags=fast_bilinear,pad=${WIDTH}:${HEIGHT}:(ow-iw)/2:(oh-ih)/2,format=yuvj420p`,

    "-r",
    String(FPS),

    "-c:v",
    "mjpeg",

    "-q:v",
    String(JPEG_QUALITY),

    "-threads",
    "1",

    "-pix_fmt",
    "yuvj420p",

    "-fps_mode",
    "cfr",

    "-f",
    "image2pipe",

    "pipe:1",

    // ================================================
    // AUDIO
    // ================================================

    "-map",
    "0:a:0?",

    "-vn",

    "-af",
    "aresample=async=1:min_hard_comp=0.100:first_pts=0",

    "-ac",
    String(
      AUDIO_CHANNELS
    ),

    "-ar",
    String(
      AUDIO_SAMPLE_RATE
    ),

    "-c:a",
    "pcm_s16le",

    "-f",
    "s16le",

    "pipe:3"
  ];

  const child =
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
    child;

  // =================================================
  // STDERR
  // =================================================

  child.stderr.on(
    "data",
    data => {
      if (
        myGeneration !==
        generation ||
        child !== ffmpeg
      ) {
        return;
      }

      const msg =
        data
          .toString()
          .trim();

      if (msg) {
        console.log(
          "[FFmpeg]",
          msg
        );
      }
    }
  );

  // =================================================
  // VIDEO PARSER
  // =================================================

  child.stdout.on(
    "data",
    chunk => {
      if (
        myGeneration !==
          generation ||
        child !== ffmpeg
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

        if (
          start < 0
        ) {
          // Không để parser lỗi tăng RAM.
          if (
            jpegBuffer.length >
            512 * 1024
          ) {
            jpegBuffer =
              jpegBuffer.slice(
                -64 * 1024
              );
          }

          break;
        }

        if (
          start > 0
        ) {
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

        if (
          end < 0
        ) {
          break;
        }

        const frame =
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
          frame.length < 100 ||
          frame[0] !== 0xff ||
          frame[1] !== 0xd8 ||
          frame[
            frame.length - 2
          ] !== 0xff ||
          frame[
            frame.length - 1
          ] !== 0xd9
        ) {
          continue;
        }

        pushVideo({
          data: frame,

          time:
            Date.now(),

          generation:
            myGeneration
        });
      }

      // ===============================================
      // CHỐNG CACHE CŨ
      // ===============================================

      if (
        videoCount >
        VIDEO_MAX_FRAMES
      ) {
        dropOldVideo();
      }
    }
  );

  // =================================================
  // AUDIO
  // =================================================

  child.stdio[3].on(
    "data",
    chunk => {
      if (
        myGeneration !==
          generation ||
        child !== ffmpeg
      ) {
        return;
      }

      // PCM đã là dữ liệu raw.
      // Đưa trực tiếp vào ring.
      pushAudio(chunk);

      // Không bao giờ để audio cũ tích tụ.
      dropOldAudio();
    }
  );

  // =================================================
  // CLOSE
  // =================================================

  child.on(
    "close",
    code => {
      console.log(
        "FFmpeg exited:",
        code
      );

      if (
        myGeneration !==
          generation ||
        child !== ffmpeg
      ) {
        return;
      }

      ffmpeg = null;

      clearBuffers();
    }
  );

  // =================================================
  // ERROR
  // =================================================

  child.on(
    "error",
    error => {
      if (
        myGeneration !==
        generation
      ) {
        return;
      }

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
          ch => ({
            id:
              ch.id,

            name:
              ch.name,

            group:
              ch.group,

            logo:
              ch.logo
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
      startFFmpeg(
        channel
      );

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

      id:
        channel.id,

      name:
        channel.name,

      video:
        "/stream",

      audio:
        "/audio",

      buffer:
        "5 seconds",

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

    res.json({
      ok: true
    });
  }
);

// =====================================================
// VIDEO
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
      "Expires",
      "0"
    );

    res.setHeader(
      "Connection",
      "keep-alive"
    );

    res.removeHeader(
      "Content-Encoding"
    );

    if (
      res.flushHeaders
    ) {
      res.flushHeaders();
    }

    let closed = false;

    let started = false;

    let clientGeneration =
      generation;

    let badWrites = 0;

    const timer =
      setInterval(
        () => {
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

          // ===========================================
          // KÊNH MỚI
          // ===========================================

          if (
            clientGeneration !==
            generation
          ) {
            clientGeneration =
              generation;

            started = false;

            return;
          }

          // ===========================================
          // PREBUFFER
          // ===========================================

          if (!started) {
            if (
              videoCount <
              PREBUFFER_VIDEO_FRAMES
            ) {
              return;
            }

            started = true;
          }

          // ===========================================
          // CHỐNG BACKLOG
          //
          // Nếu buffer vẫn quá đầy,
          // bỏ frame cũ trước khi phát.
          // ===========================================

          if (
            videoCount >
            VIDEO_KEEP_FRAMES + 2
          ) {
            dropOldVideo();
          }

          const frame =
            popVideo();

          if (!frame) {
            return;
          }

          if (
            frame.generation !==
            generation
          ) {
            return;
          }

          try {
            const header =
              Buffer.from(
                "--frame\r\n" +
                "Content-Type: image/jpeg\r\n" +
                "Content-Length: " +
                frame.data.length +
                "\r\n\r\n"
              );

            const ok1 =
              res.write(
                header
              );

            const ok2 =
              res.write(
                frame.data
              );

            const ok3 =
              res.write(
                "\r\n"
              );

            if (
              !ok1 ||
              !ok2 ||
              !ok3 ||
              res.writableNeedDrain
            ) {
              badWrites++;

              // Không giữ client chậm
              // mãi mãi.
              if (
                badWrites >=
                MAX_BACKPRESSURE
              ) {
                console.log(
                  "Đóng video client chậm"
                );

                closed = true;

                clearInterval(
                  timer
                );

                try {
                  res.destroy();
                } catch {}
              }
            } else {
              badWrites = 0;
            }
          } catch {
            closed = true;

            clearInterval(
              timer
            );

            try {
              res.destroy();
            } catch {}
          }
        },
        1000 / FPS
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

    res.on(
      "error",
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
// AUDIO
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
      "Expires",
      "0"
    );

    res.setHeader(
      "Connection",
      "keep-alive"
    );

    if (
      res.flushHeaders
    ) {
      res.flushHeaders();
    }

    let closed = false;

    let started = false;

    let clientGeneration =
      generation;

    let badWrites = 0;

    const timer =
      setInterval(
        () => {
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

          // ===========================================
          // KÊNH MỚI
          // ===========================================

          if (
            clientGeneration !==
            generation
          ) {
            clientGeneration =
              generation;

            started = false;

            return;
          }

          // ===========================================
          // PREBUFFER 5 GIÂY
          // ===========================================

          if (!started) {
            if (
              audioSize <
              PREBUFFER_AUDIO_BYTES
            ) {
              return;
            }

            started = true;
          }

          // ===========================================
          // KHÔNG CHO AUDIO CŨ TÍCH TỤ
          // ===========================================

          if (
            audioSize >
            AUDIO_KEEP_BYTES
          ) {
            dropOldAudio();
          }

          // ===========================================
          // 20ms AUDIO
          // ===========================================

          const chunk =
            readAudio(
              AUDIO_CHUNK_SIZE
            );

          if (!chunk) {
            // Nguồn đang giật.
            // Chờ dữ liệu mới,
            // KHÔNG PHÁT LẠI CACHE.
            return;
          }

          try {
            const ok =
              res.write(chunk);

            if (
              !ok ||
              res.writableNeedDrain
            ) {
              badWrites++;

              if (
                badWrites >=
                MAX_BACKPRESSURE
              ) {
                console.log(
                  "Đóng audio client chậm"
                );

                closed = true;

                clearInterval(
                  timer
                );

                try {
                  res.destroy();
                } catch {}
              }
            } else {
              badWrites = 0;
            }
          } catch {
            closed = true;

            clearInterval(
              timer
            );

            try {
              res.destroy();
            } catch {}
          }
        },
        AUDIO_CHUNK_MS
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

    res.on(
      "error",
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

      generation,

      buffer: {
        videoFrames:
          videoCount,

        videoMaxFrames:
          VIDEO_MAX_FRAMES,

        videoSeconds:
          (
            videoCount /
            FPS
          ).toFixed(2),

        audioBytes:
          audioSize,

        audioMaxBytes:
          AUDIO_BUFFER_MAX,

        audioSeconds:
          (
            audioSize /
            (
              AUDIO_SAMPLE_RATE *
              AUDIO_CHANNELS *
              AUDIO_BYTES_PER_SAMPLE
            )
          ).toFixed(2)
      },

      video: {
        width:
          WIDTH,

        height:
          HEIGHT,

        fps:
          FPS,

        quality:
          JPEG_QUALITY,

        buffer:
          "5s fixed ring",

        oldCache:
          "DROP",

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

        bits:
          16,

        chunkMs:
          AUDIO_CHUNK_MS,

        buffer:
          "5s fixed ring",

        oldCache:
          "DROP",

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
      "LIVE RING BUFFER"
    );
    console.log(
      "NO OLD CACHE"
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
      "Video buffer: 5 seconds"
    );

    console.log(
      "Audio buffer: 5 seconds"
    );

    console.log(
      "Old cache: DROP"
    );

    console.log(
      "Disk cache: OFF"
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

      console.log(
        "SERVER READY"
      );

      console.log(
        `API: /api/channels`
      );

      console.log(
        `Select: /api/select/ID`
      );

      console.log(
        `Video: /stream`
      );

      console.log(
        `Audio: /audio`
      );

      console.log(
        `Health: /health`
      );
    } catch (error) {
      console.error(
        "M3U ERROR:",
        error.message
      );
    }
  }
);
