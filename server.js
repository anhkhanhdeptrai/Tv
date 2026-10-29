const express = require("express");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const app = express();

const PORT = process.env.PORT || 10000;

const SOURCE =
  "https://amagi-live.ondemandkorea.com/amgplt0456.m3u8";

const WIDTH = 320;
const HEIGHT = 240;
const FPS = 10;

// MJPEG chạy chậm hơn live một khoảng cố định
const DELAY_SECONDS = 10;

// Tăng buffer để có nhiều frame dự phòng
const BUFFER_SECONDS = 30;

const MAX_BUFFER_FRAMES = FPS * BUFFER_SECONDS;

const HLS_TIME = 2;
const HLS_LIST = 8;

// ======================================================
// ÂM THANH CHO ESP32
// ======================================================
// ESP32-S3 không giải mã được AAC/H.264. Máy chủ xuất thêm một luồng PCM thô
// 16-bit mono 44.1 kHz rồi gửi XEN KẼ với khung JPEG trong CÙNG một luồng
// multipart /stream. Nhờ vậy:
//   - ESP32 chỉ cần một kết nối TLS (tiết kiệm DRAM nội bộ cho mbedtls).
//   - Tiếng và hình đi chung một đường, cùng độ trễ DELAY_SECONDS -> khớp nhau.
const AUDIO_RATE = 44100;
const AUDIO_CHUNK_MS = 50;
const AUDIO_BYTES_PER_MS = (AUDIO_RATE * 2) / 1000;          // mono 16-bit
const AUDIO_CHUNK_BYTES = Math.round(AUDIO_BYTES_PER_MS * AUDIO_CHUNK_MS);
const MAX_AUDIO_CHUNKS = Math.floor((BUFFER_SECONDS * 1000) / AUDIO_CHUNK_MS);
const AUDIO_CONTENT_TYPE = `audio/L16;rate=${AUDIO_RATE};channels=1`;

// Độ "đi trước" của tiếng so với hình. ESP32 giữ đúng chừng này PCM trong FIFO
// (PSRAM) rồi mới đẩy ra I2S, nên sau khi trừ độ đệm, tiếng khớp đúng khung hình.
// Đây cũng là biên chống hụt tiếng khi mạng/vẽ JPEG gây trễ.
const AUDIO_LEAD_MS = 200;

const HLS_DIR = path.join(__dirname, "hls");

if (!fs.existsSync(HLS_DIR)) {
  fs.mkdirSync(HLS_DIR, { recursive: true });
}

// Xóa HLS cũ
for (const file of fs.readdirSync(HLS_DIR)) {
  try {
    fs.unlinkSync(path.join(HLS_DIR, file));
  } catch {}
}

const playlist = path.join(HLS_DIR, "stream.m3u8");
const segment = path.join(HLS_DIR, "seg-%05d.ts");


// ======================================================
// MJPEG FRAME BUFFER
// ======================================================

const frames = [];

// ======================================================
// PCM AUDIO BUFFER (mỗi phần tử là 1 đoạn PCM mono 16-bit)
// ======================================================

const audioChunks = [];

let pcmBuffer = Buffer.alloc(0);


// ======================================================
// FFMPEG
// ======================================================

console.log("Starting FFmpeg...");
console.log("SOURCE:", SOURCE);
console.log("MJPEG:", `${WIDTH}x${HEIGHT} @ ${FPS} FPS`);
console.log("Delay:", DELAY_SECONDS, "seconds");
console.log("Buffer:", BUFFER_SECONDS, "seconds");

const ffmpeg = spawn("ffmpeg", [
  "-hide_banner",
  "-loglevel", "warning",

  "-reconnect", "1",
  "-reconnect_streamed", "1",
  "-reconnect_delay_max", "5",

  "-fflags", "nobuffer",

  "-i", SOURCE,


  // ====================================================
  // OUTPUT 1: HLS VIDEO + AUDIO
  // ====================================================

  "-map", "0:v:0",
  "-map", "0:a:0?",

  "-c:v", "copy",

  "-c:a", "aac",
  "-b:a", "96k",

  "-f", "hls",

  "-hls_time", String(HLS_TIME),
  "-hls_list_size", String(HLS_LIST),
  "-hls_delete_threshold", "4",

  "-hls_flags",
  "delete_segments+append_list+independent_segments",

  "-hls_segment_filename",
  segment,

  playlist,


  // ====================================================
  // OUTPUT 2: MJPEG
  // ====================================================

  "-map", "0:v:0",
  "-an",

  "-vf",
  `fps=${FPS},scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=decrease,pad=${WIDTH}:${HEIGHT}:(ow-iw)/2:(oh-ih)/2`,

  "-c:v", "mjpeg",

  // Tăng q để giảm CPU và giảm kích thước JPEG
  "-q:v", "10",

  "-fps_mode", "cfr",

  "-f", "image2pipe",

  "pipe:1",

  // ====================================================
  // OUTPUT 3: PCM MONO 16-BIT (fd 3) — nguồn tiếng cho ESP32
  // ====================================================

  "-map", "0:a:0?",
  "-vn",
  "-ac", "1",
  "-ar", String(AUDIO_RATE),
  // async=1: bù khoảng trống/thiếu mẫu của luồng live để nhịp tiếng phẳng,
  // tránh trôi dần so với hình.
  "-af", "aresample=async=1:min_hard_comp=0.100:first_pts=0",
  "-acodec", "pcm_s16le",
  "-f", "s16le",

  "pipe:3"
], {
  stdio: ["ignore", "pipe", "pipe", "pipe"]
});


// ======================================================
// FFMPEG ERROR
// ======================================================

ffmpeg.stderr.on("data", data => {
  const text = data.toString().trim();

  if (text) {
    console.log("[FFmpeg]", text);
  }
});


// ======================================================
// JPEG PARSER
// ======================================================

// Trục thời gian dùng chung cho hình và tiếng, tính theo NỘI DUNG:
//   hình: videoEpochMs + frameSeq * (1000/FPS)
//   tiếng: audioEpochMs + audioSeq * AUDIO_CHUNK_MS
// Mỗi trục neo vào giờ thật lúc phần tử ĐẦU TIÊN của luồng đó tới, nên vẫn giữ
// đúng quan hệ thời gian thật giữa hai luồng, mà mạng đến dồn cụm hay trễ về
// sau đều KHÔNG làm tiếng trôi khỏi hình.
let videoEpochMs = 0;
let frameSeq = 0;

let jpegBuffer = Buffer.alloc(0);

ffmpeg.stdout.on("data", chunk => {

  jpegBuffer = Buffer.concat([
    jpegBuffer,
    chunk
  ]);

  while (true) {

    const start = jpegBuffer.indexOf(
      Buffer.from([0xff, 0xd8])
    );

    if (start === -1) {

      if (jpegBuffer.length > 2 * 1024 * 1024) {
        jpegBuffer = Buffer.alloc(0);
      }

      break;
    }

    if (start > 0) {
      jpegBuffer = jpegBuffer.slice(start);
    }

    const end = jpegBuffer.indexOf(
      Buffer.from([0xff, 0xd9]),
      2
    );

    if (end === -1) {
      break;
    }

    const jpeg = Buffer.from(
      jpegBuffer.slice(0, end + 2)
    );

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

    if (mediaEpochMs === 0) {
      mediaEpochMs = now;
    }

    frames.push({
      time: mediaEpochMs + frameSeq * (1000 / FPS),
      data: jpeg
    });

    frameSeq++;


    // Giữ tối đa 30 giây
    const oldest =
      now - BUFFER_SECONDS * 1000;

    while (
      frames.length > 0 &&
      frames[0].time < oldest
    ) {
      frames.shift();
    }


    // Giới hạn số frame
    while (
      frames.length > MAX_BUFFER_FRAMES
    ) {
      frames.shift();
    }
  }
});


// ======================================================
// PCM PARSER (fd 3): gom mẫu thô thành từng gói ~50 ms
// ======================================================

let pcmCarry = Buffer.alloc(0);

// Mốc thời gian âm thanh cũng tính theo NỘI DUNG: epoch chung + số gói ×
// AUDIO_CHUNK_MS (xem JPEG PARSER). Hai luồng vì thế luôn giữ đúng quan hệ
// thời gian của nguồn, mạng đến dồn cụm hay trễ đều không làm tiếng trôi.
let audioSeq = 0;

ffmpeg.stdio[3].on("data", chunk => {

  pcmCarry = pcmCarry.length === 0
    ? chunk
    : Buffer.concat([pcmCarry, chunk]);

  while (pcmCarry.length >= AUDIO_CHUNK_BYTES) {

    const data = Buffer.from(
      pcmCarry.slice(0, AUDIO_CHUNK_BYTES)
    );

    pcmCarry = pcmCarry.slice(AUDIO_CHUNK_BYTES);

    if (mediaEpochMs === 0) {
      mediaEpochMs = Date.now();
    }

    audioChunks.push({
      time: mediaEpochMs + audioSeq * AUDIO_CHUNK_MS,
      data
    });

    audioSeq++;

    const oldest = Date.now() - BUFFER_SECONDS * 1000;

    while (
      audioChunks.length > 0 &&
      audioChunks[0].time < oldest
    ) {
      audioChunks.shift();
    }

    while (audioChunks.length > MAX_AUDIO_CHUNKS) {
      audioChunks.shift();
    }
  }
});


// ======================================================
// FFMPEG EXIT
// ======================================================
ffmpeg.on("close", code => {

  console.log(
    "FFmpeg exited with code:",
    code
  );

  // Nếu FFmpeg chết thì restart
  setTimeout(() => {
    console.log("Restarting FFmpeg...");

    // Render sẽ restart service nếu process chính kết thúc
    process.exit(1);

  }, 3000);
});


// ======================================================
// HLS PLAYLIST
// ======================================================

app.get("/hls/stream.m3u8", (req, res) => {

  if (!fs.existsSync(playlist)) {
    return res.status(404).send("HLS not ready");
  }

  try {

    let data =
      fs.readFileSync(playlist, "utf8");

    // Đổi:
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

  } catch (err) {

    res.status(500).send(
      "HLS error"
    );
  }
});


// ======================================================
// HLS SEGMENT
// ======================================================

app.get("/hls-segment/:file", (req, res) => {

  const file = path.basename(
    req.params.file
  );

  const filePath =
    path.join(HLS_DIR, file);

  if (!fs.existsSync(filePath)) {
    return res.status(404).end();
  }

  res.setHeader(
    "Content-Type",
    "video/mp2t"
  );

  res.setHeader(
    "Cache-Control",
    "no-cache"
  );

  fs.createReadStream(filePath)
    .pipe(res);
});


// ======================================================
// MJPEG STREAM
// ======================================================

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

  if (typeof res.flushHeaders === "function") {
    res.flushHeaders();
  }


  let closed = false;
  let lastSentTime = 0;
  let lastAudioTime = 0;
  let audioPrimed = false;


  req.on("close", () => {

    closed = true;

    clearInterval(timer);
  });


  // Ghi một phần multipart. `data` là Buffer thô (JPEG hoặc PCM).
  const writePart = (contentType, data) => {
    res.write("--frame\r\n");
    res.write("Content-Type: " + contentType + "\r\n");
    res.write("Content-Length: " + data.length + "\r\n\r\n");
    res.write(data);
    res.write("\r\n");
  };


  // Gửi các gói PCM nằm trong (lastAudioTime, limitTime]. Gói được gửi SỚM hơn
  // hình đúng AUDIO_LEAD_MS: ESP32 giữ chừng đó trong FIFO rồi mới phát, nên khi
  // trừ độ đệm thì mẫu tiếng đang phát khớp đúng khung hình đang hiện.
  // Không xoá khỏi audioChunks: mảng dùng chung cho mọi kết nối, mỗi kết nối
  // tự theo dõi mốc lastAudioTime của riêng nó.
  const sendAudioUpTo = (limitTime, maxChunks) => {

    let sent = 0;

    for (let i = 0; i < audioChunks.length && sent < maxChunks; i++) {

      const chunk = audioChunks[i];

      if (chunk.time <= lastAudioTime) continue;   // đã gửi rồi
      if (chunk.time > limitTime) break;

      lastAudioTime = chunk.time;

      writePart(AUDIO_CONTENT_TYPE, chunk.data);

      sent++;
    }

    return sent;
  };


  const timer = setInterval(() => {

    if (closed) {
      clearInterval(timer);
      return;
    }


    if (frames.length === 0) {
      return;
    }


    // Lấy frame cách live khoảng 10 giây
    const target =
      Date.now() -
      DELAY_SECONDS * 1000;


    let selected = null;


    // Tìm frame mới nhất nhưng không vượt quá target
    for (
      let i = frames.length - 1;
      i >= 0;
      i--
    ) {

      if (
        frames[i].time <= target
      ) {

        selected = frames[i];

        break;
      }
    }


    // Nếu buffer chưa đủ 10 giây
    if (!selected) {
      selected = frames[0];
    }


    const isNewFrame =
      selected.time !== lastSentTime;

    lastSentTime =
      selected.time;


    // Mốc tiếng đi trước hình AUDIO_LEAD_MS (bằng đúng đệm FIFO trên ESP32).
    const audioLimit =
      selected.time + AUDIO_LEAD_MS;


    try {

      // Kết nối mới: bỏ qua tiếng cũ trong đệm, bắt đầu đúng mốc khung đầu tiên
      // để tiếng khớp hình ngay từ giây đầu (không phát tiếng của 10-30 giây trước).
      if (!audioPrimed) {
        lastAudioTime = selected.time;
        audioPrimed = true;
      }

      // Mỗi frame 100 ms cần ~2 gói 50 ms; cho phép gửi bù tới ~1 giây để hồi
      // phục nhanh sau khi mạng khựng (FIFO trên ESP32 tự cắt bớt nếu dư >500 ms).
      const maxChunks = Math.ceil(1000 / AUDIO_CHUNK_MS) + 4;

      // Tiếng luôn được đẩy theo nhịp, kể cả khi hình chưa có khung mới,
      // để I2S không bị hụt (hụt sẽ nghe rè/lặp).
      sendAudioUpTo(audioLimit, maxChunks);

      if (isNewFrame) {
        writePart("image/jpeg", selected.data);
      }

    } catch (err) {

      closed = true;

      clearInterval(timer);
    }

  }, 1000 / FPS);
});


// ======================================================
// WEB PLAYER
// ======================================================

app.get("/", (req, res) => {

  const host =
    req.get("host");

  const protocol =
    req.headers["x-forwarded-proto"] ||
    req.protocol;

  const hlsUrl =
    `${protocol}://${host}/hls/stream.m3u8`;

  const safeSource =
    String(SOURCE)
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;");


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
  image-rendering: auto;
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
320 × 240 — 10 FPS — Delay khoảng 10 giây
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

const hlsUrl =
  "${hlsUrl}";


if (
  video.canPlayType(
    "application/vnd.apple.mpegurl"
  )
) {

  video.src = hlsUrl;

} else if (
  Hls.isSupported()
) {

  const hls =
    new Hls({
      lowLatencyMode: false,
      liveSyncDurationCount: 4,
      liveMaxLatencyDurationCount: 8
    });

  hls.loadSource(hlsUrl);

  hls.attachMedia(video);

  hls.on(
    Hls.Events.MANIFEST_PARSED,
    () => {

      video.play()
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
// HEALTH
// ======================================================

app.get("/health", (req, res) => {

  res.json({

    status: "ok",

    source: SOURCE,

    mjpeg: {

      url: "/stream",

      width: WIDTH,

      height: HEIGHT,

      fps: FPS,

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
        fs.existsSync(playlist)

    },

    audio: {

      contentType:
        AUDIO_CONTENT_TYPE,

      sampleRate:
        AUDIO_RATE,

      chunkMs:
        AUDIO_CHUNK_MS,

      leadMs:
        AUDIO_LEAD_MS,

      currentChunks:
        audioChunks.length

    }

  });
});


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
