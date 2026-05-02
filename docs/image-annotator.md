---
title: Image Annotator
description: Mark up screenshots and other images with freehand strokes, shapes, and arrows before sending them to your AI agents.
icon: pen-line
---

The Image Annotator is a full-screen modal for drawing on top of images you're about to attach to a prompt. Circle the bug, point an arrow at the misaligned button, scribble a quick note — then save back into the message and send.

It works on every image surface in Maestro: staged attachments in the input area, attachments inside Group Chat, the lightbox preview, and inline images in Auto Run documents.

## Opening the Annotator

A pencil button appears on every image thumbnail Maestro renders:

- **Input area** — Hover any staged image thumbnail and click the pencil overlay in the corner. Saving replaces the staged image in place; the next send will use the annotated version.
- **Group Chat input** — Same hover-overlay pattern on staged thumbnails.
- **Lightbox** — Open any image in the lightbox (`Cmd+Y` / `Ctrl+Y` carousel, or click an attachment) and press the **Annotate** button in the top-right, or use `Cmd+E` / `Ctrl+E`.
- **Auto Run attachments** — Hover an inline image in an Auto Run document and click the pencil overlay. Saving rewrites the file on disk so subsequent runs pick up the annotations.

## Tools

The vertical toolbar lives on the right edge of the modal. Click an icon to switch tools.

| Tool          | Description                                                                                                                        |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **Pen**       | Freehand strokes powered by [perfect-freehand](https://github.com/steveruizok/perfect-freehand) for natural, pressure-aware lines. |
| **Eraser**    | Click any stroke to remove it. Strokes are erased atomically — there's no per-pixel scrubbing.                                     |
| **Pan**       | Click and drag to reposition the image. You can also hold `Space` or `Shift` while using any other tool.                           |
| **Rectangle** | Drag to draw a bounding box. Toggle the fill handle to switch between outline and filled.                                          |
| **Ellipse**   | Drag to draw an oval — useful for circling specific regions.                                                                       |
| **Arrow**     | Drag from the tail to the head. Direction is preserved.                                                                            |
| **Undo**      | Removes the last stroke or shape. Walks a unified history so it works regardless of which tool created the item.                   |
| **Clear**     | Wipes every stroke and shape. Inline confirmation prompt so you don't lose work by accident.                                       |

Shapes are first-class objects after they're committed:

- **Click** a shape to select it. Resize handles appear at the corners (rect / ellipse) or at each end (arrow).
- **Drag** the body to reposition.
- **Drag a handle** to resize.
- For rect / ellipse, a small fill toggle appears next to the selected shape — click to flip between outlined and filled.
- Press `Delete` or `Backspace` while a shape is selected to remove it.

Pen strokes are immutable once committed — they can be erased or undone, but not edited. This keeps freehand input fast and predictable.

## Pen settings

Click the sliders icon in the toolbar to slide out the **Drawing settings** drawer.

- **Color** — Eight preset swatches plus a custom hex picker. The active swatch persists across sessions.
- **Size** — Pen width in pixels (1–64).
- **Thinning** — How much pointer pressure affects stroke width (0–1).
- **Smoothing** — Curve smoothing applied to the raw input (0–1).
- **Streamline** — Pointer-jitter dampening; higher values produce steadier lines for shaky hands or trackpad use (0–1).
- **Taper Start** / **Taper End** — Pixel distance over which strokes fade in / out at each end. Useful for arrow-tip aesthetics.

Settings apply immediately and are remembered across the app — including a **Reset to defaults** button at the bottom of the drawer.

Each stroke and shape captures the style in effect at the time it was drawn, so changing settings later only affects new content.

## Saving and copying

Two ways to leave the annotator with your work intact:

- **Save** (green check icon, `Cmd+S` / `Ctrl+S`) — Composites the annotations onto the underlying image and returns the result to whatever opened the annotator. For staged images, this updates the thumbnail; for the lightbox, it writes back to the originating message; for Auto Run attachments, it rewrites the file on disk.
- **Copy** (clipboard icon) — Composites and copies the annotated PNG to your system clipboard without closing the modal. A "Copied annotated image to clipboard" flash confirms success. Handy when you want to drop the annotated screenshot into a different message, a Slack thread, or a GitHub issue.

**Cancel** (`Esc` or the X button) discards all changes.

## Keyboard shortcuts

| Shortcut                         | Action                                               |
| -------------------------------- | ---------------------------------------------------- |
| `Cmd+E` / `Ctrl+E` (in Lightbox) | Open the annotator on the current lightbox image     |
| `Cmd+S` / `Ctrl+S`               | Save and exit                                        |
| `Cmd+Z` / `Ctrl+Z`               | Undo last stroke or shape                            |
| `Esc`                            | Cancel selection or close the modal                  |
| `Delete` / `Backspace`           | Delete the selected shape                            |
| `0`                              | Reset zoom and pan                                   |
| `f`                              | Fit image to viewport                                |
| `Space` (hold)                   | Temporarily switch to pan, regardless of active tool |
| `Shift` (hold)                   | Same — temporary pan                                 |
| Mouse wheel / trackpad scroll    | Zoom at cursor (5%–2000%)                            |

The annotator's shortcuts are bound at the modal layer with capture-phase priority, so they always win over the rest of the app's keymap while the modal is open.

## Tips

- The annotator works directly on the image's native pixels — no resampling — so saved annotations are pixel-perfect even on retina captures.
- Pair with the **Image Carousel** (`Cmd+Y` / `Ctrl+Y`) to flip through staged images and annotate each in turn.
- For long-form markup (mockups, design feedback), draw with **Streamline** turned up to ~0.7 — it gives surprisingly clean lines from a regular trackpad.
- The clipboard copy flow is the fastest way to share an annotated screenshot outside Maestro: open the lightbox on any past attachment, press `Cmd+E`, mark it up, then click the copy icon and paste anywhere.
