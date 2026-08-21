# The brief, verbatim

This is the exact brief the orchestrator wrote and delegated to the build agent,
unedited. It calls the project terminal-eaglercraft, which is what it was called
until message 6 below renamed it. The nine messages that arrived while it was
building follow it.

---

You own terminal-eaglercraft: Minecraft, via the Eaglercraft browser port, playable inside a terminal pane. This is the sequel to dcouple/terminal-doom, which went viral. parsa's raw ask, verbatim for the record:

```
You know how yesterday we kicked off Terminal Doom? Can we kick off Terminal EagleCraft? I think that would be sick. It's literally just like Minecraft in a browser, and it's open source too. i think terminal ec will do better then doom. my post didnt doo too well.https://github.com/Eaglercraft-Archive
```

READ FIRST, in this order:
1. https://github.com/dcouple/terminal-doom, the whole repo. Its install.sh, bin wrapper, scripts/capture.py (the blind-testing pty harness: debugger, test suite, and camera in one file), and its README voice are your templates. Reuse capture.py's approach wholesale.
2. https://github.com/zenbu-labs/terminal-browser and its how-does-it-work section.
3. https://github.com/Eaglercraft-Archive, find the EaglercraftX 1.8 offline single-file client (one self-contained HTML with the game embedded; singleplayer runs fully offline via its integrated server).

LEGAL ARCHITECTURE, a hard constraint that shapes the whole repo: Mojang has DMCA'd Eaglercraft repos before, the client contains decompiled Minecraft code, and this repo is being built to go viral, which is exactly what attracts a takedown. So the repo ships the MIT wrapper only. Zero Eaglercraft client code, zero Mojang assets committed, ever, including in test fixtures and recordings' source files. The installer downloads the offline client HTML from the archive at install time, pinned to an exact URL and sha256, with a fallback mirror if the archive provides one, and `--client <path>` for a user-supplied file. The README states this split in one plain sentence. This differs from doom (whose engine is GPL and wad is shareware) and the NOTICE file spells out the three parts honestly.

PROTOTYPE FIRST, before building anything polished. Two risks decide feasibility, prove them in the first hour and report if either fails:
1. WebGL readback. Doom drew through canvas2d software rendering. Eaglercraft needs WebGL 1. Test whether terminal-browser's pixel readback captures a swiftshader/ANGLE software-GL context in headless chromium. Success = one frame of the Eaglercraft title screen rendered as terminal graphics. That single png is the go/no-go.
2. Mouse look. Minecraft needs pointer lock and relative mouse movement. Terminal mouse reporting gives cell coordinates. Doom got away with arrow-key turning. Plan A: keyboard-first controls (arrows or mouse-delta synthesis from terminal mouse drag events). Plan B if pointer lock is unreachable: ship keyboard-look and say so cheerfully in the README controls table. Do not let mouse look block shipping; a playable keyboard experience that boots into a real Minecraft world in a terminal is the viral artifact.

Also expect: performance through software GL will be modest. Measure the fps you actually get and report it as a number. If the 1.8 client is too heavy, the older 1.5.2 client is a legitimate fallback, note the tradeoff.

DELIVERABLES:
1. New public repo dcouple/terminal-eaglercraft (you have precedent and authorization to create it, same as terminal-doom). One-liner curl install that works on a fresh machine, kitty-graphics terminals (ghostty, kitty, WezTerm, cmux, VS Code terminal).
2. A recording captured through capture.py showing real gameplay: world loads, player moves, breaks a block if achievable. Every frame must be actual bytes terminal-browser wrote to a terminal.
3. README in the terminal-doom voice: what it is, install, controls table, honest How-this-was-made crediting Pane, dcouple/skills, dcouple/orchestra with the same links, the raw ask above verbatim in a code fence, and BRIEF.md containing this entire brief verbatim. Writing rules: no em dashes anywhere, say what is rather than what is not, humane and honest, nothing salesy.
4. NOTICE covering wrapper (MIT), Eaglercraft (downloaded at install, its own terms), Minecraft (trademark of Mojang/Microsoft, this project independent of them).

Report at the end: repo URL, recording path, measured fps, exact client file + sha256 pinned, what you assumed, what broke and how you found it (the stories are the marketing). Hard stop after the repo and recording exist: parsa writes the tweet himself.

---

## Mid-flight message 1

> Note from parsa while you work: multiplayer matters to him. Eaglercraft upstream supports it two ways, WebSocket servers and shared-world LAN over WebRTC through the relay. When the singleplayer path is solid, verify at least one multiplayer path from the terminal client (joining a WebSocket server is likely the cheap one) and cover it in the README controls/usage. Two terminals in the same world would be a killer clip if it comes easy. Nice to have, never a blocker for shipping.

## Mid-flight message 2

> Update from parsa: the HERO recording is now a two-player clip, and he thinks this is what makes it go viral. The shot: two terminals side by side in the same world. The players step away from each other, turn to face each other, then one starts shift-crouching (the teabag dance) and dancing around while the other watches. Ship this as the headline GIF/video at the top of the README.
>
> How to get it: shared-world LAN over WebRTC or a local WebSocket server, whichever your prototype proves first. Run two capture.py instances, one per player, choreograph both with timed key scripts (crouch is shift held in pulses), then composite the two terminal recordings side by side into one frame (ffmpeg hstack works). Both halves must remain real bytes terminal-browser wrote to a terminal, that honesty is part of the story.
>
> Priority order stays sane: singleplayer booting and playable first, that is still the ship gate and the fallback clip if multiplayer fights back. But treat the two-terminal dance as the target deliverable for the recording, worth real effort before settling.

## Mid-flight message 3

> i rlly like 1.8 so i hope u can figure it out otherwise sure idc

## Mid-flight message 4

> parsa again, refining the hero clip into a storyboard. Film these beats in order, one continuous take per terminal if possible:
>
> 1. The Minecraft title screen in the terminal, held long enough to register.
> 2. The cursor visibly clicking Multiplayer (or Singleplayer then opening to LAN), menus navigated on camera, this is proof of life.
> 3. Second terminal: the friend joins, you see the join happen.
> 4. The two players find each other and look at each other.
> 5. Both back away a few blocks, then one (or both) starts shift-crouch spamming, the teabag dance, circling around.
>
> SOUND: parsa loves the Minecraft noises and wants them in the video. terminal-doom already proved game audio works through this stack, so capture the game audio track and mux it into the mp4 (grab it from the chromium side, a loopback/virtual audio device on macOS, or whatever the doom setup used). The GIF stays silent, obviously, so put the mp4 with sound right under it and label it as the one with sound. If audio capture turns into a tarpit, ship the clip silent and report what blocked it rather than stalling.
>
> Everything else stands: real terminal bytes only, singleplayer remains the ship gate, side-by-side composite for the two-player beats.

## Mid-flight message 5

> If you look at the demo video, there are a few small touches that make it look nice, like the gradient and simulated Mac window. You can probably copy some of those from the Terminal Doom repo.

## Mid-flight message 6

> can we  call it terminal-minceraft play ion words

## Mid-flight message 7

> the recordings good but needs ot be square for twitter not landscape so the two recordings stacked on top of each other

## Mid-flight message 8

> the title says it thats why i did it.

## Mid-flight message 9

> We can remove the "What broke?" from the README. I don't think people actually care about it. I was reading it, it didn't sound as cool as the other stuff we had to figure out.

## About the orchestration

The orchestrator is a chat session of Claude Fable 5 running the
pane-orchestrator skill. It manages work through
[Pane](https://github.com/dcouple/Pane), which gives every task its own git
worktree and agent terminal. The skills and workflow conventions it follows
live in [dcouple/skills](https://github.com/dcouple/skills) and
[dcouple/orchestra](https://github.com/dcouple/orchestra).
