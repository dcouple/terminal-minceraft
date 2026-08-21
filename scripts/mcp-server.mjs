#!/usr/bin/env node
// terminal-minceraft: an MCP server, so an agent can play.
//
// Speaks MCP over stdio and turns each tool call into one command on the
// control layer that web/serve.mjs runs beside the game. Point Claude at it:
//
//   claude mcp add minceraft -- terminal-minceraft mcp
//
// It holds no game state of its own. The game is the state, this is a door.
// Written against the protocol directly rather than an SDK, because the rest
// of this repository has no dependencies and neither should this.
const PORT = Number(
  process.argv.includes("--port")
    ? process.argv[process.argv.indexOf("--port") + 1]
    : process.env.TERMINAL_MINCERAFT_PORT || 25585
);
const BASE = `http://127.0.0.1:${PORT}`;
const VERSION = "0.1.0";

// The version the client asks for is echoed back when we know it, because a
// client that gets an unexpected protocol version is entitled to give up.
const KNOWN_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];

const NOT_RUNNING =
  `No game is answering on ${BASE}.\n\n` +
  `Start one in a terminal that can draw images, then try again:\n` +
  `  terminal-minceraft --agent\n\n` +
  `If the game is on another port, start this server with --port <n>.`;

async function command(action, args = {}, timeout = 20000) {
  let res;
  try {
    res = await fetch(`${BASE}/agent/command`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, args, timeout }),
    });
  } catch {
    return { error: NOT_RUNNING };
  }
  const body = await res.json().catch(() => ({}));
  if (body.ok === false) return { error: body.error || "the game refused that" };
  return { value: body.value };
}

// ---- the vocabulary --------------------------------------------------------
// Deliberately small and orthogonal: the things a keyboard and a mouse do, and
// one way to look at the world. An agent composes these; it does not need a
// tool per situation.
const TOOLS = [
  {
    name: "observe",
    description:
      "Look at the world. Returns where the player is, which way it is facing, " +
      "health and hunger, the hotbar, the block the crosshair is on, and nearby " +
      "players and mobs with the compass bearing to turn to face each one. Call " +
      "this before acting and again after, the way you would glance at a screen.",
    inputSchema: {
      type: "object",
      properties: {
        blocks: {
          type: "boolean",
          description: "Also list the named blocks in a small box around the player. Useful for finding ground, walls and doorways.",
        },
        radius: { type: "number", description: "How far to look for entities, in blocks. Default 24." },
      },
    },
  },
  {
    name: "screenshot",
    description:
      "What the game is drawing right now, as an image. Structured state from " +
      "observe is better for deciding what to do; this is for the times when " +
      "seeing it settles the question.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "move",
    description:
      "Walk, by holding a movement key for a while. Direction is relative to " +
      "where the player is facing, so look first, then move.",
    inputSchema: {
      type: "object",
      properties: {
        direction: { type: "string", enum: ["forward", "back", "left", "right"] },
        seconds: { type: "number", description: "How long to hold the key. About 4 blocks a second walking. Default 0.5." },
        sprint: { type: "boolean" },
        jump: { type: "boolean", description: "Hold jump at the same time, which is how you get up a block or over water." },
        sneak: { type: "boolean" },
      },
      required: ["direction"],
    },
  },
  {
    name: "look",
    description:
      "Turn the head. Give yaw and pitch to face an absolute direction, or dyaw " +
      "and dpitch to turn by an amount. Yaw 0 faces south, 90 faces west, 180 " +
      "north, -90 east. Pitch -90 is straight up, 90 is straight down.",
    inputSchema: {
      type: "object",
      properties: {
        yaw: { type: "number" }, pitch: { type: "number" },
        dyaw: { type: "number" }, dpitch: { type: "number" },
      },
    },
  },
  {
    name: "look_at",
    description:
      "Point the crosshair at a block position. This is the reliable way to aim " +
      "at something you found with observe before mining or placing.",
    inputSchema: {
      type: "object",
      properties: { x: { type: "number" }, y: { type: "number" }, z: { type: "number" } },
      required: ["x", "y", "z"],
    },
  },
  {
    name: "jump",
    description: "Jump once.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "mine",
    description:
      "Hold the left mouse button, which breaks the block the crosshair is on " +
      "and attacks whatever is in front of you. Look at the block first. In " +
      "creative one moment is enough; in survival, dirt takes about a second and " +
      "stone rather longer.",
    inputSchema: {
      type: "object",
      properties: { seconds: { type: "number", description: "Default 1." } },
    },
  },
  {
    name: "use",
    description:
      "Right click, which places the held block, opens a door or chest, and eats " +
      "what you are holding. Look at where you want it first.",
    inputSchema: {
      type: "object",
      properties: { seconds: { type: "number", description: "Hold it down, for placing a run of blocks. Default is a single click." } },
    },
  },
  {
    name: "select_slot",
    description: "Choose a hotbar slot, 1 to 9. observe says what is in each one.",
    inputSchema: {
      type: "object",
      properties: { slot: { type: "number", minimum: 1, maximum: 9 } },
      required: ["slot"],
    },
  },
  {
    name: "chat",
    description:
      "Say something in chat, which everyone in the world sees. A message that " +
      "starts with a slash is a command, so /time set day works if the world " +
      "allows cheats.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
  },
  {
    name: "stop",
    description:
      "Release every held key and mouse button. Use this if the player seems to " +
      "be walking on its own, and at the end of a sequence.",
    inputSchema: { type: "object", properties: {} },
  },
];

const ACTION_FOR = {
  observe: "observe", screenshot: "observe", move: "move", look: "look",
  look_at: "look_at", jump: "jump", mine: "mine", use: "use",
  select_slot: "select_slot", chat: "chat", stop: "stop",
};

function text(value) {
  return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] };
}

function failure(message) {
  return { content: [{ type: "text", text: message }], isError: true };
}

async function callTool(name, args = {}) {
  const action = ACTION_FOR[name];
  if (!action) return failure(`There is no tool called ${name}.`);

  if (name === "screenshot") {
    const { value, error } = await command("observe", { screenshot: true });
    if (error) return failure(error);
    if (!value || !value.screenshot) return failure("The game returned no image. Is a world loaded?");
    return {
      content: [{
        type: "image",
        data: String(value.screenshot).split(",")[1],
        mimeType: "image/png",
      }],
    };
  }

  const seconds = Number(args.seconds) || 0;
  const { value, error } = await command(action, args, seconds * 1000 + 20000);
  if (error) return failure(error);
  return text(value);
}

// ---- MCP over stdio --------------------------------------------------------
function send(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

function reply(id, result) { send({ jsonrpc: "2.0", id, result }); }
function replyError(id, code, message) { send({ jsonrpc: "2.0", id, error: { code, message } }); }

async function handle(msg) {
  const { id, method, params } = msg;

  switch (method) {
    case "initialize": {
      const asked = params && params.protocolVersion;
      reply(id, {
        protocolVersion: KNOWN_PROTOCOLS.includes(asked) ? asked : KNOWN_PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "terminal-minceraft", version: VERSION },
        instructions:
          "You are playing Minecraft in a terminal. Call observe to see where you " +
          "are and what is around you, then act, then observe again. Coordinates " +
          "are Minecraft's: y is height, and yaw 0 faces south. To break or place " +
          "a block, look_at it first and check with observe that the crosshair is " +
          "really on it, then mine or use.",
      });
      return;
    }
    case "notifications/initialized":
    case "notifications/cancelled":
      return;
    case "ping":
      reply(id, {});
      return;
    case "tools/list":
      reply(id, { tools: TOOLS });
      return;
    case "tools/call": {
      const name = params && params.name;
      try {
        reply(id, await callTool(name, (params && params.arguments) || {}));
      } catch (err) {
        reply(id, failure(String(err && err.message ? err.message : err)));
      }
      return;
    }
    case "resources/list":
      reply(id, { resources: [] });
      return;
    case "prompts/list":
      reply(id, { prompts: [] });
      return;
    default:
      if (id !== undefined) replyError(id, -32601, `no method ${method}`);
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let cut;
  while ((cut = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, cut).trim();
    buffer = buffer.slice(cut + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    handle(msg).catch((err) => {
      if (msg && msg.id !== undefined) replyError(msg.id, -32603, String(err));
    });
  }
});
process.stdin.on("end", () => process.exit(0));
