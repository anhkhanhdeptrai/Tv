const express = require("express");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 10000;

// ======================================================
// CONFIG
// ======================================================

const SOURCE =
  "https://amagi-live.ondemandkorea.com/amgplt0456.m3u8";

const WIDTH = 320;
const HEIGHT = 240;
const FPS = 10;

const DELAY_SECONDS = 5;

const HLS_SEGMENT_SECONDS = 2;
const HLS_LIST_SIZE = 8;

const DATA_DIR = path.join(__dirname, "data");
const HLS_DIR = path.join(DATA_DIR, "hls");

fs.mkdirSync(HLS_DIR, { recursive: true });

// Xóa HLS cũ
try {
  for (const file of fs.readdirSync(HLS_DIR)) {
    fs.unlinkSync(path.join(HLS_DIR, file));
  }
} catch (e) {}


// ======================================================
// MJPEG FRAME BUFFER
// ======================================================

const MAX_FRAMES = 120;

const frames = [];


// ======================================================
// HLS FFMPEG
// ======================================================

const hlsPlaylist = path.join(
  HLS_DIR,
  "index.m3u8"
);

const hlsSegment = path.join(
  HLS_DIR,
  "seg-%05d.ts"
);

console.log("Starting HLS FFmpeg...");

const hlsFFmpeg = spawn("ffmpeg", [
  "-hide_banner",
  "-loglevel", "warning",

  "-reconnect", "1",
  "-reconnect_streamed", "1",
  "-reconnect_delay_max", "5",

  "-i", SOURCE,

  "-map", "0:v:0",
  "-map", "0:a:0?",

  // Không encode lại video
  "-c:v", "copy",

  // Audio AAC cho HLS
  "-c:a", "aac",
  "-b:a", "96k",

  "-f", "hls",

  "-hls_time",
  String(HLS_SEGMENT_SECONDS),

  "-hls_list_size",
  String(HLS_LIST_SIZE),

  "-hls_delete_threshold",
  "4",

  "-hls_flags",
  "delete_segments+append_list+independent_segments",

  "-hls_segment_filename",
  hlsSegment,

  hlsPlaylist
]);

hlsFFmpeg.stderr.on("data", data => {
  const msg = data.toString().trim();

  if (msg) {
    console.log("[HLS]", msg);
  }
});

hlsFFmpeg.on("close", code => {
  console.log("HLS FFmpeg stopped:", code);
});


// ======================================================
// MJPEG FFMPEG
// ======================================================

console.log("Starting MJPEG FFmpeg...");

const mjpegFFmpeg = spawn("ffmpeg", [
  "-hide_banner",
  "-loglevel", "warning",

  "-reconnect", "1",
  "-reconnect_streamed", "1",
  "-reconnect_delay_max", "5",

  "-fflags", "nobuffer",
  "-flags", "low_delay",

  "-i", SOURCE,

  "-map", "0:v:0",
  "-an",

  // 320x240 + 10 FPS
  "-vf",
  `fps=${FPS},scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=decrease,pad=${WIDTH}:${HEIGHT}:(ow-iw)/2:(oh-ih)/2`,

  "-c:v", "mjpeg",

  // JPEG quality
  "-q:v", "8",

  "-f", "image2pipe",

  "pipe:1"
]);

mjpegFFmpeg.stderr.on("data", data => {
  const msg = data.toString().trim();

  if (msg) {
    console.log("[MJPEG]", msg);
  }
});

mjpegFFmpeg.on("close", code => {
  console.log("MJPEG FFmpeg stopped:", code);
});


// ======================================================
// JPEG PARSER
// ======================================================

let jpegBuffer = Buffer.alloc(0);

mjpegFFmpeg.stdout.on("data", chunk => {

  jpegBuffer = Buffer.concat([
    jpegBuffer,
    chunk
  ]);

  while (true) {

    // JPEG START
    const start = jpegBuffer.indexOf(
      Buffer.from([0xff, 0xd8])
    );

    if (start === -1) {

      // Không cho buffer phình vô hạn
      if (jpegBuffer.length > 2 * 1024 * 1024) {
        jpegBuffer = Buffer.alloc(0);
      }

      break;
    }

    // Nếu trước JPEG có dữ liệu rác
    if (start > 0) {
      jpegBuffer = jpegBuffer.slice(start);
    }

    // JPEG END
    const end = jpegBuffer.indexOf(
      Buffer.from([0xff, 0xd9]),
      2
    );

    if (end === -1) {
      break;
    }

    // Lấy nguyên JPEG
    const jpeg = Buffer.from(
      jpegBuffer.slice(0, end + 2)
    );

    // Xóa JPEG đã xử lý
    jpegBuffer = jpegBuffer.slice(end + 2);

    // Kiểm tra JPEG
    if (
      jpeg.length < 100 ||
      jpeg[0] !== 0xff ||
      jpeg[1] !== 0xd8 ||
      jpeg[jpeg.length - 2] !== 0xff ||
      jpeg[jpeg.length - 1] !== 0xd9
    ) {
      continue;
    }

    const now = Date.now();

    frames.push({
      time: now,
      data: jpeg
    });

    // ==================================================
    // BỎ FRAME QUÁ CŨ
    // ==================================================

    const oldest =
      now - 12000;

    while (
      frames.length > 0 &&
      frames[0].time < oldest
    ) {
      frames.shift();
    }

    // ==================================================
    // GIỚI HẠN BUFFER
    // ==================================================

    while (
      frames.length > MAX_FRAMES
    ) {
      frames.shift();
    }
  }
});


// ======================================================
// WEB
// ======================================================

app.get("/", (req, res) => {

  res.send(`
<!DOCTYPE html>
<html lang="vi">

<head>

<meta charset="UTF-8">

<meta name="viewport"
      content="width=device-width, initial-scale=1.0">

<title>TV Stream</title>

<style>

body {
  margin: 0;
  background: #111;
  color: white;
  font-family: Arial, sans-serif;
}

.container {
  max-width: 900px;
  margin: auto;
  padding: 20px;
}

.box {
  margin-bottom: 30px;
}

h2 {
  margin: 0 0 10px 0;
}

video {
  display: block;
  width: 100%;
  max-width: 900px;
  background: black;
}

.mjpeg {
  display: block;
  width: 320px;
  height: 240px;
  background: black;
}

.info {
  color: #aaa;
  font-size: 14px;
  margin-bottom: 8px;
}

</style>

</head>

<body>

<div class="container">

  <div class="box">

    <h2>HLS - Video + Audio</h2>

    <video
      id="video"
      controls
      autoplay
      playsinline>
    </video>

  </div>


  <div class="box">

    <h2>MJPEG - ESP32</h2>

    <div class="info">
      320x240 / 10 FPS / delay ~5 giây
    </div>

    <img
      class="mjpeg"
      src="/stream"
      width="320"
      height="240"
      alt="MJPEG">

  </div>

</div>


<script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>

<script>

const video =
  document.getElementById("video");

const hlsUrl = "/hls";

if (
  video.canPlayType(
    "application/vnd.apple.mpegurl"
  )
) {

  video.src = hlsUrl;

} else if (Hls.isSupported()) {

  const hls = new Hls({

    enableWorker: true,

    lowLatencyMode: false,

    liveSyncDurationCount: 3,

    maxBufferLength: 10,

    maxMaxBufferLength: 20

  });

  hls.loadSource(hlsUrl);

  hls.attachMedia(video);

  hls.on(
    Hls.Events.MANIFEST_PARSED,
    () => {
      video.play().catch(() => {});
    }
  );

}

</script>

</body>
</html>
  `);
});


// ======================================================
// HLS PLAYLIST
// ======================================================

app.get("/hls", (req, res) => {

  if (!fs.existsSync(hlsPlaylist)) {
    return res
      .status(503)
      .send("HLS chưa sẵn sàng");
  }

  try {

    let data = fs.readFileSync(
      hlsPlaylist,
      "utf8"
    );

    // Đổi:
    // seg-00001.ts
    //
    // thành:
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

  } catch (err) {

    console.error(err);

    res
      .status(500)
      .send("Không đọc được HLS");
  }
});


// ======================================================
// HLS SEGMENT
// ======================================================

app.get(
  "/hls-segment/:file",
  (req, res) => {

    const file =
      path.basename(req.params.file);

    const filePath =
      path.join(HLS_DIR, file);

    if (!fs.existsSync(filePath)) {
      return res
        .status(404)
        .send("Not found");
    }

    res.setHeader(
      "Content-Type",
      "video/mp2t"
    );

    res.setHeader(
      "Cache-Control",
      "no-cache"
    );

    res.sendFile(filePath);
  }
);


// ======================================================
// MJPEG STREAM
// ======================================================

app.get("/stream", (req, res) => {

  res.status(200);

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

  // Một số client cần header này
  res.flushHeaders();


  let closed = false;

  req.on("close", () => {
    closed = true;
    clearInterval(timer);
  });


  // Frame cuối đã gửi
  let lastSentTime = 0;


  // ====================================================
  // GỬI 10 FPS
  // ====================================================

  const timer = setInterval(() => {

    if (closed) {
      clearInterval(timer);
      return;
    }

    if (frames.length === 0) {
      return;
    }


    // Mốc thời gian 5 giây trước
    const targetTime =
      Date.now() -
      DELAY_SECONDS * 1000;


    // Tìm frame gần target nhất
    let selected = null;

    for (
      let i = frames.length - 1;
      i >= 0;
      i--
    ) {

      if (
        frames[i].time <= targetTime
      ) {

        selected = frames[i];

        break;
      }
    }


    // Nếu chưa đủ buffer 5 giây
    if (!selected) {
      selected = frames[0];
    }


    // Không gửi trùng frame
    if (
      selected.time === lastSentTime
    ) {
      return;
    }

    lastSentTime =
      selected.time;


    // ==================================================
    // MJPEG MULTIPART CHUẨN
    // ==================================================

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
        "\r\n"
      );

      res.write(
        "\r\n"
      );

      res.write(
        selected.data
      );

      res.write(
        "\r\n"
      );

    } catch (err) {

      closed = true;

      clearInterval(timer);
    }

  }, 1000 / FPS);

});


// ======================================================
// HEALTH
// ======================================================

app.get("/health", (req, res) => {

  res.json({

    ok: true,

    source: SOURCE,

    mjpeg: {

      url: "/stream",

      width: WIDTH,

      height: HEIGHT,

      fps: FPS,

      delaySeconds: DELAY_SECONDS,

      bufferedFrames:
        frames.length

    },

    hls: {

      url: "/hls",

      ready:
        fs.existsSync(hlsPlaylist)

    }

  });
});


// ======================================================
// START SERVER
// ======================================================

const server = app.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      "Server running on port " + PORT
    );

    console.log(
      "HLS: /hls"
    );

    console.log(
      "MJPEG: /stream"
    );
  }
);


// ======================================================
// SHUTDOWN
// ======================================================

function shutdown() {

  console.log(
    "Shutting down..."
  );

  try {
    hlsFFmpeg.kill("SIGTERM");
  } catch (e) {}

  try {
    mjpegFFmpeg.kill("SIGTERM");
  } catch (e) {}

  try {
    server.close();
  } catch (e) {}

  process.exit(0);
}

process.on(
  "SIGINT",
  shutdown
);

process.on(
  "SIGTERM",
  shutdown
);
