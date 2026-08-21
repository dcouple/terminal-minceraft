#!/usr/bin/env python3
"""Play terminal-minceraft inside a pretend terminal and record what it paints.

terminal-browser draws by writing kitty graphics escape sequences to its
terminal, and reads the player's keys and mouse back off the same pipe. So a
program holding the other end of a pty can be the terminal: answer the
capability queries, keep the frames that arrive, and play the game.

That makes it possible to prove the whole thing works, boots, renders, takes
input, on a machine with no display, and to record the result without a screen
recorder.

    scripts/capture.py --out media --video demo.mp4 --seconds 60 \
        --still 20:title --key 4:space --click 30:0.5:0.79 \
        --hold 40:2.5:w -- bin/terminal-minceraft

Frames arrive as f=32 (RGBA) transfers pointing at a temp file, which is what
terminal-browser uses on macOS and Linux for speed.

This file started life in dcouple/terminal-doom. The mouse half is new, because
Minecraft needs a mouse and DOOM did not.
"""
import argparse
import base64
import fcntl
import os
import pty
import re
import select
import shutil
import signal
import struct
import subprocess
import sys
import termios
import time
import zlib

ESC = b"\x1b"

# kitty keyboard protocol: CSI number ; modifiers : event-type u, and for keys
# that have a legacy escape code, CSI 1 ; modifiers : event-type <final>.
PRESS, RELEASE = 1, 3
# Keys that have a legacy escape sequence keep it, in the CSI 1 ; mods : event
# form: the arrows, and F1 to F4.
LEGACY = {
    "up": b"A", "down": b"B", "right": b"C", "left": b"D",
    "home": b"H", "end": b"F",
    "f1": b"P", "f2": b"Q", "f3": b"R", "f4": b"S",
}
UNICODE = {
    "enter": 13, "return": 13, "esc": 27, "escape": 27, "space": 32,
    "tab": 9, "backspace": 127,
}
# Modifiers are functional keys in the protocol, and a real terminal reports the
# modifier as held in the same event that presses it.
MODIFIERS = {"ctrl": (57442, 5), "shift": (57441, 2), "alt": (57443, 3)}


# The modifiers field is a bitmask plus one: shift 1, alt 2, ctrl 4.
MOD_BITS = {"shift": 1, "alt": 2, "ctrl": 4}


def key_event(name, event):
    """One key press or release, in the kitty keyboard encoding.

    Takes a key name, or a combination written with pluses: ctrl+q, shift+w.
    """
    parts = name.lower().split("+")
    name, held = parts[-1], parts[:-1]
    mods = 1
    for part in held:
        if part not in MOD_BITS:
            raise SystemExit(f"capture: {part!r} is not a modifier")
        mods += MOD_BITS[part]

    if not held and name in MODIFIERS:
        code, mods = MODIFIERS[name]
        return b"%s[%d;%d:%du" % (ESC, code, mods, event)
    if name in LEGACY:
        return b"%s[1;%d:%d%s" % (ESC, mods, event, LEGACY[name])
    code = UNICODE.get(name)
    if code is None:
        if len(name) != 1:
            raise SystemExit(f"capture: don't know the key {name!r}")
        code = ord(name)
    return b"%s[%d;%d:%du" % (ESC, code, mods, event)


# SGR mouse reporting: CSI < button ; column ; row and then M for a press or m
# for a release, columns and rows counted from one.
#
# terminal-browser asks for CSI ?1016h, which is the pixel flavour of the same
# format, as well as CSI ?1006h. It reads cells regardless. Sending pixels gets
# you silence rather than an error, so the way to find this out is to send both
# and see which one the page notices.
BUTTONS = {"left": 0, "middle": 1, "right": 2}
# 32 is the motion bit and 3 is "no button", so 35 is the pointer moving on its
# own. A held drag reports 32 plus the button instead.
MOTION_IDLE = 35


def mouse_event(x, y, code, pressed):
    return b"%s[<%d;%d;%d%s" % (ESC, code, x, y, b"M" if pressed else b"m")


def write_png(path, width, height, rgba):
    """A PNG writer, so the harness needs nothing but the standard library."""
    raw = b"".join(
        b"\x00" + rgba[y * width * 4:(y + 1) * width * 4] for y in range(height)
    )

    def chunk(tag, data):
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(raw, 6))
    png += chunk(b"IEND", b"")
    with open(path, "wb") as fh:
        fh.write(png)


class FakeTerminal:
    """Enough of a terminal for terminal-browser to believe in it."""

    def __init__(self, cols, rows, cell_w, cell_h, home=None, capture_dir=None):
        self.cols, self.rows = cols, rows
        self.cell_w, self.cell_h = cell_w, cell_h
        self.width, self.height = cols * cell_w, rows * cell_h
        self.kbd_stack = [0]
        self.frame = None          # most recent RGBA bytes
        self.frame_size = None     # (w, h)
        self.frames_seen = 0
        self.pid = self.fd = None
        self.textlog = None
        self.home = home
        self.env = {}
        if capture_dir:
            # The page only taps the game's audio when it is told to, and this
            # is the telling. The server writes the sound and its start time
            # into the same directory the frames come out of.
            self.env["TERMINAL_MINCERAFT_CAPTURE_DIR"] = os.path.abspath(capture_dir)
        if home:
            # Everything terminal-browser reads a directory out of. The
            # profile is the obvious one, but the daemon socket, the instance
            # registry and the small database it keeps beside them all have to
            # move too: leave any one of them shared and the second game
            # reaches into the first, which looks like the first game quitting
            # on its own the moment the second one starts.
            for var in ("TERMINAL_BROWSER_APPDATA", "XDG_RUNTIME_DIR",
                        "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"):
                self.env[var] = os.path.join(home, var.lower())

    def shutdown_daemon(self):
        """Stop the browser daemon this run started.

        terminal-browser leaves a daemon behind on purpose: it is meant to
        outlive the command that started it, so the next one is quick. That is
        the wrong shape here. The daemon holds a browser attached to a pty that
        died with the last capture, and the next capture finds it, adopts it,
        and paints into a pipe nobody is reading. It shows up as a run that
        never draws a frame, on every other attempt, which is a maddening thing
        to chase. So each isolated run ends its own daemon.
        """
        if not self.home:
            return
        exe = shutil.which("terminal-browser") or os.path.expanduser(
            "~/.local/bin/terminal-browser")
        if not os.path.exists(exe):
            return
        env = dict(os.environ, **self.env)
        try:
            subprocess.run([exe, "shutdown"], env=env, timeout=20,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except (OSError, subprocess.SubprocessError):
            pass

    def spawn(self, argv):
        self.shutdown_daemon()
        pid, fd = pty.fork()
        if pid == 0:
            os.environ["TERM"] = "xterm-kitty"
            os.environ["COLORTERM"] = "truecolor"
            os.environ["TERM_PROGRAM"] = "ghostty"
            if self.home:
                # terminal-browser keeps one browser per terminal pane and finds
                # the pane through the terminal it is running under. A pty is
                # not a pane any terminal knows about, so two captures, or a
                # capture and the browser someone already had open, can end up
                # sharing one browser and painting each other's tabs into the
                # wrong pipe. Pointing every directory it reads at a private
                # tree gives each run its own daemon, its own profile and its
                # own saved worlds, which is also what two players need.
                for var, path in self.env.items():
                    os.makedirs(path, exist_ok=True)
                    os.environ[var] = path
            os.execvp(argv[0], argv)
        self.pid, self.fd = pid, fd
        # ws_xpixel/ws_ypixel is where terminal-browser reads the pane size from,
        # so the frames come back at exactly this resolution.
        fcntl.ioctl(fd, termios.TIOCSWINSZ,
                    struct.pack("HHHH", self.rows, self.cols, self.width, self.height))
        return self

    # -- the terminal side of the conversation ------------------------------
    def answer(self, chunk):
        out = b""

        for m in re.finditer(rb"\x1b_G([^;\x1b]*);?([^\x1b]*)\x1b\\", chunk):
            ctrl, payload = m.group(1), m.group(2)
            fields = dict(
                kv.split(b"=", 1) for kv in ctrl.split(b",") if b"=" in kv
            )
            if fields.get(b"a") == b"q":
                out += ESC + b"_Gi=" + fields.get(b"i", b"0") + b";OK" + ESC + b"\\"
            elif fields.get(b"a") == b"T":
                self._take_frame(fields, payload)

        for m in re.finditer(rb"\x1b\[(>?)c", chunk):
            out += ESC + (b"[>1;4000;0c" if m.group(1) else b"[?62;4;22c")

        # kitty keyboard protocol: track the push/pop stack so the query can be
        # answered with the flags actually in force. Answering at all is what
        # tells terminal-browser it may send key releases, which a game needs.
        for m in re.finditer(rb"\x1b\[([><])(\d*)u", chunk):
            if m.group(1) == b">":
                self.kbd_stack.append(int(m.group(2) or 0))
            elif len(self.kbd_stack) > 1:
                self.kbd_stack.pop()
        if re.search(rb"\x1b\[\?u", chunk):
            out += b"%s[?%du" % (ESC, self.kbd_stack[-1])

        if re.search(rb"\x1b\[14t", chunk):
            out += b"%s[4;%d;%dt" % (ESC, self.height, self.width)
        if re.search(rb"\x1b\[16t", chunk):
            out += b"%s[6;%d;%dt" % (ESC, self.cell_h, self.cell_w)
        if re.search(rb"\x1b\[18t", chunk):
            out += b"%s[8;%d;%dt" % (ESC, self.rows, self.cols)

        for m in re.finditer(rb"\x1b\[\?(\d+)\$p", chunk):
            out += b"%s[?%s;2$y" % (ESC, m.group(1))

        for m in re.finditer(rb"\x1b\](1[01]);\?(?:\x1b\\|\x07)", chunk):
            which = m.group(1)
            rgb = b"0000/0000/0000" if which == b"11" else b"ffff/ffff/ffff"
            out += ESC + b"]" + which + b";rgb:" + rgb + ESC + b"\\"
        for m in re.finditer(rb"\x1b\]4;(\d+);\?(?:\x1b\\|\x07)", chunk):
            out += ESC + b"]4;" + m.group(1) + b";rgb:8080/8080/8080" + ESC + b"\\"

        for m in re.finditer(rb"\x1bP\+q([0-9a-fA-F;]*)\x1b\\", chunk):
            out += ESC + b"P0+r" + m.group(1) + ESC + b"\\"

        return out

    def _take_frame(self, fields, payload):
        if fields.get(b"t") != b"f" or fields.get(b"f") != b"32":
            return
        try:
            w, h = int(fields[b"s"]), int(fields[b"v"])
            path = base64.b64decode(payload).decode()
            with open(path, "rb") as fh:
                data = fh.read(w * h * 4)
        except (KeyError, ValueError, OSError):
            return
        if len(data) == w * h * 4:
            self.frame, self.frame_size = data, (w, h)
            self.frames_seen += 1

    def send(self, data):
        os.write(self.fd, data)

    def pump(self, timeout=0.02):
        r, _, _ = select.select([self.fd], [], [], timeout)
        if self.fd not in r:
            return True
        try:
            chunk = os.read(self.fd, 1 << 22)
        except OSError:
            return False
        if not chunk:
            return False
        if self.textlog:
            # keep the readable half of the stream: everything but the frames
            self.textlog.write(re.sub(rb"\x1b_G[^\x1b]*\x1b\\\\", b"", chunk))
            self.textlog.flush()
        reply = self.answer(chunk)
        if reply:
            os.write(self.fd, reply)
        return True

    def gone(self):
        try:
            return os.waitpid(self.pid, os.WNOHANG)[0] != 0
        except ChildProcessError:
            return True

    def close(self, grace=6.0):
        """Ask the browser to quit, and only then insist.

        Minecraft keeps its settings and its worlds in IndexedDB, and chromium
        writes those out on its own schedule. Killing the browser the moment a
        capture ends loses whatever it had not flushed, which shows up one run
        later as a game that has forgotten the world you just built. So send
        terminal-browser's own quit key first, keep answering it while it winds
        down, and escalate only if it will not go.
        """
        try:
            self.send(key_event("ctrl+q", PRESS) + key_event("ctrl+q", RELEASE))
        except OSError:
            pass
        deadline = time.time() + grace
        while time.time() < deadline:
            if self.gone():
                return
            if not self.pump(0.05):
                break
        for sig in (signal.SIGTERM, signal.SIGKILL):
            try:
                os.killpg(os.getpgid(self.pid), sig)
            except (ProcessLookupError, PermissionError):
                try:
                    os.kill(self.pid, sig)
                except ProcessLookupError:
                    break
            for _ in range(30):
                if self.gone():
                    return
                time.sleep(0.1)


def parse_timed(values, parts, optional=0):
    out = []
    for v in values or []:
        bits = v.split(":", parts + optional - 1)
        if not parts <= len(bits) <= parts + optional:
            raise SystemExit(f"capture: expected {parts} colon-separated fields in {v!r}")
        out.append((float(bits[0]), *bits[1:]))
    return sorted(out, key=lambda item: item[0])


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", default="media", help="directory for stills and video")
    ap.add_argument("--seconds", type=float, default=30.0)
    ap.add_argument("--cols", type=int, default=170)
    ap.add_argument("--rows", type=int, default=48)
    ap.add_argument("--cell", default="9x19", help="cell size in pixels, WxH")
    ap.add_argument("--video", help="filename for an mp4 of the whole run")
    ap.add_argument("--gif", help="filename for a gif of the whole run")
    ap.add_argument("--fps", type=int, default=20)
    ap.add_argument("--still", action="append", metavar="TIME:NAME")
    ap.add_argument("--key", action="append", metavar="TIME:KEY",
                    help="tap a key, e.g. 8:enter")
    ap.add_argument("--hold", action="append", metavar="TIME:SECONDS:KEY",
                    help="hold a key down, e.g. 12:1.5:w")
    ap.add_argument("--move", action="append", metavar="TIME:X:Y",
                    help="move the pointer, x and y as fractions of the pane, "
                         "e.g. 10:0.5:0.5")
    ap.add_argument("--click", action="append", metavar="TIME:X:Y[:BUTTON]",
                    help="click, e.g. 12:0.5:0.79 or 30:0.5:0.5:right")
    ap.add_argument("--mine", action="append", metavar="TIME:SECONDS:X:Y",
                    help="hold the left button down, which is how a block is "
                         "broken, e.g. 40:1.6:0.5:0.55")
    ap.add_argument("--raw", action="append", metavar="TIME:BYTES",
                    help="send raw bytes, python escapes allowed, for working "
                         "out what the far end understands")
    ap.add_argument("--control", metavar="FILE",
                    help="play the game by appending lines to FILE while the "
                         "run is going, instead of scripting it in advance: "
                         "key w, hold 1.5 w, type /time set day, "
                         "click 0.5 0.86, move 0.5 0.5, mouse down, "
                         "mouse up, still name, "
                         "raw \\x1b[A, wait, quit")
    ap.add_argument("--isolate", metavar="DIR",
                    help="give this run its own browser daemon, profile and "
                         "saved worlds under DIR, so two of them can play "
                         "together without sharing a browser. Keep DIR short: "
                         "the daemon's socket lives under it and a unix socket "
                         "path stops at 104 characters on macOS")
    ap.add_argument("--log", help="write the child's non-graphics output here")
    ap.add_argument("cmd", nargs=argparse.REMAINDER)
    args = ap.parse_args()

    argv = args.cmd[1:] if args.cmd[:1] == ["--"] else args.cmd
    if not argv:
        raise SystemExit("capture: give the command to run after --")

    cell_w, cell_h = (int(n) for n in args.cell.lower().split("x"))
    os.makedirs(args.out, exist_ok=True)

    stills = parse_timed(args.still, 2)
    taps = parse_timed(args.key, 2)
    holds = parse_timed(args.hold, 3)
    moves = parse_timed(args.move, 3)
    clicks = parse_timed(args.click, 3, optional=1)
    mines = parse_timed(args.mine, 4)
    # A hold is a press now and a release later; flatten both into one timeline.
    events = [(t, key_event(k, PRESS)) for t, k in taps]
    events += [(t + 0.06, key_event(k, RELEASE)) for t, k in taps]
    for t, dur, k in holds:
        events.append((t, key_event(k, PRESS)))
        events.append((t + float(dur), key_event(k, RELEASE)))

    # Fractions of the pane rather than cells, so a script keeps aiming at the
    # same button when the pane size changes.
    def to_cell(x, y):
        return (max(1, min(args.cols, round(float(x) * args.cols))),
                max(1, min(args.rows, round(float(y) * args.rows))))

    for t, x, y in moves:
        px, py = to_cell(x, y)
        events.append((t, mouse_event(px, py, MOTION_IDLE, True)))
    for item in clicks:
        t, x, y = item[0], item[1], item[2]
        button = BUTTONS[(item[3] if len(item) > 3 else "left").lower()]
        px, py = to_cell(x, y)
        # Move first. Minecraft's menus light a button up on hover and only act
        # on a press that lands on a lit one.
        events.append((t - 0.12, mouse_event(px, py, MOTION_IDLE, True)))
        events.append((t, mouse_event(px, py, button, True)))
        events.append((t + 0.08, mouse_event(px, py, button, False)))
    for t, dur, x, y in mines:
        px, py = to_cell(x, y)
        events.append((t - 0.12, mouse_event(px, py, MOTION_IDLE, True)))
        events.append((t, mouse_event(px, py, BUTTONS["left"], True)))
        events.append((t + float(dur), mouse_event(px, py, BUTTONS["left"], False)))

    for item in parse_timed(args.raw, 2):
        events.append((item[0], item[1].encode().decode("unicode_escape").encode("latin-1")))

    events.sort(key=lambda e: e[0])

    term = FakeTerminal(args.cols, args.rows, cell_w, cell_h, home=args.isolate,
                        capture_dir=args.out if (args.video or args.gif) else None)
    if args.log:
        term.textlog = open(args.log, "wb")
    term.spawn(argv)

    encoder = None
    frame_interval = 1.0 / args.fps
    next_frame = frame_interval
    written = 0

    # A live script, for when you do not yet know what the screen will say. The
    # timed arguments above are how a recording is made; this is how you find
    # out which pixel the button is on.
    control = None
    if args.control:
        open(args.control, "a").close()
        control = open(args.control, "r")
        control.seek(0, os.SEEK_END)

    def do(line):
        bits = line.split()
        if not bits:
            return True
        verb, rest = bits[0], bits[1:]
        if verb == "quit":
            return False
        if verb == "key":
            for name in rest:
                term.send(key_event(name, PRESS))
                time.sleep(0.06)
                term.send(key_event(name, RELEASE))
        elif verb == "hold":
            dur, name = float(rest[0]), rest[1]
            term.send(key_event(name, PRESS))
            hold_until.append((time.time() + dur, key_event(name, RELEASE)))
        elif verb == "type":
            for ch in line[5:]:
                term.send(key_event(ch, PRESS))
                time.sleep(0.03)
                term.send(key_event(ch, RELEASE))
                time.sleep(0.03)
        elif verb in ("click", "move"):
            px, py = to_cell(rest[0], rest[1])
            term.send(mouse_event(px, py, MOTION_IDLE, True))
            if verb == "click":
                button = BUTTONS[(rest[2] if len(rest) > 2 else "left").lower()]
                time.sleep(0.12)
                term.send(mouse_event(px, py, button, True))
                time.sleep(0.08)
                term.send(mouse_event(px, py, button, False))
        elif verb == "mouse":
            # Held buttons, for mining, which is a held left button in every
            # version of Minecraft there has ever been.
            button = BUTTONS[(rest[1] if len(rest) > 1 else "left").lower()]
            cx, cy = args.cols // 2, args.rows // 2
            term.send(mouse_event(cx, cy, button, rest[0] == "down"))
        elif verb == "still":
            if term.frame:
                w, h = term.frame_size
                write_png(os.path.join(args.out, f"{rest[0]}.png"), w, h, term.frame)
                print(f"still {rest[0]}.png ({w}x{h})", file=sys.stderr)
            else:
                print(f"still {rest[0]} skipped, nothing painted yet", file=sys.stderr)
        elif verb == "raw":
            term.send(" ".join(rest).encode().decode("unicode_escape").encode("latin-1"))
        elif verb != "wait":
            print(f"control: {verb!r}?", file=sys.stderr)
        return True

    hold_until = []
    start = time.time()
    # Capture mode writes the game's audio out separately; this is the clock the
    # two get lined up against.
    with open(os.path.join(args.out, "capture-start"), "w") as fh:
        fh.write(str(start))
    try:
        while (now := time.time() - start) < (args.seconds or float("inf")):
            while events and events[0][0] <= now:
                term.send(events.pop(0)[1])
            while stills and stills[0][0] <= now:
                _, name = stills.pop(0)
                if term.frame:
                    w, h = term.frame_size
                    write_png(os.path.join(args.out, f"{name}.png"), w, h, term.frame)
                    print(f"still {name}.png at {now:.1f}s ({w}x{h})", file=sys.stderr)
                else:
                    print(f"still {name} skipped, nothing painted yet", file=sys.stderr)

            if (args.video or args.gif) and now >= next_frame and term.frame:
                if encoder is None:
                    w, h = term.frame_size
                    # The moment the first frame of the video exists. Two
                    # captures started by hand never start together, and this
                    # is what lets the two halves be lined up afterwards.
                    with open(os.path.join(args.out, "video-start"), "w") as fh:
                        fh.write(str(time.time()))
                    encoder = subprocess.Popen(
                        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
                         "-f", "rawvideo", "-pix_fmt", "rgba",
                         "-s", f"{w}x{h}", "-r", str(args.fps), "-i", "-",
                         "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p",
                         "-preset", "veryfast", "-crf", "20",
                         os.path.join(args.out, args.video or "capture.mp4")],
                        stdin=subprocess.PIPE)
                encoder.stdin.write(term.frame)
                written += 1
                next_frame += frame_interval

            while hold_until and hold_until[0][0] <= time.time():
                term.send(hold_until.pop(0)[1])

            if control:
                if not all(do(line.strip()) for line in control.readlines()):
                    break

            if not term.pump():
                break
    finally:
        if encoder:
            encoder.stdin.close()
            encoder.wait()
        term.close()
        term.shutdown_daemon()

    print(f"painted {term.frames_seen} frames, encoded {written}", file=sys.stderr)
    if term.frames_seen == 0:
        print("capture: nothing was ever painted", file=sys.stderr)
        return 1

    if args.gif and args.video:
        src = os.path.join(args.out, args.video)
        dst = os.path.join(args.out, args.gif)
        subprocess.run(
            ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", src,
             "-vf", "fps=14,scale=900:-1:flags=lanczos,split[a][b];"
                    "[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer",
             dst], check=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
