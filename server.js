const express = require("express");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 10000;

// =========================
// CONFIG
// =========================

const SOURCE =
  "https://amagi-live.ondemandkorea.com/amgplt0456.m3u8";

const WIDTH = 320;
const HEIGHT = 240;
const FPS = 10;

// MJPEG delay
const DELAY_SECONDS = 5;

// HLS
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


// =========================
// MJPEG FRAME BUFFER
// =========================

// Giữ tối đa 12 giây
const MAX_FRAMES = FPS * 12;

const frames = [];

// =========================
// FFMPEG HLS
// =========================

const hlsPlaylist = path.join(HLS_DIR, "index.m3u8");
const hlsSegment = path.join(HLS_DIR, "seg-%05d.ts");

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

  // Không encode lại video -> giảm CPU
  "-c:v", "copy",

  // Encode audio sang AAC để HLS tương thích tốt hơn
  "-c:a", "aac",
  "-b:a", "96k",

  "-f", "hls",

  "-hls_time", String(HLS_SEGMENT_SECONDS),
  "-hls_list_size", String(HLS_LIST_SIZE),
  "-hls_delete_threshold", "4",

  "-hls_flags",
  "delete_segments+append_list+independent_segments",

  "-hls_segment_filename",
  hlsSegment,

  hlsPlaylist
]);

hlsFFmpeg.stderr.on("data", data => {
  console.log("[HLS]", data.toString().trim());
});

hlsFFmpeg.on("close", code => {
  console.log("HLS FFmpeg stopped:", code);
});


// =========================
// FFMPEG MJPEG
// =========================

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

  // FPS + resize
  "-vf",
  `fps=${FPS},scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=decrease,pad=${WIDTH}:${HEIGHT}:(ow-iw)/2:(oh-ih)/2`,

  "-c:v", "mjpeg",

  // Chất lượng JPEG
  // số càng nhỏ = chất lượng cao hơn = file lớn hơn
  "-q:v", "8",

  // Không dùng -r ở output nữa
  "-fps_mode", "vfr",

  "-f", "image2pipe",

  "pipe:1"
]);

mjpegFFmpeg.stderr.on("data", data => {
  console.log("[MJPEG]", data.toString().trim());
});

mjpegFFmpeg.on("close", code => {
  console.log("MJPEG FFmpeg stopped:", code);
});


// =========================
// JPEG PARSER
// =========================

let buffer = Buffer.alloc(0);

mjpegFFmpeg.stdout.on("data", chunk => {

  buffer = Buffer.concat([buffer, chunk]);

  while (true) {

    // JPEG bắt đầu FF D8
    const start = buffer.indexOf(Buffer.from([0xff, 0xd8]));

    if (start === -1) {

      // Không giữ buffer vô hạn
      if (buffer.length > 1024 * 1024) {
        buffer = Buffer.alloc(0);
      }

      break;
    }

    // JPEG kết thúc FF D9
    const end = buffer.indexOf(
      Buffer.from([0xff, 0xd9]),
      start + 2
    );

    if (end === -1) {
      break;
    }

    const jpeg = buffer.slice(start, end + 2);

    buffer = buffer.slice(end + 2);

    // =========================
    // THÊM FRAME
    // =========================

    const now = Date.now();

    frames.push({
      time: now,
      data: jpeg
    });

    // =========================
    // BỎ FRAME QUÁ CŨ
    // =========================

    const oldestAllowed =
      now - 12000;

    while (
      frames.length > 0 &&
      frames[0].time < oldestAllowed
    ) {
      frames.shift();
    }

    // =========================
    // GIỚI HẠN SỐ FRAME
    // =========================

    while (frames.length > MAX_FRAMES) {
      frames.shift();
    }

  }
});


// =========================
// EXPRESS
// =========================

app.use(express.static(path.join(__dirname, "public")));


// =========================
// WEB PAGE
// =========================

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
  text-align: center;
}

.container {
  max-width: 900px;
  margin: auto;
  padding: 20px;
}

h2 {
  margin-bottom: 15px;
}

video {
  width: 100%;
  max-width: 900px;
  background: black;
}

.info {
  margin-top: 10px;
  color: #aaa;
  font-size: 14px;
}

</style>

</head>

<body>

<div class="container">

<h2>TV Online</h2>

<video
  id="video"
  controls
  autoplay
  playsinline>
</video>

<div class="info">
  HLS • Video + Audio
</div>

</div>


<script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>

<script>

const video = document.getElementById("video");

const hlsUrl = "/hls";

if (video.canPlayType("application/vnd.apple.mpegurl")) {

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

  hls.on(Hls.Events.MANIFEST_PARSED, () => {

    video.play().catch(() => {});

  });

} else {

  document.body.innerHTML +=
    "<p>Trình duyệt không hỗ trợ HLS.</p>";

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

  if (!fs.existsSync(hlsPlaylist)) {
    return res.status(503).send(
      "HLS chưa sẵn sàng"
    );
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

    res.status(500).send(
      "Không đọc được HLS"
    );

  }

});


// =========================
// HLS SEGMENTS
// =========================

app.get("/hls-segment/:file", (req, res) => {

  const file = path.basename(req.params.file);

  const filePath = path.join(
    HLS_DIR,
    file
  );

  if (!fs.existsSync(filePath)) {
    return res.status(404).send("Not found");
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

});


// =========================
// MJPEG STREAM FOR ESP32
// =========================

app.get("/stream", (req, res) => {

  res.writeHead(200, {

    "Content-Type":
      "multipart/x-mixed-replace; boundary=frame",

    "Cache-Control":
      "no-cache, no-store, must-revalidate",

    "Pragma":
      "no-cache",

    "Connection":
      "keep-alive"

  });

  let closed = false;

  req.on("close", () => {
    closed = true;
  });


  // =========================
  // GỬI FRAME
  // =========================

  const sendFrame = () => {

    if (closed) {
      clearInterval(timer);
      return;
    }

    if (frames.length === 0) {
      return;
    }

    const targetTime =
      Date.now() - DELAY_SECONDS * 1000;


    // =========================
    // TÌM FRAME CÁCH 5 GIÂY
    // =========================

    let selected = null;

    for (let i = frames.length - 1; i >= 0; i--) {

      if (frames[i].time <= targetTime) {

        selected = frames[i];

        break;
      }

    }


    // Nếu chưa đủ 5 giây buffer
    // thì lấy frame đầu tiên

    if (!selected) {
      selected = frames[0];
    }


    // =========================
    // GỬI JPEG
    // =========================

    try {

      res.write(
        "--frame\\r\\n" +
        "Content-Type: image/jpeg\\r\\n" +
        "Content-Length: " +
        selected.data.length +
        "\\r\\n\\r\\n"
      );

      res.write(selected.data);

      res.write("\\r\\n");

    } catch (err) {

      clearInterval(timer);
      closed = true;

    }

  };


  // 10 FPS
  const timer = setInterval(
    sendFrame,
    1000 / FPS
  );

});


// =========================
// HEALTH
// =========================

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

      framesBuffered: frames.length

    },

    hls: {

      url: "/hls",

      ready: fs.existsSync(hlsPlaylist)

    }

  });

});


// =========================
// START SERVER
// =========================

const server = app.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      `Server running on port ${PORT}`
    );

    console.log(
      `MJPEG: /stream`
    );

    console.log(
      `HLS: /hls`
    );

  }
);


// =========================
// SHUTDOWN
// =========================

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
