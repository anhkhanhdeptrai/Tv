const express = require("express");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const app = express();

const PORT = process.env.PORT || 10000;

const SOURCE =
  "https://amagi-live.ondemandkorea.com/amgplt0456.m3u8";


// ======================================================
// MJPEG CONFIG
// ======================================================

const WIDTH = 320;
const HEIGHT = 240;

// 14 FPS
const FPS = 14;

// MJPEG chậm hơn live khoảng 10 giây
const DELAY_SECONDS = 10;

// Buffer 30 giây
const BUFFER_SECONDS = 30;

const MAX_BUFFER_FRAMES =
  FPS * BUFFER_SECONDS;


// ======================================================
// HLS CONFIG
// ======================================================

const HLS_TIME = 2;
const HLS_LIST = 8;

const HLS_DIR =
  path.join(__dirname, "hls");


// ======================================================
// CREATE HLS DIRECTORY
// ======================================================

if (!fs.existsSync(HLS_DIR)) {
  fs.mkdirSync(HLS_DIR, {
    recursive: true
  });
}


// Xóa HLS cũ
for (const file of fs.readdirSync(HLS_DIR)) {
  try {
    fs.unlinkSync(
      path.join(HLS_DIR, file)
    );
  } catch {}
}


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


// ======================================================
// MJPEG FRAME BUFFER
// ======================================================

const frames = [];


// ======================================================
// LOG CONFIG
// ======================================================

console.log("======================================");
console.log("TV STREAM SERVER");
console.log("======================================");
console.log("Source:", SOURCE);
console.log(
  "MJPEG:",
  `${WIDTH}x${HEIGHT} @ ${FPS} FPS`
);
console.log(
  "Delay:",
  DELAY_SECONDS,
  "seconds"
);
console.log(
  "Buffer:",
  BUFFER_SECONDS,
  "seconds"
);
console.log(
  "Max frames:",
  MAX_BUFFER_FRAMES
);
console.log("======================================");


// ======================================================
// FFMPEG
// ======================================================

const ffmpeg = spawn("ffmpeg", [

  "-hide_banner",
  "-loglevel", "warning",

  // Reconnect HLS
  "-reconnect", "1",
  "-reconnect_streamed", "1",
  "-reconnect_delay_max", "5",

  // Giảm buffering không cần thiết
  "-fflags", "nobuffer",

  "-i",
  SOURCE,


  // ====================================================
  // OUTPUT 1
  // HLS VIDEO + AUDIO
  // ====================================================

  "-map", "0:v:0",
  "-map", "0:a:0?",

  "-c:v", "copy",

  "-c:a", "aac",
  "-b:a", "96k",

  "-f", "hls",

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
  // MJPEG 320x240
  // ====================================================

  "-map", "0:v:0",

  "-an",

  "-vf",
  `fps=${FPS},scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=decrease,pad=${WIDTH}:${HEIGHT}:(ow-iw)/2:(oh-ih)/2`,

  "-c:v",
  "mjpeg",

  // JPEG nhẹ để giảm CPU
  "-q:v",
  "10",

  // CFR 14 FPS
  "-fps_mode",
  "cfr",

  "-f",
  "image2pipe",

  "pipe:1"

]);


// ======================================================
// FFMPEG STDERR
// ======================================================

ffmpeg.stderr.on(
  "data",
  data => {

    const text =
      data.toString().trim();

    if (text) {

      console.log(
        "[FFmpeg]",
        text
      );

    }
  }
);


// ======================================================
// JPEG PARSER
// ======================================================

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


ffmpeg.stdout.on(
  "data",
  chunk => {

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


      if (start === -1) {

        if (
          jpegBuffer.length >
          2 * 1024 * 1024
        ) {

          jpegBuffer =
            Buffer.alloc(0);

        }

        break;
      }


      if (start > 0) {

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


      if (end === -1) {
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


      const now =
        Date.now();


      frames.push({
        time: now,
        data: jpeg
      });


      // ==================================================
      // GIỮ BUFFER 30 GIÂY
      // ==================================================

      const oldest =
        now -
        BUFFER_SECONDS * 1000;


      while (
        frames.length > 0 &&
        frames[0].time < oldest
      ) {

        frames.shift();

      }


      // ==================================================
      // GIỚI HẠN FRAME
      // ==================================================

      while (
        frames.length >
        MAX_BUFFER_FRAMES
      ) {

        frames.shift();

      }

    }

  }
);


// ======================================================
// FFMPEG EXIT
// ======================================================

ffmpeg.on(
  "close",
  code => {

    console.log(
      "FFmpeg exited with code:",
      code
    );

    setTimeout(() => {

      process.exit(1);

    }, 3000);

  }
);


// ======================================================
// HLS PLAYLIST
// ======================================================

app.get(
  "/hls/stream.m3u8",
  (req, res) => {

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


    try {

      let data =
        fs.readFileSync(
          playlist,
          "utf8"
        );


      // Đổi tên segment
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

      res
        .status(500)
        .send(
          "HLS error"
        );

    }

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


    // 14 FPS
    // ~71ms / frame

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


          // =================================================
          // TARGET = LIVE - 10 GIÂY
          // =================================================

          const target =
            Date.now() -
            DELAY_SECONDS * 1000;


          let selected = null;


          // Lấy frame gần target nhất
          // nhưng không vượt quá target

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


          // Buffer chưa đủ 10 giây

          if (!selected) {

            selected =
              frames[0];

          }


          // =================================================
          // KHÔNG GỬI LẶP FRAME
          // =================================================

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
// WEB PAGE
// ======================================================

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

<meta name="viewport"
content="width=device-width, initial-scale=1">

<title>TV Stream</title>


<style>

body {
  margin: 0;
  padding: 20px;
  background: #111;
  color: white;
  font-family: Arial;
}

.container {
  max-width: 800px;
  margin: auto;
}

video {
  width: 100%;
  background: black;
}

.mjpeg-box {
  margin-top: 25px;
}

.mjpeg {
  width: 320px;
  height: 240px;
  display: block;
  background: black;
}

.info {
  margin: 10px 0;
  font-size: 14px;
  color: #aaa;
}

</style>

</head>


<body>

<div class="container">

<h2>TV Live HLS</h2>

<video
id="video"
controls
autoplay
muted
playsinline>
</video>


<div class="mjpeg-box">

<h2>ESP32 MJPEG</h2>

<div class="info">
320 × 240 — 14 FPS — Delay khoảng 10 giây
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
document.getElementById(
  "video"
);

const hlsUrl =
"${hlsUrl}";


if (
  video.canPlayType(
    "application/vnd.apple.mpegurl"
  )
) {

  video.src =
    hlsUrl;

}
else if (
  Hls.isSupported()
) {

  const hls =
    new Hls({

      lowLatencyMode: false,

      liveSyncDurationCount: 4,

      liveMaxLatencyDurationCount: 8

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
        .catch(
          () => {}
        );

    }
  );

}

</script>

</body>

</html>

    `);

  }
);


// ======================================================
// HEALTH
// ======================================================

app.get(
  "/health",
  (req, res) => {

    res.json({

      status: "ok",

      source:
        SOURCE,

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

        maxBufferFrames:
          MAX_BUFFER_FRAMES,

        currentFrames:
          frames.length

      },

      hls: {

        playlist:
          "/hls/stream.m3u8",

        ready:
          fs.existsSync(
            playlist
          )

      }

    });

  }
);


// ======================================================
// SERVER
// ======================================================

app.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      `Server running on port ${PORT}`
    );

  }
);
