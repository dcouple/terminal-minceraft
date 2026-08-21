#!/usr/bin/env node
// terminal-minceraft agent: the scriptable half of the agent interface.
//
// A thin front end over the control layer in web/serve.mjs. Everything the MCP
// server can do, this can do from a shell, which is what makes a policy easy to
// write as a loop and easy to test without an agent in the room.
//
//   terminal-minceraft agent status
//   terminal-minceraft agent observe [--blocks] [--radius 24]
//   terminal-minceraft agent move forward 1.5 [--sprint] [--jump]
//   terminal-minceraft agent look --yaw 90 --pitch 0
//   terminal-minceraft agent look-at 12 65 -40
//   terminal-minceraft agent jump
//   terminal-minceraft agent mine 2
//   terminal-minceraft agent use
//   terminal-minceraft agent slot 3
//   terminal-minceraft agent say "hello from an agent"
//   terminal-minceraft agent stop
//   terminal-minceraft agent screenshot out.png
//
// --port picks a different game, for when two are running.
import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);

function flag(name, fallback = null) {
  const at = args.indexOf(`--${name}`);
  if (at === -1) return fallback;
  const value = args[at + 1];
  args.splice(at, value === undefined ? 1 : 2);
  return value === undefined ? true : value;
}

function bool(name) {
  const at = args.indexOf(`--${name}`);
  if (at === -1) return false;
  args.splice(at, 1);
  return true;
}

const port = Number(flag("port", process.env.TERMINAL_MINCERAFT_PORT || 25585));
const base = `http://127.0.0.1:${port}`;
const pretty = !bool("raw");

async function call(action, params = {}, timeout = 20000) {
  let res;
  try {
    res = await fetch(`${base}/agent/command`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, args: params, timeout }),
    });
  } catch (e) {
    fail(`no game answering on ${base}. Start one with: terminal-minceraft --agent`);
  }
  const body = await res.json();
  if (body.ok === false) fail(body.error || "the game refused that");
  return body.value;
}

function fail(message) {
  process.stderr.write(`terminal-minceraft agent: ${message}\n`);
  process.exit(1);
}

function show(value) {
  process.stdout.write(JSON.stringify(value, null, pretty ? 2 : 0) + "\n");
}

const command = args.shift();

switch (command) {
  case "status": {
    const res = await fetch(`${base}/agent/status`).catch(() => null);
    if (!res) fail(`no game answering on ${base}. Start one with: terminal-minceraft --agent`);
    show(await res.json());
    break;
  }

  case "observe": {
    const opts = {};
    if (bool("blocks")) opts.blocks = { radius: Number(flag("block-radius", 3)), height: 3 };
    const radius = flag("radius");
    if (radius) opts.radius = Number(radius);
    show(await call("observe", opts));
    break;
  }

  case "move": {
    const direction = args.shift();
    const seconds = Number(args.shift() || 0.5);
    show(await call("move", {
      direction, seconds,
      sprint: bool("sprint"), sneak: bool("sneak"), jump: bool("jump"),
    }, seconds * 1000 + 15000));
    break;
  }

  case "look": {
    const yaw = flag("yaw"), pitch = flag("pitch");
    const dyaw = flag("dyaw"), dpitch = flag("dpitch");
    show(await call("look", yaw !== null || pitch !== null
      ? { yaw: yaw === null ? undefined : Number(yaw), pitch: pitch === null ? undefined : Number(pitch) }
      : { dyaw: Number(dyaw || 0), dpitch: Number(dpitch || 0) }));
    break;
  }

  case "look-at": {
    const [x, y, z] = args.splice(0, 3).map(Number);
    show(await call("look_at", { x, y, z }));
    break;
  }

  case "jump": show(await call("jump")); break;

  case "mine": {
    const seconds = Number(args.shift() || 1);
    show(await call("mine", { seconds }, seconds * 1000 + 15000));
    break;
  }

  case "use": {
    const seconds = Number(args.shift() || 0);
    show(await call("use", { seconds }, seconds * 1000 + 15000));
    break;
  }

  case "slot": show(await call("select_slot", { slot: Number(args.shift()) })); break;
  case "say": show(await call("chat", { text: args.join(" ") })); break;
  case "stop": show(await call("stop")); break;

  case "screenshot": {
    const out = args.shift() || "screenshot.png";
    const state = await call("observe", { screenshot: true }, 20000);
    if (!state.screenshot) fail("the page returned no image");
    writeFileSync(out, Buffer.from(state.screenshot.split(",")[1], "base64"));
    process.stdout.write(`${out}\n`);
    break;
  }

  case "raw": {
    // An escape hatch, for trying an action the CLI has no verb for yet.
    const action = args.shift();
    show(await call(action, JSON.parse(args.shift() || "{}")));
    break;
  }

  default:
    process.stdout.write(
      "Usage: terminal-minceraft agent <command>\n\n" +
      "  status                     is a game listening, and is a page attached\n" +
      "  observe [--blocks]         the world as json\n" +
      "  move <dir> <seconds>       forward, back, left, right; --sprint --jump --sneak\n" +
      "  look --yaw N --pitch N     turn to face a direction\n" +
      "  look --dyaw N --dpitch N   turn by an amount\n" +
      "  look-at <x> <y> <z>        point the crosshair at a block\n" +
      "  jump\n" +
      "  mine <seconds>             hold the left button\n" +
      "  use [seconds]              right click, which places and uses\n" +
      "  slot <1-9>                 pick a hotbar slot\n" +
      "  say <text>                 send a chat message\n" +
      "  stop                       release every held key and button\n" +
      "  screenshot [path.png]      what the game is drawing right now\n" +
      "  raw <action> <json>        send an action straight through\n\n" +
      "  --port <n>                 which game, when more than one is running\n"
    );
    process.exit(command ? 2 : 0);
}
