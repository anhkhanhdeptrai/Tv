const express = require("express");
const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const app = express();

const PORT = process.env.PORT || 10000;

// =====================================================
// CONFIG
// =====================================================

const PLAYLIST_URL =
  "https://raw.githubusercontent.com/iptv-org/iptv/master/streams/vn.m3u";

const WIDTH = 320;
const HEIGHT = 240;

const FPS = 14;

// Delay MJPEG so ESP32 does not have to chase live
const DELAY_SECONDS = 10;

// Keep approximately 30 seconds of JPEG frames
const BUFFER_SECONDS = 30;

// HLS
const HLS_TIME = 2;
const HLS_LIST = 8;

// Check source before showing channel
const CHECK_TIMEOUT = 7000;
const CHECK_CONCURRENCY = 6;

// =====================================================
// DIRECTORIES
// =====================================================

const DATA_DIR = path.join(__dirname, "data");
const HLS_DIR = path.join(DATA_DIR, "hls");

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(HLS_DIR, { recursive: true });

// =====================================================
// GLOBAL STATE
// =====================================================

let channels = [];
let selectedChannel = null;

let ffmpeg = null;

// MJPEG frame buffer
let frames = [];

// JPEG parser buffer
let jpgBuffer = Buffer.alloc(0);

// =====================================================
// FFmpeg statistics
// =====================================================

let ffmpegSpeed = 0;
let ffmpegFps = 0;
let ffmpegFrame = 0;

let mjpegFrameCount = 0;
let lastMjpegFrameCount = 0;

let lastStatsTime = Date.now();

let mjpegFps = 0;

let statsTimer = null;

// =====================================================
// EXPRESS
// =====================================================

app.use(express.json());

// =====================================================
// HTTP GET
// =====================================================

function httpGet(url, timeout = CHECK_TIMEOUT) {
  return new Promise((resolve, reject) => {
    let parsed;

    try {
      parsed = new URL(url);
    } catch {
      reject(new Error("Invalid URL"));
      return;
    }

    const client =
      parsed.protocol === "https:"
        ? https
        : http;

    const req = client.get(
      url,
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0 IPTV-Proxy/1.0",
          Range: "bytes=0-2047",
          Accept: "*/*"
        }
      },
      res => {
        // We only need the status code.
        // Destroy the connection quickly.
        res.resume();

        resolve({
          statusCode: res.statusCode || 0,
          headers: res.headers
        });
      }
    );

    req.setTimeout(timeout, () => {
      req.destroy(
        new Error("Request timeout")
      );
    });

    req.on("error", reject);
  });
}

// =====================================================
// DOWNLOAD PLAYLIST
// =====================================================

function downloadPlaylist() {
  return new Promise((resolve, reject) => {
    https.get(
      PLAYLIST_URL,
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0 IPTV-Proxy/1.0",
          Accept:
            "application/vnd.apple.mpegurl,text/plain,*/*"
        }
      },
      res => {
        let data = "";

        res.setEncoding("utf8");

        res.on("data", chunk => {
          data += chunk;
        });

        res.on("end", () => {
          if (
            res.statusCode < 200 ||
            res.statusCode >= 300
          ) {
            reject(
              new Error(
                `Playlist HTTP ${res.statusCode}`
              )
            );
            return;
          }

          resolve(data);
        });
      }
    ).on("error", reject);
  });
}

// =====================================================
// PARSE M3U
// =====================================================

function parseM3U(data) {
  const lines = data.split(/\r?\n/);

  const result = [];

  let currentInfo = null;

  for (const lineRaw of lines) {
    const line = lineRaw.trim();

    if (!line) continue;

    if (line.startsWith("#EXTINF:")) {
      const comma =
        line.indexOf(",");

      let attributes =
        comma >= 0
          ? line.substring(
              8,
              comma
            )
          : line.substring(8);

      let name =
        comma >= 0
          ? line.substring(
              comma + 1
            ).trim()
          : "Unknown";

      // Extract common attributes
      const tvgId =
        (attributes.match(
          /tvg-id="([^"]*)"/i
        ) || [])[1] || "";

      const tvgName =
        (attributes.match(
          /tvg-name="([^"]*)"/i
        ) || [])[1] || "";

      const tvgLogo =
        (attributes.match(
          /tvg-logo="([^"]*)"/i
        ) || [])[1] || "";

      const groupTitle =
        (attributes.match(
          /group-title="([^"]*)"/i
        ) || [])[1] || "";

      currentInfo = {
        name:
          name ||
          tvgName ||
          "Unknown",
        tvgId,
        tvgName,
        tvgLogo,
        groupTitle
      };

      continue;
    }

    if (
      !line.startsWith("#") &&
      currentInfo
    ) {
      const url = line;

      result.push({
        ...currentInfo,
        url
      });

      currentInfo = null;
    }
  }

  return result;
}

// =====================================================
// CHECK STREAM
// =====================================================

async function checkStream(channel) {
  try {
    const result =
      await httpGet(
        channel.url,
        CHECK_TIMEOUT
      );

    const status =
      result.statusCode;

    // Reject common dead/blocked streams
    if (
      status === 401 ||
      status === 403 ||
      status === 404 ||
      status === 410
    ) {
      return false;
    }

    if (
      status >= 500 &&
      status <= 599
    ) {
      return false;
    }

    // 200 / 206 = good
    if (
      status === 200 ||
      status === 206
    ) {
      return true;
    }

    // Redirects are allowed.
    // FFmpeg can follow them.
    if (
      status >= 300 &&
      status < 400
    ) {
      return true;
    }

    return false;
  } catch {
    return false;
  }
}

// =====================================================
// CHECK CHANNELS WITH CONCURRENCY
// =====================================================

async function validateChannels(list) {
  const valid = [];

  let index = 0;

  async function worker() {
    while (true) {
      const i = index++;

      if (i >= list.length) {
        return;
      }

      const channel = list[i];

      process.stdout.write(
        `[CHECK] ${i + 1}/${list.length} ${channel.name} ... `
      );

      const ok =
        await checkStream(channel);

      if (ok) {
        console.log("OK");

        valid.push(channel);
      } else {
        console.log("FAILED");
      }
    }
  }

  const workers = [];

  const count =
    Math.min(
      CHECK_CONCURRENCY,
      list.length
    );

  for (
    let i = 0;
    i < count;
    i++
  ) {
    workers.push(worker());
  }

  await Promise.all(workers);

  // Preserve original playlist order
  valid.sort((a, b) => {
    return list.indexOf(a) -
      list.indexOf(b);
  });

  // Assign IDs after filtering
  return valid.map(
    (channel, index) => ({
      id: index + 1,
      ...channel
    })
  );
}

// =====================================================
// CLEAR HLS
// =====================================================

function clearHLS() {
  try {
    const files =
      fs.readdirSync(HLS_DIR);

    for (const file of files) {
      try {
        fs.unlinkSync(
          path.join(
            HLS_DIR,
            file
          )
        );
      } catch {}
    }
  } catch {}
}

// =====================================================
// STOP FFMPEG
// =====================================================

function stopFFmpeg() {
  if (statsTimer) {
    clearInterval(statsTimer);
    statsTimer = null;
  }

  if (ffmpeg) {
    console.log(
      "[FFmpeg] stopping..."
    );

    try {
      ffmpeg.kill("SIGKILL");
    } catch {}

    ffmpeg = null;
  }

  frames = [];

  jpgBuffer = Buffer.alloc(0);

  ffmpegSpeed = 0;
  ffmpegFps = 0;
  ffmpegFrame = 0;

  mjpegFrameCount = 0;
  lastMjpegFrameCount = 0;

  mjpegFps = 0;

  lastStatsTime = Date.now();
}

// =====================================================
// START FFMPEG
// =====================================================

function startFFmpeg(channel) {
  stopFFmpeg();

  console.log("");
  console.log(
    "========================================"
  );

  console.log(
    "[FFmpeg] START:",
    channel.name
  );

  console.log(
    "[FFmpeg] URL:",
    channel.url
  );

  console.log(
    `[FFmpeg] MJPEG: ${WIDTH}x${HEIGHT} @ ${FPS} FPS`
  );

  console.log(
    `[FFmpeg] Delay: ${DELAY_SECONDS}s`
  );

  console.log(
    `[FFmpeg] Buffer: ${BUFFER_SECONDS}s`
  );

  console.log(
    "========================================"
  );

  clearHLS();

  frames = [];

  jpgBuffer = Buffer.alloc(0);

  const playlist =
    path.join(
      HLS_DIR,
      "stream.m3u8"
    );

  const segment =
    path.join(
      HLS_DIR,
      "segment_%05d.ts"
    );

  // Reset stats
  ffmpegSpeed = 0;
  ffmpegFps = 0;
  ffmpegFrame = 0;

  mjpegFrameCount = 0;
  lastMjpegFrameCount = 0;

  mjpegFps = 0;

  lastStatsTime =
    Date.now();

  // ===================================================
  // FFMPEG
  // ===================================================

  ffmpeg = spawn(
    "ffmpeg",
    [
      "-hide_banner",

      // Warnings only
      "-loglevel",
      "warning",

      // Progress information
      "-progress",
      "pipe:2",

      "-stats_period",
      "2",

      // Reconnect
      "-reconnect",
      "1",

      "-reconnect_streamed",
      "1",

      "-reconnect_delay_max",
      "5",

      // Low input buffering
      "-fflags",
      "nobuffer",

      // Input
      "-i",
      channel.url,

      // =================================================
      // OUTPUT 1: HLS
      // =================================================

      "-map",
      "0:v:0",

      "-map",
      "0:a:0?",

      // Copy original video
      "-c:v",
      "copy",

      // Browser audio
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
      // OUTPUT 2: MJPEG
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
  // MJPEG STDOUT
  // ===================================================

  ffmpeg.stdout.on(
    "data",
    chunk => {
      jpgBuffer =
        Buffer.concat([
          jpgBuffer,
          chunk
        ]);

      while (true) {
        const start =
          jpgBuffer.indexOf(
            Buffer.from([
              0xff,
              0xd8
            ])
          );

        if (start === -1) {
          if (
            jpgBuffer.length >
            1024 * 1024
          ) {
            jpgBuffer =
              jpgBuffer.slice(
                -100000
              );
          }

          break;
        }

        const end =
          jpgBuffer.indexOf(
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
          jpgBuffer.slice(
            start,
            end + 2
          );

        jpgBuffer =
          jpgBuffer.slice(
            end + 2
          );

        // Save frame
        frames.push({
          time: Date.now(),
          data: jpeg
        });

        mjpegFrameCount++;

        // Remove frames older than BUFFER_SECONDS
        const cutoff =
          Date.now() -
          BUFFER_SECONDS * 1000;

        while (
          frames.length &&
          frames[0].time <
            cutoff
        ) {
          frames.shift();
        }
      }
    }
  );

  // ===================================================
  // FFMPEG STDERR / PROGRESS
  // ===================================================

  let progress = {};

  ffmpeg.stderr.on(
    "data",
    data => {
      const text =
        data.toString();

      const lines =
        text.split(
          /\r?\n/
        );

      for (
        const lineRaw of lines
      ) {
        const line =
          lineRaw.trim();

        if (!line) continue;

        // -------------------------------
        // speed
        // -------------------------------

        if (
          line.startsWith(
            "speed="
          )
        ) {
          const value =
            line
              .substring(6)
              .trim()
              .replace(
                /x$/,
                ""
              );

          const number =
            parseFloat(
              value
            );

          if (
            Number.isFinite(
              number
            )
          ) {
            ffmpegSpeed =
              number;
          }

          progress.speed =
            value;

          continue;
        }

        // -------------------------------
        // fps
        // -------------------------------

        if (
          line.startsWith(
            "fps="
          )
        ) {
          const value =
            line
              .substring(4)
              .trim();

          const number =
            parseFloat(
              value
            );

          if (
            Number.isFinite(
              number
            )
          ) {
            ffmpegFps =
              number;
          }

          progress.fps =
            value;

          continue;
        }

        // -------------------------------
        // frame
        // -------------------------------

        if (
          line.startsWith(
            "frame="
          )
        ) {
          const value =
            line
              .substring(6)
              .trim();

          const number =
            parseInt(
              value,
              10
            );

          if (
            Number.isFinite(
              number
            )
          ) {
            ffmpegFrame =
              number;
          }

          progress.frame =
            value;

          continue;
        }

        // -------------------------------
        // out_time
        // -------------------------------

        if (
          line.startsWith(
            "out_time="
          )
        ) {
          progress.out_time =
            line.substring(
              9
            );
        }

        // -------------------------------
        // progress
        // -------------------------------

        if (
          line.startsWith(
            "progress="
          )
        ) {
          progress.progress =
            line.substring(
              9
            );
        }

        // -------------------------------
        // HLS skipping
        // -------------------------------

        if (
          line.includes(
            "skipping"
          ) &&
          line.includes(
            "segments ahead"
          )
        ) {
          console.log(
            "[HLS]",
            line
          );
        }

        // -------------------------------
        // Other important errors
        // -------------------------------

        if (
          line.includes(
            "HTTP error"
          ) ||
          line.includes(
            "Server returned"
          ) ||
          line.includes(
            "Connection"
          ) ||
          line.includes(
            "Invalid data"
          )
        ) {
          console.log(
            "[FFmpeg]",
            line
          );
        }
      }
    }
  );

  // ===================================================
  // REALTIME STATISTICS
  // ===================================================

  statsTimer =
    setInterval(() => {
      const now =
        Date.now();

      const elapsed =
        (now -
          lastStatsTime) /
        1000;

      if (
        elapsed <= 0
      ) {
        return;
      }

      // MJPEG actual FPS
      const delta =
        mjpegFrameCount -
        lastMjpegFrameCount;

      mjpegFps =
        delta / elapsed;

      lastMjpegFrameCount =
        mjpegFrameCount;

      lastStatsTime =
        now;

      // Calculate actual buffer length
      let bufferSeconds =
        0;

      if (
        frames.length >= 2
      ) {
        const oldest =
          frames[0].time;

        const newest =
          frames[
            frames.length - 1
          ].time;

        bufferSeconds =
          (newest - oldest) /
          1000;
      }

      console.log("");
      console.log(
        "========== STREAM STATS =========="
      );

      console.log(
        `[STATS] Channel    : ${channel.name}`
      );

      console.log(
        `[STATS] FFmpeg     : ${ffmpegSpeed.toFixed(2)}x`
      );

      console.log(
        `[STATS] FFmpeg FPS : ${ffmpegFps.toFixed(2)}`
      );

      console.log(
        `[STATS] MJPEG FPS  : ${mjpegFps.toFixed(2)}`
      );

      console.log(
        `[STATS] Buffer     : ${bufferSeconds.toFixed(2)}s`
      );

      console.log(
        `[STATS] Frames     : ${frames.length}`
      );

      console.log(
        `[STATS] Total JPEG : ${mjpegFrameCount}`
      );

      console.log(
        `[STATS] FFmpeg frame: ${ffmpegFrame}`
      );

      console.log(
        "=================================="
      );
    }, 5000);

  // ===================================================
  // ERROR
  // ===================================================

  ffmpeg.on(
    "error",
    error => {
      console.error(
        "[FFmpeg ERROR]",
        error.message
      );
    }
  );

  // ===================================================
  // EXIT
  // ===================================================

  ffmpeg.on(
    "close",
    (code, signal) => {
      console.log(
        `[FFmpeg] exited code=${code} signal=${signal}`
      );

      if (
        statsTimer
      ) {
        clearInterval(
          statsTimer
        );

        statsTimer = null;
      }
    }
  );
}

// =====================================================
// API: CHANNELS
// =====================================================

app.get(
  "/api/channels",
  (req, res) => {
    res.json({
      count: channels.length,

      selected:
        selectedChannel
          ? selectedChannel.id
          : null,

      channels:
        channels.map(
          channel => ({
            id: channel.id,
            name: channel.name,
            group: channel.groupTitle,
            logo: channel.tvgLogo
          })
        )
    });
  }
);

// =====================================================
// API: SELECT CHANNEL
// =====================================================

app.get(
  "/api/select/:id",
  (req, res) => {
    const id =
      parseInt(
        req.params.id,
        10
      );

    const channel =
      channels.find(
        c => c.id === id
      );

    if (!channel) {
      return res
        .status(404)
        .json({
          error:
            "Channel not found"
        });
    }

    selectedChannel =
      channel;

    startFFmpeg(
      channel
    );

    res.json({
      ok: true,
      channel: {
        id: channel.id,
        name: channel.name
      }
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
          "HLS not ready"
        );
    }

    let data;

    try {
      data =
        fs.readFileSync(
          playlist,
          "utf8"
        );
    } catch {
      return res
        .status(500)
        .send(
          "Cannot read playlist"
        );
    }

    // Rewrite TS filenames
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
  }
);

// =====================================================
// HLS SEGMENTS
// =====================================================

app.get(
  "/hls-segment/:file",
  (req, res) => {
    const filename =
      path.basename(
        req.params.file
      );

    const file =
      path.join(
        HLS_DIR,
        filename
      );

    if (
      !fs.existsSync(file)
    ) {
      return res
        .status(404)
        .send(
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

    fs.createReadStream(
      file
    ).pipe(res);
  }
);

// =====================================================
// MJPEG STREAM
// =====================================================

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

        Pragma:
          "no-cache",

        Connection:
          "close",

        "Access-Control-Allow-Origin":
          "*"
      }
    );

    let closed = false;

    req.on(
      "close",
      () => {
        closed = true;
      }
    );

    // Send frame approximately at FPS
    const interval =
      setInterval(() => {
        if (closed) {
          clearInterval(
            interval
          );
          return;
        }

        if (
          frames.length === 0
        ) {
          return;
        }

        // Current time minus delay
        const targetTime =
          Date.now() -
          DELAY_SECONDS * 1000;

        // Find latest frame that is
        // at least DELAY_SECONDS old
        let selected =
          null;

        for (
          let i =
            frames.length - 1;
          i >= 0;
          i--
        ) {
          if (
            frames[i].time <=
            targetTime
          ) {
            selected =
              frames[i];

            break;
          }
        }

        // If target frame does not exist yet,
        // use oldest available frame.
        if (!selected) {
          selected =
            frames[0];
        }

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
          clearInterval(
            interval
          );
        }
      },
      Math.max(
        1,
        Math.floor(
          1000 / FPS
        )
      )
    );
  }
);

// =====================================================
// HEALTH
// =====================================================

app.get(
  "/health",
  (req, res) => {
    let bufferSeconds =
      0;

    if (
      frames.length >= 2
    ) {
      bufferSeconds =
        (
          frames[
            frames.length - 1
          ].time -
          frames[0].time
        ) / 1000;
    }

    res.json({
      ok: true,

      channels:
        channels.length,

      selected:
        selectedChannel
          ? selectedChannel.name
          : null,

      ffmpeg:
        Boolean(ffmpeg),

      speed:
        ffmpegSpeed,

      ffmpegFps:
        ffmpegFps,

      ffmpegFrame:
        ffmpegFrame,

      mjpegFps:
        mjpegFps,

      frames:
        frames.length,

      bufferSeconds:
        bufferSeconds
    });
  }
);

// =====================================================
// MAIN WEB PAGE
// =====================================================

app.get(
  "/",
  (req, res) => {
    const channelData =
      JSON.stringify(
        channels.map(
          c => ({
            id: c.id,
            name: c.name,
            group:
              c.groupTitle,
            logo:
              c.tvgLogo
          })
        )
      );

    res.send(`
<!DOCTYPE html>
<html lang="vi">

<head>

<meta charset="UTF-8">

<meta
  name="viewport"
  content="width=device-width,initial-scale=1"
/>

<title>IPTV Server</title>

<script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>

<style>

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  background: #111;
  color: #fff;
  font-family: Arial, sans-serif;
}

header {
  padding: 15px;
  background: #1c1c1c;
  position: sticky;
  top: 0;
  z-index: 10;
}

h1 {
  margin: 0 0 10px 0;
  font-size: 22px;
}

#search {
  width: 100%;
  padding: 12px;
  border-radius: 8px;
  border: 1px solid #444;
  background: #222;
  color: white;
  font-size: 16px;
}

.container {
  padding: 15px;
}

video {
  width: 100%;
  max-width: 800px;
  background: black;
  display: block;
  margin: auto;
  border-radius: 8px;
}

.mjpeg {
  margin-top: 15px;
  text-align: center;
}

.mjpeg img {
  width: 320px;
  height: 240px;
  max-width: 100%;
  background: black;
  object-fit: contain;
}

.status {
  padding: 10px;
  margin: 10px 0;
  background: #1c1c1c;
  border-radius: 8px;
}

.channels {
  display: grid;
  grid-template-columns:
    repeat(auto-fill, minmax(180px, 1fr));
  gap: 8px;
  margin-top: 15px;
}

.channel {
  padding: 12px;
  border-radius: 8px;
  background: #222;
  border: 1px solid #333;
  cursor: pointer;
}

.channel:hover {
  background: #333;
}

.channel.active {
  border-color: #fff;
}

.logo {
  width: 45px;
  height: 45px;
  object-fit: contain;
  background: #111;
  float: left;
  margin-right: 10px;
}

.name {
  min-height: 45px;
  display: flex;
  align-items: center;
}

</style>

</head>

<body>

<header>

<h1>IPTV Server</h1>

<input
  id="search"
  placeholder="Tìm kênh..."
/>

</header>

<div class="container">

<div class="status">
  <div>
    Kênh:
    <span id="selected">Chưa chọn</span>
  </div>

  <div>
    MJPEG:
    <code>/stream</code>
  </div>
</div>

<video
  id="video"
  controls
  autoplay
  muted
  playsinline>
</video>

<div class="mjpeg">

<h3>
  MJPEG 320x240 - ESP32
</h3>

<img
  src="/stream"
  alt="MJPEG"
/>

</div>

<div
  id="channels"
  class="channels">
</div>

</div>

<script>

const channels =
  ${channelData};

const container =
  document.getElementById(
    "channels"
  );

const search =
  document.getElementById(
    "search"
  );

const selectedText =
  document.getElementById(
    "selected"
  );

const video =
  document.getElementById(
    "video"
  );

let hls = null;

function render(list) {

  container.innerHTML = "";

  for (
    const channel of list
  ) {

    const div =
      document.createElement(
        "div"
      );

    div.className =
      "channel";

    div.dataset.id =
      channel.id;

    let logo = "";

    if (
      channel.logo
    ) {
      const safeLogo =
        String(
          channel.logo
        )
        .replace(
          /&/g,
          "&amp;"
        )
        .replace(
          /"/g,
          "&quot;"
        );

      logo =
        '<img class="logo" src="' +
        safeLogo +
        '">';
    }

    div.innerHTML =
      logo +
      '<div class="name">' +
      escapeHtml(
        channel.name
      ) +
      "</div>";

    div.onclick =
      () => selectChannel(
        channel
      );

    container.appendChild(
      div
    );
  }
}

function escapeHtml(
  text
) {

  return String(text)
    .replace(
      /&/g,
      "&amp;"
    )
    .replace(
      /</g,
      "&lt;"
    )
    .replace(
      />/g,
      "&gt;"
    )
    .replace(
      /"/g,
      "&quot;"
    )
    .replace(
      /'/g,
      "&#039;"
    );
}

async function selectChannel(
  channel
) {

  selectedText.textContent =
    "Đang chuyển sang " +
    channel.name;

  try {

    const response =
      await fetch(
        "/api/select/" +
        channel.id
      );

    const data =
      await response.json();

    if (!data.ok) {
      throw new Error(
        "Select failed"
      );
    }

    selectedText.textContent =
      channel.name;

    document
      .querySelectorAll(
        ".channel"
      )
      .forEach(
        element => {
          element.classList.toggle(
            "active",
            Number(
              element.dataset.id
            ) === channel.id
          );
        }
      );

    startHLS();

  } catch (error) {

    console.error(
      error
    );

    selectedText.textContent =
      "Lỗi chọn kênh";
  }
}

function startHLS() {

  const source =
    "/hls/stream.m3u8?t=" +
    Date.now();

  if (
    hls
  ) {

    try {
      hls.destroy();
    } catch {}

    hls = null;
  }

  if (
    video.canPlayType(
      "application/vnd.apple.mpegurl"
    )
  ) {

    video.src =
      source;

    video.play().catch(
      () => {}
    );

    return;
  }

  if (
    window.Hls &&
    Hls.isSupported()
  ) {

    hls =
      new Hls({
        lowLatencyMode:
          false,

        liveSyncDurationCount:
          4,

        liveMaxLatencyDurationCount:
          8,

        maxBufferLength:
          12,

        backBufferLength:
          6
      });

    hls.loadSource(
      source
    );

    hls.attachMedia(
      video
    );

    hls.on(
      Hls.Events.MANIFEST_PARSED,
      () => {
        video.play().catch(
          () => {}
        );
      }
    );

    hls.on(
      Hls.Events.ERROR,
      (
        event,
        data
      ) => {

        console.log(
          "HLS error",
          data
        );

        if (
          data.fatal
        ) {

          if (
            data.type ===
            Hls.ErrorTypes.NETWORK_ERROR
          ) {

            hls.startLoad();

          } else if (
            data.type ===
            Hls.ErrorTypes.MEDIA_ERROR
          ) {

            hls.recoverMediaError();
          }
        }
      }
    );
  }
}

search.addEventListener(
  "input",
  () => {

    const query =
      search.value
        .toLowerCase()
        .trim();

    const filtered =
      channels.filter(
        channel =>
          channel.name
            .toLowerCase()
            .includes(
              query
            ) ||

          String(
            channel.group || ""
          )
            .toLowerCase()
            .includes(
              query
            )
      );

    render(
      filtered
    );
  }
);

render(
  channels
);

</script>

</body>
</html>
`);
  }
);

// =====================================================
// LOAD CHANNELS
// =====================================================

async function loadChannels() {
  console.log("");
  console.log(
    "========================================"
  );

  console.log(
    "Downloading IPTV playlist..."
  );

  console.log(
    PLAYLIST_URL
  );

  console.log(
    "========================================"
  );

  const data =
    await downloadPlaylist();

  let list =
    parseM3U(data);

  console.log(
    `[PLAYLIST] Total entries: ${list.length}`
  );

  // Remove geo-blocked entries
  list =
    list.filter(
      channel => {

        const name =
          channel.name
            .toLowerCase();

        if (
          name.includes(
            "[geo-blocked]"
          )
        ) {
          return false;
        }

        // DASH is not suitable for current pipeline
        if (
          channel.url
            .toLowerCase()
            .includes(".mpd")
        ) {
          return false;
        }

        return true;
      }
    );

  console.log(
    `[PLAYLIST] After basic filtering: ${list.length}`
  );

  console.log("");
  console.log(
    "Checking stream URLs..."
  );

  channels =
    await validateChannels(
      list
    );

  console.log("");

  console.log(
    `[PLAYLIST] Working channels: ${channels.length}`
  );

  if (
    channels.length === 0
  ) {
    console.log(
      "[WARNING] No working channels found."
    );

    return;
  }

  console.log("");

  channels.forEach(
    channel => {
      console.log(
        `${channel.id}. ${channel.name}`
      );
    }
  );

  console.log("");

  // Automatically select first channel
  selectedChannel =
    channels[0];

  console.log(
    `[DEFAULT] ${selectedChannel.name}`
  );

  startFFmpeg(
    selectedChannel
  );
}

// =====================================================
// START SERVER
// =====================================================

app.listen(
  PORT,
  async () => {

    console.log("");
    console.log(
      "========================================"
    );

    console.log(
      `Server running on port ${PORT}`
    );

    console.log(
      `MJPEG: /stream`
    );

    console.log(
      `HLS:   /hls/stream.m3u8`
    );

    console.log(
      `API:   /api/channels`
    );

    console.log(
      `Health: /health`
    );

    console.log(
      "========================================"
    );

    try {
      await loadChannels();
    } catch (error) {

      console.error(
        "[STARTUP ERROR]",
        error.message
      );
    }
  }
);

// =====================================================
// CLEAN EXIT
// =====================================================

process.on(
  "SIGTERM",
  () => {
    console.log(
      "SIGTERM received"
    );

    stopFFmpeg();

    process.exit(0);
  }
);

process.on(
  "SIGINT",
  () => {
    console.log(
      "SIGINT received"
    );

    stopFFmpeg();

    process.exit(0);
  }
);
