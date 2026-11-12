<!--
Desktop application instrumentation over the Chrome DevTools Protocol (CDP). Pulled on demand from the system prompt's Reference Index; the system prompt keeps only the trigger and the must-not-break rules.
-->

# Instrumenting Desktop Applications (CDP)

When a task needs you to inspect, drive, debug, or verify a **desktop application**, look for the **Chrome DevTools Protocol (CDP)** first. Every Electron app and every Chromium browser speaks it. CDP gives you the live DOM, `Runtime.evaluate` inside the page, console and network events, and exact screenshots, without moving the mouse or taking focus. Screenshot-and-click automation, accessibility-tree scraping, and AppleScript are fallbacks for apps that do not speak CDP.

## Which apps speak CDP

**These popular applications are CDP-accessible:** Claude (including Cowork), Slack, Discord, Signal, Mattermost, Element, Notion, Obsidian, Logseq, Linear, Asana, ClickUp, Todoist, Figma, Canva, Framer, Miro, Superhuman, Granola, Wispr Flow, Loom, VS Code, Cursor, Windsurf, Kiro, Antigravity, GitHub Desktop, Docker Desktop, Rancher Desktop, Postman, Insomnia, HTTPie, MongoDB Compass, Beekeeper Studio, Hyper, Tabby, Keybase, Raindrop.io, balenaEtcher, Maestro, Spotify (CEF), Google Chrome, Chromium, Brave, Microsoft Edge, Arc, Dia, Vivaldi, Opera, Comet, ChatGPT Atlas.

Not on the list, and not CDP-accessible on macOS: the ChatGPT, Perplexity, WhatsApp, and Microsoft Teams desktop apps use native or WebKit views. Password managers (1Password, Bitwarden) are Electron, but never instrument them. Do not assume an app speaks CDP because its web version runs in a browser. To check an app that is not listed, look for `Contents/Frameworks/Electron Framework.framework` (or `Chromium Embedded Framework.framework`) inside its `.app` bundle. Some apps on the list strip the debug switch in release builds; if `/json/version` does not answer after a relaunch with the flag, fall back.

## Finding and connecting

Find an open debug port before you do anything else:

```bash
# Which processes already listen? Look for the app's process name.
lsof -nP -iTCP -sTCP:LISTEN | grep -iE 'electron|chrome|<app-name>'

# Confirm the port speaks CDP and list its page targets
curl -s http://127.0.0.1:<port>/json/version
curl -s http://127.0.0.1:<port>/json/list
```

Then connect a client to a target's `webSocketDebuggerUrl`: Playwright `chromium.connectOverCDP()`, Puppeteer `puppeteer.connect()`, `chrome-remote-interface`, or a short raw `ws` script.

## Rules

- **Look before you launch.** With no open port, the app must be started with `--remote-debugging-port=<port>`. Relaunching quits the user's running instance and can lose their unsaved state, so confirm before you restart an app they have open. When you start your own instance for testing, give it a separate profile or data directory so it does not touch theirs.
- **For an app you are building, wire the port in.** Check the project's dev scripts for an existing CDP flag or env var and use it. If there is none and you need repeatable instrumentation, an opt-in one is a reasonable addition.
- **Inspect before you mutate.** `Runtime.evaluate` runs with the app's full privileges against the user's real data. Treat a write (sending a message, deleting, changing settings) like any other destructive action and confirm first.
- **Loopback only.** An open debug port is code execution for anyone who can reach it. Never bind it to `0.0.0.0`, and close every instance you started when you finish.
- **Kill your own instance by its port** (`lsof -ti :<port> | xargs kill`), not by a name match, and confirm the port is free afterwards. An orphaned instance can keep answering `/json/list` while its page is frozen, and every CDP call then hangs.
- **CDP scripts are throwaway.** Write them outside the project (or delete them when done). They are debugging scaffolding, not deliverables.

**The Conductor Profile overrides the tool choice.** If it names an instrumentation tool (one that wraps CDP, or drives native apps), use that tool. The principle still holds: prefer the app's own debug protocol over pixel automation.
