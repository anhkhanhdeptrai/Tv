const express = require("express");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const app = express();

const PORT = process.env.PORT || 10000;

const DEFAULT_URL =
  "https://amagi-live.ondemandkorea.com/amgplt0456.m3u8";

// =========================
// CONFIG
// =========================

const WIDTH = 320;
const HEIGHT = 240;

const FPS = 10;

// MJPEG chạy sau nguồn khoảng 5 giây
const DELAY_SECONDS = 5;

// HLS segment
const HLS_SEGMENT_SECONDS = 2;

// Giữ khoảng 20 segment = 40 giây
const HLS_LIST_SIZE = 20;

const DATA_DIR = path.join(__dirname, "data");
const HLS_DIR = path.join(DATA_DIR, "hls");

fs.mkdirSync(HLS_DIR, { recursive: true });

// Xóa HLS cũ
try {
  for (const file of fs.readdirSync(HLS_DIR)) {
    fs.unlinkSync(path.join(HLS_DIR, file));
  }
} catch (e) {}


// =========================
// SOURCE
// =========================

const source =
  process.env.STREAM_URL ||
  DEFAULT_URL;

console.log("[SOURCE]", source);


// =========================
// FRAME BUFFER
// =========================

const frames = [];

const MAX_FRAMES = 100;

function addFrame(buffer) {
  frames.push({
    time: Date.now(),
    data: buffer
  });

  while (frames.length > MAX_FRAMES) {
    frames.shift();
  }
}


// =========================
// FFMPEG
// =========================

const ffmpegArgs = [

  // -------------------------
  // INPUT
  // -------------------------

  "-hide_banner",

  "-loglevel",
  "warning",

  "-reconnect",
  "1",

  "-reconnect_streamed",
  "1",

  "-reconnect_delay_max",
  "5",

  // HLS master có nhiều variant.
  // Chọn variant đầu tiên.
  "-map_metadata",
  "-1",

  "-i",
  source,


  // =====================================================
  // OUTPUT 1
  // MJPEG 320x240 10 FPS
  // =====================================================

  "-map",
  "0:v:0",

  "-an",

  "-vf",
  `fps=${FPS},scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=decrease,pad=${WIDTH}:${HEIGHT}:(ow-iw)/2:(oh-ih)/2`,

  "-c:v",
  "mjpeg",

  "-q:v",
  "12",

  "-fps_mode",
  "cfr",

  "-f",
  "image2pipe",

  "pipe:1",


  // =====================================================
  // OUTPUT 2
  // HLS VIDEO + AUDIO
  // =====================================================

  "-map",
  "0:v:0",

  "-map",
  "0:a:0?",

  "-c:v",
  "libx264",

  "-preset",
  "ultrafast",

  "-tune",
  "zerolatency",

  "-pix_fmt",
  "yuv420p",

  "-profile:v",
  "main",

  "-level",
  "3.1",

  "-b:v",
  "900k",

  "-maxrate",
  "1000k",

  "-bufsize",
  "2000k",

  // GOP 2 giây
  "-g",
  "50",

  "-keyint_min",
  "50",

  "-sc_threshold",
  "0",

  // AUDIO
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
  "delete_segments+append_list+independent_segments",

  "-hls_segment_filename",
  path.join(HLS_DIR, "seg-%05d.ts"),

  path.join(HLS_DIR, "index.m3u8")
];


console.log("[FFMPEG START]");

const ffmpeg = spawn("ffmpeg", ffmpegArgs, {
  stdio: ["ignore", "pipe", "pipe"]
});


// =========================
// FFMPEG LOG
// =========================

ffmpeg.stderr.on("data", (data) => {
  process.stdout.write("[FFMPEG] " + data.toString());
});

ffmpeg.on("error", (err) => {
  console.error("[FFMPEG ERROR]", err);
});

ffmpeg.on("close", (code, signal) => {
  console.log(
    `[FFMPEG EXIT] code=${code} signal=${signal}`
  );
});


// =========================
// JPEG PARSER
// =========================

let jpegBuffer = Buffer.alloc(0);

ffmpeg.stdout.on("data", (chunk) => {

  jpegBuffer = Buffer.concat([
    jpegBuffer,
    chunk
  ]);

  while (true) {

    const start = jpegBuffer.indexOf(
      Buffer.from([0xff, 0xd8])
    );

    if (start < 0) {
      break;
    }

    const end = jpegBuffer.indexOf(
      Buffer.from([0xff, 0xd9]),
      start + 2
    );

    if (end < 0) {
      break;
    }

    const jpeg = jpegBuffer.subarray(
      start,
      end + 2
    );

    addFrame(Buffer.from(jpeg));

    jpegBuffer = jpegBuffer.subarray(
      end + 2
    );
  }

});


// =========================
// HEALTH
// =========================

app.get("/health", (req, res) => {

  const playlist =
    path.join(HLS_DIR, "index.m3u8");

  res.json({
    ok: true,
    source,
    mjpeg: `${WIDTH}x${HEIGHT}`,
    fps: FPS,
    delay: DELAY_SECONDS,
    frames: frames.length,
    hls: fs.existsSync(playlist)
  });

});


// =========================
// HOME
// =========================

app.get("/", (req, res) => {

  res.send(`
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport"
      content="width=device-width,initial-scale=1">

<title>TV Stream</title>

<style>
body {
  margin: 0;
  background: #000;
  color: white;
  font-family: Arial;
  text-align: center;
}

video {
  width: 100%;
  max-width: 960px;
  background: black;
}

img {
  width: 320px;
  height: 240px;
  object-fit: contain;
  margin-top: 20px;
}
</style>

</head>

<body>

<h3>TV HLS</h3>

<video
  id="video"
  controls
  autoplay
  muted>
</video>

<h3>MJPEG 320x240</h3>

<img src="/stream">

<script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>

<script>

const video = document.getElementById("video");

if (video.canPlayType("application/vnd.apple.mpegurl")) {

  video.src = "/hls";

} else if (Hls.isSupported()) {

  const hls = new Hls({
    liveSyncDurationCount: 3,
    maxLiveSyncPlaybackRate: 1.1
  });

  hls.loadSource("/hls");
  hls.attachMedia(video);

}

</script>

</body>
</html>
`);

});


// =========================
// HLS PLAYLIST
// =========================

app.get("/hls", (req, res) => {

  const playlist =
    path.join(HLS_DIR, "index.m3u8");

  if (!fs.existsSync(playlist)) {

    return res.status(503).send(
      "HLS chưa sẵn sàng"
    );

  }

  let data =
    fs.readFileSync(playlist, "utf8");

  // Chuyển:
  //
  // seg-00001.ts
  //
  // thành:
  //
  // /hls-segment/seg-00001.ts

  data = data.replace(
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

});


// =========================
// HLS SEGMENTS
// =========================

app.get("/hls-segment/:file", (req, res) => {

  const file = path.basename(req.params.file);

  const fullPath =
    path.join(HLS_DIR, file);

  if (!fs.existsSync(fullPath)) {

    return res.status(404).send(
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

  fs.createReadStream(fullPath)
    .pipe(res);

});


// =========================
// MJPEG
// =========================

app.get("/stream", async (req, res) => {

  res.writeHead(200, {
    "Content-Type":
      "multipart/x-mixed-replace; boundary=frame",

    "Cache-Control":
      "no-cache, no-store, must-revalidate",

    "Pragma":
      "no-cache",

    "Connection":
      "close"
  });


  const targetDelay =
    DELAY_SECONDS * 1000;


  let lastFrameTime = 0;


  const sendFrame = () => {

    if (res.destroyed) {
      return;
    }


    const now =
      Date.now();


    // Chọn frame đã cũ ít nhất 5 giây
    let selected = null;


    for (let i = frames.length - 1; i >= 0; i--) {

      const frame = frames[i];

      if (
        frame.time <=
        now - targetDelay
      ) {

        selected = frame;
        break;

      }

    }


    if (
      selected &&
      selected.time !== lastFrameTime
    ) {

      lastFrameTime =
        selected.time;


      res.write(
        `--frame\r\n` +
        `Content-Type: image/jpeg\r\n` +
        `Content-Length: ${selected.data.length}\r\n\r\n`
      );

      res.write(
        selected.data
      );

      res.write("\r\n");

    }

  };


  const timer =
    setInterval(
      sendFrame,
      Math.max(
        1000 / FPS,
        50
      )
    );


  req.on("close", () => {

    clearInterval(timer);

  });

});


// =========================
// START
// =========================

app.listen(PORT, () => {

  console.log(
    `Server running on port ${PORT}`
  );

  console.log(
    `MJPEG: /stream`
  );

  console.log(
    `HLS: /hls`
  );

});

 
