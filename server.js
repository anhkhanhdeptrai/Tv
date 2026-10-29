const http = require("http");
const { spawn } = require("child_process");

const PORT = Number(process.env.PORT || 3000);
const DEFAULT_PLAYLIST = process.env.PLAYLIST_URL ||
  "https://raw.githubusercontent.com/iptv-org/iptv/master/streams/vn.m3u";

function send(res, status, type, body) {
  res.writeHead(status, {
    "Content-Type": type,
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function validHttpUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch { return false; }
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
      current = { name, logo: attrs["tvg-logo"] || "", group: attrs["group-title"] || "", url: "" };
    } else if (!line.startsWith("#") && current) {
      current.url = line;
      channels.push(current);
      current = null;
    }
  }
  return channels;
}

async function fetchWithTimeout(url, ms = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "Mozilla/5.0 ESP32-TV-MJPEG/1.0" }
    });
  } finally { clearTimeout(timer); }
}

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (requestUrl.pathname === "/" || requestUrl.pathname === "/health") {
    return send(res, 200, "application/json; charset=utf-8", JSON.stringify({
      ok: true, service: "Render TV to MJPEG",
      endpoints: ["/health", "/channels", "/stream?url=ENCODED_M3U8_URL"]
    }));
  }

  if (requestUrl.pathname === "/channels") {
    try {
      const playlistUrl = requestUrl.searchParams.get("playlist") || DEFAULT_PLAYLIST;
      if (!validHttpUrl(playlistUrl))
        return send(res, 400, "application/json", JSON.stringify({ error: "Invalid playlist URL" }));
      const response = await fetchWithTimeout(playlistUrl);
      if (!response.ok)
        return send(res, 502, "application/json", JSON.stringify({ error: `Playlist returned HTTP ${response.status}` }));
      return send(res, 200, "application/json; charset=utf-8", JSON.stringify(parseM3U(await response.text())));
    } catch (err) {
      console.error("Playlist error:", err.stack || err);
      return send(res, 502, "application/json", JSON.stringify({ error: err.message }));
    }
  }

  if (requestUrl.pathname === "/stream") {
    const sourceUrl = requestUrl.searchParams.get("url");
    if (!sourceUrl || !validHttpUrl(sourceUrl))
      return send(res, 400, "text/plain; charset=utf-8", "Missing or invalid URL. Use /stream?url=ENCODED_M3U8_URL");

    console.log("Starting stream:", sourceUrl);
    const args = [
      "-hide_banner", "-loglevel", "warning", "-nostdin",
      "-user_agent", "Mozilla/5.0 ESP32-TV-MJPEG/1.0",
      "-rw_timeout", "15000000",
      "-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "4",
      "-i", sourceUrl, "-map", "0:v:0", "-an", "-sn", "-dn",
      "-vf", "fps=10,scale=320:240:force_original_aspect_ratio=decrease,pad=320:240:(ow-iw)/2:(oh-ih)/2",
      "-q:v", "8", "-f", "image2pipe", "-vcodec", "mjpeg", "pipe:1"
    ];

    res.writeHead(200, {
      "Content-Type": "multipart/x-mixed-replace; boundary=frame",
      "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
      "Pragma": "no-cache",
      "Access-Control-Allow-Origin": "*",
      "X-Content-Type-Options": "nosniff",
      "Connection": "keep-alive"
    });
    res.flushHeaders?.();

    const ff = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    let buffer = Buffer.alloc(0);
    let closed = false;
    let frames = 0;

    function stop(reason) {
      if (closed) return;
      closed = true;
      console.log("Stopping stream:", reason);
      if (!ff.killed) ff.kill("SIGTERM");
      if (!res.destroyed) res.end();
    }

    ff.stderr.on("data", chunk => {
      const msg = chunk.toString().trim();
      if (msg) console.error("[ffmpeg]", msg);
    });
    ff.on("error", err => {
      console.error("Failed to launch FFmpeg:", err.stack || err);
      stop("ffmpeg spawn error");
    });

    ff.stdout.on("data", chunk => {
      if (closed || res.destroyed) return;
      buffer = Buffer.concat([buffer, chunk]);

      while (buffer.length >= 4) {
        const start = buffer.indexOf(Buffer.from([0xff, 0xd8]));
        if (start < 0) {
          buffer = buffer.subarray(Math.max(0, buffer.length - 1));
          break;
        }
        const end = buffer.indexOf(Buffer.from([0xff, 0xd9]), start + 2);
        if (end < 0) {
          if (start > 0) buffer = buffer.subarray(start);
          break;
        }

        const jpg = buffer.subarray(start, end + 2);
        buffer = buffer.subarray(end + 2);
        frames++;

        const head = `--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpg.length}\r\n\r\n`;
        const canContinue = res.write(head) && res.write(jpg) && res.write("\r\n");
        if (!canContinue) {
          ff.stdout.pause();
          res.once("drain", () => { if (!closed) ff.stdout.resume(); });
        }
        if (frames === 1) console.log("First JPEG frame sent:", jpg.length, "bytes");
      }

      if (buffer.length > 6 * 1024 * 1024) {
        console.error("JPEG parser buffer too large; resetting");
        buffer = buffer.subarray(buffer.length - 1024 * 1024);
      }
    });

    ff.on("close", (code, signal) => {
      console.log(`FFmpeg exited code=${code} signal=${signal}; frames=${frames}`);
      if (!closed && !res.destroyed) {
        closed = true;
        res.end("\r\n--frame--\r\n");
      }
    });

    // Stop FFmpeg when the client connection really closes.
    res.on("close", () => {
      if (!closed) {
        closed = true;
        if (!ff.killed) ff.kill("SIGTERM");
      }
    });
    req.on("aborted", () => stop("client aborted"));
    return;
  }

  return send(res, 404, "text/plain; charset=utf-8", "Not found");
});

server.listen(PORT, "0.0.0.0", () => console.log(`TV MJPEG server listening on port ${PORT}`));
