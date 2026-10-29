const express = require("express");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const app = express();

const PORT = process.env.PORT || 10000;

// ======================================================
// SOURCE
// ======================================================

const DEFAULT_URL =
  "https://amagi-live.ondemandkorea.com/amgplt0456.m3u8";

const source =
  process.env.STREAM_URL || DEFAULT_URL;

// ======================================================
// CONFIG
// ======================================================

const DELAY_SECONDS = 15;

const MJPEG_FPS = 10;
const MJPEG_WIDTH = 320;
const MJPEG_HEIGHT = 240;

const HLS_SEGMENT_SECONDS = 4;
const HLS_LIST_SIZE = 20;

// ======================================================
// DIRECTORIES
// ======================================================

const DATA_DIR = path.join(__dirname, "data");
const HLS_DIR = path.join(DATA_DIR, "hls");

fs.mkdirSync(HLS_DIR, {
  recursive: true
});

// ======================================================
// STATE
// ======================================================

let ffmpegProcess = null;

let frameBuffer = [];

const MAX_FRAME_BUFFER = 30;

let totalFrames = 0;

// ======================================================
// LOG
// ======================================================

function log(...args) {
  console.log(
    new Date().toISOString(),
    ...args
  );
}

// ======================================================
// CLEAN HLS
// ======================================================

function cleanHLS() {
  try {
    if (!fs.existsSync(HLS_DIR)) {
      fs.mkdirSync(HLS_DIR, {
        recursive: true
      });
      return;
    }

    for (const file of fs.readdirSync(HLS_DIR)) {
      try {
        fs.unlinkSync(
          path.join(HLS_DIR, file)
        );
      } catch (_) {}
    }
  } catch (err) {
    console.error(
      "HLS cleanup:",
      err.message
    );
  }
}

// ======================================================
// START FFMPEG
// ======================================================

function startFFmpeg() {

  if (ffmpegProcess) {
    return;
  }

  cleanHLS();

  log("Starting FFmpeg");
  log("Source:", source);

  /*
   * Một FFmpeg đọc source duy nhất.
   *
   * Output 1:
   *   MJPEG 320x240 10 FPS -> pipe:1
   *
   * Output 2:
   *   HLS H264 + AAC -> data/hls
   */

  const args = [

    "-hide_banner",

    // --------------------------------------------------
    // reconnect
    // --------------------------------------------------

    "-reconnect",
    "1",

    "-reconnect_streamed",
    "1",

    "-reconnect_delay_max",
    "5",

    // Cho phép HLS dùng extension lạ
    "-allowed_extensions",
    "ALL",

    "-allowed_segment_extensions",
    "ALL",

    // --------------------------------------------------
    // INPUT
    // --------------------------------------------------

    "-i",
    source,

    // ==================================================
    // OUTPUT 1
    // MJPEG -> ESP32
    // ==================================================

    "-map",
    "0:v:0",

    "-an",

    "-vf",
    `fps=${MJPEG_FPS},scale=${MJPEG_WIDTH}:${MJPEG_HEIGHT}:force_original_aspect_ratio=decrease,pad=${MJPEG_WIDTH}:${MJPEG_HEIGHT}:(ow-iw)/2:(oh-ih)/2`,

    "-q:v",
    "10",

    "-fps_mode",
    "cfr",

    "-threads",
    "1",

    "-f",
    "image2pipe",

    "-vcodec",
    "mjpeg",

    "pipe:1",

    // ==================================================
    // OUTPUT 2
    // HLS VIDEO + AUDIO
    // ==================================================

    "-map",
    "0:v:0",

    "-map",
    "0:a:0",

    // Video
    "-c:v",
    "libx264",

    "-preset",
    "veryfast",

    "-tune",
    "zerolatency",

    "-pix_fmt",
    "yuv420p",

    "-profile:v",
    "main",

    "-level",
    "3.1",

    "-b:v",
    "1000k",

    "-maxrate",
    "1200k",

    "-bufsize",
    "2400k",

    // Audio
    "-c:a",
    "aac",

    "-b:a",
    "96k",

    "-ac",
    "2",

    "-ar",
    "44100",

    // HLS
    "-f",
    "hls",

    "-hls_time",
    String(HLS_SEGMENT_SECONDS),

    "-hls_list_size",
    String(HLS_LIST_SIZE),

    "-hls_delete_threshold",
    "10",

    "-hls_flags",
    "delete_segments+append_list",

    "-hls_segment_filename",
    path.join(
      HLS_DIR,
      "seg-%05d.ts"
    ),

    path.join(
      HLS_DIR,
      "index.m3u8"
    )
  ];

  ffmpegProcess = spawn(
    "ffmpeg",
    args,
    {
      stdio: [
        "ignore",
        "pipe",
        "pipe"
      ]
    }
  );

  // ==================================================
  // STDOUT
  // ==================================================

  let pipeBuffer = Buffer.alloc(0);

  ffmpegProcess.stdout.on(
    "data",
    (chunk) => {

      pipeBuffer = Buffer.concat([
        pipeBuffer,
        chunk
      ]);

      while (true) {

        const start =
          pipeBuffer.indexOf(
            Buffer.from([
              0xff,
              0xd8
            ])
          );

        if (start === -1) {
          break;
        }

        const end =
          pipeBuffer.indexOf(
            Buffer.from([
              0xff,
              0xd9
            ]),
            start + 2
          );

        if (end === -1) {
          break;
        }

        const jpeg =
          pipeBuffer.slice(
            start,
            end + 2
          );

        pipeBuffer =
          pipeBuffer.slice(
            end + 2
          );

        totalFrames++;

        frameBuffer.push({
          time: Date.now(),
          data: jpeg
        });

        // Chỉ giữ buffer nhỏ
        while (
          frameBuffer.length >
          MAX_FRAME_BUFFER
        ) {
          frameBuffer.shift();
        }
      }
    }
  );

  // ==================================================
  // STDERR
  // ==================================================

  ffmpegProcess.stderr.on(
    "data",
    (data) => {

      process.stdout.write(
        `[FFMPEG] ${data}`
      );
    }
  );

  // ==================================================
  // ERROR
  // ==================================================

  ffmpegProcess.on(
    "error",
    (err) => {

      console.error(
        "[FFMPEG ERROR]",
        err.message
      );
    }
  );

  // ==================================================
  // CLOSE
  // ==================================================

  ffmpegProcess.on(
    "close",
    (code, signal) => {

      log(
        `FFmpeg exited code=${code} signal=${signal}`
      );

      ffmpegProcess = null;

      setTimeout(
        startFFmpeg,
        3000
      );
    }
  );
}

// ======================================================
// HLS PLAYLIST
// ======================================================

function getDelayedPlaylist() {

  const playlistPath =
    path.join(
      HLS_DIR,
      "index.m3u8"
    );

  if (
    !fs.existsSync(
      playlistPath
    )
  ) {
    return null;
  }

  const playlist =
    fs.readFileSync(
      playlistPath,
      "utf8"
    );

  const lines =
    playlist.split("\n");

  const targetSegments =
    Math.ceil(
      DELAY_SECONDS /
      HLS_SEGMENT_SECONDS
    );

  const segmentIndexes = [];

  for (
    let i = 0;
    i < lines.length;
    i++
  ) {

    if (
      lines[i].startsWith(
        "#EXTINF:"
      )
    ) {
      segmentIndexes.push(i);
    }
  }

  if (
    segmentIndexes.length <=
    targetSegments
  ) {
    return playlist;
  }

  const removeCount =
    segmentIndexes.length -
    targetSegments;

  const firstKeepIndex =
    segmentIndexes[removeCount];

  const output = [];

  for (
    let i = 0;
    i < lines.length;
    i++
  ) {

    if (
      i >= firstKeepIndex ||
      !lines[i].startsWith(
        "#EXTINF:"
      )
    ) {

      output.push(lines[i]);
    }

    if (
      lines[i].startsWith(
        "#EXTINF:"
      ) &&
      i < firstKeepIndex
    ) {
      continue;
    }
  }

  return (
    output.join("\n") +
    "\n"
  );
}

// ======================================================
// HEALTH
// ======================================================

app.get(
  "/health",
  (req, res) => {

    res.json({

      ok: true,

      source,

      ffmpeg:
        !!ffmpegProcess,

      frames:
        totalFrames,

      frameBuffer:
        frameBuffer.length,

      mjpeg: {
        width:
          MJPEG_WIDTH,
        height:
          MJPEG_HEIGHT,
        fps:
          MJPEG_FPS
      },

      delay:
        DELAY_SECONDS
    });
  }
);

// ======================================================
// WEB PLAYER
// ======================================================

app.get(
  "/",
  (req, res) => {

    const safeSource =
      String(source)
        .replace(
          /&/g,
          "&amp;"
        )
        .replace(
          /"/g,
          "&quot;"
        );

    res.send(`
<!DOCTYPE html>

<html lang="vi">

<head>

<meta charset="UTF-8">

<meta
  name="viewport"
  content="width=device-width,initial-scale=1"
>

<title>TV Online</title>

<script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>

<style>

html,
body {
  margin: 0;
  padding: 0;
  background: #000;
  color: #fff;
  font-family: Arial, sans-serif;
}

body {
  display: flex;
  flex-direction: column;
  align-items: center;
}

h2 {
  margin: 15px;
}

video {
  width: 100%;
  max-width: 960px;
  background: #000;
}

.info {
  padding: 15px;
  text-align: center;
}

button {
  font-size: 18px;
  padding: 12px 25px;
  border: 0;
  border-radius: 8px;
}

</style>

</head>

<body>

<h2>TV Online</h2>

<video
  id="video"
  controls
  playsinline
  preload="auto">
</video>

<div class="info">

<button id="play">
▶ Phát
</button>

<p>
Bấm Phát để bật hình và âm thanh.
</p>

</div>

<script>

const video =
  document.getElementById("video");

const play =
  document.getElementById("play");

function startHLS() {

  if (
    video.canPlayType(
      "application/vnd.apple.mpegurl"
    )
  ) {

    video.src = "/hls";

    video.addEventListener(
      "loadedmetadata",
      () => {

        console.log(
          "HLS loaded"
        );
      }
    );

  }
  else if (
    Hls.isSupported()
  ) {

    const hls =
      new Hls({

        enableWorker: true,

        lowLatencyMode: false,

        maxBufferLength: 30,

        maxMaxBufferLength: 60,

        backBufferLength: 30,

        liveSyncDurationCount: 3,

        liveMaxLatencyDurationCount: 8

      });

    hls.loadSource(
      "/hls"
    );

    hls.attachMedia(
      video
    );

    hls.on(
      Hls.Events.MANIFEST_PARSED,
      () => {

        console.log(
          "HLS ready"
        );
      }
    );

    hls.on(
      Hls.Events.ERROR,
      (event, data) => {

        console.log(
          "HLS error",
          data
        );

        if (
          data.fatal &&
          data.type ===
          Hls.ErrorTypes.NETWORK_ERROR
        ) {

          hls.startLoad();
        }

        if (
          data.fatal &&
          data.type ===
          Hls.ErrorTypes.MEDIA_ERROR
        ) {

          hls.recoverMediaError();
        }

      }
    );

  }
  else {

    alert(
      "Trình duyệt không hỗ trợ HLS."
    );
  }
}

play.addEventListener(
  "click",
  async () => {

    try {

      await video.play();

      play.style.display =
        "none";

    }
    catch (err) {

      console.error(err);

      alert(
        "Không thể phát video."
      );
    }
  }
);

startHLS();

</script>

</body>

</html>
`);
  }
);

// ======================================================
// HLS PLAYLIST
// ======================================================

app.get(
  "/hls",
  (req, res) => {

    const playlist =
      getDelayedPlaylist();

    if (!playlist) {

      res.status(503);

      res.setHeader(
        "Content-Type",
        "application/vnd.apple.mpegurl"
      );

      res.send(
        "#EXTM3U\n"
      );

      return;
    }

    res.setHeader(
      "Content-Type",
      "application/vnd.apple.mpegurl"
    );

    res.setHeader(
      "Cache-Control",
      "no-cache, no-store, must-revalidate"
    );

    res.setHeader(
      "Pragma",
      "no-cache"
    );

    res.send(
      playlist
    );
  }
);

// ======================================================
// HLS SEGMENTS
// ======================================================

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

      res.status(404).end();

      return;
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
      filePath
    ).pipe(res);
  }
);

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
          "close",

        "Access-Control-Allow-Origin":
          "*"
      }
    );

    let closed = false;

    req.on(
      "close",
      () => {
        closed = true;
      }
    );

    let lastFrameTime = 0;

    function sendFrame() {

      if (closed) {
        return;
      }

      /*
       * Chọn frame khoảng DELAY_SECONDS
       * phía sau hiện tại.
       */

      const targetTime =
        Date.now() -
        DELAY_SECONDS * 1000;

      let selected = null;

      for (
        let i = 0;
        i < frameBuffer.length;
        i++
      ) {

        if (
          frameBuffer[i].time <=
          targetTime
        ) {

          selected =
            frameBuffer[i];

        }
        else {
          break;
        }
      }

      if (
        selected &&
        selected.time !==
          lastFrameTime
      ) {

        try {

          res.write(
            "--frame\\r\\n" +
            "Content-Type: image/jpeg\\r\\n" +
            "Content-Length: " +
            selected.data.length +
            "\\r\\n\\r\\n"
          );

          res.write(
            selected.data
          );

          res.write(
            "\\r\\n"
          );

          lastFrameTime =
            selected.time;

        }
        catch (_) {

          closed = true;

          return;
        }
      }

      setTimeout(
        sendFrame,
        1000 / MJPEG_FPS
      );
    }

    sendFrame();
  }
);

// ======================================================
// 404
// ======================================================

app.use(
  (req, res) => {

    res.status(404)
      .send("Not found");
  }
);

// ======================================================
// START SERVER
// ======================================================

app.listen(
  PORT,
  () => {

    log(
      `Server running on port ${PORT}`
    );

    log(
      `Source: ${source}`
    );

    log(
      `Web: /`
    );

    log(
      `HLS: /hls`
    );

    log(
      `MJPEG: /stream`
    );

    log(
      `MJPEG: ${MJPEG_WIDTH}x${MJPEG_HEIGHT} @ ${MJPEG_FPS} FPS`
    );

    log(
      `Delay: ${DELAY_SECONDS}s`
    );

    startFFmpeg();
  }
);

// ======================================================
// SHUTDOWN
// ======================================================

function shutdown() {

  log(
    "Shutting down..."
  );

  if (ffmpegProcess) {

    try {
      ffmpegProcess.kill(
        "SIGTERM"
      );
    }
    catch (_) {}
  }

  process.exit(0);
}

process.on(
  "SIGTERM",
  shutdown
);

process.on(
  "SIGINT",
  shutdown
);
