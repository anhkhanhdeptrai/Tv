const http = require("http");
const { spawn } = require("child_process");

const PORT = process.env.PORT || 3000;
const DEFAULT_PLAYLIST =
  process.env.PLAYLIST_URL ||
  "https://raw.githubusercontent.com/iptv-org/iptv/master/streams/vn.m3u";

function send(res, status, type, body) {
  res.writeHead(status, { "Content-Type": type, "Access-Control-Allow-Origin": "*" });
  res.end(body);
}

function parseM3U(text) {
  const lines = text.split(/\r?\n/);
  const channels = [];
  let current = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#EXTINF:")) {
      const name = line.split(",").slice(1).join(",").trim() || "TV channel";
      const attrs = {};
      for (const m of line.matchAll(/([\w-]+)="([^"]*)"/g)) attrs[m[1]] = m[2];
      current = {
        name,
        logo: attrs["tvg-logo"] || "",
        group: attrs["group-title"] || "",
        url: ""
      };
    } else if (!line.startsWith("#") && current) {
      current.url = line;
      channels.push(current);
      current = null;
    }
  }
  return channels;
}

function validStreamUrl(value) {
  try {
    const u = new URL(value);
    return (u.protocol === "http:" || u.protocol === "https:") &&
      !["localhost", "127.0.0.1", "::1"].includes(u.hostname);
  } catch { return false; }
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (u.pathname === "/" || u.pathname === "/health") {
    return send(res, 200, "application/json; charset=utf-8",
      JSON.stringify({ ok: true, service: "ESP32 TV MJPEG server", endpoints: ["/channels", "/stream?url=..."] }));
  }

  if (u.pathname === "/channels") {
    try {
      const playlistUrl = u.searchParams.get("playlist") || DEFAULT_PLAYLIST;
      if (!validStreamUrl(playlistUrl)) return send(res, 400, "application/json", '{"error":"Invalid playlist URL"}');
      const r = await fetch(playlistUrl, { signal: AbortSignal.timeout(15000) });
      if (!r.ok) return send(res, 502, "application/json", JSON.stringify({ error: `Playlist HTTP ${r.status}` }));
      const channels = parseM3U(await r.text());
      return send(res, 200, "application/json; charset=utf-8", JSON.stringify(channels));
    } catch (e) {
      return send(res, 502, "application/json; charset=utf-8", JSON.stringify({ error: e.message }));
    }
  }

  if (u.pathname === "/stream") {
    const streamUrl = u.searchParams.get("url");
    if (!streamUrl || !validStreamUrl(streamUrl)) {
      return send(res, 400, "text/plain; charset=utf-8", "Provide a valid public http(s) stream URL in ?url=");
    }

    // FFmpeg decodes the source and emits a sequence of JPEG frames.
    const args = [
      "-hide_banner", "-loglevel", "error",
      "-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "3",
      "-i", streamUrl,
      "-an", "-sn", "-dn",
      "-vf", "fps=10,scale=320:240:force_original_aspect_ratio=decrease,pad=320:240:(ow-iw)/2:(oh-ih)/2",
      "-q:v", "8", "-f", "image2pipe", "-vcodec", "mjpeg", "pipe:1"
    ];

    res.writeHead(200, {
      "Content-Type": "multipart/x-mixed-replace; boundary=frame",
      "Cache-Control": "no-store, no-cache, must-revalidate",
      "Pragma": "no-cache",
      "Access-Control-Allow-Origin": "*",
      "Connection": "close"
    });

    const ff = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    let buffer = Buffer.alloc(0);
    let ended = false;

    ff.stderr.on("data", d => process.stderr.write(d));
    ff.on("error", err => {
      console.error("Could not start FFmpeg:", err.message);
      if (!res.headersSent) send(res, 500, "text/plain", "FFmpeg is not installed or failed to start");
      else res.end();
    });
    ff.stdout.on("data", chunk => {
      if (ended || res.destroyed) return;
      buffer = Buffer.concat([buffer, chunk]);
      // Split JPEG frames using SOI (FFD8) and EOI (FFD9) markers.
      while (buffer.length > 4) {
        const start = buffer.indexOf(Buffer.from([0xff, 0xd8]));
        if (start < 0) { buffer = buffer.subarray(Math.max(0, buffer.length - 1)); break; }
        const end = buffer.indexOf(Buffer.from([0xff, 0xd9]), start + 2);
        if (end < 0) {
          if (start > 0) buffer = buffer.subarray(start);
          break;
        }
        const jpg = buffer.subarray(start, end + 2);
        buffer = buffer.subarray(end + 2);
        res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpg.length}\r\n\r\n`);
        res.write(jpg);
        res.write("\r\n");
      }
      // Avoid unbounded memory growth if the input is not a valid MJPEG stream.
      if (buffer.length > 8 * 1024 * 1024) buffer = buffer.subarray(buffer.length - 1024 * 1024);
    });
    ff.on("close", code => {
      if (!ended && !res.destroyed) res.end(`\r\n--frame--\r\n`);
      ended = true;
      if (code && code !== 0) console.error("FFmpeg exited with code", code);
    });
    req.on("close", () => {
      ended = true;
      ff.kill("SIGTERM");
    });
    return;
  }

  send(res, 404, "text/plain; charset=utf-8", "Not found");
});

server.listen(PORT, "0.0.0.0", () => console.log(`ESP32 TV server listening on ${PORT}`));
