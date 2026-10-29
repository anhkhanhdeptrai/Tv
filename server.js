const express = require("express");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const app = express();

const PORT = process.env.PORT || 10000;

// ======================================================
// CONFIG
// ======================================================

const DEFAULT_URL =
  "https://amagi-live.ondemandkorea.com/amgplt0456.m3u8";

const DELAY_SECONDS = 15;

// HLS
const SEGMENT_SECONDS = 4;
const HLS_LIST_SIZE = 20;

// MJPEG
const MJPEG_FPS = 8;
const MJPEG_WIDTH = 320;
const MJPEG_HEIGHT = 240;

// ======================================================
// DIRECTORIES
// ======================================================

const DATA_DIR = path.join(__dirname, "data");
const HLS_DIR = path.join(DATA_DIR, "hls");

fs.mkdirSync(HLS_DIR, { recursive: true });

// ======================================================
// STATE
// ======================================================

let source = DEFAULT_URL;

let hlsProcess = null;
let mjpegProcess = null;

let frameCount = 0;

const frameBuffer = [];

const MAX_BUFFER_FRAMES = 200;

// ======================================================
// HELPERS
// ======================================================

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function killProcess(proc) {
  if (!proc) return;

  try {
    proc.kill("SIGTERM");
  } catch (_) {}

  setTimeout(() => {
    try {
      if (!proc.killed) proc.kill("SIGKILL");
    } catch (_) {}
  }, 3000);
}

function cleanHlsDirectory() {
  try {
    if (!fs.existsSync(HLS_DIR)) {
      fs.mkdirSync(HLS_DIR, { recursive: true });
      return;
    }

    for (const file of fs.readdirSync(HLS_DIR)) {
      try {
        fs.unlinkSync(path.join(HLS_DIR, file));
      } catch (_) {}
    }
  } catch (err) {
    console.error("HLS cleanup error:", err.message);
  }
}

// ======================================================
// HLS
// ======================================================

function startHLS() {
  if (hlsProcess) {
    log("[HLS] Already running");
    return;
  }

  cleanHlsDirectory();

  log("[HLS] Starting:", source);

  const segmentPattern = path.join(
    HLS_DIR,
    "seg-%03d.ts"
  );

  const args = [
    "-hide_banner",

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

    "-i",
    source,

    // Video
    "-map",
    "0:v:0",

    // Audio nếu nguồn có audio
    "-map",
    "0:a:0?",

    // Giữ nguyên video để giảm CPU
    "-c:v",
    "copy",

    // Chuyển audio sang AAC cho trình duyệt
    "-c:a",
    "aac",
    "-b:a",
    "96k",
    "-ac",
    "2",

    "-f",
    "hls",

    "-hls_time",
    String(SEGMENT_SECONDS),

    "-hls_list_size",
    String(HLS_LIST_SIZE),

    "-hls_delete_threshold",
    "10",

    "-hls_flags",
    "delete_segments+append_list",

    "-hls_segment_filename",
    segmentPattern,

    path.join(HLS_DIR, "index.m3u8")
  ];

  hlsProcess = spawn("ffmpeg", args, {
    stdio: ["ignore", "pipe", "pipe"]
  });

  hlsProcess.stdout.on("data", (data) => {
    process.stdout.write(`[HLS] ${data}`);
  });

  hlsProcess.stderr.on("data", (data) => {
    process.stdout.write(`[HLS] ${data}`);
  });

  hlsProcess.on("error", (err) => {
    console.error("[HLS] Process error:", err.message);
  });

  hlsProcess.on("close", (code, signal) => {
    log(
      `[HLS] FFmpeg exited code=${code} signal=${signal}`
    );

    hlsProcess = null;

    setTimeout(() => {
      startHLS();
    }, 3000);
  });
}

// ======================================================
// MJPEG
// ======================================================

function startMJPEG() {
  if (mjpegProcess) {
    log("[MJPEG] Already running");
    return;
  }

  log("[MJPEG] Starting:", source);

  const args = [
    "-hide_banner",

    "-loglevel",
    "warning",

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

    "-i",
    source,

    "-an",

    "-vf",
    `fps=${MJPEG_FPS},scale=${MJPEG_WIDTH}:${MJPEG_HEIGHT}:force_original_aspect_ratio=decrease,pad=${MJPEG_WIDTH}:${MJPEG_HEIGHT}:(ow-iw)/2:(oh-ih)/2`,

    "-q:v",
    "8",

    "-f",
    "image2pipe",

    "-vcodec",
    "mjpeg",

    "pipe:1"
  ];

  mjpegProcess = spawn("ffmpeg", args, {
    stdio: ["ignore", "pipe", "pipe"]
  });

  let buffer = Buffer.alloc(0);

  mjpegProcess.stdout.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);

    while (true) {
      const start = buffer.indexOf(
        Buffer.from([0xff, 0xd8])
      );

      if (start === -1) {
        break;
      }

      const end = buffer.indexOf(
        Buffer.from([0xff, 0xd9]),
        start + 2
      );

      if (end === -1) {
        break;
      }

      const jpeg = buffer.slice(
        start,
        end + 2
      );

      buffer = buffer.slice(end + 2);

      frameCount++;

      frameBuffer.push({
        time: Date.now(),
        data: jpeg
      });

      while (frameBuffer.length > MAX_BUFFER_FRAMES) {
        frameBuffer.shift();
      }
    }
  });

  mjpegProcess.stderr.on("data", (data) => {
    process.stdout.write(`[MJPEG] ${data}`);
  });

  mjpegProcess.on("error", (err) => {
    console.error(
      "[MJPEG] Process error:",
      err.message
    );
  });

  mjpegProcess.on("close", (code, signal) => {
    log(
      `[MJPEG] FFmpeg exited code=${code} signal=${signal}; frames=${frameCount}`
    );

    mjpegProcess = null;

    setTimeout(() => {
      startMJPEG();
    }, 3000);
  });
}

// ======================================================
// HLS PLAYLIST DELAY
// ======================================================

function getDelayedPlaylist() {
  const playlistPath = path.join(
    HLS_DIR,
    "index.m3u8"
  );

  if (!fs.existsSync(playlistPath)) {
    return null;
  }

  let playlist = fs.readFileSync(
    playlistPath,
    "utf8"
  );

  const lines = playlist
    .split("\n")
    .filter(Boolean);

  const targetSegments = Math.ceil(
    DELAY_SECONDS / SEGMENT_SECONDS
  );

  const output = [];

  let segmentCount = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith("#EXTINF:")) {
      segmentCount++;

      // Chờ đủ segment để tạo delay
      if (segmentCount <= targetSegments) {
        continue;
      }

      output.push(line);

      if (i + 1 < lines.length) {
        output.push(lines[++i]);
      }

      continue;
    }

    if (
      line.startsWith("#EXTM3U") ||
      line.startsWith("#EXT-X-VERSION") ||
      line.startsWith("#EXT-X-TARGETDURATION") ||
      line.startsWith("#EXT-X-MEDIA-SEQUENCE") ||
      line.startsWith("#EXT-X-DISCONTINUITY-SEQUENCE")
    ) {
      output.push(line);
    }
  }

  if (
    !output.some((line) =>
      line.startsWith("#EXT-X-TARGETDURATION")
    )
  ) {
    return playlist;
  }

  return output.join("\n") + "\n";
}

// ======================================================
// ROUTES
// ======================================================

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    source,
    hls: !!hlsProcess,
    mjpeg: !!mjpegProcess,
    frames: frameCount,
    bufferFrames: frameBuffer.length,
    delaySeconds: DELAY_SECONDS
  });
});

// ======================================================
// WEB PLAYER
// ======================================================

app.get("/", (req, res) => {
  const safeSource = String(source)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;");

  res.send(`
<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="UTF-8">

<meta
  name="viewport"
  content="width=device-width,initial-scale=1"
/>

<title>TV Stream</title>

<script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>

<style>
html,body {
  margin:0;
  padding:0;
  background:#000;
  color:#fff;
  font-family:Arial,sans-serif;
}

body {
  display:flex;
  flex-direction:column;
  align-items:center;
}

h2 {
  margin:15px 0;
}

video {
  width:100%;
  max-width:900px;
  height:auto;
  background:#000;
}

.info {
  width:100%;
  max-width:900px;
  padding:12px;
  box-sizing:border-box;
  text-align:center;
}

button {
  padding:12px 20px;
  border:0;
  border-radius:6px;
  font-size:16px;
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
  <button id="play">▶ Phát</button>
  <p>
    Nếu trình duyệt yêu cầu, hãy bấm Phát để kích hoạt âm thanh.
  </p>
</div>

<script>

const video = document.getElementById("video");
const playButton = document.getElementById("play");

const source = "${safeSource}";

function startPlayer() {

  if (video.canPlayType("application/vnd.apple.mpegurl")) {

    video.src = "/hls";

    video.addEventListener(
      "loadedmetadata",
      () => {
        console.log("HLS loaded");
      }
    );

  } else if (Hls.isSupported()) {

    const hls = new Hls({
      enableWorker: true,
      lowLatencyMode: false,

      maxBufferLength: 30,
      maxMaxBufferLength: 60,

      backBufferLength: 30,

      liveSyncDurationCount: 3,

      liveMaxLatencyDurationCount: 8
    });

    hls.loadSource("/hls");
    hls.attachMedia(video);

    hls.on(
      Hls.Events.MANIFEST_PARSED,
      function () {
        console.log("HLS manifest loaded");
      }
    );

    hls.on(
      Hls.Events.ERROR,
      function (event, data) {
        console.log("HLS error:", data);

        if (
          data.fatal &&
          data.type === Hls.ErrorTypes.NETWORK_ERROR
        ) {
          console.log("Retry HLS network");
          hls.startLoad();
        }

        if (
          data.fatal &&
          data.type === Hls.ErrorTypes.MEDIA_ERROR
        ) {
          console.log("Recover media");
          hls.recoverMediaError();
        }
      }
    );

  } else {

    alert(
      "Trình duyệt không hỗ trợ HLS."
    );
  }
}

playButton.addEventListener(
  "click",
  async () => {

    try {

      await video.play();

      playButton.style.display =
        "none";

    } catch (err) {

      console.error(err);

      alert(
        "Không thể phát. Hãy bấm Play trên video."
      );
    }
  }
);

startPlayer();

</script>

</body>
</html>
  `);
});

// ======================================================
// HLS PLAYLIST
// ======================================================

app.get("/hls", (req, res) => {

  const playlist = getDelayedPlaylist();

  if (!playlist) {

    res.status(503).send(
      "#EXTM3U\n#EXT-X-VERSION:3\n"
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

  res.send(playlist);
});

// ======================================================
// HLS SEGMENTS
// ======================================================

app.get(
  "/hls-segment/:file",
  (req, res) => {

    const file = path.basename(
      req.params.file
    );

    const filePath = path.join(
      HLS_DIR,
      file
    );

    if (!fs.existsSync(filePath)) {
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

app.get("/stream", (req, res) => {

  res.writeHead(200, {
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
  });

  let closed = false;

  req.on("close", () => {
    closed = true;
  });

  function sendFrame() {

    if (closed) return;

    const targetTime =
      Date.now() -
      DELAY_SECONDS * 1000;

    let selected = null;

    // Tìm frame đã đủ thời gian delay
    for (let i = 0; i < frameBuffer.length; i++) {

      if (
        frameBuffer[i].time <= targetTime
      ) {
        selected = frameBuffer[i];
      } else {
        break;
      }
    }

    if (selected) {

      try {

        res.write(
          "--frame\r\n" +
          "Content-Type: image/jpeg\r\n" +
          "Content-Length: " +
          selected.data.length +
          "\r\n\r\n"
        );

        res.write(selected.data);

        res.write("\r\n");

      } catch (_) {

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
});

// ======================================================
// 404
// ======================================================

app.use((req, res) => {
  res.status(404).send("Not found");
});

// ======================================================
// START
// ======================================================

app.listen(PORT, () => {

  log(
    `Server running on port ${PORT}`
  );

  log(
    `Source: ${source}`
  );

  log(
    `HLS: /hls`
  );

  log(
    `MJPEG: /stream`
  );

  log(
    `Delay: ${DELAY_SECONDS}s`
  );

  startHLS();
  startMJPEG();
});

// ======================================================
// SHUTDOWN
// ======================================================

function shutdown() {

  log("Shutting down...");

  killProcess(hlsProcess);
  killProcess(mjpegProcess);

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

