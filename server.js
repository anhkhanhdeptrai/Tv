const express = require("express");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const app = express();
const PORT = process.env.PORT || 10000;

// ======================================================
// CONFIG
// ======================================================

const PLAYLIST_URL =
  "https://raw.githubusercontent.com/iptv-org/iptv/master/streams/vn.m3u";

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
const CHECK_CONCURRENCY = 6;

// ======================================================
// PATH
// ======================================================

const TMP_DIR =
  path.join(os.tmpdir(), "iptv-server");

const HLS_DIR =
  path.join(TMP_DIR, "hls");

if (!fs.existsSync(TMP_DIR)) {
  fs.mkdirSync(TMP_DIR, {
    recursive: true
  });
}

if (!fs.existsSync(HLS_DIR)) {
  fs.mkdirSync(HLS_DIR, {
    recursive: true
  });
}

// ======================================================
// STATE
// ======================================================

let channels = [];
let selectedChannel = null;

// 3 FFmpeg riêng:
// 1. HLS
// 2. MJPEG
// 3. Audio
let ffmpegHLS = null;
let ffmpegMJPEG = null;
let ffmpegAudio = null;

let frames = [];
let jpegBuffer = Buffer.alloc(0);

let audioQueue = [];
const MAX_AUDIO_BUFFER =
  2 * 1024 * 1024;

let statsTimer = null;

let hlsStats = {
  speed: 0,
  fps: 0,
  frame: 0
};

let mjpegStats = {
  speed: 0,
  fps: 0,
  frame: 0,
  totalFrames: 0
};

let audioStats = {
  running: false
};

// ======================================================
// UTILS
// ======================================================

function getBufferSeconds() {
  if (frames.length < 2) {
    return 0;
  }

  const first =
    frames[0].time;

  const last =
    frames[frames.length - 1].time;

  return Math.max(
    0,
    (last - first) / 1000
  );
}

function clearHLS() {
  try {
    const files =
      fs.readdirSync(HLS_DIR);

    for (const file of files) {
      try {
        fs.unlinkSync(
          path.join(HLS_DIR, file)
        );
      } catch {}
    }
  } catch {}
}

function resetStats() {
  hlsStats = {
    speed: 0,
    fps: 0,
    frame: 0
  };

  mjpegStats = {
    speed: 0,
    fps: 0,
    frame: 0,
    totalFrames: 0
  };

  audioStats = {
    running: false
  };
}

function startStatsTimer() {
  if (statsTimer) {
    clearInterval(statsTimer);
  }

  let lastMJPEGFrames = 0;
  let lastTime = Date.now();

  statsTimer =
    setInterval(() => {
      const now = Date.now();

      const dt =
        (now - lastTime) / 1000;

      const df =
        mjpegStats.totalFrames -
        lastMJPEGFrames;

      if (dt > 0) {
        mjpegStats.fps =
          df / dt;
      }

      lastMJPEGFrames =
        mjpegStats.totalFrames;

      lastTime = now;

      console.log("");
      console.log("==========");
      console.log(
        "[STATS] Channel     :",
        selectedChannel
          ? selectedChannel.name
          : "-"
      );

      console.log(
        "[STATS] HLS speed   :",
        hlsStats.speed
          ? hlsStats.speed.toFixed(2) + "x"
          : "N/A"
      );

      console.log(
        "[STATS] MJPEG speed :",
        mjpegStats.speed
          ? mjpegStats.speed.toFixed(2) + "x"
          : "N/A"
      );

      console.log(
        "[STATS] MJPEG FPS   :",
        mjpegStats.fps.toFixed(2)
      );

      console.log(
        "[STATS] Target FPS  :",
        FPS
      );

      console.log(
        "[STATS] Buffer      :",
        getBufferSeconds().toFixed(2) +
          "s"
      );

      console.log(
        "[STATS] Buffer frm  :",
        frames.length
      );

      console.log(
        "[STATS] JPEG total  :",
        mjpegStats.totalFrames
      );

      console.log(
        "[STATS] MJPEG frame :",
        mjpegStats.frame
      );

      console.log(
        "[STATS] Audio       :",
        audioStats.running
          ? "RUNNING"
          : "STOPPED"
      );

      console.log("==========");
      console.log("");
    }, 5000);
}

// ======================================================
// PLAYLIST
// ======================================================

async function loadPlaylist() {
  console.log(
    "Loading playlist..."
  );

  const response =
    await fetch(
      PLAYLIST_URL
    );

  if (!response.ok) {
    throw new Error(
      `Playlist HTTP ${response.status}`
    );
  }

  const text =
    await response.text();

  const lines =
    text
      .split(/\r?\n/)
      .map(x => x.trim())
      .filter(Boolean);

  const result = [];

  let current = null;

  for (const line of lines) {

    if (
      line.startsWith(
        "#EXTINF"
      )
    ) {
      const comma =
        line.indexOf(",");

      const name =
        comma >= 0
          ? line
              .substring(
                comma + 1
              )
              .trim()
          : "Unknown";

      const logo =
        (
          line.match(
            /tvg-logo="([^"]*)"/
          ) || []
        )[1] || "";

      const group =
        (
          line.match(
            /group-title="([^"]*)"/
          ) || []
        )[1] || "";

      current = {
        name,
        logo,
        group,
        url: ""
      };

    } else if (
      current &&
      !line.startsWith("#")
    ) {

      current.url = line;

      if (current.url) {
        result.push(
          current
        );
      }

      current = null;
    }
  }

  console.log(
    `Playlist loaded: ${result.length} channels`
  );

  return result;
}

// ======================================================
// CHECK CHANNEL
// ======================================================

async function checkChannel(
  channel
) {
  return new Promise(
    resolve => {

      const ff =
        spawn(
          "ffprobe",
          [
            "-hide_banner",
            "-loglevel",
            "error",

            "-timeout",
            String(
              CHECK_TIMEOUT * 1000
            ),

            "-i",
            channel.url,

            "-show_entries",
            "stream=codec_type",

            "-of",
            "default=noprint_wrappers=1:nokey=1"
          ],
          {
            stdio: [
              "ignore",
              "pipe",
              "pipe"
            ]
          }
        );

      let output = "";

      const timer =
        setTimeout(() => {

          try {
            ff.kill(
              "SIGKILL"
            );
          } catch {}

          resolve(false);

        }, CHECK_TIMEOUT);

      ff.stdout.on(
        "data",
        data => {
          output +=
            data.toString();
        }
      );

      ff.on(
        "close",
        code => {

          clearTimeout(timer);

          resolve(
            code === 0 &&
            output.includes(
              "video"
            )
          );
        }
      );

      ff.on(
        "error",
        () => {

          clearTimeout(timer);

          resolve(false);
        }
      );
    }
  );
}

async function filterChannels(
  list
) {
  const valid = [];

  let index = 0;

  async function worker() {

    while (true) {

      const i =
        index++;

      if (
        i >= list.length
      ) {
        return;
      }

      const channel =
        list[i];

      try {

        const ok =
          await checkChannel(
            channel
          );

        if (ok) {

          console.log(
            "[OK]",
            channel.name
          );

          valid.push(
            channel
          );

        } else {

          console.log(
            "[SKIP]",
            channel.name
          );
        }

      } catch {

        console.log(
          "[SKIP]",
          channel.name
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
    workers.push(
      worker()
    );
  }

  await Promise.all(
    workers
  );

  return valid;
}

// ======================================================
// STOP ALL FFMPEG
// ======================================================

function stopFFmpeg() {

  console.log(
    "Stopping FFmpeg..."
  );

  const processes = [
    ffmpegHLS,
    ffmpegMJPEG,
    ffmpegAudio
  ];

  for (
    const process of processes
  ) {

    if (process) {

      try {
        process.kill(
          "SIGKILL"
        );
      } catch {}
    }
  }

  ffmpegHLS = null;
  ffmpegMJPEG = null;
  ffmpegAudio = null;

  frames = [];
  jpegBuffer =
    Buffer.alloc(0);

  audioQueue = [];

  resetStats();

  clearHLS();
}

// ======================================================
// HLS FFMPEG
// ======================================================

function startHLSFFmpeg(
  channel
) {

  const playlist =
    path.join(
      HLS_DIR,
      "index.m3u8"
    );

  const segment =
    path.join(
      HLS_DIR,
      "segment_%05d.ts"
    );

  console.log(
    "[HLS] Starting..."
  );

  ffmpegHLS =
    spawn(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "warning",

        "-progress",
        "pipe:2",
        "-stats_period",
        "3",

        "-reconnect",
        "1",

        "-reconnect_streamed",
        "1",

        "-reconnect_delay_max",
        "5",

        "-fflags",
        "nobuffer",

        "-i",
        channel.url,

        "-map",
        "0:v:0",

        "-map",
        "0:a:0?",

        // HLS video copy
        "-c:v",
        "copy",

        // HLS audio
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

        playlist
      ],
      {
        stdio: [
          "ignore",
          "ignore",
          "pipe"
        ]
      }
    );

  let progressBuffer = "";

  ffmpegHLS.stderr.on(
    "data",
    data => {

      progressBuffer +=
        data.toString();

      const lines =
        progressBuffer.split(
          /\r?\n/
        );

      progressBuffer =
        lines.pop() || "";

      for (
        const raw of lines
      ) {

        const line =
          raw.trim();

        if (!line) {
          continue;
        }

        const equal =
          line.indexOf("=");

        if (equal < 0) {
          console.log(
            "[HLS]",
            line
          );

          continue;
        }

        const key =
          line.substring(
            0,
            equal
          );

        const value =
          line.substring(
            equal + 1
          );

        if (
          key === "speed"
        ) {

          const n =
            parseFloat(
              value.replace(
                "x",
                ""
              )
            );

          if (
            Number.isFinite(n)
          ) {
            hlsStats.speed =
              n;
          }
        }

        else if (
          key === "fps"
        ) {

          const n =
            parseFloat(
              value
            );

          if (
            Number.isFinite(n)
          ) {
            hlsStats.fps =
              n;
          }
        }

        else if (
          key === "frame"
        ) {

          hlsStats.frame =
            Number(value) || 0;
        }
      }
    }
  );

  ffmpegHLS.on(
    "close",
    code => {

      console.log(
        "[HLS] stopped:",
        code
      );

      ffmpegHLS = null;
    }
  );

  ffmpegHLS.on(
    "error",
    err => {

      console.log(
        "[HLS] error:",
        err.message
      );
    }
  );
}

// ======================================================
// MJPEG FFMPEG - SEPARATE
// ======================================================

function startMJPEGFFmpeg(
  channel
) {

  console.log(
    "[MJPEG] Starting separate FFmpeg..."
  );

  ffmpegMJPEG =
    spawn(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "warning",

        "-progress",
        "pipe:2",
        "-stats_period",
        "3",

        "-reconnect",
        "1",

        "-reconnect_streamed",
        "1",

        "-reconnect_delay_max",
        "5",

        "-fflags",
        "nobuffer",

        "-i",
        channel.url,

        // ============================================
        // VIDEO ONLY
        // ============================================

        "-an",

        "-map",
        "0:v:0",

        // ============================================
        // GIẢM TẢI
        // ============================================

        "-vf",
        `fps=${FPS},scale=${WIDTH}:${HEIGHT}:flags=fast_bilinear:force_original_aspect_ratio=decrease,pad=${WIDTH}:${HEIGHT}:(ow-iw)/2:(oh-ih)/2`,

        // ============================================
        // JPEG
        // ============================================

        "-c:v",
        "mjpeg",

        "-q:v",
        "14",

        "-fps_mode",
        "cfr",

        "-f",
        "image2pipe",

        "pipe:1"
      ],
      {
        stdio: [
          "ignore",
          "pipe",
          "pipe"
        ]
      }
    );

  // ====================================================
  // JPEG PARSER
  // ====================================================

  ffmpegMJPEG.stdout.on(
    "data",
    data => {

      jpegBuffer =
        Buffer.concat([
          jpegBuffer,
          Buffer.from(data)
        ]);

      while (true) {

        const start =
          jpegBuffer.indexOf(
            Buffer.from([
              0xff,
              0xd8
            ])
          );

        if (start < 0) {

          if (
            jpegBuffer.length >
            1024 * 1024
          ) {
            jpegBuffer =
              Buffer.alloc(0);
          }

          break;
        }

        const end =
          jpegBuffer.indexOf(
            Buffer.from([
              0xff,
              0xd9
            ]),
            start + 2
          );

        if (end < 0) {
          break;
        }

        const jpeg =
          jpegBuffer.subarray(
            start,
            end + 2
          );

        jpegBuffer =
          jpegBuffer.subarray(
            end + 2
          );

        frames.push({
          data: Buffer.from(
            jpeg
          ),

          time: Date.now()
        });

        mjpegStats.totalFrames++;

        while (
          frames.length >
          MAX_BUFFER_FRAMES
        ) {
          frames.shift();
        }
      }
    }
  );

  // ====================================================
  // PROGRESS
  // ====================================================

  let progressBuffer = "";

  ffmpegMJPEG.stderr.on(
    "data",
    data => {

      progressBuffer +=
        data.toString();

      const lines =
        progressBuffer.split(
          /\r?\n/
        );

      progressBuffer =
        lines.pop() || "";

      for (
        const raw of lines
      ) {

        const line =
          raw.trim();

        if (!line) {
          continue;
        }

        const equal =
          line.indexOf("=");

        if (equal < 0) {

          console.log(
            "[MJPEG]",
            line
          );

          continue;
        }

        const key =
          line.substring(
            0,
            equal
          );

        const value =
          line.substring(
            equal + 1
          );

        if (
          key === "speed"
        ) {

          const n =
            parseFloat(
              value.replace(
                "x",
                ""
              )
            );

          if (
            Number.isFinite(n)
          ) {
            mjpegStats.speed =
              n;
          }
        }

        else if (
          key === "fps"
        ) {

          const n =
            parseFloat(
              value
            );

          if (
            Number.isFinite(n)
          ) {
            // Đây là FPS nội bộ FFmpeg
            // MJPEG FPS thật được tính riêng
          }
        }

        else if (
          key === "frame"
        ) {

          mjpegStats.frame =
            Number(value) || 0;
        }
      }
    }
  );

  ffmpegMJPEG.on(
    "close",
    code => {

      console.log(
        "[MJPEG] stopped:",
        code
      );

      ffmpegMJPEG = null;
    }
  );

  ffmpegMJPEG.on(
    "error",
    err => {

      console.log(
        "[MJPEG] error:",
        err.message
      );
    }
  );
}

// ======================================================
// AUDIO FFMPEG
// ======================================================

function startAudioFFmpeg(
  channel
) {

  console.log(
    "[AUDIO] Starting..."
  );

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
        channel.url,

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
      ],
      {
        stdio: [
          "ignore",
          "pipe",
          "pipe"
        ]
      }
    );

  audioStats.running = true;

  ffmpegAudio.stdout.on(
    "data",
    data => {

      audioQueue.push(
        Buffer.from(data)
      );

      let total = 0;

      for (
        const chunk of audioQueue
      ) {
        total +=
          chunk.length;
      }

      while (
        total >
        MAX_AUDIO_BUFFER &&
        audioQueue.length
      ) {

        const removed =
          audioQueue.shift();

        total -=
          removed.length;
      }
    }
  );

  ffmpegAudio.stderr.on(
    "data",
    data => {

      const text =
        data.toString().trim();

      if (text) {
        console.log(
          "[AUDIO]",
          text
        );
      }
    }
  );

  ffmpegAudio.on(
    "close",
    () => {

      console.log(
        "[AUDIO] stopped"
      );

      audioStats.running =
        false;

      ffmpegAudio = null;
    }
  );

  ffmpegAudio.on(
    "error",
    err => {

      console.log(
        "[AUDIO] error:",
        err.message
      );

      audioStats.running =
        false;
    }
  );
}

// ======================================================
// START CHANNEL
// ======================================================

function startChannel(
  channel
) {

  stopFFmpeg();

  selectedChannel =
    channel;

  console.log("");
  console.log(
    "================================"
  );
  console.log(
    "CHANNEL:",
    channel.name
  );
  console.log(
    "URL:",
    channel.url
  );
  console.log(
    "MJPEG:",
    `${WIDTH}x${HEIGHT} @ ${FPS} FPS`
  );
  console.log(
    "================================"
  );
  console.log("");

  // Ba process riêng
  startHLSFFmpeg(
    channel
  );

  startMJPEGFFmpeg(
    channel
  );

  startAudioFFmpeg(
    channel
  );

  startStatsTimer();
}

// ======================================================
// MJPEG STREAM
// ======================================================

app.get(
  "/stream",
  (req, res) => {

    res.writeHead(
      200,
      {
        "Content-Type":
          "multipart/x-mixed-replace; boundary=frame",

        "Cache-Control":
          "no-cache, no-store, must-revalidate",

        "Pragma":
          "no-cache",

        "Connection":
          "keep-alive",

        "Access-Control-Allow-Origin":
          "*"
      }
    );

    let lastFrameTime = 0;
    let frameIndex =
      Math.max(
        0,
        frames.length - 1
      );

    let closed = false;

    const timer =
      setInterval(
        () => {

          if (closed) {
            clearInterval(
              timer
            );

            return;
          }

          const now =
            Date.now();

          // ==========================================
          // VIDEO 10 FPS
          // ==========================================

          if (
            frames.length &&
            now - lastFrameTime >=
              1000 / FPS
          ) {

            // Nếu client bị tụt quá xa,
            // nhảy tới frame mới nhất.
            if (
              frameIndex <
              frames.length - 20
            ) {
              frameIndex =
                frames.length - 1;
            }

            frameIndex =
              Math.min(
                frameIndex,
                frames.length - 1
              );

            const frame =
              frames[frameIndex];

            if (frame) {

              try {

                res.write(
                  "--frame\r\n"
                );

                res.write(
                  "Content-Type: image/jpeg\r\n"
                );

                res.write(
                  "Content-Length: " +
                  frame.data.length +
                  "\r\n\r\n"
                );

                res.write(
                  frame.data
                );

                res.write(
                  "\r\n"
                );

                lastFrameTime =
                  now;

                frameIndex++;

              } catch {

                closed = true;

                clearInterval(
                  timer
                );
              }
            }
          }

          // ==========================================
          // AUDIO
          // ==========================================

          if (
            audioQueue.length
          ) {

            const audioChunk =
              audioQueue.shift();

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

              clearInterval(
                timer
              );
            }
          }

        },
        10
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

// ======================================================
// HLS PLAYLIST
// ======================================================

app.get(
  "/hls/index.m3u8",
  (req, res) => {

    const playlist =
      path.join(
        HLS_DIR,
        "index.m3u8"
      );

    if (
      !fs.existsSync(
        playlist
      )
    ) {

      return res
        .status(404)
        .send(
          "HLS not ready"
        );
    }

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
      "no-cache"
    );

    res.send(data);
  }
);

// ======================================================
// HLS SEGMENTS
// ======================================================

app.get(
  "/hls-segment/:file",
  (req, res) => {

    const filename =
      path.basename(
        req.params.file
      );

    const file =
      path.join(
        HLS_DIR,
        filename
      );

    if (
      !fs.existsSync(file)
    ) {

      return res
        .status(404)
        .send(
          "Segment not found"
        );
    }

    res.setHeader(
      "Content-Type",
      "video/mp2t"
    );

    res.setHeader(
      "Cache-Control",
      "no-cache"
    );

    fs.createReadStream(
      file
    ).pipe(res);
  }
);

// ======================================================
// HEALTH
// ======================================================

app.get(
  "/health",
  (req, res) => {

    res.json({
      ok: true,

      channel:
        selectedChannel
          ? selectedChannel.name
          : null,

      resolution:
        `${WIDTH}x${HEIGHT}`,

      targetFPS:
        FPS,

      stats: {

        hls: {
          frame:
            hlsStats.frame,

          fps:
            hlsStats.fps,

          speed:
            hlsStats.speed
        },

        mjpeg: {
          frame:
            mjpegStats.frame,

          fps:
            mjpegStats.fps,

          speed:
            mjpegStats.speed,

          totalFrames:
            mjpegStats.totalFrames,

          bufferFrames:
            frames.length,

          bufferSeconds:
            getBufferSeconds()
        },

        audio: {
          running:
            audioStats.running,

          queuedChunks:
            audioQueue.length
        }
      }
    });
  }
);

// ======================================================
// CHANNEL API
// ======================================================

app.get(
  "/api/channels",
  (req, res) => {

    res.json(
      channels.map(
        (channel, index) => ({
          id: index,
          name:
            channel.name,
          logo:
            channel.logo,
          group:
            channel.group
        })
      )
    );
  }
);

// ======================================================
// SELECT CHANNEL
// ======================================================

app.get(
  "/api/select/:id",
  (req, res) => {

    const id =
      Number(
        req.params.id
      );

    if (
      !Number.isInteger(id) ||
      !channels[id]
    ) {

      return res
        .status(404)
        .json({
          error:
            "Channel not found"
        });
    }

    startChannel(
      channels[id]
    );

    res.json({
      ok: true,

      channel:
        channels[id].name
    });
  }
);

// ======================================================
// WEB
// ======================================================

app.get(
  "/",
  (req, res) => {

    const options =
      channels
        .map(
          (channel, index) =>
            `<option value="${index}">${channel.name}</option>`
        )
        .join("");

    res.send(`
<!DOCTYPE html>
<html lang="vi">

<head>

<meta charset="UTF-8">

<meta
  name="viewport"
  content="width=device-width,initial-scale=1"
/>

<title>IPTV Server</title>

<style>

body {
  font-family: Arial;
  background: #111;
  color: white;
  padding: 20px;
}

video {
  width: 100%;
  max-width: 900px;
  background: black;
}

img {
  width: 320px;
  height: 240px;
  object-fit: contain;
  background: black;
}

select,
button {
  padding: 10px;
  margin: 5px;
}

pre {
  background: #222;
  padding: 15px;
  overflow: auto;
}

</style>

</head>

<body>

<h2>IPTV Server</h2>

<select id="channel">
${options}
</select>

<button onclick="selectChannel()">
Chọn kênh
</button>

<h3>HLS</h3>

<video
  controls
  autoplay
  muted
  playsinline
  id="video"
></video>

<h3>
MJPEG ${WIDTH}x${HEIGHT} @ ${FPS} FPS
</h3>

<img
  src="/stream"
  alt="MJPEG"
/>

<h3>Stats</h3>

<pre id="stats">
Loading...
</pre>

<script>

async function selectChannel() {

  const id =
    document.getElementById(
      "channel"
    ).value;

  await fetch(
    "/api/select/" + id
  );

  setTimeout(
    () => location.reload(),
    1000
  );
}

async function stats() {

  try {

    const response =
      await fetch(
        "/health",
        {
          cache: "no-store"
        }
      );

    const data =
      await response.json();

    document.getElementById(
      "stats"
    ).textContent =
      JSON.stringify(
        data,
        null,
        2
      );

  } catch {}

}

setInterval(
  stats,
  2000
);

stats();

</script>

</body>

</html>
`);
  }
);

// ======================================================
// START SERVER
// ======================================================

app.listen(
  PORT,
  "0.0.0.0",
  async () => {

    console.log(
      `Server running on port ${PORT}`
    );

    try {

      const list =
        await loadPlaylist();

      console.log(
        "Checking channels..."
      );

      channels =
        await filterChannels(
          list
        );

      console.log(
        `Valid channels: ${channels.length}`
      );

      if (
        channels.length > 0
      ) {

        startChannel(
          channels[0]
        );
      }

    } catch (err) {

      console.error(
        "START ERROR:",
        err
      );
    }
  }
);
