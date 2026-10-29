const express = require("express");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 10000;

// =====================================================
// CONFIG
// =====================================================

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


// =====================================================
// MJPEG FRAME BUFFER
// =====================================================

const MAX_FRAMES = FPS * 12;

let frames = [];


// =====================================================
// HLS FFMPEG
// =====================================================

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

  // Video giữ nguyên để giảm CPU
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
  console.log(
    "[HLS]",
    data.toString().trim()
  );
});


// =====================================================
// MJPEG FFMPEG
// =====================================================

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

  // QUAN TRỌNG:
  // fps + scale + pad trong filter
  "-vf",
  `fps=${FPS},scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=decrease,pad=${WIDTH}:${HEIGHT}:(ow-iw)/2:(oh-ih)/2`,

  "-c:v", "mjpeg",

  "-q:v", "8",

  "-f", "image2pipe",

  "pipe:1"
]);

mjpegFFmpeg.stderr.on("data", data => {
  console.log(
    "[MJPEG]",
    data.toString().trim()
  );
});

mjpegFFmpeg.on("close", code => {
  console.log(
    "MJPEG FFmpeg stopped:",
    code
  );
});


// =====================================================
// JPEG PARSER
// =====================================================

let jpegBuffer = Buffer.alloc(0);

mjpegFFmpeg.stdout.on("data", chunk => {

  jpegBuffer = Buffer.concat([
    jpegBuffer,
    chunk
  ]);

  while (true) {

    const start =
      jpegBuffer.indexOf(
        Buffer.from([0xff, 0xd8])
      );

    if (start < 0) {

      // Tránh buffer phình vô hạn
      if (jpegBuffer.length > 2 * 1024 * 1024) {
        jpegBuffer = Buffer.alloc(0);
      }

      return;
    }

    const end =
      jpegBuffer.indexOf(
        Buffer.from([0xff, 0xd9]),
        start + 2
      );

    if (end < 0) {
      return;
    }

    // Lấy NGUYÊN JPEG
    const jpeg = jpegBuffer.slice(
      start,
      end + 2
    );

    // Xóa frame đã xử lý khỏi buffer
    jpegBuffer = jpegBuffer.slice(
      end + 2
    );

    // Chỉ nhận JPEG hợp lệ
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

    // Giữ khoảng 12 giây
    const minTime =
      now - 12000;

    frames = frames.filter(
      frame => frame.time >= minTime
    );

    // Giới hạn frame
    if (frames.length > MAX_FRAMES) {
      frames.splice(
        0,
        frames.length - MAX_FRAMES
      );
    }
  }
});


// =====================================================
// WEB PAGE
// =====================================================

app.get("/", (req, res) => {

  res.send(`
<!DOCTYPE html>

<html lang="vi">

<head>

<meta charset="UTF-8">

<meta name="viewport"
      content="width=device-width,initial-scale=1.0">

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

h2 {
  margin-top: 5px;
}

.box {
  margin-bottom: 25px;
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
  image-rendering: auto;
}

.label {
  margin: 8px 0;
  color: #aaa;
  font-size: 14px;
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

    <div class="label">
      320 × 240 / 10 FPS / ~5 giây delay
    </div>

    <img
      class="mjpeg"
      src="/stream"
      width="320"
      height="240"
      alt="MJPEG Stream">

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


// =====================================================
// HLS PLAYLIST
// =====================================================

app.get("/hls", (req, res) => {

  if (!fs.existsSync(hlsPlaylist)) {
    return res
      .status(503)
      .send("HLS chưa sẵn sàng");
  }

  try {

    let data =
      fs.readFileSync(
        hlsPlaylist,
        "utf8"
      );

    data = data.replace(
      /^([^#\r\n]+\\.ts)$/gm,
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


// =====================================================
// HLS SEGMENT
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


// =====================================================
// MJPEG STREAM
// DÙNG CHO ESP32 + WEB TEST
// =====================================================

app.get("/stream", (req, res) => {

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

  let closed = false;

  req.on("close", () => {
    closed = true;
  });


  // Mỗi client có frame cuối riêng
  let lastSentTime = 0;


  const timer = setInterval(() => {

    if (closed) {
      clearInterval(timer);
      return;
    }

    if (frames.length === 0) {
      return;
    }

    const targetTime =
      Date.now() -
      DELAY_SECONDS * 1000;


    // Tìm frame gần nhất nhưng
    // không vượt quá targetTime

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


    // Nếu buffer chưa đủ 5 giây
    if (!selected) {
      selected = frames[0];
    }


    // Không gửi cùng frame lặp lại
    if (
      selected.time === lastSentTime
    ) {
      return;
    }

    lastSentTime =
      selected.time;


    try {

      res.write(
        "--frame\\r\\n"
      );

      res.write(
        "Content-Type: image/jpeg\\r\\n"
      );

      res.write(
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

    } catch (err) {

      closed = true;

      clearInterval(timer);
    }

  }, 1000 / FPS);


  req.on("error", () => {

    closed = true;

    clearInterval(timer);

  });

});


// =====================================================
// HEALTH
// =====================================================

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
        fs.existsSync(
          hlsPlaylist
        )

    }

  });

});


// =====================================================
// START
// =====================================================

const server =
  app.listen(
    PORT,
    "0.0.0.0",
    () => {

      console.log(
        "Server running on port " +
        PORT
      );

      console.log(
        "HLS: /hls"
      );

      console.log(
        "MJPEG: /stream"
      );

    }
  );


// =====================================================
// SHUTDOWN
// =====================================================

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
