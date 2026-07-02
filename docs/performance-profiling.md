---
title: Performance Profiling
description: Capture a performance trace in Maestro and share it with us to help diagnose UI slowness.
icon: gauge-high
---

If Maestro's UI feels laggy or sluggish - typing that can't keep up, slow agent or tab switching, a panel that stutters when it opens - you can capture a performance trace and send it to us. A trace tells us exactly where the app is spending its time, which is far more actionable than a description of "it feels slow."

The fastest way is built right into the app and needs no setup. There's also an advanced React profile for when we ask for component-level render data.

## Capture a trace from the app (recommended)

The built-in profiler records what Maestro is doing while you reproduce the slowness, then saves it as a single compressed file you can send us. It works on any installed build - no developer tools, no source checkout.

### Step 1: Start profiling

Open the command palette with `Cmd+K` (`Ctrl+K` on Windows and Linux), type **profiling**, and choose **Debug: Start Performance Profiling**.

<Note>
While a trace is recording, the wand icon in the top-left corner glows red and pulses. That's your reminder that profiling is on - it keeps running until you stop it.
</Note>

### Step 2: Reproduce the slowness

With recording on, do the things that feel slow:

- Typing in the prompt input
- Switching between agents in the Left Bar
- Switching tabs, or opening a file
- Opening the Right Bar, Settings, or the image editor
- Whatever feels sluggish in your normal workflow

**Keep it short and focused.** A few seconds of the actual slow behavior is far more useful to us than minutes of everything. If you're chasing one specific lag, reproduce just that, two or three times.

### Step 3: Stop profiling and save

Open the command palette again (`Cmd+K`) and choose **Debug: End Performance Profiling**. This option only appears while a recording is active.

Maestro opens a Save dialog with a default name like `maestro-profile-2026-06-28T14-30-00.zip` on your Desktop. Pick a location and save. A progress window then shows the capture being stopped and compressed - a large trace can take tens of seconds to zip, so the bar keeps you posted until the file is written.

### Step 4: Send us the trace

Attach the `.zip` to one of:

- A [GitHub Issue](https://github.com/RunMaestro/Maestro/issues) describing what felt slow
- A message in our [Discord](https://runmaestro.ai/discord)

Include a quick note about what you were doing when it lagged (for example, "typing in the prompt with 30+ agents in the Left Bar"). That context helps us line the trace up with the moment of slowness.

## What's in the trace

The `.zip` contains two files:

| File            | Contents                                                                          |
| --------------- | --------------------------------------------------------------------------------- |
| `trace.json`    | The raw timeline of rendering, layout, and JavaScript activity during the capture |
| `metadata.json` | Your Maestro version, OS, CPU, memory, and how long the recording ran             |

The trace records **performance timing, not your data**. It does not include conversation content, API keys, or tokens.

<Warning>
A trace can contain file paths and script URLs from your machine. Give the file a quick look before posting it in a public GitHub issue, or send it to us privately on [Discord](https://runmaestro.ai/discord) if you'd rather not share those openly.
</Warning>

<Tip>
The most useful trace is a focused 5-10 second capture of the one action that feels slow. Start recording, reproduce it a couple of times, stop. Short and targeted beats long and broad every time.
</Tip>

## Advanced: React component profile

When we're chasing a specific re-render problem we may ask for a React profile instead. It captures component-level render timing and requires running Maestro from source. This process takes about 5 minutes and captures only React rendering metrics.

### Prerequisites

- [Node.js](https://nodejs.org/) and npm installed
- Maestro cloned from source (`git clone https://github.com/RunMaestro/Maestro.git`) with dependencies installed (`npm install`)
- **Close the production Maestro app** before starting - dev mode with production data shares the same data directory

### Step 1: Launch React Developer Tools

Maestro is an Electron app, so the browser extension won't work. Install the standalone React DevTools instead:

```bash
npx react-devtools
```

This opens React DevTools in its own window. **Leave it running** - Maestro connects to it automatically in dev mode.

### Step 2: Start Maestro with your production data

In a separate terminal, from the Maestro repo:

```bash
npm run dev:prod-data
```

This launches Maestro in development mode but uses your real data directory - same agents, sessions, groups, and configuration you use day-to-day. You should see all your existing agents populate in the Left Bar.

<Warning>
Make sure the production Maestro app is fully closed first. Running both simultaneously against the same data directory can cause conflicts.
</Warning>

Once Maestro opens, the React DevTools window should display the component tree. If it still says "Waiting for React to connect…", restart DevTools (`npx react-devtools`) and then restart Maestro (`Ctrl+C` and re-run `npm run dev:prod-data`).

### Step 3: Start profiling

1. In the React DevTools window, click the **Profiler** tab (next to "Components")
2. Click the blue **Record** button (circle icon) to start profiling
3. You should see a "Profiling..." indicator confirming it's recording

<Tip>
Before recording, open the Profiler settings (gear icon) and enable **"Record why each component rendered while profiling"**. This gives us the most useful diagnostic data.
</Tip>

### Step 4: Reproduce the slowness

With profiling active, perform the actions that trigger lag (switching agents, scrolling long conversations, opening modals, typing in the input area). Reproduce the slow behavior 2-3 times, then stop. A short, targeted profile is far more useful than a 10-minute recording of everything.

### Step 5: Stop profiling

Click the **Record** button again (it turns from red back to blue) to stop recording. The Profiler renders a flamegraph and ranked chart showing all the React commits (re-renders) it captured.

### Step 6: Export and send the profile

1. In the Profiler tab, click the **export** button (the down-arrow icon in the top-left area of the profiler panel)
2. Save the `.json` file somewhere accessible (e.g., your Desktop)
3. Attach it to a [GitHub Issue](https://github.com/RunMaestro/Maestro/issues) or a [Discord](https://runmaestro.ai/discord) message

The exported React profile contains **only React rendering metrics**:

| Included                             | Not Included                     |
| ------------------------------------ | -------------------------------- |
| Component names and render durations | Conversation content             |
| What triggered each re-render        | API keys or tokens               |
| Render counts per component          | File contents from your projects |
| Component tree structure             | Personal data                    |

The React profile is safe to share publicly.
