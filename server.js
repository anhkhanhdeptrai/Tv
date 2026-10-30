const express = require("express");
const http = require("http");
const https = require("https");
const { spawn } = require("child_process");

const app = express();

const PORT = process.env.PORT || 10000;

const M3U_URL =
    "https://raw.githubusercontent.com/iptv-org/iptv/master/streams/vn.m3u";

// ============================================================
// VIDEO
// ============================================================

const WIDTH = 340;
const HEIGHT = 230;
const FPS = 8;
const JPEG_QUALITY = 8;

const VIDEO_FRAME_MS = 1000 / FPS;

// ============================================================
// AUDIO
// ============================================================

const AUDIO_SAMPLE_RATE = 48000;
const AUDIO_CHANNELS = 1;
const AUDIO_BITS = 16;
const AUDIO_BYTES_PER_SAMPLE = 2;

const AUDIO_BYTES_PER_SECOND =
    AUDIO_SAMPLE_RATE *
    AUDIO_CHANNELS *
    AUDIO_BYTES_PER_SAMPLE;

const AUDIO_BLOCK_MS = 20;

const AUDIO_BLOCK_SAMPLES =
    Math.round(
        AUDIO_SAMPLE_RATE *
            AUDIO_BLOCK_MS /
            1000
    );

const AUDIO_BLOCK_BYTES =
    AUDIO_BLOCK_SAMPLES *
    AUDIO_CHANNELS *
    AUDIO_BYTES_PER_SAMPLE;

// ============================================================
// RING BUFFER
// ============================================================

// Mục tiêu playback cách live khoảng 5 giây
const TARGET_DELAY_MS = 5000;

// Ring giữ tối đa khoảng 7 giây
const MAX_BUFFER_MS = 7000;

// Bắt đầu phát khi có tối thiểu 5 giây
const INITIAL_BUFFER_MS = 5000;

// Khi đang phát chỉ rebuffer khi còn dưới 1 giây
const REBUFFER_MS = 1000;

// Sau rebuffer có ít nhất 2 giây thì chạy lại
const RESUME_BUFFER_MS = 2000;

// ============================================================
// STATE
// ============================================================

let channels = [];
let currentChannel = null;

let ffmpeg = null;
let generation = 0;

let state = "IDLE";
// IDLE
// FILLING
// PLAYING
// REBUFFERING

// ============================================================
// TIMELINE
// ============================================================
//
// Hai ring-buffer dùng cùng timeline:
// video pts = 0, 125, 250...
// audio pts = 0, 20, 40...
//
// Không dùng Date.now() cho playback.
// ============================================================

let timelineStartWall = 0;

let liveVideoPts = 0;
let liveAudioPts = 0;

// ============================================================
// VIDEO RING
// ============================================================

const videoRing = [];

let videoWriteIndex = 0;

let videoTotalFrames = 0;

// ============================================================
// AUDIO RING
// ============================================================

const audioRing = [];

let audioWriteIndex = 0;

let audioTotalBlocks = 0;

// ============================================================
// PLAYBACK
// ============================================================

let playbackVideoPts = 0;
let playbackAudioPts = 0;

let playbackStarted = false;

// ============================================================
// CLIENT
// ============================================================

let videoClient = null;
let audioClient = null;

// ============================================================
// HELPERS
// ============================================================

function resetTimeline() {
    timelineStartWall = 0;

    liveVideoPts = 0;
    liveAudioPts = 0;

    playbackVideoPts = 0;
    playbackAudioPts = 0;

    playbackStarted = false;
}

function clearRings() {
    videoRing.length = 0;
    audioRing.length = 0;

    videoWriteIndex = 0;
    audioWriteIndex = 0;

    videoTotalFrames = 0;
    audioTotalBlocks = 0;

    resetTimeline();
}

function videoBufferedMs() {
    if (
        videoTotalFrames <= 0
    ) {
        return 0;
    }

    return (
        videoTotalFrames *
        VIDEO_FRAME_MS
    );
}

function audioBufferedMs() {
    if (
        audioTotalBlocks <= 0
    ) {
        return 0;
    }

    return (
        audioTotalBlocks *
        AUDIO_BLOCK_MS
    );
}

function getOldestVideo() {
    if (
        videoTotalFrames <= 0
    ) {
        return null;
    }

    return videoRing[
        videoWriteIndex
    ];
}

function getOldestAudio() {
    if (
        audioTotalBlocks <= 0
    ) {
        return null;
    }

    return audioRing[
        audioWriteIndex
    ];
}

// ============================================================
// M3U DOWNLOAD
// ============================================================

function downloadText(url) {
    return new Promise(
        (resolve, reject) => {
            const lib =
                url.startsWith("https")
                    ? https
                    : http;

            const req = lib.get(
                url,
                {
                    headers: {
                        "User-Agent":
                            "Mozilla/5.0 ESP32 IPTV",
                    },
                },
                (res) => {
                    if (
                        res.statusCode >= 300 &&
                        res.statusCode < 400 &&
                        res.headers.location
                    ) {
                        return downloadText(
                            res.headers.location
                        )
                            .then(resolve)
                            .catch(reject);
                    }

                    if (
                        res.statusCode !==
                        200
                    ) {
                        reject(
                            new Error(
                                `HTTP ${res.statusCode}`
                            )
                        );

                        return;
                    }

                    let data = "";

                    res.setEncoding(
                        "utf8"
                    );

                    res.on(
                        "data",
                        (chunk) => {
                            data += chunk;
                        }
                    );

                    res.on(
                        "end",
                        () => {
                            resolve(data);
                        }
                    );
                }
            );

            req.setTimeout(
                20000,
                () => {
                    req.destroy(
                        new Error(
                            "M3U timeout"
                        )
                    );
                }
            );

            req.on(
                "error",
                reject
            );
        }
    );
}

// ============================================================
// PARSE M3U
// ============================================================

function parseM3U(text) {
    const lines =
        text
            .split(/\r?\n/)
            .map((x) => x.trim());

    const result = [];

    let info = null;

    for (
        const line of lines
    ) {
        if (!line) continue;

        if (
            line.startsWith(
                "#EXTINF:"
            )
        ) {
            info = line;
            continue;
        }

        if (
            info &&
            line.startsWith("http")
        ) {
            const comma =
                info.indexOf(",");

            const name =
                comma >= 0
                    ? info
                          .slice(
                              comma + 1
                          )
                          .trim()
                    : "Unknown";

            if (
                name
                    .toLowerCase()
                    .includes(
                        "[geo-blocked]"
                    )
            ) {
                info = null;
                continue;
            }

            if (
                line
                    .toLowerCase()
                    .includes(
                        ".mpd"
                    )
            ) {
                info = null;
                continue;
            }

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

            result.push({
                id: result.length,
                name,
                tvgId,
                group,
                logo,
                url: line,
            });

            info = null;
        }
    }

    return result;
}

// ============================================================
// LOAD CHANNELS
// ============================================================

async function loadChannels() {
    try {
        console.log(
            "Loading M3U..."
        );

        const text =
            await downloadText(
                M3U_URL
            );

        channels =
            parseM3U(text);

        console.log(
            `Loaded ${channels.length} channels`
        );
    } catch (err) {
        console.error(
            "M3U ERROR:",
            err.message
        );
    }
}

// ============================================================
// STOP FFMPEG
// ============================================================

function stopFFmpeg() {
    if (!ffmpeg) {
        return;
    }

    try {
        ffmpeg.kill(
            "SIGKILL"
        );
    } catch {}

    ffmpeg = null;
}

// ============================================================
// RESET STREAM
// ============================================================

function resetStream() {
    generation++;

    stopFFmpeg();

    clearRings();

    state = "IDLE";
}

// ============================================================
// START CHANNEL
// ============================================================

function startChannel(channel) {
    generation++;

    const myGeneration =
        generation;

    stopFFmpeg();

    clearRings();

    currentChannel =
        channel;

    state = "FILLING";

    console.log(
        `START: ${channel.name}`
    );

    startFFmpeg(
        channel,
        myGeneration
    );
}

// ============================================================
// VIDEO RING PUSH
// ============================================================

function pushVideo(
    frame
) {
    const pts =
        liveVideoPts;

    liveVideoPts +=
        VIDEO_FRAME_MS;

    const item = {
        pts,
        data: frame,
    };

    const maxFrames =
        Math.ceil(
            MAX_BUFFER_MS /
                VIDEO_FRAME_MS
        );

    if (
        videoTotalFrames <
        maxFrames
    ) {
        const index =
            (
                videoWriteIndex +
                videoTotalFrames
            ) % maxFrames;

        videoRing[index] =
            item;

        videoTotalFrames++;
    } else {
        /*
         * Ring full:
         * ghi đè frame cũ nhất.
         */
        videoRing[
            videoWriteIndex
        ] = item;

        videoWriteIndex =
            (
                videoWriteIndex +
                1
            ) % maxFrames;
    }
}

// ============================================================
// AUDIO RING PUSH
// ============================================================

function pushAudio(
    block
) {
    const pts =
        liveAudioPts;

    liveAudioPts +=
        AUDIO_BLOCK_MS;

    const maxBlocks =
        Math.ceil(
            MAX_BUFFER_MS /
                AUDIO_BLOCK_MS
        );

    if (
        audioTotalBlocks <
        maxBlocks
    ) {
        const index =
            (
                audioWriteIndex +
                audioTotalBlocks
            ) % maxBlocks;

        audioRing[index] = {
            pts,
            data: block,
        };

        audioTotalBlocks++;
    } else {
        audioRing[
            audioWriteIndex
        ] = {
            pts,
            data: block,
        };

        audioWriteIndex =
            (
                audioWriteIndex +
                1
            ) % maxBlocks;
    }
}

// ============================================================
// FIND VIDEO BY PTS
// ============================================================

function findVideo(
    pts
) {
    if (
        videoTotalFrames <= 0
    ) {
        return null;
    }

    const maxFrames =
        Math.ceil(
            MAX_BUFFER_MS /
                VIDEO_FRAME_MS
        );

    for (
        let i = 0;
        i < videoTotalFrames;
        i++
    ) {
        const index =
            (
                videoWriteIndex +
                i
            ) % maxFrames;

        const item =
            videoRing[index];

        if (!item) {
            continue;
        }

        if (
            item.pts >= pts
        ) {
            return item;
        }
    }

    return null;
}

// ============================================================
// FIND AUDIO BY PTS
// ============================================================

function findAudio(
    pts
) {
    if (
        audioTotalBlocks <= 0
    ) {
        return null;
    }

    const maxBlocks =
        Math.ceil(
            MAX_BUFFER_MS /
                AUDIO_BLOCK_MS
        );

    for (
        let i = 0;
        i < audioTotalBlocks;
        i++
    ) {
        const index =
            (
                audioWriteIndex +
                i
            ) % maxBlocks;

        const item =
            audioRing[index];

        if (!item) {
            continue;
        }

        if (
            item.pts >= pts
        ) {
            return item;
        }
    }

    return null;
}

// ============================================================
// BUFFER STATUS
// ============================================================

function updateState() {
    const v =
        videoBufferedMs();

    const a =
        audioBufferedMs();

    const available =
        Math.min(v, a);

    // --------------------------------------------------------
    // FILLING
    // --------------------------------------------------------

    if (
        state === "FILLING"
    ) {
        if (
            available >=
            INITIAL_BUFFER_MS
        ) {
            /*
             * Chọn playback point cách live
             * khoảng 5 giây.
             */

            const live =
                Math.min(
                    liveVideoPts,
                    liveAudioPts
                );

            playbackVideoPts =
                Math.max(
                    0,
                    live -
                        TARGET_DELAY_MS
                );

            playbackAudioPts =
                playbackVideoPts;

            playbackStarted =
                true;

            state =
                "PLAYING";

            console.log(
                `BUFFER READY: video=${(
                    v / 1000
                ).toFixed(
                    2
                )}s audio=${(
                    a / 1000
                ).toFixed(2)}s`
            );
        }

        return;
    }

    // --------------------------------------------------------
    // PLAYING
    // --------------------------------------------------------

    if (
        state === "PLAYING"
    ) {
        if (
            available <
            REBUFFER_MS
        ) {
            state =
                "REBUFFERING";

            console.log(
                `REBUFFERING: video=${(
                    v / 1000
                ).toFixed(
                    2
                )}s audio=${(
                    a / 1000
                ).toFixed(2)}s`
            );
        }

        return;
    }

    // --------------------------------------------------------
    // REBUFFERING
    // --------------------------------------------------------

    if (
        state === "REBUFFERING"
    ) {
        if (
            available >=
            RESUME_BUFFER_MS
        ) {
            /*
             * Khi resume, chọn lại một điểm
             * có chung A/V.
             */

            const live =
                Math.min(
                    liveVideoPts,
                    liveAudioPts
                );

            playbackVideoPts =
                Math.max(
                    0,
                    live -
                        TARGET_DELAY_MS
                );

            playbackAudioPts =
                playbackVideoPts;

            state =
                "PLAYING";

            console.log(
                `RESUME: delay=${TARGET_DELAY_MS}ms`
            );
        }
    }
}

// ============================================================
// FFMPEG
// ============================================================

function startFFmpeg(
    channel,
    myGeneration
) {
    const args = [
        "-hide_banner",
        "-loglevel",
        "warning",

        // ----------------------------------------------------
        // HLS reconnect
        // ----------------------------------------------------

        "-reconnect",
        "1",

        "-reconnect_streamed",
        "1",

        "-reconnect_at_eof",
        "1",

        "-reconnect_delay_max",
        "3",

        // ----------------------------------------------------
        // Timestamp
        // ----------------------------------------------------

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
        "1",

        "-ar",
        String(
            AUDIO_SAMPLE_RATE
        ),

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

    let buffer =
        Buffer.alloc(0);

    ffmpeg.stdout.on(
        "data",
        (chunk) => {
            if (
                myGeneration !==
                generation
            ) {
                return;
            }

            buffer =
                Buffer.concat([
                    buffer,
                    chunk,
                ]);

            while (true) {
                const start =
                    buffer.indexOf(
                        Buffer.from([
                            0xff,
                            0xd8,
                        ])
                    );

                if (
                    start < 0
                ) {
                    if (
                        buffer.length >
                        1024 * 1024
                    ) {
                        buffer =
                            buffer.slice(
                                -65536
                            );
                    }

                    break;
                }

                const end =
                    buffer.indexOf(
                        Buffer.from([
                            0xff,
                            0xd9,
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

                const frame =
                    buffer.slice(
                        start,
                        end + 2
                    );

                buffer =
                    buffer.slice(
                        end + 2
                    );

                if (
                    frame.length <
                    100
                ) {
                    continue;
                }

                pushVideo(
                    frame
                );

                updateState();
            }
        }
    );

    // ========================================================
    // AUDIO PARSER
    // ========================================================

    let audioPending =
        Buffer.alloc(0);

    ffmpeg.stdio[3].on(
        "data",
        (chunk) => {
            if (
                myGeneration !==
                generation
            ) {
                return;
            }

            if (
                !chunk.length
            ) {
                return;
            }

            audioPending =
                Buffer.concat([
                    audioPending,
                    chunk,
                ]);

            while (
                audioPending.length >=
                AUDIO_BLOCK_BYTES
            ) {
                const block =
                    audioPending.slice(
                        0,
                        AUDIO_BLOCK_BYTES
                    );

                audioPending =
                    audioPending.slice(
                        AUDIO_BLOCK_BYTES
                    );

                pushAudio(
                    block
                );

                updateState();
            }
        }
    );

    // ========================================================
    // FFMPEG STDERR
    // ========================================================

    ffmpeg.stderr.on(
        "data",
        (data) => {
            if (
                myGeneration !==
                generation
            ) {
                return;
            }

            const text =
                data
                    .toString()
                    .trim();

            if (
                text
            ) {
                console.log(
                    "[FFmpeg]",
                    text
                );
            }
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
                myGeneration !==
                generation
            ) {
                return;
            }

            console.log(
                `FFmpeg exited: code=${code} signal=${signal}`
            );

            ffmpeg = null;

            if (
                currentChannel
            ) {
                setTimeout(
                    () => {
                        if (
                            currentChannel &&
                            myGeneration ===
                                generation
                        ) {
                            startFFmpeg(
                                currentChannel,
                                myGeneration
                            );
                        }
                    },
                    1000
                );
            }
        }
    );

    ffmpeg.on(
        "error",
        (err) => {
            if (
                myGeneration !==
                generation
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
// VIDEO PLAYBACK
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

        if (
            videoClient
        ) {
            try {
                videoClient.res.end();
            } catch {}
        }

        const client = {
            res,
            timer: null,
            closed: false,
        };

        videoClient =
            client;

        function send() {
            if (
                client.closed
            ) {
                return;
            }

            if (
                state !==
                "PLAYING"
            ) {
                return;
            }

            if (
                !playbackStarted
            ) {
                return;
            }

            const frame =
                findVideo(
                    playbackVideoPts
                );

            if (!frame) {
                return;
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

                /*
                 * Playback timeline chạy độc lập
                 * với tốc độ FFmpeg.
                 */
                playbackVideoPts +=
                    VIDEO_FRAME_MS;
            } catch {
                close();
            }
        }

        client.timer =
            setInterval(
                send,
                VIDEO_FRAME_MS
            );

        function close() {
            if (
                client.closed
            ) {
                return;
            }

            client.closed =
                true;

            clearInterval(
                client.timer
            );

            if (
                videoClient ===
                client
            ) {
                videoClient =
                    null;
            }

            try {
                res.end();
            } catch {}
        }

        req.on(
            "close",
            close
        );

        res.on(
            "close",
            close
        );
    }
);

// ============================================================
// AUDIO PLAYBACK
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
                    "1",

                "X-Audio-Bits":
                    "16",
            }
        );

        if (
            audioClient
        ) {
            try {
                audioClient.res.end();
            } catch {}
        }

        const client = {
            res,
            timer: null,
            closed: false,
        };

        audioClient =
            client;

        function send() {
            if (
                client.closed
            ) {
                return;
            }

            if (
                state !==
                "PLAYING"
            ) {
                return;
            }

            if (
                !playbackStarted
            ) {
                return;
            }

            const block =
                findAudio(
                    playbackAudioPts
                );

            if (!block) {
                return;
            }

            try {
                res.write(
                    block.data
                );

                playbackAudioPts +=
                    AUDIO_BLOCK_MS;
            } catch {
                close();
            }
        }

        /*
         * Không dùng setInterval 20ms.
         *
         * Dùng timer drift thấp hơn và
         * tự tính theo timeline.
         */

        function schedule() {
            if (
                client.closed
            ) {
                return;
            }

            const start =
                process.hrtime.bigint();

            send();

            const elapsed =
                Number(
                    process.hrtime.bigint() -
                        start
                ) / 1e6;

            const delay =
                Math.max(
                    1,
                    AUDIO_BLOCK_MS -
                        elapsed
                );

            client.timer =
                setTimeout(
                    schedule,
                    delay
                );
        }

        schedule();

        function close() {
            if (
                client.closed
            ) {
                return;
            }

            client.closed =
                true;

            if (
                client.timer
            ) {
                clearTimeout(
                    client.timer
                );
            }

            if (
                audioClient ===
                client
            ) {
                audioClient =
                    null;
            }

            try {
                res.end();
            } catch {}
        }

        req.on(
            "close",
            close
        );

        res.on(
            "close",
            close
        );
    }
);

// ============================================================
// API CHANNELS
// ============================================================

app.get(
    "/api/channels",
    (req, res) => {
        res.json({
            count:
                channels.length,

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
// SELECT
// ============================================================

app.get(
    "/api/select/:id",
    (req, res) => {
        const id =
            Number(
                req.params.id
            );

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

        const channel =
            channels[id];

        startChannel(
            channel
        );

        res.json({
            ok: true,

            current: {
                id:
                    channel.id,
                name:
                    channel.name,
                group:
                    channel.group,
                logo:
                    channel.logo,
            },
        });
    }
);

// ============================================================
// STOP
// ============================================================

app.get(
    "/api/stop",
    (req, res) => {
        currentChannel =
            null;

        resetStream();

        res.json({
            ok: true,
            stopped: true,
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
        const videoMs =
            videoBufferedMs();

        const audioMs =
            audioBufferedMs();

        res.json({
            ok: true,

            state,

            ffmpeg:
                !!ffmpeg,

            generation,

            channel:
                currentChannel
                    ? {
                          id:
                              currentChannel.id,
                          name:
                              currentChannel.name,
                      }
                    : null,

            buffer: {
                target:
                    TARGET_DELAY_MS,

                video:
                    Number(
                        (
                            videoMs /
                            1000
                        ).toFixed(
                            2
                        )
                    ),

                audio:
                    Number(
                        (
                            audioMs /
                            1000
                        ).toFixed(
                            2
                        )
                    ),

                available:
                    Number(
                        (
                            Math.min(
                                videoMs,
                                audioMs
                            ) /
                            1000
                        ).toFixed(
                            2
                        )
                    ),
            },

            timeline: {
                liveVideoPts:
                    liveVideoPts,

                liveAudioPts:
                    liveAudioPts,

                playbackVideoPts:
                    playbackVideoPts,

                playbackAudioPts:
                    playbackAudioPts,

                delay:
                    Math.max(
                        0,
                        Math.min(
                            liveVideoPts -
                                playbackVideoPts,
                            liveAudioPts -
                                playbackAudioPts
                        )
                    ),
            },

            clients: {
                video:
                    !!videoClient,

                audio:
                    !!audioClient,
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
                "ESP32 IPTV MJPEG A/V Ring Buffer",

            status:
                "online",

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
    http.createServer(
        app
    );

server.listen(
    PORT,
    async () => {
        console.log(
            `Server listening on ${PORT}`
        );

        console.log(
            `Video: ${WIDTH}x${HEIGHT} @ ${FPS} FPS`
        );

        console.log(
            `Audio: ${AUDIO_SAMPLE_RATE}Hz S16LE mono`
        );

        console.log(
            `Target delay: ${TARGET_DELAY_MS}ms`
        );

        console.log(
            `Max buffer: ${MAX_BUFFER_MS}ms`
        );

        await loadChannels();
    }
);

// ============================================================
// PERIODIC STATE CHECK
// ============================================================

setInterval(
    () => {
        if (
            state ===
            "FILLING" ||
            state ===
            "REBUFFERING"
        ) {
            updateState();
        }
    },
    100
);

// ============================================================
// SHUTDOWN
// ============================================================

function shutdown() {
    console.log(
        "Shutting down..."
    );

    currentChannel =
        null;

    generation++;

    stopFFmpeg();

    clearRings();

    try {
        videoClient?.res.end();
    } catch {}

    try {
        audioClient?.res.end();
    } catch {}

    server.close(
        () => {
            process.exit(0);
        }
    );
}

process.on(
    "SIGINT",
    shutdown
);

process.on(
    "SIGTERM",
    shutdown
);
