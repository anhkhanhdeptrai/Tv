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

const HLS_TIME = 2;
const HLS_LIST = 8;

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
// FRAME BUFFER
// ======================================================
//
// Chỉ giữ khoảng 7 giây.
// Không giữ hàng chục giây để tránh bị trễ.
// ======================================================

const MAX_BUFFER_FRAMES =
  FPS * 7;

let frames = [];


// ======================================================
// START ONE FFMPEG
// ======================================================

const playlist =
  path.join(HLS_DIR, "index.m3u8");

const segment =
  path.join(HLS_DIR, "seg-%05d.ts");

console.log("Starting FFmpeg...");

const ffmpeg = spawn("ffmpeg", [

  "-hide_banner",

  "-loglevel",
  "warning",

  // ====================================================
  // INPUT RECONNECT
  // ====================================================

  "-reconnect",
  "1",

  "-reconnect_streamed",
  "1",

  "-reconnect_delay_max",
  "5",

  // Giảm input buffering
  "-fflags",
  "nobuffer",

  "-i",
  SOURCE,


  // ====================================================
  // OUTPUT 1
  // HLS
  // ====================================================

  "-map",
  "0:v:0",

  "-map",
  "0:a:0?",

  // Video HLS giữ nguyên
  "-c:v",
  "copy",

  // Audio AAC
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


  // ====================================================
  // OUTPUT 2
  // MJPEG
  // ====================================================

  "-map",
  "0:v:0",

  "-an",

  "-vf",
  `fps=${FPS},scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=decrease,pad=${WIDTH}:${HEIGHT}:(ow-iw)/2:(oh-ih)/2`,

  "-c:v",
  "mjpeg",

  "-q:v",
  "8",

  "-f",
  "image2pipe",

  "pipe:1"

]);


// ======================================================
// FFMPEG LOG
// ======================================================

ffmpeg.stderr.on("data", data => {

  const text =
    data.toString().trim();

  if (text) {
    console.log("[FFmpeg]", text);
  }

});

ffmpeg.on("close", code => {

  console.log(
    "FFmpeg stopped:",
    code
  );

});


// ======================================================
// JPEG PARSER
// ======================================================

let jpegBuffer =
  Buffer.alloc(0);

ffmpeg.stdout.on("data", chunk => {

  jpegBuffer = Buffer.concat([
    jpegBuffer,
    chunk
  ]);


  while (true) {

    // Tìm JPEG START
    const start =
      jpegBuffer.indexOf(
        Buffer.from([0xff, 0xd8])
      );

    if (start === -1) {

      if (
        jpegBuffer.length >
        1024 * 1024
      ) {
        jpegBuffer =
          Buffer.alloc(0);
      }

      break;
    }


    // Bỏ dữ liệu rác trước JPEG
    if (start > 0) {

      jpegBuffer =
        jpegBuffer.slice(start);
    }


    // Tìm JPEG END
    const end =
      jpegBuffer.indexOf(
        Buffer.from([0xff, 0xd9]),
        2
      );

    if (end === -1) {
      break;
    }


    // Lấy nguyên JPEG
    const jpeg =
      Buffer.from(
        jpegBuffer.slice(
          0,
          end + 2
        )
      );


    // Xóa JPEG đã đọc
    jpegBuffer =
      jpegBuffer.slice(
        end + 2
      );


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


    // ==================================================
    // DROP FRAME
    // ==================================================
    //
    // Nếu buffer đã đầy thì bỏ frame CŨ.
    // Không để video tích tụ thành 1 phút.
    // ==================================================

    const now =
      Date.now();


    frames.push({
      time: now,
      data: jpeg
    });


    while (
      frames.length >
      MAX_BUFFER_FRAMES
    ) {
      frames.shift();
    }


    // ==================================================
    // QUAN TRỌNG:
    // Nếu buffer vượt quá 6 giây,
    // bỏ frame cũ để bắt kịp live.
    // ==================================================

    const maxAge =
      6000;

    const minTime =
      now - maxAge;

    while (
      frames.length > 0 &&
      frames[0].time < minTime
    ) {
      frames.shift();
    }

  }

});


// ======================================================
// WEB PAGE
// ======================================================

app.get("/", (req, res) => {

  res.send(`

<!DOCTYPE html>

<html lang="vi">

<head>

<meta charset="UTF-8">

<meta name="viewport"
      content="width=device-width,initial-scale=1">

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
  margin-bottom: 10px;
}

video {
  width: 100%;
  max-width: 900px;
  background: black;
}

.mjpeg {
  width: 320px;
  height: 240px;
  display: block;
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

<h2>
HLS - Video + Audio
</h2>

<video
  id="video"
  controls
  autoplay
  playsinline>
</video>

</div>


<div class="box">

<h2>
MJPEG - ESP32
</h2>

<div class="info">
320x240 / 10 FPS / delay ~5 giây
</div>

<img
  class="mjpeg"
  src="/stream"
  width="320"
  height="240">

</div>


</div>


<script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>

<script>

const video =
  document.getElementById("video");

const url = "/hls";


if (
  video.canPlayType(
    "application/vnd.apple.mpegurl"
  )
) {

  video.src = url;

} else if (Hls.isSupported()) {

  const hls =
    new Hls({

      enableWorker: true,

      lowLatencyMode: false,

      liveSyncDurationCount: 3,

      maxBufferLength: 8,

      maxMaxBufferLength: 12

    });


  hls.loadSource(url);

  hls.attachMedia(video);


  hls.on(
    Hls.Events.MANIFEST_PARSED,
    () => {

      video
        .play()
        .catch(() => {});

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

  if (
    !fs.existsSync(playlist)
  ) {

    return res
      .status(503)
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

  } catch (err) {

    console.error(err);

    res
      .status(500)
      .send(
        "Không đọc được HLS"
      );

  }

});


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
      !fs.existsSync(filePath)
    ) {

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

app.get(
  "/stream",
  (req, res) => {

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


    // ==================================================
    // 10 FPS
    // ==================================================

    const timer =
      setInterval(
        () => {

          if (closed) {

            clearInterval(timer);

            return;

          }


          if (
            frames.length === 0
          ) {
            return;
          }


          // ============================================
          // CHỌN FRAME CÁCH LIVE ~5 GIÂY
          // ============================================

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


          // Nếu chưa đủ 5 giây
          if (!selected) {

            selected =
              frames[
                frames.length - 1
              ];

          }


          // =========================================
          // Không gửi trùng
          // =========================================

          if (
            selected.time ===
            lastSentTime
          ) {
            return;
          }


          lastSentTime =
            selected.time;


          // =========================================
          // MJPEG STANDARD
          // =========================================

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


          } catch (err) {

            closed = true;

            clearInterval(timer);

          }

        },

        1000 / FPS
      );

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

      source: SOURCE,

      mjpeg: {

        url: "/stream",

        width: WIDTH,

        height: HEIGHT,

        fps: FPS,

        delay:
          DELAY_SECONDS,

        frames:
          frames.length

      },

      hls: {

        url: "/hls",

        ready:
          fs.existsSync(
            playlist
          )

      }

    });

  }
);


// ======================================================
// START SERVER
// ======================================================

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


// ======================================================
// SHUTDOWN
// ======================================================

function shutdown() {

  console.log(
    "Shutting down..."
  );


  try {
    ffmpeg.kill(
      "SIGTERM"
    );
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
