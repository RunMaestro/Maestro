---
title: Media Player
description: Play audio and video files in a floating player you can drag anywhere, with a saved play queue, playback speed, and a recently-played history.
icon: music
---

Open an audio or video file and Maestro plays it in a small floating player. It does not open a tab, and it does not take over the main window. The player floats above whatever you are working on and follows you across tabs and agents, so a podcast keeps playing while you keep working.

![The Maestro media player, floating over an agent with its Recently Played menu open](/screenshots/media-player.png)

## Opening a file

Double-click any supported audio or video file - in the Files pane, from a link in a chat transcript, or through Fuzzy File Search. The player appears in the bottom-right corner and starts playing.

Audio opens as a slim control strip, since there is nothing to look at. Video opens as a proper frame, sized to that file's own aspect ratio - a 4:3 screen recording and a vertical phone clip each get a box that fits them, so nothing ever plays inside black bars.

There is only ever **one** player. Opening a second file switches to it and keeps the first in the queue, so two things can never play over each other.

To line a file up instead of switching to it, right-click it and choose **Add to Play Queue**. Select several files, right-click, and **Preview** plays the first and queues the rest - that is how you start a playlist in one gesture.

<Note>
Media files never appear in the tab bar. If you want the file itself - to inspect it, move it, or open it in another app - use the Files pane, or the player's own **Open in default app** button.
</Note>

### Supported formats

The player handles the containers and codecs Chromium can decode in an Electron build, which includes the proprietary ones:

| Kind      | Extensions                                               |
| --------- | -------------------------------------------------------- |
| **Audio** | `mp3` `m4a` `aac` `wav` `flac` `ogg` `oga` `opus` `weba` |
| **Video** | `mp4` `m4v` `webm` `ogv` `mov`                           |

Formats Chromium cannot demux (`mkv`, `avi`, `wmv`) are deliberately left out. They fall through to the normal binary file preview, where you can open them in your default app instead of landing in a player that could only fail.

Files on an [SSH remote](/ssh-remote-execution) also fall through to that preview. The player streams bytes from the local disk, and a remote file has none to stream, so it offers **Download & Open** instead.

## Moving it around

**Drag the title bar** to move the player anywhere on screen. The grip on the left is the affordance, but the whole bar is grabbable, including the filename. It stays inside the window, and if you resize the window it stays on screen.

**Drag the grip in the bottom-right corner** to resize. Double-click that grip to snap back to the default size.

Resizing sets the width; the height follows the file, so a video keeps its shape as it grows. Where you leave the player is remembered across restarts, and the width is remembered **per kind** - size a movie the way you like without your podcast bar becoming half the screen wide.

When the queue steps from an audio file to a video one, the player reshapes itself: it expands into a picture frame for the video and collapses back to a control strip for the next MP3. A queue of mixed files needs no fiddling with the grip.

## Controls

| Control                 | What it does                                                       |
| ----------------------- | ------------------------------------------------------------------ |
| **Play / Pause**        | Toggle playback                                                    |
| **Back / Forward 10s**  | Jump ten seconds                                                   |
| **Previous / Next**     | Move through the queue in the order you opened files               |
| **Volume**              | Slider, with a mute toggle                                         |
| **Loop**                | Repeat the current file                                            |
| **Speed**               | 0.25x through 4x, pitch-corrected so a 2x podcast stays listenable |
| **Play queue**          | The list of what plays next (see below)                            |
| **Recently played**     | Jump to anything you played earlier (see below)                    |
| **Open in default app** | Hand the file to macOS, Windows, or Linux                          |
| **Fullscreen**          | Video only                                                         |

Playback speed is global and persists: pick 1.5x once and every file after it starts at 1.5x, including after a restart.

### Keyboard

Click the player to focus it, then:

| Key                   | Action                    |
| --------------------- | ------------------------- |
| `Space` or `K`        | Play / pause              |
| `←` / `→`             | Back / forward 10 seconds |
| `Shift+←` / `Shift+→` | Back / forward 5 seconds  |
| `↑` / `↓`             | Volume up / down          |
| `M`                   | Mute                      |
| `L`                   | Loop                      |
| `,` / `.`             | Slower / faster           |
| `F`                   | Fullscreen (video)        |

## The play queue and Recently Played

The title bar has two lists, and each button only appears when its list has something in it.

**Play queue** (the list icon) is what plays next, in the order you added files. When a file finishes, the next one starts on its own.

- **Previous / Next** walk the same order. It never changes, so the buttons are predictable no matter how you got to the current file. They do not wrap, so they grey out at the ends.
- Click any row to jump to it, the `x` on a row to drop it, or **Clear** to empty the queue.
- Every row shows how long the file runs. If you are part way through one, a second, dimmer time underneath shows how much is left (`-3:26`).
- Each file remembers where you paused it, so jumping away and coming back resumes rather than restarting.
- **The queue is saved across restarts.** Reopen Maestro and a half-listened playlist is still there, paused, with your positions and times intact. Nothing starts playing on its own at launch.

**Recently played** (the clock icon) lists what you have already played, newest first, with the currently loaded file marked and the same times on each row. Click any entry to jump straight to it - that is how you get back to something that is neither adjacent in the queue nor currently loaded. An entry works even after you drop the file from the queue; picking it puts the file back.

Recently played is per session and is deliberately **not** saved across restarts. A fresh session opens on your queue, not on a log of last week's files.

Closing the file that is currently playing stops playback - closing is stop, not skip.

## Minimizing and hiding

**Minimize** (the `-` button) collapses the player to a compact pill that keeps a play/pause button. It is still fully draggable, and playback continues - the transport is only clipped out of view, not unloaded.

**Hide** (the `x` button) removes the player from the screen _without stopping playback_. Hiding a control should not have the side effect of stopping your audio.

While the player is hidden, a small **note icon** appears in the Left Bar header next to the Maestro logo, with the name of the loaded file. It pulses while something is playing, so you can always see that the audio is coming from Maestro. Click it to bring the player back. It disappears when you show the player again or empty the queue.

You can also open the Command Palette and run **Show Floating Media Player**, or just open another media file.

## Tips

- Speed and volume changes take effect instantly and carry to the next file, so you can set up a listening session once and open files freely.
- Minimize the player and drag it into a corner for long listening; the pill is small enough to leave parked over the Left Bar.
- The player sits above your workspace but always below modals and the Command Palette, so it can never cover a dialog you are trying to read.
- Playing a video? Resize the player larger by dragging its bottom-right grip, or press `F` for real fullscreen.
- Queue a batch before a long task: select the files in the Files pane, right-click, **Add N to Play Queue**, and they play through one after another while you work.
