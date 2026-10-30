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

// Chỉ giữ ít frame mới nhất.
// Không tích hàng chục giây gây delay.
const FRAME_BUFFER_SIZE = 3;

// Audio buffer
const MAX_AUDIO_BUFFER = 256 * 1024;

// HLS
const HLS_TIME = 2;
const HLS_LIST = 6;

// CHECK
// Đây KHÔNG phải số lượng kênh.
// Chỉ là số kênh được check đồng thời.
const CHECK_CONCURRENCY = 20;
const CHECK_TIMEOUT = 2000;


// ============================================================
// GLOBAL
// ============================================================

// TẤT CẢ KÊNH từ M3U
let channels = [];

let currentIndex = 0;
let currentChannel = null;

// Session tăng mỗi lần đổi kênh.
// Dùng để tuyệt đối không trộn kênh.
let sessionId = 0;

// FFmpeg hiện tại
let videoProcess = null;
let hlsProcess = null;
let audioProcess = null;

// Frame buffer MJPEG
let frameBuffer = [];

// Audio buffer
let audioQueue = [];
let audioBytes = 0;

// HLS thư mục hiện tại
let currentHlsDir = null;

// MJPEG clients
const mjpegClients = new Set();


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
// LOG
// ============================================================

function log(...args) {
  console.log(
    new Date().toISOString(),
    ...args
  );
}


// ============================================================
// LOAD M3U
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

    if (!line) {
      continue;
    }

    if (
      line.startsWith("#EXTINF")
    ) {

      const comma =
        line.indexOf(",");

      const name =
        comma >= 0
          ? line
              .substring(comma + 1)
              .trim()
          : "Unknown";

      const tvgId =
        (
          line.match(
            /tvg-id="([^"]*)"/i
          ) || []
        )[1] || "";

      const group =
        (
          line.match(
            /group-title="([^"]*)"/i
          ) || []
        )[1] || "";

      const logo =
        (
          line.match(
            /tvg-logo="([^"]*)"/i
          ) || []
        )[1] || "";

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

        url: line,

        // Mặc định chưa check
        live: null,

        error: null
      });

      info = null;
    }
  }

  log(
    `[M3U] Total channels: ${result.length}`
  );

  return result;
}


// ============================================================
// CHECK ONE CHANNEL
// ============================================================

function checkChannel(channel) {

  return new Promise(resolve => {

    let finished = false;
    let timer = null;
    let ff = null;
    let output = "";

    function finish(
      ok,
      error = null
    ) {

      if (finished) {
        return;
      }

      finished = true;

      if (timer) {
        clearTimeout(timer);
      }

      try {
        if (ff) {
          ff.kill("SIGKILL");
        }
      } catch {}

      resolve({
        ok,
        error
      });
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

          // timeout network
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
            "pipe"
          ]
        }
      );

      timer =
        setTimeout(
          () => {
            finish(
              false,
              "timeout"
            );
          },
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

            finish(
              true,
              null
            );
          }
        }
      );

      ff.stderr.on(
        "data",
        data => {

          const errorText =
            data.toString()
              .trim();

          if (
            errorText &&
            !output
          ) {
            // Chỉ lưu để tham khảo,
            // không kết luận chết ngay.
          }
        }
      );

      ff.on(
        "close",
        code => {

          if (finished) {
            return;
          }

          if (
            code === 0 &&
            output
              .toLowerCase()
              .includes("video")
          ) {

            finish(
              true,
              null
            );

          } else {

            finish(
              false,
              `ffprobe exit ${code}`
            );
          }
        }
      );

      ff.on(
        "error",
        err => {

          finish(
            false,
            err.message
          );
        }
      );

    } catch (err) {

      finish(
        false,
        err.message
      );
    }
  });
}


// ============================================================
// CHECK ALL CHANNELS
//
// QUAN TRỌNG:
// - Không xóa kênh khỏi channels.
// - channels vẫn chứa TOÀN BỘ M3U.
// - live chỉ được cập nhật.
// ============================================================

async function checkAllChannels() {

  log(
    `[CHECK] Checking ALL ${channels.length} channels`
  );

  log(
    `[CHECK] Concurrency = ${CHECK_CONCURRENCY}`
  );

  let nextIndex = 0;

  async function worker() {

    while (true) {

      const index =
        nextIndex++;

      if (
        index >= channels.length
      ) {
        return;
      }

      const channel =
        channels[index];

      log(
        `[CHECK] ${index + 1}/${channels.length} ${channel.name}`
      );

      const result =
        await checkChannel(
          channel
        );

      // Cập nhật trực tiếp vào
      // đúng phần tử trong channels
      channel.live =
        result.ok;

      channel.error =
        result.ok
          ? null
          : result.error;

      if (result.ok) {

        log(
          `[LIVE] ${channel.name}`
        );

      } else {

        log(
          `[DEAD] ${channel.name} (${result.error})`
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
      channels.length
    );
    i++
  ) {

    workers.push(
      worker()
    );
  }

  await Promise.all(
    workers
  );

  const liveCount =
    channels.filter(
      c => c.live === true
    ).length;

  log(
    `[CHECK] Finished: ${liveCount}/${channels.length} live`
  );
}


// ============================================================
// HLS DIRECTORY
// ============================================================

function createHlsDirectory(
  id
) {

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


function removeHlsDirectory(
  dir
) {

  if (!dir) {
    return;
  }

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

function killProcess(
  proc
) {

  if (!proc) {
    return;
  }

  try {
    proc.kill("SIGKILL");
  } catch {}
}


// ============================================================
// STOP CURRENT SESSION
// ============================================================

function stopCurrentSession() {

  log(
    "[SESSION] Stop old session"
  );

  killProcess(
    videoProcess
  );

  killProcess(
    hlsProcess
  );

  killProcess(
    audioProcess
  );

  videoProcess = null;
  hlsProcess = null;
  audioProcess = null;

  // Xóa toàn bộ frame cũ
  frameBuffer = [];

  // Xóa toàn bộ audio cũ
  audioQueue = [];
  audioBytes = 0;

  stats.audio.running =
    false;

  stats.audio.bytes =
    0;

  // Xóa HLS cũ
  if (currentHlsDir) {

    removeHlsDirectory(
      currentHlsDir
    );

    currentHlsDir = null;
  }
}


// ============================================================
// FFMPEG STATS
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

  if (
    type === "video"
  ) {

    if (fps) {
      stats.mjpeg.fps =
        Number(
          fps[1]
        );
    }

    if (speed) {
      stats.mjpeg.speed =
        Number(
          speed[1]
        );
    }

    if (frame) {
      stats.mjpeg.frame =
        Number(
          frame[1]
        );
    }
  }

  if (
    type === "hls"
  ) {

    if (fps) {
      stats.hls.fps =
        Number(
          fps[1]
        );
    }

    if (speed) {
      stats.hls.speed =
        Number(
          speed[1]
        );
    }

    if (frame) {
      stats.hls.frame =
        Number(
          frame[1]
        );
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
    now -
    fpsLastTime;

  if (
    elapsed >= 1000
  ) {

    stats.mjpeg.fps =
      fpsCounter /
      (elapsed / 1000);

    fpsCounter = 0;

    fpsLastTime =
      now;
  }
}


// ============================================================
// START VIDEO
// ============================================================

function startVideo(
  channel,
  mySession
) {

  log(
    `[VIDEO] Session ${mySession}: ${channel.name}`
  );

  frameBuffer = [];

  fpsCounter = 0;
  fpsLastTime =
    Date.now();

  const ff =
    spawn(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "warning",

        // LOW LATENCY
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

        // VIDEO ONLY
        "-map",
        "0:v:0",

        "-an",

        // 320x240 10 FPS
        "-vf",
        [
          `fps=${FPS}`,

          `scale=${WIDTH}:${HEIGHT}:flags=fast_bilinear:force_original_aspect_ratio=decrease`,

          `pad=${WIDTH}:${HEIGHT}:(ow-iw)/2:(oh-ih)/2`
        ].join(","),

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

  videoProcess =
    ff;

  let buffer =
    Buffer.alloc(0);

  ff.stdout.on(
    "data",
    chunk => {

      // Không nhận dữ liệu
      // từ session cũ
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

        if (
          start < 0
        ) {

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

        if (
          end < 0
        ) {

          if (
            start > 0
          ) {

            buffer =
              buffer.slice(
                start
              );
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
          buffer.slice(
            endPos
          );

        if (
          mySession !== sessionId
        ) {
          return;
        }

        // ====================================================
        // FRAME BUFFER NHỎ
        // ====================================================

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

      parseFFmpegStats(
        data.toString(),
        "video"
      );
    }
  );

  ff.on(
    "close",
    code => {

      log(
        `[VIDEO] Session ${mySession} stopped: ${code}`
      );

      if (
        mySession !== sessionId
      ) {
        return;
      }

      if (
        videoProcess === ff
      ) {
        videoProcess =
          null;
      }

      // Chỉ restart session hiện tại
      if (
        currentChannel &&
        mySession === sessionId
      ) {

        setTimeout(
          () => {

            if (
              mySession === sessionId &&
              currentChannel
            ) {

              startVideo(
                currentChannel,
                mySession
              );
            }

          },
          1000
        );
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
        `[VIDEO] Error: ${err.message}`
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
    `[HLS] Session ${mySession}: ${channel.name}`
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

  hlsProcess =
    ff;

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
        `[HLS] Session ${mySession} stopped: ${code}`
      );

      if (
        mySession !== sessionId
      ) {
        return;
      }

      if (
        hlsProcess === ff
      ) {
        hlsProcess =
          null;
      }

      if (
        currentChannel &&
        mySession === sessionId
      ) {

        setTimeout(
          () => {

            if (
              mySession === sessionId
            ) {

              startHLS(
                currentChannel,
                mySession,
                hlsDir
              );
            }

          },
          1000
        );
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
        `[HLS] Error: ${err.message}`
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
    `[AUDIO] Session ${mySession}: ${channel.name}`
  );

  audioQueue = [];
  audioBytes = 0;

  stats.audio.bytes =
    0;

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

  audioProcess =
    ff;

  stats.audio.running =
    true;

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

      audioQueue.push(
        data
      );

      audioBytes +=
        data.length;

      while (
        audioBytes >
        MAX_AUDIO_BUFFER
      ) {

        const old =
          audioQueue.shift();

        if (!old) {
          break;
        }

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
        `[AUDIO] Session ${mySession} stopped: ${code}`
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
        audioProcess =
          null;
      }

      if (
        currentChannel &&
        mySession === sessionId
      ) {

        setTimeout(
          () => {

            if (
              mySession === sessionId
            ) {

              startAudio(
                currentChannel,
                mySession
              );
            }

          },
          1000
        );
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
        `[AUDIO] Error: ${err.message}`
      );
    }
  );
}


// ============================================================
// START CHANNEL
// ============================================================

function startChannel(
  index
) {

  if (
    !channels.length
  ) {
    return false;
  }

  if (
    index < 0 ||
    index >= channels.length
  ) {
    return false;
  }

  // ----------------------------------------------------------
  // SESSION MỚI
  // ----------------------------------------------------------

  sessionId++;

  const mySession =
    sessionId;

  // ----------------------------------------------------------
  // DỪNG SESSION CŨ
  // ----------------------------------------------------------

  stopCurrentSession();

  currentIndex =
    index;

  currentChannel =
    channels[index];

  log(
    "================================================"
  );

  log(
    `[SESSION] ${mySession}`
  );

  log(
    `[CHANNEL] ${currentChannel.name}`
  );

  log(
    `[LIVE] ${currentChannel.live}`
  );

  log(
    `[URL] ${currentChannel.url}`
  );

  log(
    "================================================"
  );

  // ----------------------------------------------------------
  // HLS DIRECTORY RIÊNG
  // ----------------------------------------------------------

  currentHlsDir =
    createHlsDirectory(
      mySession
    );

  // ----------------------------------------------------------
  // START
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

  return true;
}


// ============================================================
// NEXT CHANNEL
// ============================================================

function nextChannel() {

  if (
    !channels.length
  ) {
    return false;
  }

  let index =
    currentIndex + 1;

  if (
    index >= channels.length
  ) {
    index = 0;
  }

  return startChannel(
    index
  );
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

      session:
        sessionId,

      lastFrame:
        null
    };

    mjpegClients.add(
      client
    );

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
// STABLE MJPEG OUTPUT
//
// Bộ phát cố định 10 FPS.
// Không lấy trực tiếp frame từ pipe.
// Luôn lấy frame MỚI NHẤT.
// ============================================================

setInterval(
  () => {

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

    for (
      const client of mjpegClients
    ) {

      // ------------------------------------------------------
      // Khi đổi kênh:
      // reset client sang session mới.
      // ------------------------------------------------------

      if (
        client.session !==
        sessionId
      ) {

        client.session =
          sessionId;

        client.lastFrame =
          null;

        continue;
      }

      // ------------------------------------------------------
      // Không gửi cùng frame 2 lần
      // ------------------------------------------------------

      if (
        client.lastFrame ===
        frame.time
      ) {
        continue;
      }

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

        client.res.write(
          frame.data
        );

        client.res.write(
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

  },
  Math.round(
    1000 / FPS
  )
);


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

      res.send(
        data
      );

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
// ALL CHANNELS JSON
// ============================================================

app.get(
  "/api/channels",
  (req, res) => {

    res.json(
      channels.map(
        (channel, index) => ({

          index,

          name:
            channel.name,

          group:
            channel.group,

          logo:
            channel.logo,

          tvgId:
            channel.tvgId,

          url:
            channel.url,

          // null = chưa check
          // true = sống
          // false = chết
          live:
            channel.live,

          error:
            channel.error

        })
      )
    );
  }
);


// ============================================================
// CURRENT CHANNEL
// ============================================================

app.get(
  "/api/current",
  (req, res) => {

    res.json({

      session:
        sessionId,

      index:
        currentIndex,

      channel:
        currentChannel
          ? {
              name:
                currentChannel.name,

              url:
                currentChannel.url,

              live:
                currentChannel.live
            }
          : null
    });
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

    const ok =
      startChannel(
        index
      );

    if (!ok) {

      return res
        .status(500)
        .json({
          ok: false
        });
    }

    res.json({

      ok: true,

      session:
        sessionId,

      index,

      channel:
        currentChannel.name,

      live:
        currentChannel.live
    });
  }
);


// ============================================================
// NEXT
// ============================================================

app.post(
  "/api/next",
  (req, res) => {

    const ok =
      nextChannel();

    res.json({

      ok,

      session:
        sessionId,

      index:
        currentIndex,

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

    const liveCount =
      channels.filter(
        c => c.live === true
      ).length;

    const deadCount =
      channels.filter(
        c => c.live === false
      ).length;

    const unchecked =
      channels.filter(
        c => c.live === null
      ).length;

    res.json({

      ok: true,

      session:
        sessionId,

      channel:
        currentChannel
          ? currentChannel.name
          : null,

      index:
        currentIndex,

      resolution:
        `${WIDTH}x${HEIGHT}`,

      targetFPS:
        FPS,

      stats: {

        mjpeg: {

          fps:
            stats.mjpeg.fps,

          totalFrames:
            stats.mjpeg.frames,

          frame:
            stats.mjpeg.frame,

          speed:
            stats.mjpeg.speed,

          bufferFrames:
            frameBuffer.length,

          bufferSeconds:
            frameBuffer.length /
            FPS
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

        live:
          liveCount,

        dead:
          deadCount,

        unchecked:
          unchecked,

        current:
          currentIndex
      }
    });
  }
);


// ============================================================
// WEB
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

<title>IPTV Server</title>

<style>

body {
  margin: 0;
  background: #111;
  color: #fff;
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
  background: #000;
}

#mjpeg {
  width: 320px;
  height: 240px;
  background: #000;
}

pre {
  white-space: pre-wrap;
}

</style>

</head>

<body>

<div class="container">

<h2>IPTV</h2>

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

  const response =
    await fetch(
      "/api/channels"
    );

  channels =
    await response.json();

  const select =
    document.getElementById(
      "channels"
    );

  select.innerHTML = "";

  channels.forEach(
    (channel, index) => {

      const option =
        document.createElement(
          "option"
        );

      option.value =
        index;

      let status = "";

      if (
        channel.live === true
      ) {
        status = " [LIVE]";
      }

      if (
        channel.live === false
      ) {
        status = " [DEAD]";
      }

      option.textContent =
        channel.name +
        status;

      select.appendChild(
        option
      );
    }
  );
}


// ==========================================================
// PLAY SELECTED
// ==========================================================

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

  // Chờ HLS session mới tạo playlist
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
        .catch(
          () => {}
        );

    },
    700
  );
}


// ==========================================================
// NEXT
// ==========================================================

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
        .catch(
          () => {}
        );

    },
    700
  );
}


// ==========================================================
// HEALTH
// ==========================================================

async function updateStats() {

  try {

    const response =
      await fetch(
        "/health"
      );

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

  } catch {}

}


// ==========================================================
// REFRESH CHANNEL LIST
// ==========================================================

setInterval(
  loadChannels,
  10000
);

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
// SERVER START
// ============================================================

async function main() {

  try {

    // --------------------------------------------------------
    // LOAD TOÀN BỘ M3U
    // --------------------------------------------------------

    channels =
      await loadPlaylist();

    if (
      !channels.length
    ) {

      throw new Error(
        "Playlist is empty"
      );
    }

    // --------------------------------------------------------
    // SERVER START NGAY
    // --------------------------------------------------------

    app.listen(
      PORT,
      () => {

        log(
          `[SERVER] Running on port ${PORT}`
        );

        log(
          `[SERVER] /stream`
        );

        log(
          `[SERVER] /hls/index.m3u8`
        );

        log(
          `[SERVER] /api/channels`
        );

        log(
          `[SERVER] /health`
        );
      }
    );

    // --------------------------------------------------------
    // CHECK TẤT CẢ KÊNH
    //
    // 20 chỉ là concurrency.
    // Không giới hạn playlist ở 20.
    // --------------------------------------------------------

    await checkAllChannels();

    // --------------------------------------------------------
    // Tìm kênh LIVE đầu tiên
    // --------------------------------------------------------

    const firstLive =
      channels.findIndex(
        channel =>
          channel.live === true
      );

    if (
      firstLive >= 0
    ) {

      startChannel(
        firstLive
      );

    } else {

      log(
        "[SERVER] No live channel found"
      );
    }

  } catch (err) {

    console.error(
      "[FATAL]",
      err
    );

    process.exit(1);
  }
}


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


// ============================================================
// RUN
// ============================================================

main();
