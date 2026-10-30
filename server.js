const express = require("express");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");

const app = express();
const PORT = process.env.PORT || 10000;

// =====================================================
// IPTV-ORG
// =====================================================

const M3U_URL =
  "https://raw.githubusercontent.com/iptv-org/iptv/master/streams/vn.m3u";

// =====================================================
// CONFIG
// =====================================================

const WIDTH = 320;
const HEIGHT = 240;
const FPS = 10;

const DELAY_SECONDS = 1;
const BUFFER_SECONDS = 12;

const MAX_BUFFER_FRAMES =
  FPS * BUFFER_SECONDS;

const HLS_TIME = 2;
const HLS_LIST = 8;

const CHECK_TIMEOUT = 7000;

// Giới hạn nguồn tối đa 720p
const MAX_SOURCE_WIDTH = 1280;
const MAX_SOURCE_HEIGHT = 720;

// =====================================================
// HLS
// =====================================================

const HLS_DIR =
  path.join(__dirname, "hls");

if (!fs.existsSync(HLS_DIR)) {
  fs.mkdirSync(HLS_DIR, {
    recursive: true
  });
}

// =====================================================
// DOWNLOAD M3U
// =====================================================

function downloadM3U(url) {

  return new Promise((resolve, reject) => {

    const protocol =
      url.startsWith("https")
        ? https
        : http;

    const request =
      protocol.get(
        url,
        {
          headers: {
            "User-Agent":
              "Mozilla/5.0"
          }
        },
        response => {

          // Redirect
          if (
            response.statusCode >= 300 &&
            response.statusCode < 400 &&
            response.headers.location
          ) {

            response.resume();

            const redirectUrl =
              new URL(
                response.headers.location,
                url
              ).toString();

            downloadM3U(
              redirectUrl
            )
              .then(resolve)
              .catch(reject);

            return;
          }

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
                    "HTTP " +
                    response.statusCode
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
      CHECK_TIMEOUT,
      () => {

        request.destroy(
          new Error(
            "Request timeout"
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
// LẤY TOÀN BỘ KÊNH
// KHÔNG CHECK
// KHÔNG BỎ GEO-BLOCKED
// KHÔNG BỎ KÊNH CHẾT
// =====================================================

function parseM3U(text) {

  const lines =
    text
      .split(/\r?\n/)
      .map(x => x.trim());

  const result = [];

  for (
    let i = 0;
    i < lines.length;
    i++
  ) {

    const line =
      lines[i];

    if (
      !line.startsWith("#EXTINF")
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
        !lines[j]
      ) {
        continue;
      }

      // Bỏ qua các dòng EXT khác
      // như #EXTVLCOPT
      if (
        lines[j].startsWith("#")
      ) {
        continue;
      }

      url =
        lines[j];

      break;
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

    // =================================================
    // KHÔNG FILTER GÌ Ở ĐÂY
    // =================================================

    result.push({

      id:
        String(result.length),

      name,

      tvgId,

      tvgName,

      logo,

      group,

      url,

      playUrl: null,

      available: true,

      checking: false,

      error: null
    });
  }

  return result;
}

// =====================================================
// CHỌN HLS VARIANT <=720P
// =====================================================

async function select720pOrLower(url) {

  if (
    !url ||
    !/^https?:/i.test(url)
  ) {
    return url;
  }

  if (
    !/\.m3u8(?:$|\?)/i.test(url)
  ) {
    return url;
  }

  try {

    const text =
      await downloadM3U(url);

    // Không phải master playlist
    if (
      !/#EXT-X-STREAM-INF/i.test(text)
    ) {

      return url;
    }

    const lines =
      text
        .split(/\r?\n/)
        .map(x => x.trim());

    const variants = [];

    for (
      let i = 0;
      i < lines.length;
      i++
    ) {

      const line =
        lines[i];

      if (
        !line.startsWith(
          "#EXT-X-STREAM-INF"
        )
      ) {
        continue;
      }

      const resolution =
        line.match(
          /RESOLUTION=(\d+)x(\d+)/i
        );

      if (!resolution) {
        continue;
      }

      const width =
        Number(
          resolution[1]
        );

      const height =
        Number(
          resolution[2]
        );

      let j =
        i + 1;

      while (
        j < lines.length &&
        (
          !lines[j] ||
          lines[j].startsWith("#")
        )
      ) {
        j++;
      }

      if (
        j >= lines.length
      ) {
        continue;
      }

      let variantUrl;

      try {

        variantUrl =
          new URL(
            lines[j],
            url
          ).toString();

      } catch {

        variantUrl =
          lines[j];
      }

      if (
        width <= MAX_SOURCE_WIDTH &&
        height <= MAX_SOURCE_HEIGHT
      ) {

        variants.push({

          url:
            variantUrl,

          width,

          height
        });
      }
    }

    if (
      variants.length === 0
    ) {

      console.log(
        "Không có variant <=720p, dùng URL gốc"
      );

      return url;
    }

    // Cao nhất nhưng <=720p
    variants.sort(
      (a, b) =>
        (b.width * b.height) -
        (a.width * a.height)
    );

    const selected =
      variants[0];

    console.log(
      "Đã chọn:",
      `${selected.width}x${selected.height}`
    );

    return selected.url;

  } catch (error) {

    console.log(
      "Lỗi đọc master HLS:",
      error.message
    );

    return url;
  }
}

// =====================================================
// GLOBAL
// =====================================================

let channels = [];

let currentChannel = null;

let ffmpeg = null;

let ffmpegGeneration = 0;

let ffmpegAudio = null;

let ffmpegAudioGeneration = 0;

const frames = [];

const audioQueue = [];

let audioQueueBytes = 0;

const MAX_AUDIO_QUEUE_BYTES =
  2 * 1024 * 1024;

let jpegBuffer =
  Buffer.alloc(0);

const JPEG_START =
  Buffer.from([
    0xff,
    0xd8
  ]);

const JPEG_END =
  Buffer.from([
    0xff,
    0xd9
  ]);

// =====================================================
// CLEAR HLS
// =====================================================

function clearHLS() {

  if (
    !fs.existsSync(HLS_DIR)
  ) {
    return;
  }

  for (
    const file of
    fs.readdirSync(HLS_DIR)
  ) {

    try {

      fs.unlinkSync(
        path.join(
          HLS_DIR,
          file
        )
      );

    } catch {}
  }
}

// =====================================================
// STOP FFMPEG
// =====================================================

function stopFFmpeg() {

  if (!ffmpeg) {
    return;
  }

  try {
    ffmpeg.kill("SIGKILL");
  } catch {}

  ffmpeg = null;
}

function stopAudioFFmpeg() {

  if (ffmpegAudio) {

    try {
      ffmpegAudio.kill("SIGKILL");
    } catch {}

    ffmpegAudio = null;
  }

  audioQueue.length = 0;
  audioQueueBytes = 0;
}

function queueAudioChunk(chunk) {

  if (
    !chunk ||
    chunk.length === 0
  ) {
    return;
  }

  const audioChunk =
    Buffer.from(chunk);

  while (
    audioQueueBytes +
      audioChunk.length >
      MAX_AUDIO_QUEUE_BYTES &&
    audioQueue.length
  ) {

    const removed =
      audioQueue.shift();

    audioQueueBytes -=
      removed.length;
  }

  audioQueue.push(
    audioChunk
  );

  audioQueueBytes +=
    audioChunk.length;
}

// =====================================================
// AUDIO FFMPEG
// =====================================================

function startAudioFFmpeg(
  channel,
  sourceUrl
) {

  if (
    !channel ||
    !sourceUrl
  ) {
    return;
  }

  ffmpegAudioGeneration++;

  const generation =
    ffmpegAudioGeneration;

  stopAudioFFmpeg();

  ffmpegAudio =
    spawn(
      "ffmpeg",
      [

        "-hide_banner",

        "-loglevel",
        "warning",

        "-reconnect",
        "1",

        "-reconnect_streamed",
        "1",

        "-reconnect_delay_max",
        "5",

        "-fflags",
        "nobuffer",

        "-i",
        sourceUrl,

        "-vn",

        "-ac",
        "1",

        "-ar",
        "44100",

        "-c:a",
        "pcm_s16le",

        "-f",
        "s16le",

        "pipe:1"
      ]
    );

  ffmpegAudio.stderr.on(
    "data",
    data => {

      const text =
        data
          .toString()
          .trim();

      if (text) {

        console.log(
          "[FFmpeg Audio]",
          text
        );
      }
    }
  );

  ffmpegAudio.stdout.on(
    "data",
    chunk => {

      if (
        generation !==
        ffmpegAudioGeneration
      ) {
        return;
      }

      queueAudioChunk(
        chunk
      );
    }
  );

  ffmpegAudio.on(
    "close",
    () => {

      if (
        generation !==
        ffmpegAudioGeneration
      ) {
        return;
      }

      ffmpegAudio = null;

      setTimeout(
        () => {

          if (
            currentChannel ===
              channel &&
            channel.playUrl
          ) {

            startAudioFFmpeg(
              channel,
              channel.playUrl
            );
          }

        },
        3000
      );
    }
  );
}

// =====================================================
// VIDEO FFMPEG
// =====================================================

async function startFFmpeg(channel) {

  ffmpegGeneration++;

  const generation =
    ffmpegGeneration;

  stopFFmpeg();
  stopAudioFFmpeg();

  clearHLS();

  frames.length = 0;

  jpegBuffer =
    Buffer.alloc(0);

  console.log("");
  console.log(
    "======================================"
  );

  console.log(
    "ĐANG PHÁT:",
    channel.name
  );

  console.log(
    "URL:",
    channel.url
  );

  console.log(
    "======================================"
  );

  // =========================================
  // Chọn nguồn <=720p nếu có
  // =========================================

  const sourceUrl =
    await select720pOrLower(
      channel.url
    );

  if (
    generation !==
    ffmpegGeneration
  ) {
    return;
  }

  channel.playUrl =
    sourceUrl;

  console.log(
    "SOURCE:",
    sourceUrl
  );

  const playlist =
    path.join(
      HLS_DIR,
      "stream.m3u8"
    );

  const segment =
    path.join(
      HLS_DIR,
      "seg-%05d.ts"
    );

  ffmpeg =
    spawn(
      "ffmpeg",
      [

        "-hide_banner",

        "-loglevel",
        "warning",

        "-reconnect",
        "1",

        "-reconnect_streamed",
        "1",

        "-reconnect_delay_max",
        "5",

        "-fflags",
        "nobuffer",

        "-i",
        sourceUrl,

        // =========================================
        // HLS VIDEO + AUDIO
        // =========================================

        "-map",
        "0:v:0",

        "-map",
        "0:a:0?",

        "-c:v",
        "copy",

        "-c:a",
        "aac",

        "-b:a",
        "96k",

        "-f",
        "hls",

        "-hls_time",
        String(HLS_TIME),

        "-hls_list_size",
        String(HLS_LIST),

        "-hls_delete_threshold",
        "4",

        "-hls_flags",
        "delete_segments+append_list+independent_segments",

        "-hls_segment_filename",
        segment,

        playlist,

        // =========================================
        // MJPEG 320x240
        // =========================================

        "-map",
        "0:v:0",

        "-an",

        "-vf",
        `fps=${FPS},scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=decrease,pad=${WIDTH}:${HEIGHT}:(ow-iw)/2:(oh-ih)/2`,

        "-c:v",
        "mjpeg",

        "-q:v",
        "10",

        "-fps_mode",
        "cfr",

        "-f",
        "image2pipe",

        "pipe:1"
      ]
    );

  // Audio riêng
  startAudioFFmpeg(
    channel,
    sourceUrl
  );

  // =========================================
  // STDERR
  // =========================================

  ffmpeg.stderr.on(
    "data",
    data => {

      const text =
        data
          .toString()
          .trim();

      if (text) {

        console.log(
          "[FFmpeg]",
          text
        );
      }
    }
  );

  // =========================================
  // MJPEG
  // =========================================

  ffmpeg.stdout.on(
    "data",
    chunk => {

      if (
        generation !==
        ffmpegGeneration
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
            2 * 1024 * 1024
          ) {

            jpegBuffer =
              Buffer.alloc(0);
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
          jpeg[jpeg.length - 2] !== 0xff ||
          jpeg[jpeg.length - 1] !== 0xd9
        ) {
          continue;
        }

        const now =
          Date.now();

        frames.push({
          time: now,
          data: jpeg
        });

        const oldest =
          now -
          BUFFER_SECONDS * 1000;

        while (
          frames.length &&
          frames[0].time <
            oldest
        ) {

          frames.shift();
        }

        while (
          frames.length >
          MAX_BUFFER_FRAMES
        ) {

          frames.shift();
        }
      }
    }
  );

  // =========================================
  // CLOSE
  // =========================================

  ffmpeg.on(
    "close",
    code => {

      console.log(
        "FFmpeg exited:",
        code
      );

      if (
        generation !==
        ffmpegGeneration
      ) {
        return;
      }

      ffmpeg = null;

      if (
        currentChannel !==
        channel
      ) {
        return;
      }

      setTimeout(
        () => {

          if (
            currentChannel ===
            channel
          ) {

            startFFmpeg(
              channel
            );
          }

        },
        3000
      );
    }
  );
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

            tvgId:
              ch.tvgId,

            logo:
              ch.logo,

            group:
              ch.group
          })
        )
    });
  }
);

// =====================================================
// SELECT
// =====================================================

app.get(
  "/api/select/:id",
  async (req, res) => {

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

    currentChannel =
      channel;

    // Chạy nền
    startFFmpeg(
      channel
    );

    res.json({

      ok: true,

      id:
        channel.id,

      name:
        channel.name
    });
  }
);

// =====================================================
// HLS PLAYLIST
// =====================================================

app.get(
  "/hls/stream.m3u8",
  (req, res) => {

    const playlist =
      path.join(
        HLS_DIR,
        "stream.m3u8"
      );

    if (
      !fs.existsSync(
        playlist
      )
    ) {

      return res
        .status(404)
        .send(
          "HLS chưa sẵn sàng"
        );
    }

    try {

      let data =
        fs.readFileSync(
          playlist,
          "utf8"
        );

      data =
        data.replace(
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

      res
        .status(500)
        .send(
          "HLS error"
        );
    }
  }
);

// =====================================================
// HLS SEGMENTS
// =====================================================

app.get(
  "/hls-segment/:file",
  (req, res) => {

    const file =
      path.basename(
        req.params.file
      );

    const filePath =
      path.join(
        HLS_DIR,
        file
      );

    if (
      !fs.existsSync(
        filePath
      )
    ) {

      return res
        .status(404)
        .end();
    }

    res.setHeader(
      "Content-Type",
      "video/mp2t"
    );

    res.setHeader(
      "Cache-Control",
      "no-cache"
    );

    fs
      .createReadStream(
        filePath
      )
      .pipe(res);
  }
);

// =====================================================
// MJPEG
// =====================================================

app.get(
  "/stream",
  (req, res) => {

    const requestedUrl =
      req.query.url ||
      req.query.channelUrl;

    if (requestedUrl) {

      const customChannel = {

        id: "custom",

        name:
          "Custom stream",

        group:
          "custom",

        url:
          requestedUrl,

        playUrl:
          null,

        checking:
          false,

        available:
          true,

        error:
          null
      };

      currentChannel =
        customChannel;

      startFFmpeg(
        customChannel
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

    if (
      typeof res.flushHeaders ===
      "function"
    ) {

      res.flushHeaders();
    }

    let closed = false;

    let lastSentTime = 0;

    req.on(
      "close",
      () => {

        closed = true;

        clearInterval(timer);
      }
    );

    const timer =
      setInterval(
        () => {

          if (closed) {

            clearInterval(timer);

            return;
          }

          // =========================================
          // AUDIO
          // =========================================

          while (
            audioQueue.length
          ) {

            const audioChunk =
              audioQueue.shift();

            audioQueueBytes -=
              audioChunk.length;

            try {

              res.write(
                "--frame\r\n"
              );

              res.write(
                "Content-Type: audio/L16; rate=44100; channels=1\r\n"
              );

              res.write(
                "Content-Length: " +
                audioChunk.length +
                "\r\n\r\n"
              );

              res.write(
                audioChunk
              );

              res.write(
                "\r\n"
              );

            } catch {

              closed = true;

              clearInterval(timer);

              return;
            }
          }

          // =========================================
          // VIDEO
          // =========================================

          if (
            frames.length === 0
          ) {
            return;
          }

          const target =
            Date.now() -
            DELAY_SECONDS * 1000;

          let selected = null;

          for (
            let i =
              frames.length - 1;
            i >= 0;
            i--
          ) {

            if (
              frames[i].time <=
              target
            ) {

              selected =
                frames[i];

              break;
            }
          }

          if (!selected) {

            selected =
              frames[0];
          }

          if (
            selected.time ===
            lastSentTime
          ) {
            return;
          }

          lastSentTime =
            selected.time;

          try {

            res.write(
              "--frame\r\n"
            );

            res.write(
              "Content-Type: image/jpeg\r\n"
            );

            res.write(
              "Content-Length: " +
              selected.data.length +
              "\r\n\r\n"
            );

            res.write(
              selected.data
            );

            res.write(
              "\r\n"
            );

          } catch {

            closed = true;

            clearInterval(timer);
          }

        },
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

      playlist:
        M3U_URL,

      channelCount:
        channels.length,

      currentChannel:
        currentChannel
          ? {

              id:
                currentChannel.id,

              name:
                currentChannel.name,

              source:
                currentChannel.playUrl ||
                currentChannel.url

            }
          : null,

      sourceLimit:
        "720p",

      mjpeg: {

        url:
          "/stream",

        width:
          WIDTH,

        height:
          HEIGHT,

        fps:
          FPS,

        delaySeconds:
          DELAY_SECONDS,

        bufferSeconds:
          BUFFER_SECONDS,

        currentFrames:
          frames.length
      }
    });
  }
);

// =====================================================
// WEB
// =====================================================

app.get(
  "/",
  (req, res) => {

    const host =
      req.get("host");

    const protocol =
      req.headers[
        "x-forwarded-proto"
      ] ||
      req.protocol;

    const hlsUrl =
      `${protocol}://${host}/hls/stream.m3u8`;

    res.send(`

<!DOCTYPE html>

<html>

<head>

<meta charset="UTF-8">

<meta
name="viewport"
content="width=device-width,initial-scale=1"
>

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
  color:#fff;
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

.info {
  color:#aaa;
  font-size:14px;
  margin:8px 0;
}

.mjpeg {
  width:320px;
  height:240px;
  background:#000;
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

<div id="status">
Chưa chọn kênh
</div>

<video
id="video"
controls
playsinline
></video>

<h3>Danh sách kênh</h3>

<input
id="search"
class="search"
placeholder="🔎 Tìm VTV, HTV, SCTV..."
>

<div id="channels"></div>

<h3>ESP32 MJPEG</h3>

<div class="info">
320 × 240 — 10 FPS — nguồn tối đa 720p
</div>

<img
src="/stream"
class="mjpeg"
width="320"
height="240"
>

</div>

<script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>

<script>

const video =
document.getElementById(
  "video"
);

const channelBox =
document.getElementById(
  "channels"
);

const search =
document.getElementById(
  "search"
);

const status =
document.getElementById(
  "status"
);

const hlsUrl =
"${hlsUrl}";

let channels = [];

let current = null;

let hls = null;

// =========================================
// LOAD CHANNELS
// =========================================

async function loadChannels() {

  try {

    const r =
      await fetch(
        "/api/channels"
      );

    const data =
      await r.json();

    channels =
      data.channels;

    current =
      data.current;

    renderChannels();

    if (current) {

      const ch =
        channels.find(
          c =>
            c.id ===
            current
        );

      if (ch) {

        status.innerText =
          "Đang phát: " +
          ch.name;

        startHLS();
      }

    } else {

      status.innerText =
        "Chưa chọn kênh";
    }

  } catch {

    status.innerText =
      "Không tải được danh sách";
  }
}

// =========================================
// HLS
// =========================================

function startHLS() {

  if (
    video.canPlayType(
      "application/vnd.apple.mpegurl"
    )
  ) {

    video.src =
      hlsUrl;

    video.play()
      .catch(() => {});

    return;
  }

  if (
    typeof Hls !== "undefined" &&
    Hls.isSupported()
  ) {

    if (hls) {
      hls.destroy();
    }

    hls =
      new Hls({
        lowLatencyMode:false,
        liveSyncDurationCount:4,
        liveMaxLatencyDurationCount:8
      });

    hls.loadSource(
      hlsUrl
    );

    hls.attachMedia(
      video
    );

    hls.on(
      Hls.Events.MANIFEST_PARSED,
      () => {

        video.play()
          .catch(() => {});
      }
    );
  }
}

// =========================================
// RENDER
// =========================================

function renderChannels() {

  const keyword =
    search.value
      .toLowerCase()
      .trim();

  channelBox.innerHTML = "";

  channels
    .filter(
      ch =>
        ch.name
          .toLowerCase()
          .includes(keyword)
    )
    .forEach(
      ch => {

        const div =
          document.createElement(
            "div"
          );

        div.className =
          "channel" +
          (
            ch.id === current
              ? " active"
              : ""
          );

        div.innerText =
          ch.name;

        div.onclick =
          () =>
            selectChannel(
              ch.id,
              ch.name
            );

        channelBox.appendChild(
          div
        );
      }
    );
}

// =========================================
// SELECT
// =========================================

async function selectChannel(
  id,
  name
) {

  status.innerText =
    "Đang chuyển sang " +
    name +
    "...";

  try {

    const r =
      await fetch(
        "/api/select/" +
        id
      );

    const data =
      await r.json();

    if (!data.ok) {
      throw new Error();
    }

    current =
      id;

    renderChannels();

    status.innerText =
      "Đang phát: " +
      name;

    // Chờ FFmpeg tạo HLS
    setTimeout(
      startHLS,
      2000
    );

  } catch {

    status.innerText =
      "Không thể phát kênh";
  }
}

// =========================================
// SEARCH
// =========================================

search.addEventListener(
  "input",
  renderChannels
);

// =========================================
// START
// =========================================

loadChannels();

</script>

</body>

</html>

`);
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
      "VIETNAM TV SERVER"
    );

    console.log(
      "======================================"
    );

    try {

      console.log(
        "Đang tải vn.m3u..."
      );

      const m3u =
        await downloadM3U(
          M3U_URL
        );

      channels =
        parseM3U(m3u);

      console.log(
        "TỔNG KÊNH:",
        channels.length
      );

      console.log(
        "Không check stream."
      );

      console.log(
        "Không loại Geo-blocked."
      );

      console.log(
        "Không tự phát kênh đầu tiên."
      );

      console.log("");

      console.log(
        "Server:",
        `http://0.0.0.0:${PORT}`
      );

    } catch (error) {

      console.error(
        "LỖI:",
        error.message
      );

      process.exit(1);
    }
  }
);
