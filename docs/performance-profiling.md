---
title: Performance Profiling
description: Capture a React DevTools performance profile to help diagnose UI slowness in Maestro.
icon: gauge-high
---

If you're experiencing UI lag or sluggishness, a React performance profile helps us pinpoint exactly which components are causing slowdowns. The process takes about 5 minutes and captures render timing data — no conversation content, API keys, or personal data.

## Prerequisites

- [Node.js](https://nodejs.org/) and npm installed
- Maestro cloned from source (`git clone https://github.com/RunMaestro/Maestro.git`) with dependencies installed (`npm install`)
- **Close the production Maestro app** before starting — dev mode with production data shares the same data directory

## Step 1: Launch React Developer Tools

Maestro is an Electron app, so the browser extension won't work. Install the standalone React DevTools instead:

```bash
npx react-devtools
```

This opens React DevTools in its own window. **Leave it running** — Maestro connects to it automatically in dev mode.

## Step 2: Start Maestro with Your Production Data

In a separate terminal, from the Maestro repo:

```bash
npm run dev:prod-data
```

This launches Maestro in development mode but uses your real data directory — same agents, sessions, groups, and configuration you use day-to-day. You should see all your existing agents populate in the Left Bar.

<Warning>
Make sure the production Maestro app is fully closed first. Running both simultaneously against the same data directory can cause conflicts.
</Warning>

Once Maestro opens, the React DevTools window should display the component tree. If it still says "Waiting for React to connect…", restart DevTools (`npx react-devtools`) and then restart Maestro (`Ctrl+C` and re-run `npm run dev:prod-data`).

## Step 3: Start Profiling

1. In the React DevTools window, click the **Profiler** tab (next to "Components")
2. Click the blue **Record** button (circle icon) to start profiling
3. You should see a "Profiling..." indicator confirming it's recording

<Tip>
Before recording, open the Profiler settings (gear icon) and enable **"Record why each component rendered while profiling"**. This gives us the most useful diagnostic data.
</Tip>

## Step 4: Reproduce the Slowness

With profiling active, perform the actions that trigger lag. For example:

- Switching between agents in the Left Bar
- Scrolling through long conversations
- Opening/closing the Right Bar or Settings modal
- Creating, renaming, or grouping agents
- Typing in the input area
- Whatever feels slow in your normal workflow

**Keep it focused** — reproduce the slow behavior 2–3 times, then stop. A short, targeted profile is far more useful than a 10-minute recording of everything.

## Step 5: Stop Profiling

Click the **Record** button again (it turns from red back to blue) to stop recording. The Profiler will render a flamegraph and ranked chart showing all the React commits (re-renders) it captured.

## Step 6: Export the Profile

1. In the Profiler tab, click the **export** button (⬇ down-arrow icon in the top-left area of the profiler panel)
2. Save the `.json` file somewhere accessible (e.g., your Desktop)

## Step 7: Send Us the Profile

Attach the exported `.json` file to one of:

- A [GitHub Issue](https://github.com/RunMaestro/Maestro/issues) describing what felt slow
- A message in our [Discord](https://runmaestro.ai/discord)

Include a brief description of what you were doing when the slowness occurred (e.g., "switching between agents with 20+ sessions open").

## What's in the Profile

The exported file contains **only React rendering metrics**:

| Included | Not Included |
|----------|--------------|
| Component names and render durations | Conversation content |
| What triggered each re-render | API keys or tokens |
| Render counts per component | File contents from your projects |
| Component tree structure | Personal data |

The profile is safe to share publicly.
