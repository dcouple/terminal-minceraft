// A static file server for terminal-minceraft.
//
// The client is one self-contained HTML file downloaded at install time. It is
// served from loopback rather than opened as file://, because the game asks the
// browser for IndexedDB, WebGL and a few APIs that a file url does not get.
//
// The one transform this server does is inject look.js into the client's head,
// after the client's own launch-options script and before the game bundle runs.
// That is how the wrapper reaches the game without a single line of the game's
// code living in this repository.
import { createServer } from "node:http";
import { appendFileSync, createReadStream, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";

const root = resolve(process.argv[2] ?? ".");
const wanted = Number(process.argv[3] ?? 0);
const clientPath = process.env.TERMINAL_MINCERAFT_CLIENT || join(root, "client.html");

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".wasm": "application/wasm",
};

// Capture mode drops two files here: the game's own audio, and the moment the
// recorder started, which is what the capture harness aligns the video against.
const captureDir = process.env.TERMINAL_MINCERAFT_CAPTURE_DIR;

// The injected page is built once and held, because the client is ~20MB and a
// game reloads more often than you would think.
let page = null;
function buildPage() {
  if (page) return page;
  const html = readFileSync(clientPath, "utf8");
  const tag = '<script type="text/javascript" src="/look.js"></script>';
  // The client sets window.eaglercraftXOpts in the first script in <head>, then
  // loads the bundle. Landing right before </head> puts look.js after the
  // options and before the game, which is the only ordering that works.
  //
  // Find the closing head tag by scanning the string as it is. Lowercasing it
  // first looks tidier and is wrong: the client carries Minecraft's translated
  // credits, and a few of those letters lowercase into two code units, which
  // slides every index after them and lands the injection two characters into
  // the tag it was aiming at.
  let at = -1;
  for (const m of html.matchAll(/<\/head\s*>/gi)) at = m.index;
  page = Buffer.from(at === -1 ? tag + html : html.slice(0, at) + tag + html.slice(at), "utf8");
  return page;
}

const server = createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");

  if (req.method === "POST" && captureDir) {
    if (url.pathname === "/__mark") {
      writeFileSync(join(captureDir, "audio-start"), String(Date.now() / 1000));
      res.writeHead(204).end();
      return;
    }
    if (url.pathname === "/__audio") {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        appendFileSync(join(captureDir, "audio.webm"), Buffer.concat(chunks));
        res.writeHead(204).end();
      });
      return;
    }
  }

  if (url.pathname === "/" || url.pathname === "/index.html") {
    let body;
    try {
      body = buildPage();
    } catch (err) {
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      res.end(`the eaglercraft client is missing from ${clientPath}\n${err.message}\n`);
      return;
    }
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-length": body.length,
      "cache-control": "no-store",
    });
    res.end(body);
    return;
  }

  const rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
  const path = join(root, rel);
  if (!path.startsWith(root)) {
    res.writeHead(403).end("forbidden");
    return;
  }

  let stat;
  try {
    stat = statSync(path);
  } catch {
    res.writeHead(404).end("not found");
    return;
  }
  if (!stat.isFile()) {
    res.writeHead(404).end("not found");
    return;
  }

  res.writeHead(200, {
    "content-type": TYPES[extname(path).toLowerCase()] ?? "application/octet-stream",
    "content-length": stat.size,
    "cache-control": "no-store",
  });
  createReadStream(path).pipe(res);
});

// The port is part of the origin, and the origin is where the browser keeps
// localStorage and IndexedDB, which is where Minecraft keeps your settings and
// your worlds. A server on an ephemeral port hands the game a new, empty
// machine on every launch. So the port is fixed, and a clash is an error you
// can act on rather than a silent reset.
server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    process.stderr.write(`port ${wanted} is taken\n`);
    process.exit(3);
  }
  throw err;
});

// If the launcher goes away without getting to its cleanup, which is what
// happens when something kills the whole process group, this server would keep
// the port and the next game would refuse to start on it. Being reparented to
// init is the signal that nobody is waiting for us any more.
const parent = process.ppid;
setInterval(() => {
  if (process.ppid !== parent) process.exit(0);
}, 2000).unref();

server.listen(wanted, "127.0.0.1", () => {
  process.stdout.write(`${server.address().port}\n`);
});
