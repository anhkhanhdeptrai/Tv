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
const FPS = 10;

const FRAME_BUFFER_SIZE = 3;
const MAX_AUDIO_BUFFER = 256 * 1024;

const HLS_TIME = 2;
const HLS_LIST = 6;

const TMP_ROOT = path.join(os.tmpdir(), "iptv-server");

fs.mkdirSync(TMP_ROOT, {
  recursive: true
});

// ======================================================
// GLOBAL
// ======================================================

let channels = [];

let currentIndex = -1;
let currentChannel = null;

let sessionId = 0;

let ffmpegVideo = null;
let ffmpegHLS = null;
let ffmpegAudio = null;

let frameBuffer = [];
let audioQueue = [];

let mjpegClients = new Set();

let mjpegTimer = null;
let statsTimer = null;

let stats = {
  ffmpegFrame: 0,
  ffmpegFPS: 0,
  ffmpegSpeed: 0,

  mjpegFPS: 0,
  mjpegTotalFrames: 0,

  bufferFrames: 0,
  bufferSeconds: 0,

  audioBytes: 0
};

let mjpegFrameCounter = 0;
let lastMjpegStatTime = Date.now();


// ======================================================
// PLAYLIST
// ======================================================

async function loadPlaylist() {
  console.log("==========================================");
  console.log("LOAD IPTV PLAYLIST");
  console.log("==========================================");

  const response = await fetch(PLAYLIST_URL);

  if (!response.ok) {
    throw new Error(
      `Cannot load playlist: HTTP ${response.status}`
    );
  }

  const text = await response.text();

  const lines = text.split(/\r?\n/);

  channels = [];

  let currentInfo = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    if (!line) {
      continue;
    }

    // ------------------------------------------
    // EXTINF
    // ------------------------------------------

    if (line.startsWith("#EXTINF:")) {
      const comma = line.indexOf(",");

      let name = "";

      if (comma !== -1) {
        name = line.substring(comma + 1).trim();
      }

      const tvgIdMatch =
        line.match(/tvg-id="([^"]*)"/i);

      const groupMatch =
        line.match(/group-title="([^"]*)"/i);

      const logoMatch =
        line.match(/tvg-logo="([^"]*)"/i);

      currentInfo = {
        name: name || `Channel ${channels.length + 1}`,

        tvgId:
          tvgIdMatch ? tvgIdMatch[1] : "",

        group:
          groupMatch ? groupMatch[1] : "",

        logo:
          logoMatch ? logoMatch[1] : ""
      };

      continue;
    }

    // ------------------------------------------
    // STREAM URL
    // ------------------------------------------

    if (
      !line.startsWith("#") &&
      currentInfo
    ) {
      channels.push({
        index: channels.length,

        name: currentInfo.name,

        tvgId: currentInfo.tvgId,

        group: currentInfo.group,

        logo: currentInfo.logo,

        url: line,

        live: null,

        error: null
      });

      currentInfo = null;
    }
  }

  console.log(
    `Loaded ${channels.length} channels`
  );

  console.log(
    "NO CHANNEL CHECKING"
  );

  console.log("==========================================");
}


// ======================================================
// CLEANUP OLD SESSION
// ======================================================

function killProcess(proc) {
  if (!proc) {
    return;
  }

  try {
    proc.kill("SIGKILL");
  } catch (_) {}
}


function clearClients() {
  for (const client of mjpegClients) {
    try {
      client.end();
    } catch (_) {}
  }

  mjpegClients.clear();
}


function stopCurrentSession() {
  console.log("Stopping current session...");

  sessionId++;

  killProcess(ffmpegVideo);
  killProcess(ffmpegHLS);
  killProcess(ffmpegAudio);

  ffmpegVideo = null;
  ffmpegHLS = null;
  ffmpegAudio = null;

  frameBuffer = [];
  audioQueue = [];

  clearClients();

  if (mjpegTimer) {
    clearInterval(mjpegTimer);
    mjpegTimer = null;
  }

  if (statsTimer) {
    clearInterval(statsTimer);
    statsTimer = null;
  }

  stats = {
    ffmpegFrame: 0,
    ffmpegFPS: 0,
    ffmpegSpeed: 0,

    mjpegFPS: 0,
    mjpegTotalFrames: 0,

    bufferFrames: 0,
    bufferSeconds: 0,

    audioBytes: 0
  };

  mjpegFrameCounter = 0;
  lastMjpegStatTime = Date.now();
}


// ======================================================
// NEW HLS DIRECTORY
// ======================================================

function createHLSDirectory(mySession) {
  const dir = path.join(
    TMP_ROOT,
    `hls-${mySession}`
  );

  fs.rmSync(dir, {
    recursive: true,
    force: true
  });

  fs.mkdirSync(dir, {
    recursive: true
  });

  return dir;
}


// ======================================================
// MJPEG BROADCAST
// ======================================================

function startMJPEGBroadcaster(mySession) {
  if (mjpegTimer) {
    clearInterval(mjpegTimer);
  }

  mjpegTimer = setInterval(() => {

    if (mySession !== sessionId) {
      return;
    }

    if (frameBuffer.length === 0) {
      return;
    }

    // ------------------------------------------
    // CHỈ LẤY FRAME MỚI NHẤT
    // Không phát frame cũ.
    // ------------------------------------------

    const frame =
      frameBuffer[frameBuffer.length - 1];

    // Xóa các frame cũ
    frameBuffer = [frame];

    const clients =
      Array.from(mjpegClients);

    for (const client of clients) {
      try {
        client.res.write(
          "--frame\r\n"
        );

        client.res.write(
          "Content-Type: image/jpeg\r\n"
        );

        client.res.write(
          "Content-Length: " +
          frame.data.length +
          "\r\n\r\n"
        );

        client.res.write(frame.data);

        client.res.write("\r\n");

      } catch (_) {

        try {
          client.res.end();
        } catch (_) {}

        mjpegClients.delete(client);
      }
    }

    stats.mjpegTotalFrames++;

    mjpegFrameCounter++;

    const now = Date.now();

    if (
      now - lastMjpegStatTime >= 1000
    ) {
      stats.mjpegFPS =
        mjpegFrameCounter /
        ((now - lastMjpegStatTime) / 1000);

      mjpegFrameCounter = 0;

      lastMjpegStatTime = now;
    }

    stats.bufferFrames =
      frameBuffer.length;

    stats.bufferSeconds =
      frameBuffer.length / FPS;

  }, 1000 / FPS);
}


// ======================================================
// VIDEO -> MJPEG
// ======================================================

function startVideo(channel, mySession) {

  console.log("");
  console.log("==========================================");
  console.log("START MJPEG");
  console.log("Channel:", channel.name);
  console.log("URL:", channel.url);
  console.log("==========================================");

  const args = [
    "-hide_banner",

    "-loglevel",
    "warning",

    // ----------------------------------------
    // LOW LATENCY
    // ----------------------------------------

    "-fflags",
    "nobuffer",

    "-flags",
    "low_delay",

    "-avioflags",
    "direct",

    "-analyzeduration",
    "500k",

    "-probesize",
    "1M",

    "-rw_timeout",
    "5000000",

    // ----------------------------------------
    // INPUT
    // ----------------------------------------

    "-i",
    channel.url,

    // ----------------------------------------
    // VIDEO ONLY
    // ----------------------------------------

    "-map",
    "0:v:0",

    "-an",

    // ----------------------------------------
    // 320x240 / 10 FPS
    // ----------------------------------------

    "-vf",
    [
      `fps=${FPS}`,

      `scale=${WIDTH}:${HEIGHT}:flags=fast_bilinear:force_original_aspect_ratio=decrease`,

      `pad=${WIDTH}:${HEIGHT}:(ow-iw)/2:(oh-ih)/2`
    ].join(","),

    // ----------------------------------------
    // MJPEG
    // ----------------------------------------

    "-c:v",
    "mjpeg",

    "-q:v",
    "18",

    "-fps_mode",
    "cfr",

    "-flush_packets",
    "1",

    "-f",
    "image2pipe",

    "pipe:1"
  ];

  ffmpegVideo = spawn(
    "ffmpeg",
    args,
    {
      stdio: [
        "ignore",
        "pipe",
        "pipe"
      ]
    }
  );

  let jpegBuffer = Buffer.alloc(0);

  ffmpegVideo.stdout.on(
    "data",
    (chunk) => {

      if (mySession !== sessionId) {
        return;
      }

      jpegBuffer = Buffer.concat([
        jpegBuffer,
        chunk
      ]);

      while (true) {

        const start =
          jpegBuffer.indexOf(
            Buffer.from([0xff, 0xd8])
          );

        if (start === -1) {

          // Không để buffer phình
          if (jpegBuffer.length > 1024 * 1024) {
            jpegBuffer =
              jpegBuffer.subarray(
                jpegBuffer.length - 64 * 1024
              );
          }

          break;
        }

        const end =
          jpegBuffer.indexOf(
            Buffer.from([0xff, 0xd9]),
            start + 2
          );

        if (end === -1) {
          break;
        }

        const jpegEnd = end + 2;

        const frame =
          jpegBuffer.subarray(
            start,
            jpegEnd
          );

        jpegBuffer =
          jpegBuffer.subarray(jpegEnd);

        // ------------------------------------
        // BUFFER CỰC NHỎ
        // ------------------------------------

        frameBuffer.push({
          data: Buffer.from(frame),
          time: Date.now()
        });

        while (
          frameBuffer.length >
          FRAME_BUFFER_SIZE
        ) {
          frameBuffer.shift();
        }

        stats.bufferFrames =
          frameBuffer.length;
      }
    }
  );


  ffmpegVideo.stderr.on(
    "data",
    (data) => {

      if (mySession !== sessionId) {
        return;
      }

      const text =
        data.toString();

      const fpsMatch =
        text.match(
          /fps=\s*([0-9.]+)/
        );

      const speedMatch =
        text.match(
          /speed=\s*([0-9.]+)x/
        );

      const frameMatch =
        text.match(
          /frame=\s*(\d+)/
        );

      if (fpsMatch) {
        stats.ffmpegFPS =
          Number(fpsMatch[1]);
      }

      if (speedMatch) {
        stats.ffmpegSpeed =
          Number(speedMatch[1]);
      }

      if (frameMatch) {
        stats.ffmpegFrame =
          Number(frameMatch[1]);
      }

      const clean =
        text.trim();

      if (clean) {
        console.log(
          "[FFMPEG VIDEO]",
          clean
        );
      }
    }
  );


  ffmpegVideo.on(
    "close",
    (code, signal) => {

      if (mySession !== sessionId) {
        return;
      }

      console.log(
        "FFmpeg MJPEG stopped:",
        code,
        signal
      );

      ffmpegVideo = null;
    }
  );


  ffmpegVideo.on(
    "error",
    (err) => {

      if (mySession !== sessionId) {
        return;
      }

      console.error(
        "FFmpeg MJPEG error:",
        err.message
      );
    }
  );


  startMJPEGBroadcaster(
    mySession
  );
}


// ======================================================
// HLS
// ======================================================

function startHLS(channel, mySession) {

  const hlsDir =
    createHLSDirectory(mySession);

  const playlist =
    path.join(
      hlsDir,
      "index.m3u8"
    );

  const segment =
    path.join(
      hlsDir,
      "segment-%05d.ts"
    );

  console.log("");
  console.log("==========================================");
  console.log("START HLS");
  console.log("Channel:", channel.name);
  console.log("==========================================");

  const args = [

    "-hide_banner",

    "-loglevel",
    "warning",

    // ----------------------------------------
    // LOW LATENCY
    // ----------------------------------------

    "-fflags",
    "nobuffer",

    "-flags",
    "low_delay",

    "-avioflags",
    "direct",

    "-reconnect",
    "1",

    "-reconnect_streamed",
    "1",

    "-reconnect_delay_max",
    "2",

    "-rw_timeout",
    "5000000",

    // ----------------------------------------
    // INPUT
    // ----------------------------------------

    "-i",
    channel.url,

    // ----------------------------------------
    // VIDEO
    // KHÔNG ENCODE LẠI
    // ----------------------------------------

    "-map",
    "0:v:0",

    "-c:v",
    "copy",

    // ----------------------------------------
    // AUDIO
    // ----------------------------------------

    "-map",
    "0:a:0?",

    "-c:a",
    "aac",

    "-b:a",
    "128k",

    "-ar",
    "44100",

    "-ac",
    "2",

    // ----------------------------------------
    // HLS
    // ----------------------------------------

    "-f",
    "hls",

    "-hls_time",
    String(HLS_TIME),

    "-hls_list_size",
    String(HLS_LIST),

    "-hls_flags",
    "delete_segments+append_list+omit_endlist",

    "-hls_segment_filename",
    segment,

    playlist
  ];

  ffmpegHLS = spawn(
    "ffmpeg",
    args,
    {
      stdio: [
        "ignore",
        "ignore",
        "pipe"
      ]
    }
  );


  ffmpegHLS.stderr.on(
    "data",
    (data) => {

      if (mySession !== sessionId) {
        return;
      }

      const text =
        data.toString().trim();

      if (text) {
        console.log(
          "[FFMPEG HLS]",
          text
        );
      }
    }
  );


  ffmpegHLS.on(
    "close",
    (code, signal) => {

      if (mySession !== sessionId) {
        return;
      }

      console.log(
        "FFmpeg HLS stopped:",
        code,
        signal
      );

      ffmpegHLS = null;
    }
  );


  ffmpegHLS.on(
    "error",
    (err) => {

      if (mySession !== sessionId) {
        return;
      }

      console.error(
        "FFmpeg HLS error:",
        err.message
      );
    }
  );
}


// ======================================================
// SEPARATE AUDIO PROCESS
// ======================================================

function startAudio(channel, mySession) {

  console.log(
    "START AUDIO:",
    channel.name
  );

  const args = [

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
  ];

  ffmpegAudio = spawn(
    "ffmpeg",
    args,
    {
      stdio: [
        "ignore",
        "pipe",
        "pipe"
      ]
    }
  );


  ffmpegAudio.stdout.on(
    "data",
    (chunk) => {

      if (mySession !== sessionId) {
        return;
      }

      audioQueue.push(
        Buffer.from(chunk)
      );

      stats.audioBytes +=
        chunk.length;

      // --------------------------------------
      // Giới hạn buffer audio
      // --------------------------------------

      let total = 0;

      for (let i = audioQueue.length - 1; i >= 0; i--) {

        total +=
          audioQueue[i].length;

        if (
          total >
          MAX_AUDIO_BUFFER
        ) {

          audioQueue =
            audioQueue.slice(i);

          break;
        }
      }
    }
  );


  ffmpegAudio.stderr.on(
    "data",
    (data) => {

      if (mySession !== sessionId) {
        return;
      }

      const text =
        data.toString().trim();

      if (text) {
        console.log(
          "[FFMPEG AUDIO]",
          text
        );
      }
    }
  );


  ffmpegAudio.on(
    "close",
    (code, signal) => {

      if (mySession !== sessionId) {
        return;
      }

      console.log(
        "FFmpeg AUDIO stopped:",
        code,
        signal
      );

      ffmpegAudio = null;
    }
  );


  ffmpegAudio.on(
    "error",
    (err) => {

      if (mySession !== sessionId) {
        return;
      }

      console.error(
        "FFmpeg AUDIO error:",
        err.message
      );
    }
  );
}


// ======================================================
// START CHANNEL
// ======================================================

function startChannel(index) {

  if (
    index < 0 ||
    index >= channels.length
  ) {
    return false;
  }

  const channel =
    channels[index];

  currentIndex = index;
  currentChannel = channel;

  stopCurrentSession();

  // stopCurrentSession() increments sessionId
  const mySession = sessionId;

  console.log("");
  console.log("##########################################");
  console.log(
    "CHANNEL:",
    index,
    "/",
    channels.length - 1
  );

  console.log(
    "NAME:",
    channel.name
  );

  console.log(
    "URL:",
    channel.url
  );

  console.log(
    "SESSION:",
    mySession
  );

  console.log("##########################################");
  console.log("");

  channel.live = null;
  channel.error = null;

  startVideo(
    channel,
    mySession
  );

  startHLS(
    channel,
    mySession
  );

  startAudio(
    channel,
    mySession
  );

  return true;
}


// ======================================================
// NEXT CHANNEL
// ======================================================

function nextChannel() {

  if (channels.length === 0) {
    return false;
  }

  let next =
    currentIndex + 1;

  if (next >= channels.length) {
    next = 0;
  }

  return startChannel(next);
}


// ======================================================
// EXPRESS
// ======================================================

// ------------------------------------------------------
// HOME
// ------------------------------------------------------

app.get(
  "/",
  (req, res) => {

    res.send(`<!DOCTYPE html>
<html lang="vi">

<head>

<meta charset="UTF-8">

<meta
  name="viewport"
  content="width=device-width, initial-scale=1.0"
>

<title>IPTV Server</title>

<style>

body {
  background:#111;
  color:#fff;
  font-family:Arial,sans-serif;
  margin:0;
  padding:20px;
}

video,
img {
  width:320px;
  height:240px;
  background:#000;
  object-fit:contain;
  display:block;
  margin-bottom:15px;
}

button {
  padding:10px 16px;
  margin:4px;
  font-size:16px;
}

select {
  padding:10px;
  width:320px;
  max-width:100%;
}

pre {
  white-space:pre-wrap;
  background:#222;
  padding:10px;
}

</style>

</head>

<body>

<h2>IPTV Server</h2>

<select id="channels"></select>

<br><br>

<button onclick="playSelected()">
Phát kênh
</button>

<button onclick="nextChannel()">
Kênh tiếp
</button>

<h3>HLS</h3>

<video
  id="video"
  controls
  autoplay
  playsinline
></video>

<h3>MJPEG ESP32</h3>

<img
  id="mjpeg"
  src="/stream"
/>

<h3>Stats</h3>

<pre id="stats">
Loading...
</pre>

<script>

const select =
  document.getElementById("channels");

const video =
  document.getElementById("video");

async function loadChannels() {

  const response =
    await fetch("/api/channels");

  const data =
    await response.json();

  select.innerHTML = "";

  for (const ch of data.channels) {

    const option =
      document.createElement("option");

    option.value =
      ch.index;

    option.textContent =
      ch.index +
      " - " +
      ch.name;

    select.appendChild(option);
  }
}


function playSelected() {

  const index =
    Number(select.value);

  fetch(
    "/api/channel/" + index
  )
  .then(() => {

    setTimeout(() => {

      video.src =
        "/hls/index.m3u8?t=" +
        Date.now();

      video.play()
        .catch(() => {});

    }, 1500);

  });
}


function nextChannel() {

  fetch("/api/next")
    .then(() => {

      setTimeout(() => {

        video.src =
          "/hls/index.m3u8?t=" +
          Date.now();

        video.play()
          .catch(() => {});

        loadChannels();

      }, 1500);

    });
}


async function updateStats() {

  try {

    const response =
      await fetch("/api/current");

    const data =
      await response.json();

    document.getElementById(
      "stats"
    ).textContent =
      JSON.stringify(
        data,
        null,
        2
      );

  } catch (_) {}

}


loadChannels();

setInterval(
  updateStats,
  1000
);

</script>

</body>
</html>`);
  }
);


// ======================================================
// MJPEG STREAM
// ======================================================

app.get(
  "/stream",
  (req, res) => {

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

    res.flushHeaders();

    const client = {
      res
    };

    mjpegClients.add(client);

    req.on(
      "close",
      () => {
        mjpegClients.delete(client);
      }
    );
  }
);


// ======================================================
// HLS PLAYLIST
// ======================================================

app.get(
  "/hls/index.m3u8",
  (req, res) => {

    if (!currentChannel) {
      return res
        .status(404)
        .send("No channel");
    }

    const dir =
      path.join(
        TMP_ROOT,
        `hls-${sessionId}`
      );

    const playlist =
      path.join(
        dir,
        "index.m3u8"
      );

    if (!fs.existsSync(playlist)) {
      return res
        .status(404)
        .send("HLS not ready");
    }

    try {

      let data =
        fs.readFileSync(
          playlist,
          "utf8"
        );

      // --------------------------------------
      // Rewrite TS segment URL
      // --------------------------------------

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
        .send(err.message);
    }
  }
);


// ======================================================
// HLS SEGMENT
// ======================================================

app.get(
  "/hls-segment/:file",
  (req, res) => {

    const dir =
      path.join(
        TMP_ROOT,
        `hls-${sessionId}`
      );

    const file =
      path.basename(
        req.params.file
      );

    const fullPath =
      path.join(
        dir,
        file
      );

    if (!fs.existsSync(fullPath)) {
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

    res.sendFile(
      fullPath
    );
  }
);


// ======================================================
// CHANNEL API
// ======================================================

app.get(
  "/api/channels",
  (req, res) => {

    res.json({
      count: channels.length,

      checking: false,

      channels:
        channels.map(ch => ({
          index: ch.index,

          name: ch.name,

          tvgId: ch.tvgId,

          group: ch.group,

          logo: ch.logo,

          url: ch.url,

          live: ch.live,

          error: ch.error,

          status:
            ch.index === currentIndex
              ? "current"
              : "unchecked"
        }))
    });
  }
);


// ======================================================
// CURRENT
// ======================================================

app.get(
  "/api/current",
  (req, res) => {

    res.json({
      ok: true,

      index: currentIndex,

      channel: currentChannel
        ? {
            index:
              currentChannel.index,

            name:
              currentChannel.name,

            url:
              currentChannel.url
          }
        : null,

      session:
        sessionId,

      resolution:
        `${WIDTH}x${HEIGHT}`,

      targetFPS:
        FPS,

      stats
    });
  }
);


// ======================================================
// SELECT CHANNEL
// ======================================================

app.get(
  "/api/channel/:index",
  (req, res) => {

    const index =
      Number(req.params.index);

    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index >= channels.length
    ) {
      return res
        .status(400)
        .json({
          ok: false,
          error: "Invalid channel"
        });
    }

    startChannel(index);

    res.json({
      ok: true,

      index,

      channel:
        channels[index].name,

      message:
        "Channel started"
    });
  }
);


// ======================================================
// NEXT
// ======================================================

app.get(
  "/api/next",
  (req, res) => {

    const ok =
      nextChannel();

    if (!ok) {
      return res
        .status(500)
        .json({
          ok: false
        });
    }

    res.json({
      ok: true,

      index:
        currentIndex,

      channel:
        currentChannel
          ? currentChannel.name
          : null
    });
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

      channels:
        channels.length,

      currentIndex,

      currentChannel:
        currentChannel
          ? currentChannel.name
          : null,

      session:
        sessionId,

      mjpegClients:
        mjpegClients.size,

      frameBuffer:
        frameBuffer.length,

      audioBuffer:
        audioQueue.length
    });
  }
);


// ======================================================
// START SERVER
// ======================================================

async function main() {

  try {

    await loadPlaylist();

    app.listen(
      PORT,
      "0.0.0.0",
      () => {

        console.log("");
        console.log("==========================================");
        console.log("IPTV SERVER STARTED");
        console.log("PORT:", PORT);
        console.log("CHANNELS:", channels.length);
        console.log("==========================================");
        console.log("");
      }
    );

    // ----------------------------------------
    // KHÔNG CHECK CHANNELS
    // Phát thẳng kênh đầu tiên
    // ----------------------------------------

    if (channels.length > 0) {

      startChannel(0);

    } else {

      console.log(
        "No channels found."
      );
    }

  } catch (err) {

    console.error(
      "SERVER START ERROR:",
      err
    );

    process.exit(1);
  }
}


// ======================================================
// PROCESS SIGNALS
// ======================================================

process.on(
  "SIGTERM",
  () => {

    console.log(
      "SIGTERM received"
    );

    stopCurrentSession();

    process.exit(0);
  }
);


process.on(
  "SIGINT",
  () => {

    console.log(
      "SIGINT received"
    );

    stopCurrentSession();

    process.exit(0);
  }
);


// ======================================================
// RUN
// ======================================================

main();
