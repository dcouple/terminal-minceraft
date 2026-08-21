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
  const tag = '<script type="text/javascript" src="/look.js"></script>'
    + '<script type="text/javascript" src="/agent.js"></script>';
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

// ---- the agent control layer ----------------------------------------------
// One place that knows how to ask the running game a question and how to tell
// it to do something. The MCP server and the CLI are both clients of this.
//
// The page cannot be called, so the traffic is inverted: the page holds a GET
// open, the server answers it the moment a command arrives, and the page posts
// the result back. Two ordinary requests, no socket library, no dependency.
const waitingPages = [];   // held /agent/poll responses
const queued = [];         // commands with nobody to take them yet
const pending = new Map(); // id -> the caller waiting for a result
let commandId = 0;
let lastSeen = 0;

function deliver(res, entry) {
  const text = JSON.stringify({ id: entry.id, action: entry.action, args: entry.args });
  res.writeHead(200, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
  });
  res.end(text);
}

function enqueue(action, args, timeoutMs) {
  return new Promise((resolve) => {
    const id = ++commandId;
    const entry = { id, action, args };
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve({ ok: false, error: `the game did not answer in ${timeoutMs}ms. Is a world loaded?` });
    }, timeoutMs);
    pending.set(id, { resolve, timer });

    const waiter = waitingPages.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      deliver(waiter.res, entry);
    } else {
      queued.push(entry);
    }
  });
}

function readJson(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(new Error("body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); }
      catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

function json(res, code, body) {
  const text = JSON.stringify(body);
  res.writeHead(code, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
  });
  res.end(text);
}

async function agentRoute(req, res, url) {
  // The page taking its next instruction. Held open, because an agent that
  // polls on a timer is an agent that is always a little behind the game.
  if (url.pathname === "/agent/poll") {
    lastSeen = Date.now();
    const ready = queued.shift();
    if (ready) { deliver(res, ready); return true; }
    const waiter = { res };
    // An empty 204 rather than a held connection for ever, so a page that goes
    // away with the browser does not leave a socket open behind it.
    waiter.timer = setTimeout(() => {
      const at = waitingPages.indexOf(waiter);
      if (at >= 0) waitingPages.splice(at, 1);
      res.writeHead(204).end();
    }, 25000);
    waitingPages.push(waiter);
    res.on("close", () => {
      const at = waitingPages.indexOf(waiter);
      if (at >= 0) waitingPages.splice(at, 1);
      clearTimeout(waiter.timer);
    });
    return true;
  }

  if (url.pathname === "/agent/result" && req.method === "POST") {
    const body = await readJson(req).catch(() => null);
    const slot = body && pending.get(body.id);
    if (slot) {
      clearTimeout(slot.timer);
      pending.delete(body.id);
      slot.resolve(body);
    }
    json(res, 200, { ok: true });
    return true;
  }

  // What the MCP server and the CLI call.
  if (url.pathname === "/agent/command" && req.method === "POST") {
    const body = await readJson(req).catch(() => ({}));
    if (!body.action) { json(res, 400, { ok: false, error: "a command needs an action" }); return true; }
    const timeout = Math.max(1000, Math.min(60000, Number(body.timeout) || 20000));
    json(res, 200, await enqueue(body.action, body.args || {}, timeout));
    return true;
  }

  if (url.pathname === "/agent/status") {
    json(res, 200, {
      ok: true,
      pageConnected: waitingPages.length > 0 || Date.now() - lastSeen < 30000,
      lastSeenMsAgo: lastSeen ? Date.now() - lastSeen : null,
      queued: queued.length,
      pending: pending.size,
    });
    return true;
  }

  return false;
}

const server = createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");

  if (url.pathname.startsWith("/agent/")) {
    agentRoute(req, res, url).then((handled) => {
      if (!handled) json(res, 404, { ok: false, error: "no such agent route" });
    }).catch((err) => json(res, 500, { ok: false, error: String(err && err.message || err) }));
    return;
  }

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
