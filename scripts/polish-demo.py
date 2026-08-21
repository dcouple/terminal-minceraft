#!/usr/bin/env python3
"""Turn two raw terminal captures into the demo clip.

Puts each player's capture in a mac window, stands the two windows side by side
on a gradient, captions the beats, and muxes the game's own audio back in. The
presentation is added here. The frames inside the windows are the recording,
exactly as terminal-browser wrote them to a terminal, and the sound is the game's.

The two captures start within a millisecond of each other because they are
launched together, and each writes a video-start stamp; this lines them up on
those stamps rather than trusting that.

Needs pillow for the overlays, because the ffmpeg most people have on macOS is
built without freetype and so has no drawtext:

    python3 -m venv .venv && .venv/bin/pip install pillow
    .venv/bin/python scripts/polish-demo.py \\
        --left  media/raw/steve.mp4 --left-title steve \\
        --right media/raw/alex.mp4  --right-title alex \\
        --audio media/raw/audio.webm --audio-offset 39.9 \\
        --stack --cut 43:58 --cut 134:256 --out media/terminal-minceraft.mp4

This file is terminal-doom's polish-demo.py with a second window added.
"""
import argparse
import os
import subprocess
import sys
import tempfile

from PIL import Image, ImageDraw, ImageFilter, ImageFont

# A terminal pane is much wider than it is tall, so two of them do not fit any
# ordinary frame comfortably. Side by side wants a very wide canvas; one above
# the other fits a square, which is what Twitter wants. layout() picks one.
PANE_ASPECT = 1530 / 912

CANVAS = (1920, 760)
WIN_W, VIDEO_H, BAR_H, WIN_H = 920, 548, 38, 586
GAP = 48
FIRST = (16, 87)   # top left of the first window
SECOND = (984, 87)  # top left of the second
RADIUS = 14
PILL_H, PILL_R, PILL_PAD, PILL_FONT = 84, 24, 40, 40
PILL_Y = 631


def layout(stack, single=False):
    """Work out where the windows sit, and how big the canvas has to be."""
    global CANVAS, WIN_W, VIDEO_H, BAR_H, WIN_H, GAP, FIRST, SECOND
    global RADIUS, PILL_H, PILL_R, PILL_PAD, PILL_FONT, PILL_Y

    if single:
        # One terminal, so the frame can be an ordinary wide one.
        CANVAS = (1920, 1080)
        WIN_W, BAR_H, GAP, RADIUS = 1560, 40, 0, 16
        VIDEO_H = round(WIN_W / PANE_ASPECT)
        WIN_H = VIDEO_H + BAR_H
        FIRST = ((CANVAS[0] - WIN_W) // 2, (CANVAS[1] - WIN_H) // 2)
        SECOND = FIRST
        PILL_H, PILL_R, PILL_PAD, PILL_FONT = 84, 24, 40, 40
        PILL_Y = FIRST[1] + WIN_H - PILL_H // 2
    elif stack:
        CANVAS = (1080, 1080)
        WIN_W, BAR_H, GAP, RADIUS = 780, 30, 26, 12
        VIDEO_H = round(WIN_W / PANE_ASPECT)
        WIN_H = VIDEO_H + BAR_H
        x = (CANVAS[0] - WIN_W) // 2
        top = (CANVAS[1] - (WIN_H * 2 + GAP)) // 2
        FIRST = (x, top)
        SECOND = (x, top + WIN_H + GAP)
        PILL_H, PILL_R, PILL_PAD, PILL_FONT = 62, 18, 28, 29
        # Straddling the bottom edge of the lower window, the way a mac hud does.
        PILL_Y = SECOND[1] + WIN_H - int(PILL_H * 0.72)
    else:
        CANVAS = (1920, 760)
        WIN_W, BAR_H, GAP, RADIUS = 920, 38, 48, 14
        VIDEO_H = round(WIN_W / PANE_ASPECT)
        WIN_H = VIDEO_H + BAR_H
        left = (CANVAS[0] - (WIN_W * 2 + GAP)) // 2
        top = (CANVAS[1] - WIN_H) // 2
        FIRST = (left, top)
        SECOND = (left + WIN_W + GAP, top)
        PILL_H, PILL_R, PILL_PAD, PILL_FONT = 84, 24, 40, 40
        PILL_Y = top + WIN_H - PILL_H // 2

TRAFFIC = ["#ff5f57", "#febc2e", "#28c840"]
FONTS = [
    "/System/Library/Fonts/SFNSMono.ttf",
    "/System/Library/Fonts/Menlo.ttc",
    "/System/Library/Fonts/Supplemental/Andale Mono.ttf",
]


def font(size):
    for path in FONTS:
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            continue
    return ImageFont.load_default(size)


def gradient(path):
    """A grass-to-sky wash, in the spirit of a mac desktop.

    Drawn small and scaled up by ffmpeg, which is both quicker and smoother than
    laying down two million pixels one at a time.
    """
    w, h = 320, 180
    stops = [
        (0.00, (0x1B, 0x2A, 0x3E)),
        (0.30, (0x2C, 0x5A, 0x7A)),
        (0.55, (0x4E, 0x9E, 0xD0)),
        (0.78, (0x6F, 0xAF, 0x63)),
        (1.00, (0x2E, 0x5A, 0x2C)),
    ]
    img = Image.new("RGB", (w, h))
    px = img.load()
    for y in range(h):
        for x in range(w):
            t = x / (w - 1) * 0.35 + y / (h - 1) * 0.65
            for k in range(len(stops) - 1):
                t0, c0 = stops[k]
                t1, c1 = stops[k + 1]
                if t <= t1 or k == len(stops) - 2:
                    f = 0.0 if t1 == t0 else min(1.0, max(0.0, (t - t0) / (t1 - t0)))
                    f = f * f * (3 - 2 * f)
                    base = [c0[c] + (c1[c] - c0[c]) * f for c in range(3)]
                    break
            dx, dy = (x / w - 0.5) * 2, (y / h - 0.5) * 2
            shade = 1 - 0.22 * min(1.0, (dx * dx + dy * dy) / 2)
            px[x, y] = tuple(int(v * shade) for v in base)
    img.save(path)


def window_mask(path):
    img = Image.new("L", (WIN_W, WIN_H), 0)
    ImageDraw.Draw(img).rounded_rectangle((0, 0, WIN_W - 1, WIN_H - 1), RADIUS, fill=255)
    img.convert("RGB").save(path)


def titlebar(path, title):
    img = Image.new("RGBA", (WIN_W, BAR_H), (32, 33, 36, 255))
    d = ImageDraw.Draw(img)
    for n, colour in enumerate(TRAFFIC):
        cx, cy, r = 20 + n * 18, BAR_H / 2, 5.5
        d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=colour)
    d.text((WIN_W / 2, BAR_H / 2), title, font=font(BAR_H // 2 - 2),
           fill="#9aa0a6", anchor="mm")
    img.save(path)


def pill(path, label):
    f = font(PILL_FONT)
    tmp = ImageDraw.Draw(Image.new("RGBA", (1, 1)))
    width = int(tmp.textlength(label, font=f)) + PILL_PAD * 2
    img = Image.new("RGBA", (width, PILL_H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((0, 0, width - 1, PILL_H - 1), PILL_R,
                        fill=(18, 18, 22, 235), outline=(255, 255, 255, 40), width=1)
    d.text((width / 2, PILL_H / 2 - 2), label, font=f, fill="white", anchor="mm")
    img.save(path)
    return width


def shadow(path):
    img = Image.new("RGBA", (WIN_W, WIN_H), (0, 0, 0, 0))
    ImageDraw.Draw(img).rounded_rectangle(
        (0, 0, WIN_W - 1, WIN_H - 1), RADIUS, fill=(0, 0, 0, 150))
    img.filter(ImageFilter.GaussianBlur(18)).save(path)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--left", required=True)
    ap.add_argument("--right", help="a second capture, beside or below the first. "
                                    "Without one, the clip is a single window")
    ap.add_argument("--left-title", default="steve",
                    help="the top window when stacked, the left one when not")
    ap.add_argument("--right-title", default="alex")
    ap.add_argument("--left-offset", type=float, default=0.0,
                    help="seconds to skip in the left capture, on top of --start")
    ap.add_argument("--right-offset", type=float, default=0.0)
    ap.add_argument("--cut", action="append", default=[], metavar="START:END",
                    help="keep this range of the captures, in the capture's own "
                         "clock. Repeat to keep several, and they are joined in "
                         "the order given. Without any, the whole capture is used")
    ap.add_argument("--stack", action="store_true",
                    help="one terminal above the other in a square frame, which "
                         "is the shape social video wants. Without it the two "
                         "sit side by side in a wide one")
    ap.add_argument("--fps", type=int, default=24)
    ap.add_argument("--audio")
    ap.add_argument("--audio-offset", type=float, default=0.0,
                    help="seconds into the capture where the audio recording begins")
    ap.add_argument("--caption", action="append", default=[], metavar="START:END:LABEL",
                    help="times are in the finished clip's clock, after cutting")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    single = not args.right
    layout(args.stack, single)

    tmp = tempfile.mkdtemp(prefix="polish-")
    paths = {n: os.path.join(tmp, f"{n}.png")
             for n in ("bg", "mask", "barl", "barr", "shadow")}
    gradient(paths["bg"])
    window_mask(paths["mask"])
    titlebar(paths["barl"], args.left_title)
    titlebar(paths["barr"], args.right_title)
    shadow(paths["shadow"])

    captions = []
    for n, spec in enumerate(args.caption):
        start, end, label = spec.split(":", 2)
        path = os.path.join(tmp, f"pill{n}.png")
        captions.append((float(start), float(end), pill(path, label), path))

    cuts = [tuple(float(v) for v in c.split(":")) for c in args.cut]

    inputs = ["-loop", "1", "-i", paths["bg"],
              "-i", args.left,
              "-i", args.right or args.left,
              "-i", paths["barl"], "-i", paths["barr"],
              "-i", paths["mask"], "-loop", "1", "-i", paths["shadow"]]
    next_index = 7
    for *_, path in captions:
        inputs += ["-loop", "1", "-i", path]
    audio_index = None
    if args.audio:
        audio_index = next_index + len(captions)
        inputs += ["-i", args.audio]

    fps = args.fps

    def cut_stream(index, offset, label):
        """The kept ranges of one capture, joined end to end.

        Trimming with the filter rather than -ss so that both captures and the
        sound are cut on the same clock, which is the capture's own.
        """
        if not cuts:
            return [f"[{index}:v]setpts=PTS-STARTPTS[{label}]"]
        # A stream feeds one filter, so it has to be split before it can be cut
        # in more than one place.
        parts = [f"[{index}:v]split={len(cuts)}" +
                 "".join(f"[{label}s{n}]" for n in range(len(cuts)))]
        for n, (a, b) in enumerate(cuts):
            parts.append(
                f"[{label}s{n}]trim=start={a + offset:.3f}:end={b + offset:.3f},"
                f"setpts=PTS-STARTPTS[{label}{n}]"
            )
        joined = "".join(f"[{label}{n}]" for n in range(len(cuts)))
        parts.append(f"{joined}concat=n={len(cuts)}:v=1:a=0[{label}]")
        return parts

    graph = [f"[0:v]scale={CANVAS[0]}:{CANVAS[1]}:flags=lanczos,fps={fps},setsar=1[bg]"]
    graph += cut_stream(1, args.left_offset, "lcut")
    graph.append(f"[lcut]scale={WIN_W}:{VIDEO_H}:flags=lanczos,fps={fps},setsar=1[lv]")
    graph.append(f"[3:v]fps={fps},setsar=1[lbar]")
    graph.append("[lbar][lv]vstack=inputs=2[lwin]")

    windows = 1 if single else 2
    graph.append(f"[5:v]format=gray,fps={fps},setsar=1,split={windows}" +
                 "".join(f"[m{n}]" for n in range(1, windows + 1)))
    graph.append("[lwin][m1]alphamerge[lwr]")
    graph.append(f"[6:v]fps={fps},setsar=1,split={windows}" +
                 "".join(f"[sh{n}]" for n in range(1, windows + 1)))

    if single:
        graph.append(f"[bg][sh1]overlay={FIRST[0]}:{FIRST[1] + 14}:shortest=1[bgs]")
        graph.append(f"[bgs][lwr]overlay={FIRST[0]}:{FIRST[1]}[stage]")
    else:
        graph += cut_stream(2, args.right_offset, "rcut")
        graph.append(f"[rcut]scale={WIN_W}:{VIDEO_H}:flags=lanczos,fps={fps},setsar=1[rv]")
        graph.append(f"[4:v]fps={fps},setsar=1[rbar]")
        graph.append("[rbar][rv]vstack=inputs=2[rwin]")
        graph.append("[rwin][m2]alphamerge[rwr]")
        graph.append(f"[bg][sh1]overlay={FIRST[0]}:{FIRST[1] + 14}:shortest=1[bg1]")
        graph.append(f"[bg1][sh2]overlay={SECOND[0]}:{SECOND[1] + 14}[bg2]")
        graph.append(f"[bg2][lwr]overlay={FIRST[0]}:{FIRST[1]}[stage1]")
        graph.append(f"[stage1][rwr]overlay={SECOND[0]}:{SECOND[1]}[stage]")

    last = "stage"
    for n, (start, end, width, _) in enumerate(captions):
        a, b = start, end
        x = (CANVAS[0] - width) // 2
        graph.append(
            f"[{last}][{next_index + n}:v]overlay={x}:{PILL_Y}"
            f":enable='between(t\\,{a:.2f}\\,{b:.2f})'[c{n}]"
        )
        last = f"c{n}"

    if audio_index is not None:
        # The recorder only starts once the game has built its audio graph, some
        # way into the capture, so the sound file's clock is the capture's clock
        # minus that. Pad the front so both clocks agree, then cut the sound on
        # exactly the ranges the picture was cut on.
        pad = int(args.audio_offset * 1000)
        graph.append(f"[{audio_index}:a]adelay={pad}:all=1[apad]")
        if not cuts:
            graph.append("[apad]asetpts=PTS-STARTPTS[aud]")
        else:
            graph.append(f"[apad]asplit={len(cuts)}" +
                         "".join(f"[as{n}]" for n in range(len(cuts))))
            for n, (a, b) in enumerate(cuts):
                graph.append(
                    f"[as{n}]atrim=start={a:.3f}:end={b:.3f},asetpts=PTS-STARTPTS[ac{n}]")
            joined = "".join(f"[ac{n}]" for n in range(len(cuts)))
            graph.append(f"{joined}concat=n={len(cuts)}:v=0:a=1[aud]")

    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "warning", "-y", *inputs,
           "-filter_complex", ";".join(graph), "-map", f"[{last}]"]
    if audio_index is not None:
        cmd += ["-map", "[aud]", "-c:a", "aac", "-b:a", "160k"]
    cmd += ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "slow", "-crf", "20",
            "-movflags", "+faststart", "-shortest", args.out]

    subprocess.run(cmd, check=True)
    print(f"{args.out}: {len(cuts) or 1} cut(s), {len(captions)} captions",
          file=sys.stderr)


if __name__ == "__main__":
    sys.exit(main())
