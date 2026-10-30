const express = require("express");
const http = require("http");
const https = require("https");
const { spawn } = require("child_process");
const { performance } = require("perf_hooks");

const app = express();

const PORT = process.env.PORT || 10000;

const M3U_URL =
    "https://raw.githubusercontent.com/iptv-org/iptv/master/streams/vn.m3u";

// ============================================================
// CONFIG
// ============================================================

const WIDTH = 340;
const HEIGHT = 230;

const FPS = 8;
const JPEG_QUALITY = 8;

// Audio PCM S16LE mono
const AUDIO_SAMPLE_RATE = 48000;
const AUDIO_CHANNELS = 1;
const AUDIO_BYTES_PER_SAMPLE = 2;

const AUDIO_BYTES_PER_SECOND =
    AUDIO_SAMPLE_RATE *
    AUDIO_CHANNELS *
    AUDIO_BYTES_PER_SAMPLE;

// ------------------------------------------------------------
// BUFFER
// ------------------------------------------------------------

// ESP32 bắt đầu sau khi có đủ 5 giây
const INITIAL_BUFFER_SECONDS = 5;

// Buffer tối đa
const VIDEO_BUFFER_MAX_SECONDS = 6;
const AUDIO_BUFFER_MAX_SECONDS = 7;

// Khi đang phát chỉ rebuffer khi gần cạn
const VIDEO_REBUFFER_SECONDS = 1.5;
const AUDIO_REBUFFER_SECONDS = 1.5;

// Sau khi rebuffer không cần chờ đủ 5 giây.
// Chờ 3 giây để tránh giật lại ngay.
const REBUFFER_READY_SECONDS = 3;

// ------------------------------------------------------------
// LIMITS
// ------------------------------------------------------------

const VIDEO_BUFFER_MAX_FRAMES =
    Math.ceil(VIDEO_BUFFER_MAX_SECONDS * FPS);

const AUDIO_BUFFER_MAX_BYTES =
    Math.ceil(AUDIO_BUFFER_MAX_SECONDS * AUDIO_BYTES_PER_SECOND);

// ============================================================
// STATE
// ============================================================

let channels = [];
let currentChannel = null;

let ffmpeg = null;
let ffmpegGeneration = 0;

// ------------------------------------------------------------
// PLAYBACK STATE
// ------------------------------------------------------------

let state = "IDLE";
// IDLE
// FILLING
// PLAYING
// REBUFFERING

let firstBufferReadyLogged = false;

// ============================================================
// VIDEO BUFFER
// ============================================================
//
// Không splice buffer khi client đang đọc.
// Mỗi frame có sequence number.
// Client giữ cursor riêng.
// ============================================================

let videoBuffer = [];
let videoSequence = 0;

// ============================================================
// AUDIO BUFFER
// ============================================================
//
// Audio chia thành chunk nhỏ.
// ============================================================

let audioChunks = [];
let audioBufferedBytes = 0;

// ============================================================
// CLIENTS
// ============================================================

const videoClients = new Set();
const audioClients = new Set();

// ============================================================
// UTILS
// ============================================================

function now() {
    return performance.now();
}

function videoSeconds() {
    return videoBuffer.length / FPS;
}

function audioSeconds() {
    return audioBufferedBytes / AUDIO_BYTES_PER_SECOND;
}

function logBuffer(force = false) {
    if (!force) return;

    console.log(
        `BUFFER: video=${videoBuffer.length} frames (${videoSeconds().toFixed(
            2
        )}s), audio=${audioSeconds().toFixed(2)}s, state=${state}`
    );
}

// ============================================================
// DOWNLOAD M3U
// ============================================================

function downloadText(url) {
    return new Promise((resolve, reject) => {
        const lib = url.startsWith("https")
            ? https
            : http;

        const req = lib.get(
            url,
            {
                headers: {
                    "User-Agent":
                        "Mozilla/5.0 IPTV-ESP32-Server"
                },
            },
            (res) => {
                let data = "";

                if (
                    res.statusCode >= 300 &&
                    res.statusCode < 400 &&
                    res.headers.location
                ) {
                    return downloadText(res.headers.location)
                        .then(resolve)
                        .catch(reject);
                }

                if (res.statusCode !== 200) {
                    reject(
                        new Error(
                            `HTTP ${res.statusCode}`
                        )
                    );
                    return;
                }

                res.setEncoding("utf8");

                res.on("data", (chunk) => {
                    data += chunk;
                });

                res.on("end", () => {
                    resolve(data);
                });
            }
        );

        req.setTimeout(20000, () => {
            req.destroy(
                new Error("M3U download timeout")
            );
        });

        req.on("error", reject);
    });
}

// ============================================================
// PARSE M3U
// ============================================================

function parseM3U(text) {
    const lines = text
        .split(/\r?\n/)
        .map((x) => x.trim());

    const result = [];

    let pendingInfo = null;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        if (!line) continue;

        if (line.startsWith("#EXTINF:")) {
            pendingInfo = line;
            continue;
        }

        if (
            pendingInfo &&
            line.startsWith("http")
        ) {
            const info = pendingInfo;

            const commaIndex = info.indexOf(",");

            let name =
                commaIndex >= 0
                    ? info
                          .substring(commaIndex + 1)
                          .trim()
                    : "Unknown";

            const tvgId =
                (
                    info.match(
                        /tvg-id="([^"]*)"/i
                    ) || []
                )[1] || "";

            const group =
                (
                    info.match(
                        /group-title="([^"]*)"/i
                    ) || []
                )[1] || "";

            const logo =
                (
                    info.match(
                        /tvg-logo="([^"]*)"/i
                    ) || []
                )[1] || "";

            // Không lấy Geo-blocked
            if (
                name
                    .toLowerCase()
                    .includes("[geo-blocked]")
            ) {
                pendingInfo = null;
                continue;
            }

            // Bỏ DASH
            if (
                line
                    .toLowerCase()
                    .includes(".mpd")
            ) {
                pendingInfo = null;
                continue;
            }

            result.push({
                id: result.length,
                name,
                tvgId,
                group,
                logo,
                url: line,
            });

            pendingInfo = null;
        }
    }

    return result;
}

// ============================================================
// LOAD CHANNELS
// ============================================================

async function loadChannels() {
    try {
        console.log("Loading M3U...");

        const text =
            await downloadText(M3U_URL);

        channels = parseM3U(text);

        console.log(
            `Loaded ${channels.length} channels`
        );
    } catch (err) {
        console.error(
            "M3U ERROR:",
            err.message
        );

        channels = [];
    }
}

// ============================================================
// CLEAR BUFFER
// ============================================================

function clearBuffers() {
    videoBuffer = [];
    audioChunks = [];
    audioBufferedBytes = 0;

    videoSequence = 0;

    firstBufferReadyLogged = false;
}

// ============================================================
// STOP FFMPEG
// ============================================================

function stopFFmpeg() {
    if (!ffmpeg) return;

    try {
        ffmpeg.stdout?.removeAllListeners();
        ffmpeg.stdio?.[3]?.removeAllListeners();
        ffmpeg.stderr?.removeAllListeners();
    } catch {}

    try {
        ffmpeg.kill("SIGKILL");
    } catch {}

    ffmpeg = null;
}

// ============================================================
// RESET STREAM
// ============================================================

function resetStreamState() {
    ffmpegGeneration++;

    stopFFmpeg();

    clearBuffers();

    state = "IDLE";
}

// ============================================================
// START BUFFERING
// ============================================================

function startBuffering() {
    if (!currentChannel) return;

    resetStreamState();

    state = "FILLING";

    const generation =
        ffmpegGeneration;

    console.log(
        `BUFFERING: ${currentChannel.name}`
    );

    startFFmpeg(
        currentChannel,
        generation
    );
}

// ============================================================
// FFmpeg
// ============================================================

function startFFmpeg(
    channel,
    generation
) {
    const args = [
        "-hide_banner",
        "-loglevel",
        "warning",

        // Reconnect HLS
        "-reconnect",
        "1",
        "-reconnect_streamed",
        "1",
        "-reconnect_at_eof",
        "1",
        "-reconnect_delay_max",
        "3",

        // Timestamp
        "-fflags",
        "+genpts+discardcorrupt",

        "-flags",
        "low_delay",

        "-i",
        channel.url,

        // ====================================================
        // VIDEO
        // ====================================================

        "-map",
        "0:v:0",

        "-an",

        "-vf",
        `scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=decrease,pad=${WIDTH}:${HEIGHT}:(ow-iw)/2:(oh-ih)/2:black,format=yuvj420p`,

        "-r",
        String(FPS),

        "-c:v",
        "mjpeg",

        "-q:v",
        String(JPEG_QUALITY),

        "-threads",
        "2",

        "-pix_fmt",
        "yuvj420p",

        "-fps_mode",
        "cfr",

        "-f",
        "image2pipe",

        "pipe:1",

        // ====================================================
        // AUDIO
        // ====================================================

        "-map",
        "0:a:0?",

        "-vn",

        "-af",
        "aresample=async=1:min_hard_comp=0.100000:first_pts=0",

        "-ac",
        String(AUDIO_CHANNELS),

        "-ar",
        String(AUDIO_SAMPLE_RATE),

        "-c:a",
        "pcm_s16le",

        "-f",
        "s16le",

        "pipe:3",
    ];

    console.log(
        "FFmpeg starting..."
    );

    ffmpeg = spawn(
        "ffmpeg",
        args,
        {
            stdio: [
                "ignore",
                "pipe",
                "pipe",
                "pipe",
            ],
        }
    );

    // ========================================================
    // VIDEO PARSER
    // ========================================================

    let videoTemp = Buffer.alloc(0);

    ffmpeg.stdout.on(
        "data",
        (chunk) => {
            if (
                generation !==
                ffmpegGeneration
            ) {
                return;
            }

            videoTemp = Buffer.concat([
                videoTemp,
                chunk,
            ]);

            while (true) {
                const start =
                    videoTemp.indexOf(
                        Buffer.from([
                            0xff,
                            0xd8,
                        ])
                    );

                if (start < 0) {
                    // Giữ tối đa phần cuối
                    if (
                        videoTemp.length >
                        1024 * 1024
                    ) {
                        videoTemp =
                            videoTemp.slice(
                                -65536
                            );
                    }

                    break;
                }

                const end =
                    videoTemp.indexOf(
                        Buffer.from([
                            0xff,
                            0xd9,
                        ]),
                        start + 2
                    );

                if (end < 0) {
                    // Chưa đủ JPEG
                    if (start > 0) {
                        videoTemp =
                            videoTemp.slice(
                                start
                            );
                    }

                    break;
                }

                const frameEnd =
                    end + 2;

                const frame =
                    videoTemp.slice(
                        start,
                        frameEnd
                    );

                videoTemp =
                    videoTemp.slice(
                        frameEnd
                    );

                // Chỉ nhận JPEG hợp lệ
                if (
                    frame.length < 100
                ) {
                    continue;
                }

                videoSequence++;

                videoBuffer.push({
                    seq: videoSequence,
                    data: frame,
                    time: now(),
                    generation,
                });

                // Giữ tối đa 6 giây
                while (
                    videoBuffer.length >
                    VIDEO_BUFFER_MAX_FRAMES
                ) {
                    videoBuffer.shift();
                }

                updateBufferState();
            }
        }
    );

    // ========================================================
    // AUDIO
    // ========================================================

    ffmpeg.stdio[3].on(
        "data",
        (chunk) => {
            if (
                generation !==
                ffmpegGeneration
            ) {
                return;
            }

            if (!chunk.length) return;

            audioChunks.push(chunk);
            audioBufferedBytes +=
                chunk.length;

            // Giữ tối đa 7 giây
            while (
                audioBufferedBytes >
                AUDIO_BUFFER_MAX_BYTES
            ) {
                const first =
                    audioChunks[0];

                if (!first) break;

                const excess =
                    audioBufferedBytes -
                    AUDIO_BUFFER_MAX_BYTES;

                if (
                    first.length <=
                    excess
                ) {
                    audioChunks.shift();

                    audioBufferedBytes -=
                        first.length;
                } else {
                    audioChunks[0] =
                        first.slice(
                            excess
                        );

                    audioBufferedBytes -=
                        excess;

                    break;
                }
            }

            updateBufferState();
        }
    );

    // ========================================================
    // STDERR
    // ========================================================

    ffmpeg.stderr.on(
        "data",
        (data) => {
            if (
                generation !==
                ffmpegGeneration
            ) {
                return;
            }

            const text =
                data.toString().trim();

            if (!text) return;

            console.log(
                "[FFmpeg]",
                text
            );
        }
    );

    // ========================================================
    // EXIT
    // ========================================================

    ffmpeg.on(
        "exit",
        (
            code,
            signal
        ) => {
            if (
                generation !==
                ffmpegGeneration
            ) {
                return;
            }

            console.log(
                `FFmpeg exited code=${code} signal=${signal}`
            );

            ffmpeg = null;

            // Nếu đang phát thì thử lại
            if (
                currentChannel
            ) {
                if (
                    state ===
                        "PLAYING" ||
                    state ===
                        "REBUFFERING"
                ) {
                    console.log(
                        "Restarting FFmpeg..."
                    );

                    setTimeout(() => {
                        if (
                            currentChannel
                        ) {
                            startBuffering();
                        }
                    }, 1500);
                }
            }
        }
    );

    ffmpeg.on(
        "error",
        (err) => {
            if (
                generation !==
                ffmpegGeneration
            ) {
                return;
            }

            console.error(
                "FFmpeg error:",
                err.message
            );
        }
    );
}

// ============================================================
// BUFFER STATE
// ============================================================

let lastStateLog = "";

function updateBufferState() {
    const v =
        videoSeconds();

    const a =
        audioSeconds();

    // ========================================================
    // INITIAL FILL
    // ========================================================

    if (state === "FILLING") {
        if (
            v >=
                INITIAL_BUFFER_SECONDS &&
            a >=
                INITIAL_BUFFER_SECONDS
        ) {
            state = "PLAYING";

            console.log(
                `BUFFER READY: video=${videoBuffer.length} frames, audio=${a.toFixed(
                    2
                )}s`
            );

            firstBufferReadyLogged = true;
        }

        return;
    }

    // ========================================================
    // PLAYING
    // ========================================================

    if (state === "PLAYING") {
        if (
            v <
                VIDEO_REBUFFER_SECONDS ||
            a <
                AUDIO_REBUFFER_SECONDS
        ) {
            state =
                "REBUFFERING";

            console.log(
                `REBUFFERING: video=${v.toFixed(
                    2
                )}s audio=${a.toFixed(2)}s`
            );
        }

        return;
    }

    // ========================================================
    // REBUFFERING
    // ========================================================

    if (
        state === "REBUFFERING"
    ) {
        if (
            v >=
                REBUFFER_READY_SECONDS &&
            a >=
                REBUFFER_READY_SECONDS
        ) {
            state =
                "PLAYING";

            console.log(
                `RESUME PLAYBACK: video=${v.toFixed(
                    2
                )}s audio=${a.toFixed(2)}s`
            );
        }
    }
}

// ============================================================
// REMOVE OLD VIDEO DATA
// ============================================================
//
// Chỉ xóa frame cũ khi không còn client nào cần.
// Với ESP32 đơn sẽ giữ buffer ổn định.
// ============================================================

function pruneVideoBuffer() {
    if (
        videoClients.size === 0
    ) {
        while (
            videoBuffer.length >
            VIDEO_BUFFER_MAX_FRAMES
        ) {
            videoBuffer.shift();
        }

        return;
    }

    let minSeq =
        Infinity;

    for (
        const client of videoClients
    ) {
        if (
            client.closed
        ) {
            continue;
        }

        if (
            Number.isFinite(
                client.nextSeq
            )
        ) {
            minSeq = Math.min(
                minSeq,
                client.nextSeq
            );
        }
    }

    if (
        minSeq === Infinity
    ) {
        return;
    }

    while (
        videoBuffer.length &&
        videoBuffer[0].seq <
            minSeq - 2
    ) {
        videoBuffer.shift();
    }
}

// ============================================================
// FIND VIDEO FRAME
// ============================================================

function findFrame(
    seq
) {
    if (
        videoBuffer.length === 0
    ) {
        return null;
    }

    const first =
        videoBuffer[0].seq;

    const index =
        seq - first;

    if (
        index < 0
    ) {
        return null;
    }

    if (
        index >=
        videoBuffer.length
    ) {
        return null;
    }

    return videoBuffer[index];
}

// ============================================================
// GET LATEST FRAME SEQ
// ============================================================

function getLatestSeq() {
    if (
        videoBuffer.length === 0
    ) {
        return null;
    }

    return videoBuffer[
        videoBuffer.length - 1
    ].seq;
}

// ============================================================
// GET OLDEST FRAME SEQ
// ============================================================

function getOldestSeq() {
    if (
        videoBuffer.length === 0
    ) {
        return null;
    }

    return videoBuffer[0].seq;
}

// ============================================================
// STREAM VIDEO
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

                Pragma:
                    "no-cache",

                Expires:
                    "0",

                Connection:
                    "close",

                "Access-Control-Allow-Origin":
                    "*",
            }
        );

        const client = {
            res,
            closed: false,
            nextSeq: null,
            timer: null,
            waiting: true,
        };

        videoClients.add(client);

        // ====================================================
        // BẮT ĐẦU TỪ FRAME CŨ NHẤT
        // ====================================================

        function initializeCursor() {
            if (
                client.nextSeq !==
                null
            ) {
                return;
            }

            const oldest =
                getOldestSeq();

            if (
                oldest === null
            ) {
                return;
            }

            /*
             * Buffer đã có 5 giây.
             * Bắt đầu từ đầu buffer để ESP32
             * được hưởng đầy đủ khoảng đệm.
             */
            client.nextSeq =
                oldest;

            client.waiting = false;
        }

        function sendFrame() {
            if (
                client.closed
            ) {
                return;
            }

            // ------------------------------------------------
            // Chưa đủ buffer
            // ------------------------------------------------

            if (
                state ===
                    "FILLING" ||
                state === "IDLE"
            ) {
                client.waiting = true;

                return;
            }

            // ------------------------------------------------
            // Rebuffer
            // ------------------------------------------------

            if (
                state ===
                "REBUFFERING"
            ) {
                client.waiting = true;

                return;
            }

            initializeCursor();

            if (
                client.nextSeq ===
                null
            ) {
                return;
            }

            let frame =
                findFrame(
                    client.nextSeq
                );

            // ------------------------------------------------
            // Frame đã bị prune
            // ------------------------------------------------

            if (!frame) {
                const oldest =
                    getOldestSeq();

                const latest =
                    getLatestSeq();

                if (
                    oldest !== null &&
                    client.nextSeq <
                        oldest
                ) {
                    // Nhảy về đầu buffer
                    client.nextSeq =
                        oldest;

                    frame =
                        findFrame(
                            client.nextSeq
                        );
                }

                // Chưa có frame mới
                if (!frame) {
                    return;
                }
            }

            try {
                res.write(
                    "--frame\r\n" +
                        "Content-Type: image/jpeg\r\n" +
                        `Content-Length: ${frame.data.length}\r\n\r\n`
                );

                res.write(
                    frame.data
                );

                res.write(
                    "\r\n"
                );

                client.nextSeq++;

                pruneVideoBuffer();
            } catch {
                closeClient();
            }
        }

        // 8 FPS
        client.timer =
            setInterval(
                sendFrame,
                1000 / FPS
            );

        function closeClient() {
            if (
                client.closed
            ) {
                return;
            }

            client.closed = true;

            if (
                client.timer
            ) {
                clearInterval(
                    client.timer
                );
            }

            videoClients.delete(
                client
            );

            try {
                res.end();
            } catch {}

            pruneVideoBuffer();
        }

        req.on(
            "close",
            closeClient
        );

        res.on(
            "close",
            closeClient
        );
    }
);

// ============================================================
// AUDIO STREAM
// ============================================================

app.get(
    "/audio",
    (req, res) => {
        res.writeHead(
            200,
            {
                "Content-Type":
                    "audio/L16",

                "Cache-Control":
                    "no-cache, no-store, must-revalidate",

                Pragma:
                    "no-cache",

                Expires:
                    "0",

                Connection:
                    "close",

                "Access-Control-Allow-Origin":
                    "*",

                "X-Audio-Sample-Rate":
                    String(
                        AUDIO_SAMPLE_RATE
                    ),

                "X-Audio-Channels":
                    String(
                        AUDIO_CHANNELS
                    ),

                "X-Audio-Bits":
                    "16",
            }
        );

        const client = {
            res,
            closed: false,
            started: false,
            timer: null,
            pending: Buffer.alloc(0),
        };

        audioClients.add(client);

        // ----------------------------------------------------
        // Mỗi lần gửi 20ms PCM
        // ----------------------------------------------------

        const CHUNK_BYTES =
            Math.floor(
                AUDIO_BYTES_PER_SECOND *
                    0.02
            );

        function sendAudio() {
            if (
                client.closed
            ) {
                return;
            }

            // ------------------------------------------------
            // Chưa đủ buffer ban đầu
            // ------------------------------------------------

            if (
                state ===
                    "FILLING" ||
                state === "IDLE"
            ) {
                return;
            }

            // ------------------------------------------------
            // Rebuffer
            // ------------------------------------------------

            if (
                state ===
                "REBUFFERING"
            ) {
                return;
            }

            if (
                !client.started
            ) {
                /*
                 * Khi PLAYING bắt đầu,
                 * client bắt đầu lấy audio từ đầu buffer.
                 *
                 * Vì audio buffer là queue nên copy toàn bộ
                 * buffer hiện tại thành playback queue riêng.
                 */

                client.started = true;
            }

            // ------------------------------------------------
            // Nếu pending chưa đủ
            // ------------------------------------------------

            while (
                client.pending.length <
                    CHUNK_BYTES &&
                audioChunks.length
            ) {
                const chunk =
                    audioChunks.shift();

                if (!chunk)
                    break;

                audioBufferedBytes -=
                    chunk.length;

                client.pending =
                    Buffer.concat([
                        client.pending,
                        chunk,
                    ]);
            }

            if (
                client.pending.length <
                CHUNK_BYTES
            ) {
                return;
            }

            const output =
                client.pending.slice(
                    0,
                    CHUNK_BYTES
                );

            client.pending =
                client.pending.slice(
                    CHUNK_BYTES
                );

            try {
                res.write(
                    output
                );
            } catch {
                closeClient();
            }
        }

        client.timer =
            setInterval(
                sendAudio,
                20
            );

        function closeClient() {
            if (
                client.closed
            ) {
                return;
            }

            client.closed = true;

            if (
                client.timer
            ) {
                clearInterval(
                    client.timer
                );
            }

            audioClients.delete(
                client
            );

            try {
                res.end();
            } catch {}
        }

        req.on(
            "close",
            closeClient
        );

        res.on(
            "close",
            closeClient
        );
    }
);

// ============================================================
// SELECT CHANNEL
// ============================================================

app.get(
    "/api/select/:id",
    (req, res) => {
        const id =
            Number(req.params.id);

        if (
            !Number.isInteger(id) ||
            id < 0 ||
            id >= channels.length
        ) {
            return res
                .status(404)
                .json({
                    ok: false,
                    error:
                        "Channel not found",
                });
        }

        currentChannel =
            channels[id];

        console.log(
            `SELECT CHANNEL: ${currentChannel.id} - ${currentChannel.name}`
        );

        startBuffering();

        res.json({
            ok: true,
            current: currentChannel,
        });
    }
);

// ============================================================
// STOP
// ============================================================

app.get(
    "/api/stop",
    (req, res) => {
        currentChannel = null;

        resetStreamState();

        res.json({
            ok: true,
            stopped: true,
        });
    }
);

// ============================================================
// CHANNEL LIST
// ============================================================

app.get(
    "/api/channels",
    (req, res) => {
        res.json({
            count: channels.length,

            current:
                currentChannel
                    ? {
                          id:
                              currentChannel.id,
                          name:
                              currentChannel.name,
                          group:
                              currentChannel.group,
                          logo:
                              currentChannel.logo,
                      }
                    : null,

            channels:
                channels.map(
                    (ch) => ({
                        id: ch.id,
                        name: ch.name,
                        group: ch.group,
                        logo: ch.logo,
                    })
                ),
        });
    }
);

// ============================================================
// CURRENT
// ============================================================

app.get(
    "/api/current",
    (req, res) => {
        res.json({
            current:
                currentChannel
                    ? {
                          id:
                              currentChannel.id,
                          name:
                              currentChannel.name,
                          group:
                              currentChannel.group,
                          logo:
                              currentChannel.logo,
                      }
                    : null,
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

            state,

            ffmpeg:
                !!ffmpeg,

            generation:
                ffmpegGeneration,

            channel:
                currentChannel
                    ? {
                          id:
                              currentChannel.id,
                          name:
                              currentChannel.name,
                      }
                    : null,

            video: {
                frames:
                    videoBuffer.length,

                seconds:
                    Number(
                        videoSeconds().toFixed(
                            2
                        )
                    ),

                maxSeconds:
                    VIDEO_BUFFER_MAX_SECONDS,
            },

            audio: {
                bytes:
                    audioBufferedBytes,

                seconds:
                    Number(
                        audioSeconds().toFixed(
                            2
                        )
                    ),

                maxSeconds:
                    AUDIO_BUFFER_MAX_SECONDS,
            },

            clients: {
                video:
                    videoClients.size,

                audio:
                    audioClients.size,
            },
        });
    }
);

// ============================================================
// ROOT
// ============================================================

app.get(
    "/",
    (req, res) => {
        res.json({
            name:
                "ESP32 IPTV MJPEG Server",

            status: "online",

            endpoints: {
                channels:
                    "/api/channels",

                current:
                    "/api/current",

                select:
                    "/api/select/:id",

                stop:
                    "/api/stop",

                video:
                    "/stream",

                audio:
                    "/audio",

                health:
                    "/health",
            },
        });
    }
);

// ============================================================
// SERVER
// ============================================================

const server =
    http.createServer(app);

server.listen(
    PORT,
    async () => {
        console.log(
            `Server listening on port ${PORT}`
        );

        console.log(
            `Video: ${WIDTH}x${HEIGHT} @ ${FPS} FPS`
        );

        console.log(
            `Audio: ${AUDIO_SAMPLE_RATE}Hz S16LE mono`
        );

        console.log(
            `Initial buffer: ${INITIAL_BUFFER_SECONDS}s`
        );

        console.log(
            `Video max buffer: ${VIDEO_BUFFER_MAX_SECONDS}s`
        );

        console.log(
            `Audio max buffer: ${AUDIO_BUFFER_MAX_SECONDS}s`
        );

        await loadChannels();
    }
);

// ============================================================
// PERIODIC BUFFER MONITOR
// ============================================================
//
// Chỉ log khi trạng thái thay đổi hoặc buffer thật sự thấp.
// Không spam "BUFFER READY" liên tục.
// ============================================================

setInterval(() => {
    if (!currentChannel) {
        return;
    }

    const v =
        videoSeconds();

    const a =
        audioSeconds();

    const key =
        `${state}:${Math.floor(v * 2)}:${Math.floor(a * 2)}`;

    if (
        key !== lastStateLog &&
        (
            state ===
                "REBUFFERING" ||
            state === "FILLING"
        )
    ) {
        lastStateLog = key;

        console.log(
            `BUFFER STATUS: state=${state} video=${v.toFixed(
                2
            )}s audio=${a.toFixed(2)}s`
        );
    }
}, 1000);

// ============================================================
// CLEAN SHUTDOWN
// ============================================================

process.on(
    "SIGTERM",
    () => {
        console.log(
            "SIGTERM received"
        );

        currentChannel = null;

        resetStreamState();

        server.close(() => {
            process.exit(0);
        });
    }
);

process.on(
    "SIGINT",
    () => {
        console.log(
            "SIGINT received"
        );

        currentChannel = null;

        resetStreamState();

        server.close(() => {
            process.exit(0);
        });
    }
);
