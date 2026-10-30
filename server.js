const express = require("express");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const app = express();
const PORT = process.env.PORT || 10000;

// ======================================================
// CONFIG
// ======================================================

const PLAYLIST_URL =
  "https://raw.githubusercontent.com/iptv-org/iptv/master/streams/vn.m3u";

const WIDTH = 320;
const HEIGHT = 240;

// MJPEG giảm xuống 10 FPS để Render chạy realtime ổn định
const FPS = 10;

const DELAY_SECONDS = 1;
const BUFFER_SECONDS = 12;

const MAX_BUFFER_FRAMES = FPS * BUFFER_SECONDS;

const HLS_TIME = 2;
const HLS_LIST = 8;

const CHECK_TIMEOUT = 7000;
const CHECK_CONCURRENCY = 6;

// ======================================================
// PATH
// ======================================================

const TMP_DIR = path.join(os.tmpdir(), "iptv-server");

if (!fs.existsSync(TMP_DIR)) {
  fs.mkdirSync(TMP_DIR, { recursive: true });
}

const HLS_DIR = path.join(TMP_DIR, "hls");

if (!fs.existsSync(HLS_DIR)) {
  fs.mkdirSync(HLS_DIR, { recursive: true });
}

// ======================================================
// STATE
// ======================================================

let channels = [];
let selectedChannel = null;

let ffmpeg = null;
let ffmpegAudio = null;

let frames = [];
let jpegBuffer = Buffer.alloc(0);

let audioQueue = [];
const MAX_AUDIO_BUFFER = 2 * 1024 * 1024;

let streamClients = [];

let statsTimer = null;

let ffmpegStats = {
  frame: 0,
  fps: 0,
  speed: 0,
  outTime: "00:00:00.000000",
  lastUpdate: 0
};

let mjpegStats = {
  frames: 0,
  lastFrames: 0,
  lastTime: Date.now(),
  fps: 0
};

let progressTextBuffer = "";

// ======================================================
// UTILS
// ======================================================

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getBufferSeconds() {
  if (frames.length < 2) return 0;

  const first = frames[0];
  const last = frames[frames.length - 1];

  return Math.max(0, (last.time - first.time) / 1000);
}

function resetStats() {
  ffmpegStats = {
    frame: 0,
    fps: 0,
    speed: 0,
    outTime: "00:00:00.000000",
    lastUpdate: Date.now()
  };

  mjpegStats = {
    frames: 0,
    lastFrames: 0,
    lastTime: Date.now(),
    fps: 0
  };

  progressTextBuffer = "";
}

function startStatsTimer() {
  if (statsTimer) {
    clearInterval(statsTimer);
  }

  statsTimer = setInterval(() => {
    const now = Date.now();

    const dt = (now - mjpegStats.lastTime) / 1000;
    const df = mjpegStats.frames - mjpegStats.lastFrames;

    if (dt > 0) {
      mjpegStats.fps = df / dt;
    }

    mjpegStats.lastFrames = mjpegStats.frames;
    mjpegStats.lastTime = now;

    console.log("");
    console.log("==========");
    console.log(
      "[STATS] Channel     :",
      selectedChannel ? selectedChannel.name : "-"
    );
    console.log(
      "[STATS] FFmpeg speed:",
      ffmpegStats.speed
        ? ffmpegStats.speed.toFixed(2) + "x"
        : "N/A"
    );
    console.log(
      "[STATS] FFmpeg FPS  :",
      ffmpegStats.fps
        ? ffmpegStats.fps.toFixed(2)
        : "N/A"
    );
    console.log(
      "[STATS] MJPEG FPS   :",
      mjpegStats.fps.toFixed(2)
    );
    console.log(
      "[STATS] Buffer      :",
      getBufferSeconds().toFixed(2) + "s"
    );
    console.log(
      "[STATS] Frames      :",
      frames.length
    );
    console.log(
      "[STATS] JPEG total  :",
      mjpegStats.frames
    );
    console.log(
      "[STATS] FFmpeg frame:",
      ffmpegStats.frame
    );
    console.log("==========");
    console.log("");
  }, 5000);
}

function clearHLS() {
  try {
    const files = fs.readdirSync(HLS_DIR);

    for (const file of files) {
      try {
        fs.unlinkSync(path.join(HLS_DIR, file));
      } catch {}
    }
  } catch {}
}

// ======================================================
// PLAYLIST
// ======================================================

async function loadPlaylist() {
  console.log("Loading playlist:");

  console.log(PLAYLIST_URL);

  const response = await fetch(PLAYLIST_URL);

  if (!response.ok) {
    throw new Error(
      `Playlist HTTP ${response.status}`
    );
  }

  const text = await response.text();

  const lines = text
    .split(/\r?\n/)
    .map(x => x.trim())
    .filter(Boolean);

  const result = [];

  let current = null;

  for (const line of lines) {
    if (line.startsWith("#EXTINF")) {
      const comma = line.indexOf(",");

      let name =
        comma >= 0
          ? line.substring(comma + 1).trim()
          : "Unknown";

      const tvgLogo =
        (line.match(/tvg-logo="([^"]*)"/) || [])[1] || "";

      const group =
        (line.match(/group-title="([^"]*)"/) || [])[1] || "";

      current = {
        name,
        logo: tvgLogo,
        group,
        url: ""
      };
    } else if (
      current &&
      !line.startsWith("#")
    ) {
      current.url = line;

      if (current.url) {
        result.push(current);
      }

      current = null;
    }
  }

  console.log(
    `Playlist loaded: ${result.length} channels`
  );

  return result;
}

// ======================================================
// CHECK CHANNEL
// ======================================================

async function checkChannel(channel) {
  return new Promise(resolve => {
    const ff = spawn(
      "ffprobe",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-timeout",
        String(CHECK_TIMEOUT * 1000),
        "-i",
        channel.url,
        "-show_entries",
        "stream=codec_type",
        "-of",
        "default=noprint_wrappers=1:nokey=1"
      ],
      {
        stdio: ["ignore", "pipe", "pipe"]
      }
    );

    let output = "";

    const timer = setTimeout(() => {
      try {
        ff.kill("SIGKILL");
      } catch {}

      resolve(false);
    }, CHECK_TIMEOUT);

    ff.stdout.on("data", data => {
      output += data.toString();
    });

    ff.on("close", code => {
      clearTimeout(timer);

      const ok =
        code === 0 &&
        output.includes("video");

      resolve(ok);
    });

    ff.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

async function filterChannels(list) {
  const valid = [];

  let index = 0;

  async function worker() {
    while (true) {
      const i = index++;

      if (i >= list.length) {
        return;
      }

      const channel = list[i];

      try {
        const ok = await checkChannel(channel);

        if (ok) {
          console.log(
            "[OK]",
            channel.name
          );

          valid.push(channel);
        } else {
          console.log(
            "[SKIP]",
            channel.name
          );
        }
      } catch {
        console.log(
          "[SKIP]",
          channel.name
        );
      }
    }
  }

  const workers = [];

  for (
    let i = 0;
    i < CHECK_CONCURRENCY;
    i++
  ) {
    workers.push(worker());
  }

  await Promise.all(workers);

  return valid;
}

// ======================================================
// STOP FFMPEG
// ======================================================

function stopFFmpeg() {
  console.log("Stopping FFmpeg...");

  if (ffmpeg) {
    try {
      ffmpeg.kill("SIGKILL");
    } catch {}

    ffmpeg = null;
  }

  if (ffmpegAudio) {
    try {
      ffmpegAudio.kill("SIGKILL");
    } catch {}

    ffmpegAudio = null;
  }

  frames = [];
  jpegBuffer = Buffer.alloc(0);
  audioQueue = [];

  resetStats();

  clearHLS();
}

// ======================================================
// AUDIO FFMPEG
// ======================================================

function startAudioFFmpeg(channel) {
  console.log(
    "[AUDIO] Starting audio:",
    channel.name
  );

  ffmpegAudio = spawn(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "warning",

      "-reconnect",
      "1",
      "-reconnect_streamed",
      "1",
      "-reconnect_delay_max",
      "5",

      "-fflags",
      "nobuffer",

      "-i",
      channel.url,

      "-vn",

      "-ac",
      "1",
      "-ar",
      "44100",

      "-c:a",
      "pcm_s16le",

      "-f",
      "s16le",

      "pipe:1"
    ],
    {
      stdio: [
        "ignore",
        "pipe",
        "pipe"
      ]
    }
  );

  ffmpegAudio.stdout.on("data", data => {
    audioQueue.push(Buffer.from(data));

    let total = audioQueue.reduce(
      (sum, chunk) => sum + chunk.length,
      0
    );

    while (
      total > MAX_AUDIO_BUFFER &&
      audioQueue.length
    ) {
      const removed = audioQueue.shift();

      total -= removed.length;
    }
  });

  ffmpegAudio.stderr.on("data", data => {
    const text = data.toString().trim();

    if (text) {
      console.log(
        "[FFmpeg-AUDIO]",
        text
      );
    }
  });

  ffmpegAudio.on("close", () => {
    console.log(
      "[AUDIO] FFmpeg stopped"
    );

    ffmpegAudio = null;
  });

  ffmpegAudio.on("error", err => {
    console.log(
      "[AUDIO] Error:",
      err.message
    );
  });
}

// ======================================================
// VIDEO FFMPEG
// ======================================================

function startFFmpeg(channel) {
  stopFFmpeg();

  selectedChannel = channel;

  clearHLS();

  resetStats();

  const playlist =
    path.join(
      HLS_DIR,
      "index.m3u8"
    );

  const segment =
    path.join(
      HLS_DIR,
      "segment_%05d.ts"
    );

  console.log("");
  console.log(
    "Starting video FFmpeg:"
  );
  console.log(channel.name);
  console.log(channel.url);

  // ====================================================
  // VIDEO
  // ====================================================

  ffmpeg = spawn(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "warning",

      // REAL-TIME PROGRESS
      "-progress",
      "pipe:2",
      "-stats_period",
      "2",

      "-reconnect",
      "1",
      "-reconnect_streamed",
      "1",
      "-reconnect_delay_max",
      "5",

      "-fflags",
      "nobuffer",

      "-i",
      channel.url,

      // =================================================
      // HLS
      // =================================================

      "-map",
      "0:v:0",

      "-map",
      "0:a:0?",

      // Giữ nguyên video HLS
      "-c:v",
      "copy",

      // Audio HLS
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
      // MJPEG
      // =================================================

      "-map",
      "0:v:0",

      "-an",

      // 10 FPS
      "-vf",
      `fps=${FPS},scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=decrease,pad=${WIDTH}:${HEIGHT}:(ow-iw)/2:(oh-ih)/2`,

      // JPEG nhẹ hơn
      "-c:v",
      "mjpeg",

      "-q:v",
      "12",

      "-fps_mode",
      "cfr",

      "-f",
      "image2pipe",

      "pipe:1"
    ],
    {
      stdio: [
        "ignore",
        "pipe",
        "pipe"
      ]
    }
  );

  // ====================================================
  // JPEG PIPE
  // ====================================================

  ffmpeg.stdout.on("data", data => {
    jpegBuffer = Buffer.concat([
      jpegBuffer,
      Buffer.from(data)
    ]);

    while (true) {
      const start =
        jpegBuffer.indexOf(
          Buffer.from([0xff, 0xd8])
        );

      if (start < 0) {
        // Không giữ buffer quá lớn
        if (jpegBuffer.length > 1024 * 1024) {
          jpegBuffer = Buffer.alloc(0);
        }

        break;
      }

      const end =
        jpegBuffer.indexOf(
          Buffer.from([0xff, 0xd9]),
          start + 2
        );

      if (end < 0) {
        break;
      }

      const jpeg =
        jpegBuffer.subarray(
          start,
          end + 2
        );

      jpegBuffer =
        jpegBuffer.subarray(
          end + 2
        );

      frames.push({
        data: Buffer.from(jpeg),
        time: Date.now()
      });

      mjpegStats.frames++;

      // Giữ tối đa 12 giây
      while (
        frames.length >
        MAX_BUFFER_FRAMES
      ) {
        frames.shift();
      }
    }
  });

  // ====================================================
  // FFMPEG PROGRESS
  // ====================================================

  ffmpeg.stderr.on("data", data => {
    progressTextBuffer +=
      data.toString();

    const lines =
      progressTextBuffer.split(
        /\r?\n/
      );

    progressTextBuffer =
      lines.pop() || "";

    for (const raw of lines) {
      const line = raw.trim();

      if (!line) continue;

      if (line.includes("=")) {
        const idx =
          line.indexOf("=");

        const key =
          line.substring(0, idx);

        const value =
          line.substring(idx + 1);

        if (key === "frame") {
          ffmpegStats.frame =
            Number(value) || 0;
        }

        else if (key === "fps") {
          const n =
            parseFloat(value);

          if (Number.isFinite(n)) {
            ffmpegStats.fps = n;
          }
        }

        else if (key === "speed") {
          const n =
            parseFloat(
              value.replace("x", "")
            );

          if (Number.isFinite(n)) {
            ffmpegStats.speed = n;
          }
        }

        else if (key === "out_time") {
          ffmpegStats.outTime =
            value;
        }

        else if (key === "progress") {
          ffmpegStats.lastUpdate =
            Date.now();
        }
      } else {
        console.log(
          "[FFmpeg]",
          line
        );
      }
    }
  });

  ffmpeg.on("close", (code, signal) => {
    console.log(
      "[FFmpeg] stopped",
      {
        code,
        signal
      }
    );

    if (ffmpeg) {
      ffmpeg = null;
    }
  });

  ffmpeg.on("error", err => {
    console.log(
      "[FFmpeg] error:",
      err.message
    );
  });

  // ====================================================
  // AUDIO
  // ====================================================

  startAudioFFmpeg(channel);

  // ====================================================
  // STATS
  // ====================================================

  startStatsTimer();
}

// ======================================================
// STREAM CLIENT
// ======================================================

app.get("/stream", (req, res) => {
  res.writeHead(200, {
    "Content-Type":
      "multipart/x-mixed-replace; boundary=frame",

    "Cache-Control":
      "no-cache, no-store, must-revalidate",

    "Pragma": "no-cache",

    "Connection": "keep-alive",

    "Access-Control-Allow-Origin": "*"
  });

  const client = {
    res,
    index: Math.max(
      0,
      frames.length - 1
    ),
    lastSend: 0
  };

  streamClients.push(client);

  console.log(
    "[STREAM] Client connected. Total:",
    streamClients.length
  );

  let closed = false;

  const cleanup = () => {
    if (closed) return;

    closed = true;

    streamClients =
      streamClients.filter(
        x => x !== client
      );

    console.log(
      "[STREAM] Client disconnected. Total:",
      streamClients.length
    );
  };

  req.on("close", cleanup);
  res.on("close", cleanup);

  const timer =
    setInterval(() => {
      if (closed) {
        clearInterval(timer);
        return;
      }

      // ================================================
      // VIDEO
      // ================================================

      if (frames.length) {
        const now = Date.now();

        if (
          now - client.lastSend >=
          1000 / FPS
        ) {
          let index =
            Math.min(
              client.index,
              frames.length - 1
            );

          const selected =
            frames[index];

          if (selected) {
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

              client.lastSend =
                now;

              client.index =
                Math.min(
                  client.index + 1,
                  frames.length - 1
                );
            } catch {
              cleanup();
            }
          }
        }
      }

      // ================================================
      // AUDIO
      // ================================================

      if (
        audioQueue.length
      ) {
        const audioChunk =
          audioQueue.shift();

        try {
          res.write(
            "--frame\r\n"
          );

          res.write(
            "Content-Type: audio/L16; rate=44100; channels=1\r\n"
          );

          res.write(
            "Content-Length: " +
            audioChunk.length +
            "\r\n\r\n"
          );

          res.write(
            audioChunk
          );

          res.write(
            "\r\n"
          );
        } catch {
          cleanup();
        }
      }
    }, 10);

  req.on("close", () => {
    clearInterval(timer);
  });
});

// ======================================================
// HLS PLAYLIST
// ======================================================

app.get(
  "/hls/index.m3u8",
  (req, res) => {
    const playlist =
      path.join(
        HLS_DIR,
        "index.m3u8"
      );

    if (!fs.existsSync(playlist)) {
      return res
        .status(404)
        .send("HLS not ready");
    }

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
      "no-cache"
    );

    res.send(data);
  }
);

// ======================================================
// HLS SEGMENTS
// ======================================================

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

    if (!fs.existsSync(file)) {
      return res
        .status(404)
        .send("Segment not found");
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

// ======================================================
// HEALTH
// ======================================================

app.get(
  "/health",
  (req, res) => {
    res.json({
      ok: true,

      channel:
        selectedChannel
          ? selectedChannel.name
          : null,

      resolution:
        `${WIDTH}x${HEIGHT}`,

      targetFPS: FPS,

      stats: {
        ffmpeg: {
          frame:
            ffmpegStats.frame,

          fps:
            ffmpegStats.fps,

          speed:
            ffmpegStats.speed
        },

        mjpeg: {
          fps:
            mjpegStats.fps,

          totalFrames:
            mjpegStats.frames,

          bufferFrames:
            frames.length,

          bufferSeconds:
            getBufferSeconds()
        }
      }
    });
  }
);

// ======================================================
// API CHANNELS
// ======================================================

app.get(
  "/api/channels",
  (req, res) => {
    res.json(
      channels.map((channel, index) => ({
        id: index,
        name: channel.name,
        logo: channel.logo,
        group: channel.group
      }))
    );
  }
);

// ======================================================
// SELECT CHANNEL
// ======================================================

app.get(
  "/api/select/:id",
  (req, res) => {
    const id =
      Number(req.params.id);

    if (
      !Number.isInteger(id) ||
      !channels[id]
    ) {
      return res
        .status(404)
        .json({
          error:
            "Channel not found"
        });
    }

    startFFmpeg(
      channels[id]
    );

    res.json({
      ok: true,
      channel:
        channels[id].name
    });
  }
);

// ======================================================
// WEB UI
// ======================================================

app.get("/", (req, res) => {
  const safeSource =
    selectedChannel
      ? String(
          selectedChannel.url
        )
          .replace(
            /&/g,
            "&amp;"
          )
          .replace(
            /"/g,
            "&quot;"
          )
      : "";

  const channelOptions =
    channels
      .map(
        (channel, index) =>
          `<option value="${index}">${channel.name}</option>`
      )
      .join("");

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

<style>

body {
  font-family: Arial, sans-serif;
  background: #111;
  color: white;
  margin: 0;
  padding: 20px;
}

video {
  width: 100%;
  max-width: 900px;
  background: black;
}

img {
  width: 320px;
  height: 240px;
  object-fit: contain;
  background: black;
}

select,
button {
  padding: 10px;
  margin: 5px;
}

pre {
  background: #222;
  padding: 15px;
  overflow: auto;
}

</style>

</head>

<body>

<h2>IPTV Server</h2>

<select id="channel">
${channelOptions}
</select>

<button onclick="selectChannel()">
Chọn kênh
</button>

<h3>HLS</h3>

<video
  id="video"
  controls
  autoplay
  muted
  playsinline
></video>

<h3>MJPEG 320x240 @ ${FPS} FPS</h3>

<img
  src="/stream"
  alt="MJPEG"
/>

<h3>Stats</h3>

<pre id="stats">
Loading...
</pre>

<script>

async function selectChannel() {

  const id =
    document.getElementById(
      "channel"
    ).value;

  await fetch(
    "/api/select/" + id
  );

  setTimeout(() => {
    location.reload();
  }, 1000);
}

async function updateStats() {

  try {

    const r =
      await fetch(
        "/health",
        {
          cache: "no-store"
        }
      );

    const data =
      await r.json();

    document.getElementById(
      "stats"
    ).textContent =
      JSON.stringify(
        data,
        null,
        2
      );

  } catch {}

}

setInterval(
  updateStats,
  2000
);

updateStats();

</script>

</body>
</html>
`);
});

// ======================================================
// START
// ======================================================

async function start() {

  try {

    console.log(
      "Loading IPTV playlist..."
    );

    const list =
      await loadPlaylist();

    console.log(
      "Checking channels..."
    );

    channels =
      await filterChannels(
        list
      );

    console.log(
      `Valid channels: ${channels.length}`
    );

    if (channels.length) {

      // Chọn kênh đầu tiên
      startFFmpeg(
        channels[0]
      );

    }

  } catch (err) {

    console.error(
      "START ERROR:",
      err
    );
  }
}

app.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      `Server running on port ${PORT}`
    );

    start();
  }
);
