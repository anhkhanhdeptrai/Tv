const express = require("express");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const https = require("https");

const app = express();
const PORT = process.env.PORT || 10000;

// =====================================================
// IPTV-ORG VIETNAM PLAYLIST
// =====================================================

const M3U_URL =
  "https://raw.githubusercontent.com/iptv-org/iptv/master/streams/vn.m3u";

// =====================================================
// CONFIG
// =====================================================

const WIDTH = 320;
const HEIGHT = 240;

const FPS = 14;

const DELAY_SECONDS = 10;
const BUFFER_SECONDS = 30;

const MAX_BUFFER_FRAMES =
  FPS * BUFFER_SECONDS;

const HLS_TIME = 2;
const HLS_LIST = 8;

const HLS_DIR =
  path.join(__dirname, "hls");

if (!fs.existsSync(HLS_DIR)) {
  fs.mkdirSync(HLS_DIR, {
    recursive: true
  });
}

// =====================================================
// DOWNLOAD M3U
// =====================================================

function downloadM3U(url) {

  return new Promise((resolve, reject) => {

    https.get(
      url,
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0"
        }
      },
      response => {

        let data = "";

        response.setEncoding("utf8");

        response.on(
          "data",
          chunk => {
            data += chunk;
          }
        );

        response.on(
          "end",
          () => {

            if (
              response.statusCode < 200 ||
              response.statusCode >= 300
            ) {

              reject(
                new Error(
                  "HTTP " +
                  response.statusCode
                )
              );

              return;
            }

            resolve(data);
          }
        );

      }
    ).on(
      "error",
      reject
    );
  });
}

// =====================================================
// PARSE M3U
// =====================================================

function parseM3U(text) {

  const lines =
    text
      .split(/\r?\n/)
      .map(x => x.trim())
      .filter(Boolean);

  const result = [];

  for (
    let i = 0;
    i < lines.length;
    i++
  ) {

    const line = lines[i];

    if (
      !line.startsWith("#EXTINF")
    ) {
      continue;
    }

    let name =
      line
        .substring(
          line.lastIndexOf(",") + 1
        )
        .trim();

    const tvgId =
      (
        line.match(
          /tvg-id="([^"]*)"/i
        ) || []
      )[1] || "";

    const logo =
      (
        line.match(
          /tvg-logo="([^"]*)"/i
        ) || []
      )[1] || "";

    const group =
      (
        line.match(
          /group-title="([^"]*)"/i
        ) || []
      )[1] || "";

    let url = "";

    for (
      let j = i + 1;
      j < lines.length;
      j++
    ) {

      if (
        !lines[j].startsWith("#")
      ) {

        url = lines[j];

        break;
      }
    }

    if (!url) continue;

    if (!name) {
      name =
        tvgId ||
        "Channel " +
        result.length;
    }

    result.push({

      id:
        String(result.length),

      name,

      tvgId,

      logo,

      group,

      url
    });
  }

  return result;
}

// =====================================================
// GLOBAL
// =====================================================

let channels = [];

let currentChannel = null;

let ffmpeg = null;

let ffmpegGeneration = 0;

const frames = [];

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

// =====================================================
// CLEAR HLS
// =====================================================

function clearHLS() {

  if (!fs.existsSync(HLS_DIR)) {
    return;
  }

  for (
    const file of
    fs.readdirSync(HLS_DIR)
  ) {

    try {

      fs.unlinkSync(
        path.join(
          HLS_DIR,
          file
        )
      );

    } catch {}
  }
}

// =====================================================
// STOP FFMPEG
// =====================================================

function stopFFmpeg() {

  if (!ffmpeg) {
    return;
  }

  try {
    ffmpeg.kill("SIGKILL");
  } catch {}

  ffmpeg = null;
}

// =====================================================
// START FFMPEG
// =====================================================

function startFFmpeg(channel) {

  ffmpegGeneration++;

  const generation =
    ffmpegGeneration;

  console.log("");
  console.log(
    "================================"
  );
  console.log(
    "ĐANG PHÁT:",
    channel.name
  );
  console.log(
    channel.url
  );
  console.log(
    "================================"
  );

  stopFFmpeg();

  clearHLS();

  frames.length = 0;

  jpegBuffer =
    Buffer.alloc(0);

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

  ffmpeg = spawn(
    "ffmpeg",
    [

      "-hide_banner",

      "-loglevel",
      "warning",

      // =========================
      // NETWORK
      // =========================

      "-reconnect",
      "1",

      "-reconnect_streamed",
      "1",

      "-reconnect_delay_max",
      "5",

      "-fflags",
      "nobuffer",

      // =========================
      // INPUT
      // =========================

      "-i",
      channel.url,

      // =================================================
      // OUTPUT 1 — HLS
      // =================================================

      "-map",
      "0:v:0",

      "-map",
      "0:a:0?",

      "-c:v",
      "copy",

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

      // =================================================
      // OUTPUT 2 — MJPEG
      // =================================================

      "-map",
      "0:v:0",

      "-an",

      "-vf",

      `fps=${FPS},scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=decrease,pad=${WIDTH}:${HEIGHT}:(ow-iw)/2:(oh-ih)/2`,

      "-c:v",
      "mjpeg",

      "-q:v",
      "10",

      "-fps_mode",
      "cfr",

      "-f",
      "image2pipe",

      "pipe:1"
    ]
  );

  // ===================================================
  // STDERR
  // ===================================================

  ffmpeg.stderr.on(
    "data",
    data => {

      const text =
        data
          .toString()
          .trim();

      if (text) {

        console.log(
          "[FFmpeg]",
          text
        );
      }
    }
  );

  // ===================================================
  // MJPEG
  // ===================================================

  ffmpeg.stdout.on(
    "data",
    chunk => {

      if (
        generation !==
        ffmpegGeneration
      ) {
        return;
      }

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

        const oldest =
          now -
          BUFFER_SECONDS * 1000;

        while (
          frames.length &&
          frames[0].time <
            oldest
        ) {

          frames.shift();
        }

        while (
          frames.length >
          MAX_BUFFER_FRAMES
        ) {

          frames.shift();
        }
      }
    }
  );

  // ===================================================
  // CLOSE
  // ===================================================

  ffmpeg.on(
    "close",
    code => {

      console.log(
        "FFmpeg exited:",
        code
      );

      if (
        generation !==
        ffmpegGeneration
      ) {
        return;
      }

      ffmpeg = null;

      setTimeout(
        () => {

          if (
            generation ===
              ffmpegGeneration &&
            currentChannel
          ) {

            startFFmpeg(
              currentChannel
            );
          }

        },
        3000
      );
    }
  );
}

// =====================================================
// API — CHANNELS
// =====================================================

app.get(
  "/api/channels",
  (req, res) => {

    res.json({

      count:
        channels.length,

      current:
        currentChannel
          ? currentChannel.id
          : null,

      channels:
        channels.map(ch => ({

          id: ch.id,

          name: ch.name,

          group: ch.group,

          logo: ch.logo
        }))
    });
  }
);

// =====================================================
// API — SELECT CHANNEL
// =====================================================

app.get(
  "/api/select/:id",
  (req, res) => {

    const channel =
      channels.find(
        ch =>
          ch.id ===
          String(req.params.id)
      );

    if (!channel) {

      return res
        .status(404)
        .json({
          error:
            "Không tìm thấy kênh"
        });
    }

    currentChannel =
      channel;

    startFFmpeg(
      channel
    );

    res.json({

      ok: true,

      id:
        channel.id,

      name:
        channel.name
    });
  }
);

// =====================================================
// HLS PLAYLIST
// =====================================================

app.get(
  "/hls/stream.m3u8",
  (req, res) => {

    const playlist =
      path.join(
        HLS_DIR,
        "stream.m3u8"
      );

    if (
      !fs.existsSync(
        playlist
      )
    ) {

      return res
        .status(404)
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

    } catch {

      res
        .status(500)
        .send(
          "HLS error"
        );
    }
  }
);

// =====================================================
// HLS SEGMENTS
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

    fs
      .createReadStream(
        filePath
      )
      .pipe(res);
  }
);

// =====================================================
// MJPEG — ESP32
// =====================================================

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

    const timer =
      setInterval(
        () => {

          if (closed) {

            clearInterval(
              timer
            );

            return;
          }

          if (
            frames.length === 0
          ) {
            return;
          }

          const target =
            Date.now() -
            DELAY_SECONDS *
              1000;

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

          if (!selected) {

            selected =
              frames[0];
          }

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

          } catch {

            closed = true;

            clearInterval(
              timer
            );
          }

        },
        1000 / FPS
      );
  }
);

// =====================================================
// HEALTH
// =====================================================

app.get(
  "/health",
  (req, res) => {

    res.json({

      status: "ok",

      source:
        M3U_URL,

      channelCount:
        channels.length,

      currentChannel:
        currentChannel
          ? {
              id:
                currentChannel.id,
              name:
                currentChannel.name
            }
          : null,

      mjpeg: {

        url: "/stream",

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

        currentFrames:
          frames.length
      },

      hls: {

        playlist:
          "/hls/stream.m3u8",

        ready:
          fs.existsSync(
            path.join(
              HLS_DIR,
              "stream.m3u8"
            )
          )
      }
    });
  }
);

// =====================================================
// WEB
// =====================================================

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

<meta
name="viewport"
content="width=device-width, initial-scale=1"
>

<title>Vietnam TV</title>

<style>

body {
  margin:0;
  padding:15px;
  background:#111;
  color:white;
  font-family:Arial;
}

.container {
  max-width:900px;
  margin:auto;
}

video {
  width:100%;
  background:black;
}

.search {
  width:100%;
  box-sizing:border-box;
  padding:12px;
  margin:15px 0;
  background:#222;
  border:1px solid #444;
  color:white;
  border-radius:6px;
}

.channel {
  padding:12px;
  margin:5px 0;
  background:#222;
  border-radius:6px;
  cursor:pointer;
}

.channel:hover {
  background:#333;
}

.channel.active {
  background:#075e9b;
}

.info {
  color:#aaa;
  font-size:14px;
}

.mjpeg {
  width:320px;
  height:240px;
  background:black;
}

</style>

</head>

<body>

<div class="container">

<h2>🇻🇳 Vietnam TV</h2>

<div id="status">
Đang tải danh sách...
</div>

<video
id="video"
controls
autoplay
playsinline
></video>

<h3>Danh sách kênh</h3>

<input
id="search"
class="search"
placeholder="🔎 Tìm VTV, HTV, SCTV..."
>

<div id="channels"></div>

<h3>ESP32 MJPEG</h3>

<div class="info">
320 × 240 — 14 FPS — delay khoảng 10 giây
</div>

<br>

<img
src="/stream"
class="mjpeg"
width="320"
height="240"
>

</div>

<script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>

<script>

const video =
document.getElementById(
  "video"
);

const channelBox =
document.getElementById(
  "channels"
);

const search =
document.getElementById(
  "search"
);

const status =
document.getElementById(
  "status"
);

const hlsUrl =
"${hlsUrl}";

let channels = [];

let current = null;

let hls = null;


// ==========================================
// LOAD
// ==========================================

async function loadChannels() {

  const r =
    await fetch(
      "/api/channels"
    );

  const data =
    await r.json();

  channels =
    data.channels;

  current =
    data.current;

  renderChannels();

  const ch =
    channels.find(
      c => c.id === current
    );

  status.innerText =
    "Đang phát: " +
    (
      ch
        ? ch.name
        : ""
    );

  startHLS();
}


// ==========================================
// HLS
// ==========================================

function startHLS() {

  if (
    video.canPlayType(
      "application/vnd.apple.mpegurl"
    )
  ) {

    video.src =
      hlsUrl;

    video.play()
      .catch(() => {});

    return;
  }

  if (
    typeof Hls !==
      "undefined" &&
    Hls.isSupported()
  ) {

    if (hls) {
      hls.destroy();
    }

    hls =
      new Hls({
        lowLatencyMode:false,
        liveSyncDurationCount:4,
        liveMaxLatencyDurationCount:8
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
          .catch(() => {});
      }
    );
  }
}


// ==========================================
// RENDER CHANNELS
// ==========================================

function renderChannels() {

  const keyword =
    search.value
      .toLowerCase()
      .trim();

  channelBox.innerHTML = "";

  channels
    .filter(
      ch =>
        ch.name
          .toLowerCase()
          .includes(keyword)
    )
    .forEach(
      ch => {

        const div =
          document.createElement(
            "div"
          );

        div.className =
          "channel" +
          (
            ch.id === current
              ? " active"
              : ""
          );

        div.innerText =
          ch.name;

        div.onclick =
          () =>
            selectChannel(
              ch.id,
              ch.name
            );

        channelBox.appendChild(
          div
        );
      }
    );
}


// ==========================================
// SELECT
// ==========================================

async function selectChannel(
  id,
  name
) {

  status.innerText =
    "Đang chuyển sang " +
    name +
    "...";

  try {

    const r =
      await fetch(
        "/api/select/" +
        id
      );

    const data =
      await r.json();

    if (!data.ok) {
      throw new Error();
    }

    current =
      id;

    renderChannels();

    status.innerText =
      "Đang phát: " +
      name;

    // Cho FFmpeg tạo playlist
    setTimeout(
      startHLS,
      1500
    );

  } catch {

    status.innerText =
      "Không thể phát kênh này";
  }
}


// ==========================================
// SEARCH
// ==========================================

search.addEventListener(
  "input",
  renderChannels
);


// ==========================================
// START
// ==========================================

loadChannels();

</script>

</body>

</html>

`);
  }
);

// =====================================================
// START SERVER
// =====================================================

app.listen(
  PORT,
  "0.0.0.0",
  async () => {

    console.log(
      "================================"
    );

    console.log(
      "TV SERVER STARTING"
    );

    console.log(
      "================================"
    );

    try {

      console.log(
        "Đang tải playlist:"
      );

      console.log(
        M3U_URL
      );

      const m3u =
        await downloadM3U(
          M3U_URL
        );

      channels =
        parseM3U(m3u);

      console.log(
        "Đã tải:",
        channels.length,
        "kênh"
      );

      if (
        channels.length === 0
      ) {

        throw new Error(
          "Playlist không có kênh"
        );
      }

      // Chọn kênh đầu tiên
      currentChannel =
        channels[0];

      startFFmpeg(
        currentChannel
      );

    } catch (error) {

      console.error(
        "Không tải được M3U:",
        error.message
      );

      process.exit(1);
    }

    console.log(
      `Server chạy port ${PORT}`
    );
  }
);
