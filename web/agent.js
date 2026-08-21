// terminal-minceraft: the game's half of the agent interface.
//
// web/serve.mjs injects this next to look.js when the launcher is started with
// --agent. It gives whatever is on the other end of the loopback control server
// the two things a player has: something to see with, and something to act with.
//
//   observe()  reads the live game state out of EaglerForge's ModAPI and
//              returns compact JSON
//   act(cmd)   presses keys, moves the mouse and clicks, the same events a
//              human's keyboard and mouse produce
//
// Commands arrive by long poll rather than a socket, because the server is a
// dependency free node script and a held GET is the smallest thing that works.
"use strict";
(function () {
  var params = new URLSearchParams(location.search);
  if (!params.has("agent")) return;

  var api = {};              // window.terminalMinceraftAgent
  var lastError = null;

  // ---- keeping a frame readable -------------------------------------------
  // WebGL throws the drawing buffer away once it has been composited, so
  // canvas.toDataURL() outside the drawing call returns a black image. Asking
  // for the buffer to be preserved costs a little speed and is the only way to
  // read a frame whenever the agent wants one rather than only during a paint.
  // It only happens when an agent is attached.
  var realGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, attrs) {
    if (type === "webgl" || type === "webgl2" || type === "experimental-webgl") {
      attrs = Object.assign({}, attrs || {}, { preserveDrawingBuffer: true });
    }
    return realGetContext.call(this, type, attrs);
  };

  // ---- reaching the game --------------------------------------------------
  // ModAPI is EaglerForge's bridge into the TeaVM heap. Asking for player and
  // world here means it keeps those proxies refreshed on every player tick,
  // which is what makes an observation cheap later.
  function modapi() {
    return typeof globalThis.ModAPI === "object" ? globalThis.ModAPI : null;
  }

  var required = false;
  function ensureRequired() {
    var M = modapi();
    if (!M || required || typeof M.require !== "function") return;
    M.require("player");
    M.require("world");
    required = true;
  }

  // Java strings are char arrays in TeaVM, so anything read out of the heap has
  // to come back through their decoder before it is a string here.
  function jstr(v) {
    var M = modapi();
    try {
      if (v === null || v === undefined) return null;
      if (typeof v === "string") return v;
      if (M && M.util && M.util.unstring) return M.util.unstring(v.getRef ? v.getRef() : v);
    } catch (e) {}
    return null;
  }

  function num(v, digits) {
    if (typeof v !== "number" || !isFinite(v)) return null;
    var p = Math.pow(10, digits === undefined ? 2 : digits);
    return Math.round(v * p) / p;
  }

  // Yaw out of Minecraft grows without bound as you spin. Normalising it to
  // -180..180 is what makes "turn to face 90" a sentence an agent can act on.
  function wrapYaw(y) {
    if (typeof y !== "number") return null;
    y = ((y + 180) % 360 + 360) % 360 - 180;
    return Math.round(y * 100) / 100;
  }

  // Everything below was worked out by reading the heap of a running game
  // rather than from documentation, because there is none. The names are what
  // TeaVM emitted: a Java enum keeps its name in $name2, an ArrayList keeps its
  // length in $size0, and a field that collided with a method got a digit.
  function classOf(ref) {
    try { return ref.constructor.$meta.name; } catch (e) { return null; }
  }

  function enumName(e) {
    try { return jstr(e.getRef ? e.getRef().$name2 : e.$name2); } catch (x) { return null; }
  }

  function listSize(list) {
    try { return list.size0 || 0; } catch (e) { return 0; }
  }

  function method(name) {
    var M = modapi();
    return M && M.hooks && M.hooks.methods ? M.hooks.methods[name] : null;
  }

  var blockPosCtor = null;
  function blockPos(x, y, z) {
    var M = modapi();
    if (!blockPosCtor) {
      // Six constructors, and the one that takes three ints is the second.
      blockPosCtor = M.hooks._classMap[M.util.getCompiledName("net.minecraft.util.BlockPos")]
        .constructors[1];
    }
    return blockPosCtor(x, y, z);
  }

  function itemInfo(stack) {
    if (!stack) return null;
    try {
      var ref = stack.getRef ? stack.getRef() : stack;
      var item = ref.$item;
      // TeaVM appends a digit when a field name collided during compilation, so
      // Item.unlocalizedName came out as $unlocalizedName1 and Item.block as
      // $block0. A block held in the hand is an ItemBlock whose own name is
      // empty, and the name worth showing belongs to the block behind it.
      var name = null;
      if (item) {
        if (item.$block0) name = jstr(item.$block0.$unlocalizedName);
        if (!name) name = jstr(item.$unlocalizedName1);
        if (!name) name = jstr(item.$unlocalizedName);
      }
      return {
        item: name ? String(name).replace(/^item\.|^tile\./, "") : "unknown",
        count: ref.$stackSize === undefined ? null : ref.$stackSize,
      };
    } catch (e) {
      return { item: "unknown", count: null };
    }
  }

  // ---- observe ------------------------------------------------------------
  function observe(opts) {
    opts = opts || {};
    ensureRequired();
    var M = modapi();
    var out = { ok: false, connected: !!M };
    if (!M) { out.error = "ModAPI is not on the page yet"; return out; }

    var mc = M.mcinstance ? M.mc : null;
    out.inGame = !!(M.player && mc && mc.theWorld);

    // The screen tells the agent whether its keys will reach the world or a
    // menu, which is the difference between walking and typing into a text box.
    try {
      var screen = mc && mc.currentScreen ? mc.currentScreen.getRef() : null;
      out.screen = screen ? (screen.constructor && screen.constructor.$meta
        ? screen.constructor.$meta.name : "unknown") : null;
    } catch (e) { out.screen = null; }

    if (!out.inGame) {
      out.ok = true;
      out.hint = "no world loaded, the game is on a menu screen";
      return out;
    }

    try {
      var p = M.player;
      var getHealth = method("nme_EntityLivingBase_getHealth");
      out.player = {
        name: playerName(),
        x: num(p.posX), y: num(p.posY), z: num(p.posZ),
        yaw: wrapYaw(p.rotationYaw),
        pitch: num(p.rotationPitch),
        onGround: !!p.onGround,
        health: getHealth ? num(getHealth(p.getRef()), 1) : null,
        food: p.getRef().$foodStats ? p.getRef().$foodStats.$foodLevel0 : null,
        inWater: !!p.inWater,
      };
    } catch (e) { out.error = "player: " + e; }

    try {
      var inv = M.player.inventory;
      var hotbar = [];
      for (var i = 0; i < 9; i++) {
        hotbar.push(itemInfo(inv.mainInventory[i]));
      }
      out.hotbar = hotbar;
      out.selectedSlot = inv.currentItem;
      out.holding = hotbar[inv.currentItem];
    } catch (e) { out.hotbar = null; }

    // What the crosshair is on. This is the single most useful field: mining
    // and placing both act on whatever this says.
    try {
      var hit = mc.objectMouseOver;
      if (!hit) out.target = null;
      else {
        var kind = enumName(hit.typeOfHit);
        var t = { type: kind ? String(kind).toLowerCase() : "unknown" };
        if (t.type === "block" && hit.blockPos) {
          t.block = {
            x: hit.blockPos.x, y: hit.blockPos.y, z: hit.blockPos.z,
            name: blockNameAt(hit.blockPos.x, hit.blockPos.y, hit.blockPos.z),
          };
          t.side = enumName(hit.sideHit);
        }
        if (hit.entityHit) t.entity = entityLabel(hit.entityHit);
        out.target = t;
      }
    } catch (e) { out.target = null; }

    try { out.entities = nearbyEntities(opts.radius || 24); } catch (e) { out.entities = null; }
    try { out.world = worldInfo(); } catch (e) { out.world = null; }
    if (opts.blocks) { try { out.blocks = blockScan(opts.blocks); } catch (e) {} }
    if (opts.screenshot) { try { out.screenshot = shot(); } catch (e) {} }

    out.ok = true;
    return out;
  }

  function blockNameAt(x, y, z) {
    var M = modapi();
    try {
      var get = method("nmw_World_getBlockState");
      var state = get(M.mc.theWorld.getRef(), blockPos(x, y, z));
      // Going through IBlockState.getBlock() looks right and never returns:
      // it is an interface call, and TeaVM compiles those to suspending
      // functions that hand control back to the scheduler. The field behind
      // the interface is right there and is not suspending.
      if (!state || !state.$block) return null;
      return String(jstr(state.$block.$unlocalizedName) || "").replace(/^tile\./, "") || null;
    } catch (e) {
      return null;
    }
  }

  // A small box of block names around the player, so an agent can tell a wall
  // from a doorway without reading pixels. Kept coarse on purpose: this is for
  // orientation, not for mapping.
  function blockScan(spec) {
    var M = modapi();
    var r = Math.max(1, Math.min(8, spec.radius || 3));
    var h = Math.max(1, Math.min(6, spec.height || 3));
    var px = Math.floor(M.player.posX), py = Math.floor(M.player.posY), pz = Math.floor(M.player.posZ);
    var found = {};
    for (var dx = -r; dx <= r; dx++) {
      for (var dz = -r; dz <= r; dz++) {
        for (var dy = -1; dy < h; dy++) {
          var name = blockNameAt(px + dx, py + dy, pz + dz);
          if (!name || name === "air") continue;
          (found[name] || (found[name] = [])).push([px + dx, py + dy, pz + dz]);
        }
      }
    }
    // Report the nearest few of each kind rather than every block, which keeps
    // the observation small enough to read.
    var out = {};
    Object.keys(found).forEach(function (k) {
      out[k] = found[k]
        .sort(function (a, b) { return dist2(a, px, py, pz) - dist2(b, px, py, pz); })
        .slice(0, 4);
    });
    return { origin: [px, py, pz], radius: r, height: h, blocks: out };
  }

  function dist2(a, x, y, z) {
    return (a[0] - x) * (a[0] - x) + (a[1] - y) * (a[1] - y) + (a[2] - z) * (a[2] - z);
  }

  function playerName() {
    var M = modapi();
    try { return jstr(M.mc.getRef().$session0.$profile.$name3); } catch (e) { return null; }
  }

  // Other players carry a GameProfile. Everything else is named by its class,
  // which is enough for an agent to tell a cow from a creeper.
  function entityLabel(e) {
    try {
      var ref = e.getRef ? e.getRef() : e;
      if (ref.$gameProfile) return jstr(ref.$gameProfile.$name3);
      var cls = classOf(ref) || "";
      return cls.split(".").pop().replace(/^Entity/, "") || null;
    } catch (x) { return null; }
  }

  function isPlayer(ref) {
    var cls = classOf(ref) || "";
    return cls.indexOf("EntityPlayer") !== -1 || cls.indexOf("EntityOtherPlayer") !== -1;
  }

  function nearbyEntities(radius) {
    var M = modapi();
    var list = M.mc.theWorld.loadedEntityList;
    var size = listSize(list);
    var me = M.player, meRef = me.getRef(), out = [];
    for (var i = 0; i < size; i++) {
      var e = list.get(i);
      if (!e || !e.getRef || e.getRef() === meRef) continue;
      var dx = e.posX - me.posX, dy = e.posY - me.posY, dz = e.posZ - me.posZ;
      var d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d > radius) continue;
      var ref = e.getRef();
      out.push({
        kind: isPlayer(ref) ? "player"
          : String(classOf(ref) || "unknown").split(".").pop().replace(/^Entity/, ""),
        name: entityLabel(e),
        x: num(e.posX), y: num(e.posY), z: num(e.posZ),
        distance: num(d, 1),
        // Where to turn to look at it, so the agent does not have to do
        // trigonometry to find another player.
        yaw: wrapYaw(Math.atan2(-dx, dz) * 180 / Math.PI),
      });
    }
    return out.sort(function (a, b) { return a.distance - b.distance; }).slice(0, 12);
  }

  function worldInfo() {
    var M = modapi();
    var w = M.mc.theWorld;
    var getTime = method("nmw_World_getWorldTime");
    var raw = getTime ? getTime(w.getRef()) : null;
    // TeaVM longs arrive as {lo, hi}. World time fits in the low word for any
    // world anyone will play in a demo.
    var t = null;
    if (typeof raw === "number") t = raw;
    else if (raw && typeof raw === "object" && "lo" in raw) t = raw.lo;
    else if (raw !== null && raw !== undefined) {
      var parsed = Number(String(raw));
      t = isFinite(parsed) ? parsed : null;
    }
    var players = [];
    try {
      var ps = w.playerEntities, n = listSize(ps);
      for (var i = 0; i < n; i++) {
        var label = entityLabel(ps.get(i));
        if (label) players.push(label);
      }
    } catch (e) { players = null; }
    return {
      time: t,
      daytime: t === null ? null : (t % 24000) < 12000,
      // The host of a shared world is still running the integrated server, so
      // the client's own singleplayer flag stays true and says nothing useful
      // about whether anyone else is here. The player list does.
      players: players,
      multiplayer: Array.isArray(players) ? players.length > 1 : null,
      hostingWorld: !!M.mc.isSingleplayer,
    };
  }

  function shot() {
    var c = document.querySelector("canvas");
    if (!c) return null;
    // preserveDrawingBuffer is off, so the buffer is only intact inside a frame
    // callback. The game paints constantly, so the last painted frame is what
    // the terminal is showing anyway.
    try {
      return c.toDataURL("image/png");
    } catch (e) {
      return null;
    }
  }

  // ---- act ----------------------------------------------------------------
  // Keys go in as real KeyboardEvents on the window, which is where the client
  // listens, so the game cannot tell them apart from a keyboard. Holding is a
  // keydown now and a keyup later, exactly like a finger.
  var KEYS = {
    forward: "KeyW", back: "KeyS", left: "KeyA", right: "KeyD",
    jump: "Space", sneak: "ShiftLeft", sprint: "ControlLeft",
    inventory: "KeyE", drop: "KeyQ", chat: "KeyT",
  };
  var CODE_TO_KEY = {
    KeyW: "w", KeyS: "s", KeyA: "a", KeyD: "d", Space: " ",
    ShiftLeft: "Shift", ControlLeft: "Control", KeyE: "e", KeyQ: "q", KeyT: "t",
    Enter: "Enter", Escape: "Escape",
  };
  var KEYCODES = {
    KeyW: 87, KeyS: 83, KeyA: 65, KeyD: 68, Space: 32, ShiftLeft: 16,
    ControlLeft: 17, KeyE: 69, KeyQ: 81, KeyT: 84, Enter: 13, Escape: 27,
  };

  var held = Object.create(null);

  function keyEvent(type, code) {
    var init = {
      code: code,
      key: CODE_TO_KEY[code] || code,
      keyCode: KEYCODES[code] || 0,
      which: KEYCODES[code] || 0,
      bubbles: true,
      cancelable: true,
      shiftKey: !!held.ShiftLeft,
      ctrlKey: !!held.ControlLeft,
    };
    var target = document.querySelector("canvas") || document.body;
    var ev = new KeyboardEvent(type, init);
    window.dispatchEvent(ev);
    target.dispatchEvent(new KeyboardEvent(type, init));
  }

  function keyDown(code) { if (!held[code]) { held[code] = true; keyEvent("keydown", code); } }
  function keyUp(code) { if (held[code]) { held[code] = false; keyEvent("keyup", code); } }

  function releaseAll() {
    Object.keys(held).forEach(function (c) { keyUp(c); });
    mouseUp("left"); mouseUp("right");
  }

  var BUTTONS = { left: 0, middle: 1, right: 2 };
  var mouseHeld = {};

  function mouseEvent(type, button) {
    var c = document.querySelector("canvas") || document.body;
    var box = c.getBoundingClientRect ? c.getBoundingClientRect() : { left: 0, top: 0, width: 0, height: 0 };
    var ev = new MouseEvent(type, {
      bubbles: true, cancelable: true, view: window,
      button: BUTTONS[button], buttons: type === "mousedown" ? (button === "right" ? 2 : 1) : 0,
      clientX: box.left + box.width / 2,
      clientY: box.top + box.height / 2,
    });
    c.dispatchEvent(ev);
  }

  function mouseDown(button) {
    if (mouseHeld[button]) return;
    mouseHeld[button] = true;
    mouseEvent("mousedown", button);
  }
  function mouseUp(button) {
    if (!mouseHeld[button]) return;
    mouseHeld[button] = false;
    mouseEvent("mouseup", button);
  }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  // Look reuses the shim look.js already installs, which turns a delta into the
  // relative mouse movement the game reads. Turning is done as a closed loop:
  // nudge, read the yaw that came back, nudge again. Open loop would need the
  // player's mouse sensitivity as a constant, and this way the setting can be
  // anything.

  // Worked out at run time by nudging the mouse and measuring the yaw that
  // came back, because it depends on the player's sensitivity setting.
  var YAW_PER_PIXEL = 0.15;
  var calibrated = false;

  function calibrate() {
    var M = modapi();
    if (calibrated || !M || !M.player || !window.terminalMinceraft) return Promise.resolve();
    var before = M.player.rotationYaw;
    window.terminalMinceraft.look(40, 0);
    return sleep(60).then(function () {
      var after = M.player.rotationYaw;
      var d = after - before;
      if (Math.abs(d) > 0.01) {
        YAW_PER_PIXEL = d / 40;
        calibrated = true;
      }
      window.terminalMinceraft.look(-40, 0);
      return sleep(60);
    });
  }

  function lookTo(yaw, pitch) {
    var M = modapi();
    if (!M || !M.player) return Promise.reject(new Error("no player"));
    return calibrate().then(function () {
      return turnLoop(yaw, pitch, 40);
    });
  }

  function turnLoop(yaw, pitch, budget) {
    var M = modapi();
    var p = M.player;
    var dy = yaw === null || yaw === undefined ? 0 : shortestTurn(p.rotationYaw, yaw);
    var dp = pitch === null || pitch === undefined ? 0 : pitch - p.rotationPitch;
    if ((Math.abs(dy) < 1.2 && Math.abs(dp) < 1.2) || budget <= 0) return Promise.resolve();
    var stepYaw = Math.max(-25, Math.min(25, dy));
    var stepPitch = Math.max(-25, Math.min(25, dp));
    window.terminalMinceraft.look(stepYaw / YAW_PER_PIXEL, stepPitch / YAW_PER_PIXEL);
    return sleep(20).then(function () { return turnLoop(yaw, pitch, budget - 1); });
  }

  function shortestTurn(from, to) {
    return ((to - from + 540) % 360) - 180;
  }

  function chat(text) {
    var M = modapi();
    // The client sends chat through the player entity, which is the same call
    // the chat box makes when you press enter.
    var method = M.hooks.methods["nmce_EntityPlayerSP_sendChatMessage"];
    if (!method) throw new Error("chat method is missing");
    method(M.player.getRef(), M.util.string(String(text).slice(0, 100)));
    return true;
  }

  var ACTIONS = {
    observe: function (a) { return observe(a); },

    move: function (a) {
      var dir = KEYS[a.direction];
      if (!dir) throw new Error("move needs forward, back, left or right");
      var ms = Math.max(0, Math.min(10000, (a.seconds || 0.5) * 1000));
      if (a.sprint) keyDown(KEYS.sprint);
      if (a.sneak) keyDown(KEYS.sneak);
      if (a.jump) keyDown(KEYS.jump);
      keyDown(dir);
      return sleep(ms).then(function () {
        keyUp(dir);
        if (a.jump) keyUp(KEYS.jump);
        if (a.sneak) keyUp(KEYS.sneak);
        if (a.sprint) keyUp(KEYS.sprint);
        return { moved: a.direction, seconds: ms / 1000 };
      });
    },

    look: function (a) {
      if (a.yaw !== undefined || a.pitch !== undefined) {
        return lookTo(a.yaw, a.pitch).then(function () {
          var p = modapi().player;
          return { yaw: wrapYaw(p.rotationYaw), pitch: num(p.rotationPitch) };
        });
      }
      var M = modapi();
      var target = {
        yaw: wrapYaw(M.player.rotationYaw + (a.dyaw || 0)),
        pitch: Math.max(-90, Math.min(90, M.player.rotationPitch + (a.dpitch || 0))),
      };
      return lookTo(target.yaw, target.pitch).then(function () {
        var p = modapi().player;
        return { yaw: wrapYaw(p.rotationYaw), pitch: num(p.rotationPitch) };
      });
    },

    look_at: function (a) {
      var M = modapi();
      var p = M.player;
      // observe reports block positions as the integer corner, so the middle of
      // the block is half a step along every axis. Aiming at the corner points
      // the ray down an edge, which from close up picks the neighbour or
      // misses entirely.
      var dx = (a.x + 0.5) - p.posX,
          dy = (a.y + 0.5) - (p.posY + 1.62),
          dz = (a.z + 0.5) - p.posZ;
      var yaw = Math.atan2(-dx, dz) * 180 / Math.PI;
      var pitch = -Math.atan2(dy, Math.sqrt(dx * dx + dz * dz)) * 180 / Math.PI;
      return lookTo(wrapYaw(yaw), pitch).then(function () {
        return { yaw: wrapYaw(p.rotationYaw), pitch: num(p.rotationPitch) };
      });
    },

    jump: function () {
      keyDown(KEYS.jump);
      return sleep(120).then(function () { keyUp(KEYS.jump); return { jumped: true }; });
    },

    mine: function (a) {
      var ms = Math.max(50, Math.min(15000, (a.seconds || 1) * 1000));
      mouseDown("left");
      return sleep(ms).then(function () {
        mouseUp("left");
        return { mined: ms / 1000, target: observe({}).target };
      });
    },

    use: function (a) {
      var ms = Math.max(0, Math.min(5000, (a.seconds || 0) * 1000));
      mouseDown("right");
      return sleep(ms || 90).then(function () {
        mouseUp("right");
        return { used: true, target: observe({}).target };
      });
    },

    select_slot: function (a) {
      var n = Math.max(1, Math.min(9, a.slot | 0));
      modapi().player.inventory.currentItem = n - 1;
      return { selectedSlot: n - 1 };
    },

    chat: function (a) { return { sent: chat(a.text) }; },

    key: function (a) {
      var code = KEYS[a.name] || a.name;
      var ms = Math.max(0, Math.min(10000, (a.seconds || 0.08) * 1000));
      keyDown(code);
      return sleep(ms).then(function () { keyUp(code); return { key: code }; });
    },

    stop: function () { releaseAll(); return { released: true }; },

  };

  function run(cmd) {
    var fn = ACTIONS[cmd.action];
    if (!fn) return Promise.reject(new Error("no action called " + cmd.action));
    // The channel is one command at a time, so an action that never finishes
    // would take the whole interface with it. Nothing here should run for
    // more than a few seconds beyond what it was asked for.
    var budget = ((cmd.args && cmd.args.seconds) || 0) * 1000 + 20000;
    var timer = null;
    var guard = new Promise(function (_, reject) {
      timer = setTimeout(function () {
        releaseAll();
        reject(new Error(cmd.action + " did not finish, keys released"));
      }, budget);
    });
    // Promise.race settles, it does not cancel, so the losing timer keeps
    // running unless it is cleared. Leaving it set meant every quick observe
    // armed a releaseAll twenty seconds into the future, which would land in
    // the middle of whatever the agent was doing by then and let go of the
    // keys under it.
    return Promise.race([
      Promise.resolve().then(function () { return fn(cmd.args || {}); }),
      guard,
    ]).then(function (value) {
      clearTimeout(timer);
      return value;
    }, function (err) {
      clearTimeout(timer);
      throw err;
    });
  }

  // ---- the control channel ------------------------------------------------
  // A held GET that the server answers when someone asks for something, then a
  // POST with the answer. Two plain requests, no socket, no dependency.
  var stopped = false;

  function pump() {
    if (stopped) return;
    fetch("/agent/poll", { cache: "no-store" })
      .then(function (r) { return r.status === 200 ? r.json() : null; })
      .then(function (cmd) {
        if (!cmd || !cmd.id) return;
        return run(cmd)
          .then(function (value) { return { id: cmd.id, ok: true, value: value }; })
          .catch(function (e) { return { id: cmd.id, ok: false, error: String(e && e.message || e) }; })
          .then(function (result) {
            return fetch("/agent/result", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(result),
            });
          });
      })
      .catch(function (e) { lastError = String(e); })
      .then(function () { setTimeout(pump, 5); });
  }

  api.observe = observe;
  api.run = run;
  api.state = function () { return { required: required, yawPerPixel: YAW_PER_PIXEL, lastError: lastError }; };
  window.terminalMinceraftAgent = api;

  // ModAPI only starts keeping the player and world proxies fresh once someone
  // has asked for them, and it does that on the next player tick. Asking as
  // soon as ModAPI exists means the first observation is a real one rather
  // than an empty one that teaches the agent the world is not loaded.
  var waitForModApi = setInterval(function () {
    ensureRequired();
    if (required) clearInterval(waitForModApi);
  }, 500);

  window.addEventListener("beforeunload", function () { stopped = true; releaseAll(); });
  pump();
  console.log("[terminal-minceraft] agent interface listening");
})();
