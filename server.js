const express = require("express");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const app = express();

const PORT = process.env.PORT || 10000;

const source =
  process.env.STREAM_URL ||
  "https://amagi-live.ondemandkorea.com/amgplt0456.m3u8";

// ======================================================
// CONFIG
// ======================================================

const DELAY_SECONDS = 15;

const MJPEG_WIDTH = 320;
const MJPEG_HEIGHT = 240;
const MJPEG_FPS = 10;

const HLS_SEGMENT_SECONDS = 4;
const HLS_LIST_SIZE = 20;

// ======================================================
// PATH
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

const MAX_FRAME_BUFFER = 25;

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
    fs.mkdirSync(HLS_DIR, {
      recursive: true
    });

    for (const file of fs.readdirSync(HLS_DIR)) {
      try {
        fs.unlinkSync(
          path.join(HLS_DIR, file)
        );
      } catch (_) {}
    }
  } catch (err) {
    console.error(
      "[HLS CLEAN]",
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

  log("[FFMPEG] Starting");
  log("[FFMPEG] Source:", source);

  const args = [

    "-hide_banner",

    // --------------------------------------------------
    // NETWORK
    // --------------------------------------------------

    "-reconnect",
    "1",

    "-reconnect_streamed",
    "1",

    "-reconnect_delay_max",
    "5",

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
    // MJPEG
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

    "-f",
    "image2pipe",

    "-c:v",
    "mjpeg",

    "pipe:1",

    // ==================================================
    // OUTPUT 2
    // HLS
    // ==================================================

    "-map",
    "0:v:0",

    // Audio OPTIONAL
    // Nếu nguồn có audio -> lấy audio
    // Nếu không có -> FFmpeg vẫn chạy
    "-map",
    "0:a:0?",

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
  // MJPEG PIPE
  // ==================================================

  let jpegBuffer =
    Buffer.alloc(0);

  ffmpegProcess.stdout.on(
    "data",
    (chunk) => {

      jpegBuffer =
        Buffer.concat([
          jpegBuffer,
          chunk
        ]);

      while (true) {

        const start =
          jpegBuffer.indexOf(
            Buffer.from([
              0xff,
              0xd8
            ])
          );

        if (start === -1) {
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

        if (end === -1) {
          break;
        }

        const jpeg =
          jpegBuffer.slice(
            start,
            end + 2
          );

        jpegBuffer =
          jpegBuffer.slice(
            end + 2
          );

        totalFrames++;

        frameBuffer.push({
          time: Date.now(),
          data: jpeg
        });

        // Không giữ quá nhiều frame
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
  // FFMPEG LOG
  // ==================================================

  ffmpegProcess.stderr.on(
    "data",
    (data) => {

      process.stdout.write(
        `[FFMPEG] ${data}`
      );
    }
  );

  ffmpegProcess.on(
    "error",
    (err) => {

      console.error(
        "[FFMPEG ERROR]",
        err.message
      );
    }
  );

  ffmpegProcess.on(
    "close",
    (code, signal) => {

      log(
        `[FFMPEG] exited code=${code} signal=${signal}`
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

function getPlaylist() {

  const file =
    path.join(
      HLS_DIR,
      "index.m3u8"
    );

  if (!fs.existsSync(file)) {
    return null;
  }

  let playlist =
    fs.readFileSync(
      file,
      "utf8"
    );

  /*
   * QUAN TRỌNG:
   *
   * FFmpeg ghi:
   *
   * seg-00001.ts
   *
   * Nhưng browser cần:
   *
   * /hls-segment/seg-00001.ts
   */

  playlist =
    playlist.replace(
      /^([^#\r\n]+\.ts)$/gm,
      "/hls-segment/$1"
    );

  return playlist;
}

// ======================================================
// DELAY PLAYLIST
// ======================================================

function getDelayedPlaylist() {

  const file =
    path.join(
      HLS_DIR,
      "index.m3u8"
    );

  if (!fs.existsSync(file)) {
    return null;
  }

  let playlist =
    fs.readFileSync(
      file,
      "utf8"
    );

  const lines =
    playlist.split(/\r?\n/);

  const segmentPairs = [];

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

      segmentPairs.push({
        info: lines[i],
        file: lines[i + 1]
      });

      i++;
    }
  }

  const keepCount =
    Math.max(
      1,
      segmentPairs.length -
      Math.floor(
        DELAY_SECONDS /
        HLS_SEGMENT_SECONDS
      )
    );

  /*
   * Nếu chưa đủ buffer thì dùng playlist hiện tại.
   */

  if (
    segmentPairs.length <=
    keepCount
  ) {

    return getPlaylist();
  }

  const header = [];

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
      break;
    }

    if (lines[i].trim() !== "") {
      header.push(lines[i]);
    }
  }

  const selected =
    segmentPairs.slice(
      0,
      keepCount
    );

  const output = [
    ...header
  ];

  for (const seg of selected) {

    output.push(
      seg.info
    );

    output.push(
      "/hls-segment/" +
      seg.file
    );
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

      bufferFrames:
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
// WEB
// ======================================================

app.get(
  "/",
  (req, res) => {

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
  font-family: Arial;
}

body {
  text-align: center;
}

video {
  width: 100%;
  max-width: 960px;
  background: #000;
}

button {
  margin: 15px;
  padding: 12px 25px;
  font-size: 18px;
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

<br>

<button id="play">
▶ PHÁT
</button>

<p>
HLS Video + Audio
</p>

<script>

const video =
  document.getElementById("video");

const button =
  document.getElementById("play");

let hls = null;

function start() {

  if (
    video.canPlayType(
      "application/vnd.apple.mpegurl"
    )
  ) {

    video.src = "/hls";

    return;
  }

  if (
    Hls.isSupported()
  ) {

    hls = new Hls({

      enableWorker: true,

      lowLatencyMode: false,

      maxBufferLength: 30,

      maxMaxBufferLength: 60,

      backBufferLength: 30

    });

    hls.loadSource(
      "/hls"
    );

    hls.attachMedia(
      video
    );

    hls.on(
      Hls.Events.MANIFEST_PARSED,
      function () {

        console.log(
          "HLS READY"
        );
      }
    );

    hls.on(
      Hls.Events.ERROR,
      function (
        event,
        data
      ) {

        console.log(
          "HLS ERROR",
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
}

button.onclick =
  async function () {

    try {

      await video.play();

      button.style.display =
        "none";

    } catch (e) {

      console.error(e);

      alert(
        "Không thể phát video"
      );
    }
  };

start();

</script>

</body>

</html>
`);
  }
);

// ======================================================
// HLS
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

    res.send(
      playlist
    );
  }
);

// ======================================================
// HLS SEGMENT
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
// MJPEG
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

    let lastTime = 0;

    req.on(
      "close",
      () => {
        closed = true;
      }
    );

    function send() {

      if (closed) {
        return;
      }

      const target =
        Date.now() -
        DELAY_SECONDS * 1000;

      let selected = null;

      /*
       * Tìm frame cũ nhất nhưng vẫn
       * gần mốc delay.
       */

      for (
        let i = 0;
        i < frameBuffer.length;
        i++
      ) {

        if (
          frameBuffer[i].time <=
          target
        ) {

          selected =
            frameBuffer[i];

        } else {

          break;
        }
      }

      if (
        selected &&
        selected.time !== lastTime
      ) {

        try {

          res.write(
            "--frame\r\n" +
            "Content-Type: image/jpeg\r\n" +
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

          lastTime =
            selected.time;

        } catch (_) {

          closed = true;

          return;
        }
      }

      setTimeout(
        send,
        1000 / MJPEG_FPS
      );
    }

    send();
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
// START
// ======================================================

app.listen(
  PORT,
  () => {

    log(
      `Server running :${PORT}`
    );

    log(
      `Source: ${source}`
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
    "Stopping..."
  );

  if (ffmpegProcess) {

    try {
      ffmpegProcess.kill(
        "SIGTERM"
      );
    } catch (_) {}
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
