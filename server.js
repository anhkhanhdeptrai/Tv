const express = require("express");
const { spawn } = require("child_process");
const fetch = require("node-fetch");
const fs = require("fs");
const path = require("path");
const os = require("os");

const app = express();

const PORT = process.env.PORT || 10000;

// ============================================================
// CONFIG
// ============================================================

const PLAYLIST_URL =
  "https://raw.githubusercontent.com/iptv-org/iptv/master/streams/vn.m3u";

const WIDTH = 320;
const HEIGHT = 240;
const FPS = 10;

// Frame buffer:
// chỉ giữ vài ảnh mới nhất.
// Không được tăng quá lớn vì sẽ tạo delay.
const FRAME_BUFFER_SIZE = 3;

// Audio buffer tối đa
const MAX_AUDIO_BUFFER = 256 * 1024;

// HLS
const HLS_TIME = 2;
const HLS_LIST = 6;

// Check kênh
const CHECK_TIMEOUT = 2000;
const CHECK_CONCURRENCY = 20;

// ============================================================
// GLOBAL
// ============================================================

let channels = [];
let currentIndex = 0;
let currentChannel = null;

// Session tăng mỗi lần đổi kênh.
// Session cũ tuyệt đối không được ghi dữ liệu vào session mới.
let sessionId = 0;

// Process của session hiện tại
let videoProcess = null;
let hlsProcess = null;
let audioProcess = null;

// Frame buffer
let frameBuffer = [];

// Audio buffer
let audioQueue = [];
let audioBytes = 0;

// HTTP MJPEG clients
const mjpegClients = new Set();

// HLS directory hiện tại
let currentHlsDir = null;

// ============================================================
// STATS
// ============================================================

const stats = {
  mjpeg: {
    fps: 0,
    frames: 0,
    frame: 0,
    speed: 0
  },

  hls: {
    fps: 0,
    frame: 0,
    speed: 0
  },

  audio: {
    running: false,
    bytes: 0
  }
};

let fpsCounter = 0;
let fpsLastTime = Date.now();


// ============================================================
// UTILITY
// ============================================================

function log(...args) {
  console.log(
    new Date().toISOString(),
    ...args
  );
}

function sleep(ms) {
  return new Promise(resolve =>
    setTimeout(resolve, ms)
  );
}


// ============================================================
// PLAYLIST
// ============================================================

async function loadPlaylist() {

  log("[M3U] Downloading playlist...");

  const response =
    await fetch(PLAYLIST_URL);

  if (!response.ok) {
    throw new Error(
      `M3U HTTP ${response.status}`
    );
  }

  const text =
    await response.text();

  const lines =
    text.split(/\r?\n/);

  const result = [];

  let info = null;

  for (const raw of lines) {

    const line =
      raw.trim();

    if (!line) continue;

    if (line.startsWith("#EXTINF")) {

      const comma =
        line.indexOf(",");

      const name =
        comma >= 0
          ? line
              .substring(comma + 1)
              .trim()
          : "Unknown";

      const tvgId =
        (line.match(
          /tvg-id="([^"]*)"/i
        ) || [])[1] || "";

      const group =
        (line.match(
          /group-title="([^"]*)"/i
        ) || [])[1] || "";

      const logo =
        (line.match(
          /tvg-logo="([^"]*)"/i
        ) || [])[1] || "";

      info = {
        name,
        tvgId,
        group,
        logo
      };

      continue;
    }

    if (
      !line.startsWith("#") &&
      info
    ) {

      result.push({
        ...info,
        url: line
      });

      info = null;
    }
  }

  log(
    `[M3U] ${result.length} channels found`
  );

  return result;
}


// ============================================================
// FAST CHANNEL CHECK
// ============================================================

function checkChannel(channel) {

  return new Promise(resolve => {

    let done = false;
    let timer = null;
    let ff = null;
    let output = "";

    function finish(ok) {

      if (done) return;

      done = true;

      if (timer) {
        clearTimeout(timer);
      }

      try {
        if (ff) {
          ff.kill("SIGKILL");
        }
      } catch {}

      resolve(ok);
    }

    try {

      ff = spawn(
        "ffprobe",
        [
          "-hide_banner",
          "-loglevel",
          "error",

          "-analyzeduration",
          "500k",

          "-probesize",
          "500k",

          "-rw_timeout",
          "2000000",

          "-i",
          channel.url,

          "-select_streams",
          "v:0",

          "-show_entries",
          "stream=codec_type",

          "-of",
          "csv=p=0"
        ],
        {
          stdio: [
            "ignore",
            "pipe",
            "ignore"
          ]
        }
      );

      timer =
        setTimeout(
          () => finish(false),
          CHECK_TIMEOUT
        );

      ff.stdout.on(
        "data",
        data => {

          output +=
            data.toString();

          if (
            output
              .toLowerCase()
              .includes("video")
          ) {
            finish(true);
          }
        }
      );

      ff.on(
        "close",
        code => {

          if (done) return;

          finish(
            code === 0 &&
            output
              .toLowerCase()
              .includes("video")
          );
        }
      );

      ff.on(
        "error",
        () => finish(false)
      );

    } catch {
      finish(false);
    }
  });
}


// ============================================================
// CHECK ALL CHANNELS
// ============================================================

async function checkChannels(list) {

  const alive = [];

  let next = 0;

  async function worker() {

    while (true) {

      const index =
        next++;

      if (
        index >= list.length
      ) {
        return;
      }

      const channel =
        list[index];

      log(
        `[CHECK] ${index + 1}/${list.length} ${channel.name}`
      );

      const ok =
        await checkChannel(channel);

      if (ok) {

        log(
          `[LIVE] ${channel.name}`
        );

        alive.push({
          ...channel,
          originalIndex: index
        });

      } else {

        log(
          `[DEAD] ${channel.name}`
        );
      }
    }
  }

  const workers = [];

  for (
    let i = 0;
    i <
    Math.min(
      CHECK_CONCURRENCY,
      list.length
    );
    i++
  ) {
    workers.push(worker());
  }

  await Promise.all(workers);

  alive.sort(
    (a, b) =>
      a.originalIndex -
      b.originalIndex
  );

  return alive;
}


// ============================================================
// CREATE HLS DIRECTORY
// ============================================================

function createHlsDirectory(id) {

  const dir =
    path.join(
      os.tmpdir(),
      `iptv-hls-${id}`
    );

  fs.mkdirSync(
    dir,
    {
      recursive: true
    }
  );

  return dir;
}


// ============================================================
// DELETE OLD HLS DIRECTORY
// ============================================================

function removeHlsDirectory(dir) {

  if (!dir) return;

  try {

    fs.rmSync(
      dir,
      {
        recursive: true,
        force: true
      }
    );

  } catch {}
}


// ============================================================
// KILL PROCESS
// ============================================================

function killProcess(proc) {

  if (!proc) return;

  try {
    proc.kill("SIGKILL");
  } catch {}
}


// ============================================================
// STOP EVERYTHING
// ============================================================

function stopCurrentSession() {

  log(
    "[SESSION] Stopping old session"
  );

  killProcess(videoProcess);
  killProcess(hlsProcess);
  killProcess(audioProcess);

  videoProcess = null;
  hlsProcess = null;
  audioProcess = null;

  frameBuffer = [];

  audioQueue = [];
  audioBytes = 0;

  stats.audio.running = false;
  stats.audio.bytes = 0;

  if (currentHlsDir) {

    removeHlsDirectory(
      currentHlsDir
    );

    currentHlsDir = null;
  }
}


// ============================================================
// PARSE FFMPEG STATUS
// ============================================================

function parseFFmpegStats(
  text,
  type
) {

  const fps =
    text.match(
      /fps=\s*([0-9.]+)/
    );

  const speed =
    text.match(
      /speed=\s*([0-9.]+)x/
    );

  const frame =
    text.match(
      /frame=\s*([0-9]+)/
    );

  if (type === "video") {

    if (fps) {
      stats.mjpeg.fps =
        Number(fps[1]);
    }

    if (speed) {
      stats.mjpeg.speed =
        Number(speed[1]);
    }

    if (frame) {
      stats.mjpeg.frame =
        Number(frame[1]);
    }
  }

  if (type === "hls") {

    if (fps) {
      stats.hls.fps =
        Number(fps[1]);
    }

    if (speed) {
      stats.hls.speed =
        Number(speed[1]);
    }

    if (frame) {
      stats.hls.frame =
        Number(frame[1]);
    }
  }
}


// ============================================================
// MJPEG FPS
// ============================================================

function updateFPS() {

  fpsCounter++;

  const now =
    Date.now();

  const elapsed =
    now - fpsLastTime;

  if (elapsed >= 1000) {

    stats.mjpeg.fps =
      fpsCounter /
      (elapsed / 1000);

    fpsCounter = 0;

    fpsLastTime = now;
  }
}


// ============================================================
// START VIDEO / MJPEG
// ============================================================

function startVideo(
  channel,
  mySession
) {

  log(
    `[VIDEO] Start session ${mySession}: ${channel.name}`
  );

  frameBuffer = [];

  fpsCounter = 0;
  fpsLastTime = Date.now();

  const ff =
    spawn(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "warning",

        // ====================================================
        // LOW LATENCY INPUT
        // ====================================================

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
        "3000000",

        "-i",
        channel.url,

        // ====================================================
        // VIDEO ONLY
        // ====================================================

        "-map",
        "0:v:0",

        "-an",

        // ====================================================
        // SCALE TO ESP32 SIZE
        // ====================================================

        "-vf",
        [
          `fps=${FPS}`,

          `scale=${WIDTH}:${HEIGHT}:flags=fast_bilinear:force_original_aspect_ratio=decrease`,

          `pad=${WIDTH}:${HEIGHT}:(ow-iw)/2:(oh-ih)/2`
        ].join(","),

        // ====================================================
        // JPEG
        // ====================================================

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
      ],
      {
        stdio: [
          "ignore",
          "pipe",
          "pipe"
        ]
      }
    );

  videoProcess = ff;

  let buffer =
    Buffer.alloc(0);

  ff.stdout.on(
    "data",
    chunk => {

      // ------------------------------------------------------
      // SESSION PROTECTION
      // ------------------------------------------------------

      if (
        mySession !== sessionId
      ) {
        return;
      }

      buffer =
        Buffer.concat([
          buffer,
          chunk
        ]);

      while (true) {

        const start =
          buffer.indexOf(
            Buffer.from([
              0xff,
              0xd8
            ])
          );

        if (start < 0) {

          // Không giữ buffer vô hạn
          if (
            buffer.length >
            512 * 1024
          ) {
            buffer =
              buffer.slice(
                -32 * 1024
              );
          }

          break;
        }

        const end =
          buffer.indexOf(
            Buffer.from([
              0xff,
              0xd9
            ]),
            start + 2
          );

        if (end < 0) {

          if (start > 0) {
            buffer =
              buffer.slice(start);
          }

          break;
        }

        const endPos =
          end + 2;

        const jpeg =
          Buffer.from(
            buffer.slice(
              start,
              endPos
            )
          );

        buffer =
          buffer.slice(endPos);

        // ----------------------------------------------------
        // SESSION PROTECTION
        // ----------------------------------------------------

        if (
          mySession !== sessionId
        ) {
          return;
        }

        // ----------------------------------------------------
        // FRAME BUFFER
        //
        // Không gửi ảnh trực tiếp.
        // Đưa ảnh vào buffer nhỏ rồi bộ phát
        // lấy ảnh ổn định ở 10 FPS.
        // ----------------------------------------------------

        frameBuffer.push({
          data: jpeg,
          time: Date.now()
        });

        while (
          frameBuffer.length >
          FRAME_BUFFER_SIZE
        ) {
          frameBuffer.shift();
        }

        stats.mjpeg.frames++;

        updateFPS();
      }
    }
  );

  ff.stderr.on(
    "data",
    data => {

      if (
        mySession !== sessionId
      ) {
        return;
      }

      const text =
        data.toString();

      parseFFmpegStats(
        text,
        "video"
      );
    }
  );

  ff.on(
    "close",
    code => {

      log(
        `[VIDEO] Session ${mySession} stopped code=${code}`
      );

      if (
        mySession !== sessionId
      ) {
        return;
      }

      if (
        videoProcess === ff
      ) {
        videoProcess = null;
      }

      // ------------------------------------------------------
      // Chỉ session hiện tại mới được restart
      // ------------------------------------------------------

      if (
        currentChannel &&
        mySession === sessionId
      ) {

        setTimeout(() => {

          if (
            mySession === sessionId &&
            currentChannel
          ) {

            startVideo(
              currentChannel,
              mySession
            );
          }

        }, 1000);
      }
    }
  );

  ff.on(
    "error",
    err => {

      if (
        mySession !== sessionId
      ) {
        return;
      }

      log(
        `[VIDEO] error: ${err.message}`
      );
    }
  );
}


// ============================================================
// START HLS
// ============================================================

function startHLS(
  channel,
  mySession,
  hlsDir
) {

  log(
    `[HLS] Start session ${mySession}: ${channel.name}`
  );

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

  const ff =
    spawn(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "warning",

        "-fflags",
        "nobuffer",

        "-flags",
        "low_delay",

        "-reconnect",
        "1",

        "-reconnect_streamed",
        "1",

        "-reconnect_delay_max",
        "2",

        "-rw_timeout",
        "5000000",

        "-i",
        channel.url,

        // VIDEO
        "-map",
        "0:v:0",

        "-c:v",
        "copy",

        // AUDIO
        "-map",
        "0:a:0?",

        "-c:a",
        "aac",

        "-b:a",
        "96k",

        "-ac",
        "2",

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
      ],
      {
        stdio: [
          "ignore",
          "ignore",
          "pipe"
        ]
      }
    );

  hlsProcess = ff;

  ff.stderr.on(
    "data",
    data => {

      if (
        mySession !== sessionId
      ) {
        return;
      }

      parseFFmpegStats(
        data.toString(),
        "hls"
      );
    }
  );

  ff.on(
    "close",
    code => {

      log(
        `[HLS] Session ${mySession} stopped code=${code}`
      );

      if (
        mySession !== sessionId
      ) {
        return;
      }

      if (
        hlsProcess === ff
      ) {
        hlsProcess = null;
      }

      if (
        currentChannel &&
        mySession === sessionId
      ) {

        setTimeout(() => {

          if (
            mySession === sessionId
          ) {

            startHLS(
              currentChannel,
              mySession,
              hlsDir
            );
          }

        }, 1000);
      }
    }
  );

  ff.on(
    "error",
    err => {

      if (
        mySession !== sessionId
      ) {
        return;
      }

      log(
        `[HLS] error: ${err.message}`
      );
    }
  );
}


// ============================================================
// START AUDIO
// ============================================================

function startAudio(
  channel,
  mySession
) {

  log(
    `[AUDIO] Start session ${mySession}: ${channel.name}`
  );

  audioQueue = [];
  audioBytes = 0;

  const ff =
    spawn(
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

        "-rw_timeout",
        "5000000",

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

  audioProcess = ff;

  stats.audio.running = true;

  ff.stdout.on(
    "data",
    chunk => {

      if (
        mySession !== sessionId
      ) {
        return;
      }

      const data =
        Buffer.from(chunk);

      audioQueue.push(data);

      audioBytes +=
        data.length;

      // ------------------------------------------------------
      // Không cho audio buffer tích quá nhiều
      // ------------------------------------------------------

      while (
        audioBytes >
        MAX_AUDIO_BUFFER
      ) {

        const old =
          audioQueue.shift();

        if (!old) break;

        audioBytes -=
          old.length;
      }

      stats.audio.bytes =
        audioBytes;
    }
  );

  ff.on(
    "close",
    code => {

      log(
        `[AUDIO] Session ${mySession} stopped code=${code}`
      );

      if (
        mySession !== sessionId
      ) {
        return;
      }

      stats.audio.running =
        false;

      if (
        audioProcess === ff
      ) {
        audioProcess = null;
      }

      if (
        currentChannel &&
        mySession === sessionId
      ) {

        setTimeout(() => {

          if (
            mySession === sessionId
          ) {

            startAudio(
              currentChannel,
              mySession
            );
          }

        }, 1000);
      }
    }
  );

  ff.on(
    "error",
    err => {

      if (
        mySession !== sessionId
      ) {
        return;
      }

      log(
        `[AUDIO] error: ${err.message}`
      );
    }
  );
}


// ============================================================
// START CHANNEL
// ============================================================

function startChannel(index) {

  if (
    !channels.length
  ) {
    return;
  }

  if (
    index < 0 ||
    index >= channels.length
  ) {
    index = 0;
  }

  // ----------------------------------------------------------
  // TẠO SESSION MỚI TRƯỚC
  // ----------------------------------------------------------

  sessionId++;

  const mySession =
    sessionId;

  log(
    "================================================"
  );

  log(
    `[SESSION] NEW SESSION ${mySession}`
  );

  // ----------------------------------------------------------
  // STOP SESSION CŨ
  // ----------------------------------------------------------

  stopCurrentSession();

  currentIndex = index;

  currentChannel =
    channels[index];

  log(
    `[CHANNEL] ${currentChannel.name}`
  );

  log(
    `[URL] ${currentChannel.url}`
  );

  // ----------------------------------------------------------
  // HLS DIRECTORY RIÊNG
  // ----------------------------------------------------------

  currentHlsDir =
    createHlsDirectory(
      mySession
    );

  // ----------------------------------------------------------
  // START 3 PIPE
  // ----------------------------------------------------------

  startVideo(
    currentChannel,
    mySession
  );

  startHLS(
    currentChannel,
    mySession,
    currentHlsDir
  );

  startAudio(
    currentChannel,
    mySession
  );

  log(
    `[SESSION] ${mySession} started`
  );

  log(
    "================================================"
  );
}


// ============================================================
// NEXT CHANNEL
// ============================================================

function nextChannel() {

  if (
    !channels.length
  ) {
    return;
  }

  const index =
    (currentIndex + 1) %
    channels.length;

  startChannel(index);
}


// ============================================================
// MJPEG STREAM
// ============================================================

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

        "Pragma":
          "no-cache",

        "Connection":
          "keep-alive",

        "Access-Control-Allow-Origin":
          "*"
      }
    );

    const client = {
      res,
      session: sessionId,
      lastFrame: null
    };

    mjpegClients.add(client);

    req.on(
      "close",
      () => {
        mjpegClients.delete(
          client
        );
      }
    );
  }
);


// ============================================================
// FRAME BROADCASTER
//
// Không gửi JPEG ngay khi FFmpeg vừa decode.
// Cứ đúng 10 FPS mới lấy 1 frame từ buffer.
// ============================================================

setInterval(() => {

  if (
    !frameBuffer.length
  ) {
    return;
  }

  const frame =
    frameBuffer[
      frameBuffer.length - 1
    ];

  if (!frame) {
    return;
  }

  const now =
    Date.now();

  for (
    const client of mjpegClients
  ) {

    // --------------------------------------------------------
    // Client cũ của session cũ
    // --------------------------------------------------------

    if (
      client.session !== sessionId
    ) {

      client.session =
        sessionId;

      client.lastFrame =
        null;

      continue;
    }

    // --------------------------------------------------------
    // Không gửi cùng một frame 2 lần
    // --------------------------------------------------------

    if (
      client.lastFrame ===
      frame.time
    ) {
      continue;
    }

    try {

      const res =
        client.res;

      res.write(
        "--frame\r\n"
      );

      res.write(
        "Content-Type: image/jpeg\r\n"
      );

      res.write(
        "Content-Length: " +
        frame.data.length +
        "\r\n\r\n"
      );

      res.write(
        frame.data
      );

      res.write(
        "\r\n"
      );

      client.lastFrame =
        frame.time;

    } catch {

      mjpegClients.delete(
        client
      );
    }
  }

}, Math.round(1000 / FPS));


// ============================================================
// HLS PLAYLIST
// ============================================================

app.get(
  "/hls/index.m3u8",
  (req, res) => {

    if (
      !currentHlsDir
    ) {
      return res
        .status(503)
        .send(
          "HLS not ready"
        );
    }

    const file =
      path.join(
        currentHlsDir,
        "index.m3u8"
      );

    if (
      !fs.existsSync(file)
    ) {
      return res
        .status(503)
        .send(
          "HLS not ready"
        );
    }

    try {

      let data =
        fs.readFileSync(
          file,
          "utf8"
        );

      // ------------------------------------------------------
      // Đổi segment thành URL của server
      // ------------------------------------------------------

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
        "no-cache, no-store"
      );

      res.send(data);

    } catch {

      res
        .status(500)
        .send(
          "HLS read error"
        );
    }
  }
);


// ============================================================
// HLS SEGMENT
// ============================================================

app.get(
  "/hls-segment/:file",
  (req, res) => {

    if (
      !currentHlsDir
    ) {
      return res
        .status(404)
        .send(
          "No HLS"
        );
    }

    const filename =
      path.basename(
        req.params.file
      );

    const file =
      path.join(
        currentHlsDir,
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
      "no-cache, no-store"
    );

    fs.createReadStream(
      file
    ).pipe(res);
  }
);


// ============================================================
// CHANNEL API
// ============================================================

app.get(
  "/api/channels",
  (req, res) => {

    res.json(
      channels.map(
        (c, i) => ({
          index: i,
          name: c.name,
          group: c.group,
          logo: c.logo
        })
      )
    );
  }
);


// ============================================================
// SELECT CHANNEL
// ============================================================

app.post(
  "/api/channel/:index",
  (req, res) => {

    const index =
      Number(
        req.params.index
      );

    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index >= channels.length
    ) {

      return res
        .status(400)
        .json({
          ok: false,
          error:
            "Invalid channel"
        });
    }

    startChannel(index);

    res.json({
      ok: true,
      session: sessionId,
      channel:
        currentChannel.name
    });
  }
);


// ============================================================
// NEXT
// ============================================================

app.post(
  "/api/next",
  (req, res) => {

    nextChannel();

    res.json({
      ok: true,
      session: sessionId,
      channel:
        currentChannel
          ? currentChannel.name
          : null
    });
  }
);


// ============================================================
// HEALTH
// ============================================================

app.get(
  "/health",
  (req, res) => {

    res.json({

      ok: true,

      session:
        sessionId,

      channel:
        currentChannel
          ? currentChannel.name
          : null,

      url:
        currentChannel
          ? currentChannel.url
          : null,

      resolution:
        `${WIDTH}x${HEIGHT}`,

      targetFPS:
        FPS,

      stats: {

        mjpeg: {

          fps:
            stats.mjpeg.fps,

          frames:
            stats.mjpeg.frames,

          frame:
            stats.mjpeg.frame,

          speed:
            stats.mjpeg.speed,

          bufferFrames:
            frameBuffer.length,

          bufferSeconds:
            frameBuffer.length / FPS
        },

        hls: {

          fps:
            stats.hls.fps,

          frame:
            stats.hls.frame,

          speed:
            stats.hls.speed
        },

        audio: {

          running:
            stats.audio.running,

          bytes:
            stats.audio.bytes,

          KB:
            Math.round(
              stats.audio.bytes /
              1024
            )
        }
      },

      channels: {

        total:
          channels.length,

        current:
          currentIndex
      }
    });
  }
);


// ============================================================
// WEB UI
// ============================================================

app.get(
  "/",
  (req, res) => {

    res.send(`
<!DOCTYPE html>
<html lang="vi">

<head>

<meta charset="UTF-8">

<meta
  name="viewport"
  content="width=device-width,initial-scale=1"
>

<title>IPTV</title>

<style>

body {
  margin: 0;
  background: #111;
  color: white;
  font-family: Arial;
}

.container {
  max-width: 900px;
  margin: auto;
  padding: 15px;
}

select,
button {
  font-size: 16px;
  padding: 10px;
  margin: 4px;
}

video {
  width: 100%;
  max-height: 500px;
  background: black;
}

#mjpeg {
  width: 320px;
  height: 240px;
  background: black;
  image-rendering: auto;
}

pre {
  white-space: pre-wrap;
}

</style>

</head>

<body>

<div class="container">

<h2>IPTV Server</h2>

<select id="channels">
</select>

<button onclick="playSelected()">
Phát
</button>

<button onclick="nextChannel()">
Kênh tiếp
</button>

<h3>HLS</h3>

<video
  id="video"
  controls
  autoplay
  playsinline>
</video>

<h3>MJPEG 320x240</h3>

<img
  id="mjpeg"
  src="/stream"
>

<h3>Health</h3>

<pre id="stats"></pre>

</div>

<script>

let channels = [];

async function loadChannels() {

  const r =
    await fetch(
      "/api/channels"
    );

  channels =
    await r.json();

  const select =
    document.getElementById(
      "channels"
    );

  select.innerHTML = "";

  channels.forEach(
    (c, i) => {

      const option =
        document.createElement(
          "option"
        );

      option.value = i;

      option.textContent =
        c.name;

      select.appendChild(
        option
      );
    }
  );
}

async function playSelected() {

  const index =
    Number(
      document
        .getElementById(
          "channels"
        )
        .value
    );

  await fetch(
    "/api/channel/" +
    index,
    {
      method: "POST"
    }
  );

  // Cho server có thời gian tạo playlist mới
  setTimeout(
    () => {

      const video =
        document.getElementById(
          "video"
        );

      video.src =
        "/hls/index.m3u8?t=" +
        Date.now();

      video.load();

      video.play()
        .catch(() => {});

    },
    500
  );
}

async function nextChannel() {

  await fetch(
    "/api/next",
    {
      method: "POST"
    }
  );

  setTimeout(
    () => {

      const video =
        document.getElementById(
          "video"
        );

      video.src =
        "/hls/index.m3u8?t=" +
        Date.now();

      video.load();

      video.play()
        .catch(() => {});

    },
    500
  );

  loadChannels();
}

async function updateStats() {

  try {

    const r =
      await fetch(
        "/health"
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
  1000
);

loadChannels();

</script>

</body>

</html>
`);
  }
);


// ============================================================
// START SERVER
// ============================================================

async function main() {

  try {

    // --------------------------------------------------------
    // Load M3U
    // --------------------------------------------------------

    const allChannels =
      await loadPlaylist();

    if (
      !allChannels.length
    ) {
      throw new Error(
        "Playlist empty"
      );
    }

    // --------------------------------------------------------
    // SERVER START NGAY
    // --------------------------------------------------------

    app.listen(
      PORT,
      () => {

        log(
          `[SERVER] Port ${PORT}`
        );

        log(
          `[SERVER] http://localhost:${PORT}`
        );

        log(
          `[SERVER] /stream`
        );

        log(
          `[SERVER] /health`
        );
      }
    );

    // --------------------------------------------------------
    // CHECK BACKGROUND
    // --------------------------------------------------------

    const alive =
      await checkChannels(
        allChannels
      );

    log(
      `[CHECK] LIVE ${alive.length}/${allChannels.length}`
    );

    if (!alive.length) {

      log(
        "[CHECK] No live channel"
      );

      return;
    }

    // --------------------------------------------------------
    // CHỈ GIỮ KÊNH SỐNG
    // --------------------------------------------------------

    channels =
      alive;

    // --------------------------------------------------------
    // START KÊNH ĐẦU TIÊN
    // --------------------------------------------------------

    startChannel(0);

  } catch (err) {

    console.error(
      "[FATAL]",
      err
    );

    process.exit(1);
  }
}


main();


// ============================================================
// CLEANUP
// ============================================================

process.on(
  "SIGTERM",
  () => {

    log(
      "[SYSTEM] SIGTERM"
    );

    stopCurrentSession();

    process.exit(0);
  }
);

process.on(
  "SIGINT",
  () => {

    log(
      "[SYSTEM] SIGINT"
    );

    stopCurrentSession();

    process.exit(0);
  }
);
