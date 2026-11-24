<!--
Audio and video playback through Maestro's floating media player. Pulled on demand from the system prompt's Reference Index when the user asks to play, open, or queue media. Placeholders in double braces stand for the values in the Session Information block of your system prompt.
-->

# Playing Audio and Video

When the user asks you to play, open, or listen to a media file, hand it to
**Maestro's own floating media player**. It is the only surface audio and video
ever appear on inside Maestro: no tab is created, no panel is taken over, and
the user gets a transport, a play queue, and a resume position.

```bash
# Plays it in the Maestro player, right now
{{MAESTRO_CLI_PATH}} open-file "/path/to/track.mp3" --agent {{AGENT_ID}}
```

Rules for media:

- **Never shell out to the OS player.** `open`, `afplay`, `xdg-open`, `start`,
  `ffplay`, `vlc`, and `mpv` all hand playback to a separate application the
  user did not ask for, outside Maestro, with no queue and no transport - and
  the sound then comes from somewhere they cannot pause from the app they are
  looking at. `open-file` is the answer for every playable audio or video file.
- **`open-file` is the one verb.** There is no separate "play" command; the
  open path recognizes playable media and diverts it to the player itself, so
  the same verb that previews a document plays a track.
- **Pass `--agent {{AGENT_ID}}` for anything outside the project.** Without it
  the file must sit inside some agent's working directory, and music usually
  does not.
- **Playing is a visible, audible act.** `--background` does not apply here -
  starting playback is not a quiet action, so do it when the user asked for it,
  not to inspect a file. To check a media file's duration or codec without
  making noise, use `ffprobe` in your own shell.
- **Local files and http(s) URLs reach the player; SSH-remote files do not.**
  A file on an SSH remote has no stream to play, so it falls back to the
  ordinary binary-file path. Say so rather than reporting that it is playing.
- **`open-file <https-url>` streams media from the web.** Progressive MP4
  (H.264/AAC) and plain audio files (mp3, m4a, ...) play directly. HLS
  (`.m3u8`), DASH, RTSP, and RTMP do NOT - say so instead of trying.
- **Each call takes over the player, so open ONE file.** There is only ever one
  player, and a second `open-file` starts playing that file instead. The first
  is not lost, it stays in the play queue and the previous button goes back to
  it, but it stops. So firing a list of paths leaves the LAST one playing, which
  is rarely what was asked for. For a playlist, open the first file and pass
  `--queue` for the rest: they line up behind it without interrupting it.
- **`--queue` puts media on screen without pressing play.** With nothing loaded,
  the file loads paused and the player appears; with something loaded, it lines
  up behind it. Use it when the user wants to start playback themselves, and
  for every file of a playlist they asked to have ready rather than playing.
