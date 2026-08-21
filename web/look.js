// terminal-eaglercraft: the wrapper's half of the game.
//
// web/serve.mjs injects this into the client's <head>, after the client sets
// its launch options and before its bundle runs. It is the only place the
// wrapper touches the game, and everything it does is here:
//
//   1. launch options, so the game stays on your machine
//   2. gets past EaglerForge's mod manager, which otherwise holds the launch
//   3. gives the game a pointer lock it can believe in, because an offscreen
//      chromium in a terminal pane has no cursor to lock
//   4. turns arrow keys into relative mouse movement, which is what Minecraft
//      reads for look, so the game is playable from a keyboard alone
//   5. taps the game's audio, so a recording can have Minecraft in it
//   6. exposes window.terminalEaglercraft, so the capture harness can ask how
//      the game is doing instead of reading the screen
"use strict";
(function () {
  var params = new URLSearchParams(location.search);

  // ---- 1. launch options --------------------------------------------------
  // The client reads window.eaglercraftXOpts once, on the way into main(). The
  // three switched off here are the only things it does over the network on its
  // own: an update check, an update download, and asking the relays whether
  // they have heard of a newer client. Off, a singleplayer game touches nothing
  // outside your machine. The relay list is left alone, because that is what
  // shared worlds are signalled through, and it is only used when you ask for
  // one.
  var opts = window.eaglercraftXOpts || (window.eaglercraftXOpts = {});
  if (!params.has("phonehome")) {
    opts.allowUpdateSvc = false;
    opts.allowUpdateDL = false;
    opts.checkRelaysForUpdates = false;
  }
  if (params.get("relay")) {
    opts.relays = [{ addr: params.get("relay"), comment: "terminal-eaglercraft", primary: true }];
  }

  // ---- 2. the mod manager -------------------------------------------------
  // This build carries EaglerForge, whose mod manager covers the whole game on
  // every launch and holds the launch until someone presses Done.
  //
  // The obvious move, removing the panel the way its own Done button does, is
  // wrong twice over. The manager keeps filling the panel in after it opens, so
  // writing innerHTML into a node that is gone throws inside a promise and takes
  // the rest of the launch with it. And the launch is not the removal: it is a
  // mousedown listener on that button, which calls the continuation the client
  // handed the manager on the way in. Miss it and the pane stays black for ever.
  //
  // So the panel is hidden with a stylesheet, and then pressed. Pass ?mods=1 to
  // see it and press it yourself.
  if (!params.has("mods")) {
    var hide = document.createElement("style");
    hide.textContent = "#modapi_gui_container{display:none !important}";
    document.documentElement.appendChild(hide);

    // The button exists before its listener does, because the manager awaits the
    // mod list in between. Pressing twice is harmless, the manager guards the
    // callback, so the simplest correct thing is to keep pressing until the
    // panel takes itself away.
    var tries = 0;
    var press = setInterval(function () {
      if (++tries > 600) return clearInterval(press);
      var gui = document.getElementById("modapi_gui_container");
      if (!gui) return;
      var done = gui.querySelector("._doneButton");
      if (done) done.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    }, 100);
  }

  // ---- 3. pointer lock ----------------------------------------------------
  // The game gates look on document.pointerLockElement and asks for the lock
  // with canvas.requestPointerLock(). Neither works in an offscreen window, so
  // the lock is kept here instead: same API, same events, no cursor involved.
  var locked = null;
  var canvas = null;

  function fire(type) {
    var ev = document.createEvent("Event");
    ev.initEvent(type, true, false);
    document.dispatchEvent(ev);
  }

  try {
    Object.defineProperty(document, "pointerLockElement", {
      configurable: true,
      get: function () { return locked; },
    });
    Element.prototype.requestPointerLock = function () {
      locked = this;
      canvas = this;
      fire("pointerlockchange");
    };
    document.exitPointerLock = function () {
      locked = null;
      fire("pointerlockchange");
    };
  } catch (e) {
    console.error("[terminal-eaglercraft] pointer lock shim failed", e);
  }

  // ---- 4. arrow keys as mouse movement ------------------------------------
  var LOOK_KEYS = {
    ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1],
  };
  // Pixels of mouse movement per second at full tilt. Minecraft multiplies this
  // by the in-game sensitivity, so it is a starting point, not the last word.
  //
  // Per second, not per frame. Per frame is the obvious way to write it and it
  // makes the game turn twice as fast on a machine that renders twice as fast,
  // which is a strange thing to discover halfway through a recording.
  var SPEED = Number(params.get("look")) || 520;
  // Look ramps up over a fifth of a second, so a tap nudges and a hold sweeps,
  // which is the nearest a keyboard gets to the feel of a mouse.
  var RAMP = 0.18;

  function target() {
    return locked || canvas || document.querySelector("canvas") || document.body;
  }

  function look(dx, dy) {
    var el = target();
    if (!el) return;
    var box = el.getBoundingClientRect
      ? el.getBoundingClientRect()
      : { left: 0, top: 0, width: 0, height: 0 };
    // Chromium honours movementX and movementY from the MouseEvent init dict,
    // and the game adds them straight onto the look it has accumulated since
    // the last frame, which is the same arithmetic a real mouse lands in.
    var ev = new MouseEvent("mousemove", {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: box.left + box.width / 2,
      clientY: box.top + box.height / 2,
      movementX: dx,
      movementY: dy,
    });
    ev.__terminalEaglercraft = true;
    el.dispatchEvent(ev);
  }

  var held = Object.create(null);
  var ramp = 0;
  var running = false;
  var lastFrame = 0;

  function tick(now) {
    // A frame longer than an eighth of a second is a stall, not movement, and
    // paying it out as look would throw the camera across the sky.
    var dt = Math.min(0.125, lastFrame ? (now - lastFrame) / 1000 : 1 / 60);
    lastFrame = now;

    var dx = 0, dy = 0;
    for (var k in held) {
      if (!held[k]) continue;
      dx += LOOK_KEYS[k][0];
      dy += LOOK_KEYS[k][1];
    }
    if (dx || dy) {
      ramp = Math.min(1, ramp + dt / RAMP);
      look(dx * SPEED * ramp * dt, dy * SPEED * ramp * dt);
      requestAnimationFrame(tick);
    } else {
      ramp = 0;
      running = false;
      lastFrame = 0;
    }
  }

  window.addEventListener("keydown", function (e) {
    if (!(e.key in LOOK_KEYS)) return;
    e.preventDefault();
    e.stopPropagation();
    held[e.key] = true;
    if (!running) { running = true; lastFrame = 0; requestAnimationFrame(tick); }
  }, true);

  window.addEventListener("keyup", function (e) {
    if (!(e.key in LOOK_KEYS)) return;
    e.preventDefault();
    e.stopPropagation();
    held[e.key] = false;
  }, true);

  // terminal-browser works out movementX itself, from the distance between the
  // last two cells it sent, so a real mouse drag needs nothing from here. This
  // only covers a move that arrived without the movement fields filled in.
  var last = null;
  window.addEventListener("mousemove", function (e) {
    if (e.__terminalEaglercraft) return;
    if (!locked) { last = null; return; }
    if (!e.movementX && !e.movementY && last) {
      var dx = e.clientX - last.x, dy = e.clientY - last.y;
      if (dx || dy) look(dx, dy);
    }
    last = { x: e.clientX, y: e.clientY };
  }, true);

  // ---- 5. the audio tap ---------------------------------------------------
  // Only with ?capture=1, so a normal game never does any of this. The machine
  // that records this has no audio device to record from, so the sound is taken
  // from inside the page: every node the game connects to its speakers is also
  // connected to a recorder, and the slices are posted back to the local server
  // as they land.
  var audio = { state: "off", contexts: 0 };
  if (params.has("capture") && window.AudioNode && window.MediaRecorder) {
    audio.state = "waiting";
    var connect = AudioNode.prototype.connect;
    var taps = new WeakMap();
    var recording = false;

    function tapFor(ctx) {
      var tap = taps.get(ctx);
      if (tap) return tap;
      tap = ctx.createMediaStreamDestination();
      taps.set(ctx, tap);
      audio.contexts++;
      // One recorder, ever. Two of them appending into the same file gives a
      // webm that stops decoding wherever the second one's header landed.
      if (recording) return tap;
      recording = true;

      // The game lets its audio context fall asleep between sounds, and a
      // sleeping context feeds the recorder nothing at all. What comes out is
      // every noise the game made with all the quiet removed, which lines up
      // with the video for exactly as long as the first silence. So the
      // context is kept awake, and a silent oscillator keeps samples flowing
      // into the tap even when nothing is playing.
      try {
        var keepAwake = setInterval(function () {
          if (ctx.state === "suspended") ctx.resume();
        }, 250);
        var silence = ctx.createOscillator();
        var quiet = ctx.createGain();
        quiet.gain.value = 0;
        silence.connect(quiet);
        connect.call(quiet, tap);
        silence.start();
        window.addEventListener("beforeunload", function () {
          clearInterval(keepAwake);
        });
      } catch (e) {
        audio.state = "keepalive failed: " + e;
      }
      try {
        var rec = new MediaRecorder(tap.stream, { mimeType: "audio/webm" });
        // Post each slice as it lands and let the server append them. Waiting
        // for onstop loses the whole recording, because the harness closes the
        // browser when the run ends.
        rec.ondataavailable = function (e) {
          if (e.data && e.data.size) fetch("/__audio", { method: "POST", body: e.data });
        };
        rec.start(400);
        // The server timestamps this, which is what lines the audio up with the
        // video frames afterwards.
        fetch("/__mark", { method: "POST" });
        audio.state = "recording";
        window.addEventListener("beforeunload", function () {
          try { rec.stop(); } catch (e) {}
        });
      } catch (e) {
        audio.state = "failed: " + e;
      }
      return tap;
    }

    AudioNode.prototype.connect = function (destination) {
      var out = connect.apply(this, arguments);
      try {
        if (destination && this.context && destination === this.context.destination) {
          // The node stays wired to the speakers as well. This only adds a
          // second listener on the same signal.
          connect.call(this, tapFor(this.context));
        }
      } catch (e) {
        audio.state = "failed: " + e;
      }
      return out;
    };
  }

  // ---- 6. a handle for the harness ---------------------------------------
  var frames = 0;
  var rAF = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = function (cb) {
    return rAF(function (t) { frames++; return cb(t); });
  };

  var started = Date.now();
  window.terminalEaglercraft = {
    // Non-zero once the game has painted, which means the bundle ran, chromium
    // gave it a GL context, and the terminal has something to draw.
    frames: function () { return frames; },
    fps: function () { return frames / ((Date.now() - started) / 1000); },
    resetFps: function () { frames = 0; started = Date.now(); },
    locked: function () { return !!locked; },
    audio: function () { return audio; },
    gl: function () {
      var c = document.querySelector("canvas");
      if (!c) return { error: "no canvas" };
      var gl = c.getContext("webgl2") || c.getContext("webgl");
      if (!gl) return { error: "no gl context" };
      var dbg = gl.getExtension("WEBGL_debug_renderer_info");
      return {
        w: c.width, h: c.height,
        version: gl.getParameter(gl.VERSION),
        renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
      };
    },
    look: look,
  };

  // ---- a readable overlay, for when the only debugger is a screenshot -----
  // With ?debug=1 the page prints what it is being told about the mouse and the
  // keyboard into the corner. On a machine with no display that is how you find
  // out whether an event arrived at all, and in whose coordinate system.
  if (params.has("debug")) {
    var log = document.createElement("div");
    log.style.cssText = "position:fixed;left:0;top:0;z-index:2147483647;background:#000c;" +
      "color:#0f0;font:13px ui-monospace,monospace;padding:4px 6px;white-space:pre;pointer-events:none";
    var lines = { size: "", move: "", button: "", key: "" };
    var draw = function () {
      lines.size = "page " + window.innerWidth + "x" + window.innerHeight +
        "  locked " + !!locked + "  fps " + window.terminalEaglercraft.fps().toFixed(0) +
        "  audio " + audio.state;
      log.textContent = [lines.size, lines.move, lines.button, lines.key].join("\n");
    };
    window.addEventListener("DOMContentLoaded", function () {
      document.body.appendChild(log);
      setInterval(draw, 500);
      draw();
    });
    window.addEventListener("mousemove", function (e) {
      if (e.__terminalEaglercraft) return;
      lines.move = "move  " + e.clientX + "," + e.clientY + "  d " + e.movementX + "," + e.movementY;
    }, true);
    ["mousedown", "mouseup"].forEach(function (t) {
      window.addEventListener(t, function (e) {
        lines.button = t + " " + e.button + " at " + e.clientX + "," + e.clientY;
      }, true);
    });
    window.addEventListener("keydown", function (e) { lines.key = "key   " + e.code; }, true);
  }
})();
