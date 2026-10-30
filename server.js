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

// Giữ khoảng 5 giây video
const VIDEO_BUFFER_SECONDS = 5;

const VIDEO_MAX_FRAMES =
  FPS * VIDEO_BUFFER_SECONDS;

// =====================================================
// AUDIO
// =====================================================

const AUDIO_SAMPLE_RATE = 44100;
const AUDIO_CHANNELS = 1;
const AUDIO_BYTES_PER_SAMPLE = 2;

// Giữ khoảng 5 giây audio
const AUDIO_BUFFER_SECONDS = 5;

const AUDIO_BUFFER_MAX =
  AUDIO_SAMPLE_RATE *
  AUDIO_CHANNELS *
  AUDIO_BYTES_PER_SAMPLE *
  AUDIO_BUFFER_SECONDS;

// 20ms audio
const AUDIO_CHUNK_MS = 20;

const AUDIO_CHUNK_SIZE =
  AUDIO_SAMPLE_RATE *
  AUDIO_CHANNELS *
  AUDIO_BYTES_PER_SAMPLE *
  AUDIO_CHUNK_MS /
  1000;

// =====================================================
// PREBUFFER
// =====================================================

// Không phát ngay khi mới có dữ liệu.
// Chờ khoảng 5 giây để tạo vùng chống giật.
const PREBUFFER_SECONDS = 5;

const PREBUFFER_AUDIO_BYTES =
  AUDIO_SAMPLE_RATE *
  AUDIO_CHANNELS *
  AUDIO_BYTES_PER_SAMPLE *
  PREBUFFER_SECONDS;

// Video cần khoảng 5 giây frame.
const PREBUFFER_VIDEO_FRAMES =
  Math.max(
    1,
    Math.floor(
      FPS * PREBUFFER_SECONDS
    )
  );

// =====================================================
// NETWORK
// =====================================================

const M3U_TIMEOUT = 10000;

// Nếu client quá chậm, không để nó giữ server.
// Sau số lần backpressure này sẽ đóng connection.
const MAX_BACKPRESSURE = 50;

// =====================================================
// STATE
// =====================================================

let channels = [];

let currentChannel = null;

let ffmpeg = null;

let ffmpegGeneration = 0;

// =====================================================
// VIDEO RING BUFFER
// =====================================================

const videoRing = new Array(
  VIDEO_MAX_FRAMES
);

let videoWriteIndex = 0;
let videoCount = 0;

// =====================================================
// AUDIO RING BUFFER
// =====================================================

// Dùng Buffer cố định.
// Không Buffer.concat() liên tục.
const audioRing = Buffer.alloc(
  AUDIO_BUFFER_MAX
);

let audioWritePos = 0;
let audioReadPos = 0;
let audioSize = 0;

// =====================================================
// AUDIO INPUT TEMP BUFFER
// =====================================================

let audioInputBuffer = Buffer.alloc(0);

// =====================================================
// JPEG PARSER
// =====================================================

let jpegBuffer = Buffer.alloc(0);

const JPEG_START = Buffer.from([
  0xff,
  0xd8
]);

const JPEG_END = Buffer.from([
  0xff,
  0xd9
]);

// =====================================================
// VIDEO RING
// =====================================================

function clearVideoBuffer() {
  for (
    let i = 0;
    i < videoRing.length;
    i++
  ) {
    videoRing[i] = null;
  }

  videoWriteIndex = 0;
  videoCount = 0;
}

// =====================================================
// ADD VIDEO FRAME
// =====================================================

function pushVideoFrame(frame) {
  if (!frame) {
    return;
  }

  videoRing[
    videoWriteIndex
  ] = frame;

  videoWriteIndex =
    (
      videoWriteIndex + 1
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
// GET OLDEST VIDEO
// =====================================================

function getOldestVideoIndex() {
  if (
    videoCount <= 0
  ) {
    return -1;
  }

  return (
    videoWriteIndex -
    videoCount +
    VIDEO_MAX_FRAMES
  ) %
  VIDEO_MAX_FRAMES;
}

// =====================================================
// POP VIDEO
// =====================================================

function popVideoFrame() {
  if (
    videoCount <= 0
  ) {
    return null;
  }

  const index =
    getOldestVideoIndex();

  const frame =
    videoRing[index];

  videoRing[index] = null;

  videoCount--;

  return frame;
}

// =====================================================
// AUDIO RING CLEAR
// =====================================================

function clearAudioBuffer() {
  audioWritePos = 0;
  audioReadPos = 0;
  audioSize = 0;

  audioInputBuffer =
    Buffer.alloc(0);
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
      data.length -
      offset;

    // Nếu dữ liệu mới lớn hơn toàn bộ buffer
    // chỉ giữ phần cuối.
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

      audioReadPos = 0;

      audioWritePos =
        AUDIO_BUFFER_MAX %
        AUDIO_BUFFER_MAX;

      audioSize =
        AUDIO_BUFFER_MAX;

      return;
    }

    const free =
      AUDIO_BUFFER_MAX -
      audioSize;

    // Buffer đầy -> bỏ dữ liệu cũ.
    if (
      free === 0
    ) {
      const drop =
        Math.min(
          AUDIO_CHUNK_SIZE,
          audioSize
        );

      audioReadPos =
        (
          audioReadPos +
          drop
        ) %
        AUDIO_BUFFER_MAX;

      audioSize -= drop;
    }

    const writeSpace =
      AUDIO_BUFFER_MAX -
      audioWritePos;

    const count =
      Math.min(
        remaining,
        writeSpace,
        AUDIO_BUFFER_MAX -
          audioSize
      );

    data.copy(
      audioRing,
      audioWritePos,
      offset,
      offset + count
    );

    audioWritePos =
      (
        audioWritePos +
        count
      ) %
      AUDIO_BUFFER_MAX;

    audioSize += count;

    offset += count;
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
        audioReadPos
    );

  audioRing.copy(
    result,
    0,
    audioReadPos,
    audioReadPos + first
  );

  if (
    first < size
  ) {
    audioRing.copy(
      result,
      first,
      0,
      size - first
    );
  }

  audioReadPos =
    (
      audioReadPos +
      size
    ) %
    AUDIO_BUFFER_MAX;

  audioSize -= size;

  return result;
}

// =====================================================
// CLEAR EVERYTHING
// =====================================================

function clearAllBuffers() {
  clearVideoBuffer();
  clearAudioBuffer();

  jpegBuffer =
    Buffer.alloc(0);
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
        !lines[j].startsWith(
          "#"
        )
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
  // Tăng generation trước.
  // Tất cả dữ liệu process cũ lập tức vô hiệu.
  ffmpegGeneration++;

  const old =
    ffmpeg;

  ffmpeg = null;

  if (old) {
    try {
      old.kill("SIGKILL");
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

  currentChannel = null;

  stopFFmpeg();

  currentChannel =
    channel;

  const generation =
    ffmpegGeneration;

  // ===================================================
  // FFMPEG
  // ===================================================

  const args = [
    "-hide_banner",

    "-loglevel",
    "warning",

    // =================================================
    // HLS RECONNECT
    // =================================================

    "-reconnect",
    "1",

    "-reconnect_streamed",
    "1",

    "-reconnect_at_eof",
    "1",

    "-reconnect_delay_max",
    "3",

    // =================================================
    // INPUT
    // =================================================

    "-fflags",
    "+genpts+discardcorrupt",

    "-flags",
    "low_delay",

    "-i",
    channel.url,

    // =================================================
    // VIDEO OUTPUT
    // =================================================

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

    // =================================================
    // AUDIO OUTPUT
    // =================================================

    "-map",
    "0:a:0?",

    "-vn",

    "-af",
    "aresample=async=1:min_hard_comp=0.100000:first_pts=0",

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
  // VIDEO
  // =================================================

  processFFmpeg.stdout.on(
    "data",
    chunk => {
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
        const start =
          jpegBuffer.indexOf(
            JPEG_START
          );

        if (
          start === -1
        ) {
          if (
            jpegBuffer.length >
            1024 * 1024
          ) {
            // Giữ phần cuối để tránh RAM tăng.
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
          end === -1
        ) {
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

        pushVideoFrame({
          data: jpeg,

          time: Date.now(),

          generation
        });
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
        processFFmpeg !==
          ffmpeg
      ) {
        return;
      }

      audioInputBuffer =
        Buffer.concat([
          audioInputBuffer,
          chunk
        ]);

      // Đưa dữ liệu vào ring buffer.
      if (
        audioInputBuffer.length >=
        AUDIO_CHUNK_SIZE
      ) {
        pushAudio(
          audioInputBuffer
        );

        audioInputBuffer =
          Buffer.alloc(0);
      }
    }
  );

  // =================================================
  // CLOSE
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
        processFFmpeg !==
          ffmpeg
      ) {
        return;
      }

      ffmpeg = null;

      clearAllBuffers();
    }
  );

  // =================================================
  // ERROR
  // =================================================

  processFFmpeg.on(
    "error",
    error => {
      if (
        generation !==
        ffmpegGeneration
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
            id: ch.id,
            name: ch.name,
            group: ch.group,
            logo: ch.logo
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

      buffer: {
        seconds:
          PREBUFFER_SECONDS
      },

      format: {
        video:
          `${WIDTH}x${HEIGHT} ${FPS}fps`,

        audio:
          "PCM S16LE",

        sampleRate:
          AUDIO_SAMPLE_RATE,

        channels:
          AUDIO_CHANNELS,

        bits: 16
      }
    });
  }
);

// =====================================================
// STOP
// =====================================================

app.get(
  "/api/stop",
  (req, res) => {
    currentChannel = null;

    stopFFmpeg();

    res.json({
      ok: true,
      message:
        "Đã dừng phát"
    });
  }
);

// =====================================================
// VIDEO STREAM
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
      typeof res.flushHeaders ===
      "function"
    ) {
      res.flushHeaders();
    }

    let closed = false;

    let playing = false;

    let backpressureCount = 0;

    let lastGeneration =
      ffmpegGeneration;

    // =================================================
    // CLOCK
    // =================================================

    const interval =
      1000 / FPS;

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

          if (
            lastGeneration !==
            ffmpegGeneration
          ) {
            lastGeneration =
              ffmpegGeneration;

            playing = false;

            return;
          }

          // =============================================
          // PREBUFFER 5 GIÂY
          // =============================================

          if (!playing) {
            if (
              videoCount <
              PREBUFFER_VIDEO_FRAMES
            ) {
              return;
            }

            playing = true;
          }

          // =============================================
          // LẤY FRAME CŨ NHẤT
          // =============================================

          const frame =
            popVideoFrame();

          if (!frame) {
            return;
          }

          if (
            frame.generation !==
            ffmpegGeneration
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

            const ok =
              res.write(
                header
              ) &&
              res.write(
                frame.data
              ) &&
              res.write(
                "\r\n"
              );

            if (
              !ok ||
              res.writableNeedDrain
            ) {
              backpressureCount++;

              // =========================================
              // QUAN TRỌNG:
              // Không chờ drain vô hạn.
              // Client chậm -> đóng.
              // =========================================

              if (
                backpressureCount >=
                MAX_BACKPRESSURE
              ) {
                console.log(
                  "Video client quá chậm -> đóng connection"
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
              backpressureCount = 0;
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
        interval
      );

    // =================================================
    // CLIENT CLOSE
    // =================================================

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
// AUDIO STREAM
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
      typeof res.flushHeaders ===
      "function"
    ) {
      res.flushHeaders();
    }

    let closed = false;

    let playing = false;

    let backpressureCount = 0;

    let lastGeneration =
      ffmpegGeneration;

    // =================================================
    // AUDIO CLOCK
    // 20ms / chunk
    // =================================================

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

          if (
            lastGeneration !==
            ffmpegGeneration
          ) {
            lastGeneration =
              ffmpegGeneration;

            playing = false;

            return;
          }

          // =============================================
          // CHỜ ĐỦ 5 GIÂY
          // =============================================

          if (!playing) {
            if (
              audioSize <
              PREBUFFER_AUDIO_BYTES
            ) {
              return;
            }

            playing = true;
          }

          // =============================================
          // ĐỌC ĐÚNG 20ms
          // =============================================

          const chunk =
            readAudio(
              AUDIO_CHUNK_SIZE
            );

          if (!chunk) {
            // Nguồn bị giật.
            // Không block server.
            return;
          }

          try {
            const ok =
              res.write(chunk);

            if (
              !ok ||
              res.writableNeedDrain
            ) {
              backpressureCount++;

              if (
                backpressureCount >=
                MAX_BACKPRESSURE
              ) {
                console.log(
                  "Audio client quá chậm -> đóng connection"
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
              backpressureCount = 0;
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

    // =================================================
    // CLIENT CLOSE
    // =================================================

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

      generation:
        ffmpegGeneration,

      memory: {
        videoFrames:
          videoCount,

        videoFramesMax:
          VIDEO_MAX_FRAMES,

        videoBufferSeconds:
          (
            videoCount /
            FPS
          ).toFixed(2),

        audioBufferBytes:
          audioSize,

        audioBufferMax:
          AUDIO_BUFFER_MAX,

        audioBufferSeconds:
          (
            audioSize /
            (
              AUDIO_SAMPLE_RATE *
              AUDIO_CHANNELS *
              AUDIO_BYTES_PER_SAMPLE
            )
          ).toFixed(2),

        jpegParserBytes:
          jpegBuffer.length,

        audioInputBytes:
          audioInputBuffer.length
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

        bufferSeconds:
          VIDEO_BUFFER_SECONDS,

        mode:
          "RING BUFFER",

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

        bufferSeconds:
          AUDIO_BUFFER_SECONDS,

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
      "A/V RING BUFFER"
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
      `A/V Buffer: ${PREBUFFER_SECONDS}s`
    );

    console.log(
      "Disk cache: OFF"
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
