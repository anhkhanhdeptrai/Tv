const express = require("express");
const { spawn } = require("child_process");

const app = express();
const PORT = process.env.PORT || 10000;

app.get("/", (req, res) => {
res.type("text").send(
"TV MJPEG Server is running.\n" +
"/health\n" +
"/stream?url=YOUR_M3U8_URL"
);
});

app.get("/health", (req, res) => {
res.json({ ok: true, service: "TV MJPEG Server" });
});

app.get("/stream", (req, res) => {
const sourceUrl = req.query.url;

if (!sourceUrl) {
return res.status(400).send("Missing url parameter");
}

let parsedUrl;

try {
parsedUrl = new URL(sourceUrl);
} catch {
return res.status(400).send("Invalid stream URL");
}

if (!["http:", "https:"].includes(parsedUrl.protocol)) {
return res.status(400).send("Only HTTP/HTTPS URLs are supported");
}

res.writeHead(200, {
"Content-Type": "multipart/x-mixed-replace; boundary=frame",
"Cache-Control": "no-cache, no-store, must-revalidate",
"Pragma": "no-cache",
"Connection": "keep-alive",
"Access-Control-Allow-Origin": "*"
});

const args = [
"-hide_banner",
"-loglevel", "warning",
"-nostdin",

"-user_agent",
"Mozilla/5.0 ESP32-TV-MJPEG/1.0",

"-allowed_extensions", "ALL",
"-rw_timeout", "15000000",

"-i", sourceUrl,

"-map", "0:v:0",
"-an",
"-sn",
"-dn",

"-vf",
"fps=10,scale=320:240:force_original_aspect_ratio=decrease,pad=320:240:(ow-iw)/2:(oh-ih)/2",

"-q:v", "8",
"-f", "image2pipe",
"-vcodec", "mjpeg",
"pipe:1"

];

console.log("Starting stream:", sourceUrl);

const ffmpeg = spawn("ffmpeg", args, {
stdio: ["ignore", "pipe", "pipe"]
});

let buffer = Buffer.alloc(0);
let frameCount = 0;
let closed = false;

ffmpeg.stdout.on("data", (chunk) => {
if (closed || res.destroyed) return;

buffer = Buffer.concat([buffer, chunk]);

while (true) {
  const start = buffer.indexOf(Buffer.from([0xff, 0xd8]));
  if (start < 0) {
    buffer = buffer.slice(Math.max(0, buffer.length - 1));
    break;
  }

  const end = buffer.indexOf(
    Buffer.from([0xff, 0xd9]),
    start + 2
  );

  if (end < 0) {
    buffer = buffer.slice(start);
    break;
  }

  const jpeg = buffer.slice(start, end + 2);
  buffer = buffer.slice(end + 2);

  res.write("--frame\r\n");
  res.write("Content-Type: image/jpeg\r\n");
  res.write(`Content-Length: ${jpeg.length}\r\n\r\n`);
  res.write(jpeg);
  res.write("\r\n");

  frameCount++;

  if (frameCount === 1) {
    console.log("First JPEG frame sent:", jpeg.length, "bytes");
  }
}

});

ffmpeg.stderr.on("data", (data) => {
console.error("[ffmpeg]", data.toString().trim());
});

ffmpeg.on("error", (err) => {
console.error("FFmpeg spawn error:", err.message);
if (!res.destroyed) res.destroy();
});

ffmpeg.on("close", (code, signal) => {
console.log(
"FFmpeg exited code=${code} signal=${signal}; frames=${frameCount}"
);

if (!res.destroyed) res.end();

});

res.on("close", () => {
closed = true;

if (ffmpeg && ffmpeg.exitCode === null) {
  ffmpeg.kill("SIGTERM");
}

});
});

app.listen(PORT, "0.0.0.0", () => {
console.log("TV MJPEG server listening on port ${PORT}");
});
