# **Project Specification: Multi-Instance AI Coding Console (MACC)**
*A phased, validated-primitive product requirements document for engineering.*

---

# **0. Product Summary**
MACC is a unified, highly-responsive developer IDE that manages multiple AI coding assistants (Claude Code, Aider, OpenCode, Codex, etc.) simultaneously.  
It runs as an Electron desktop application with a fully responsive interface that also exposes a web-view for mobile access.  
Each “instance” behaves like a worker: showing state, logs, artifacts, diffs, and contextual metadata.  

The app emphasizes:
- Obsidian-like UI (themes, fixed-width fonts, panel layout)
- Linear/Superhuman-level responsiveness + keyboard-first UX
- Full per-instance lifecycle control (create, resume, terminate)
- Support for Git and non-Git workspaces
- Artifact tracking, semantic worklogs, context usage visualization
- Remote control via auto-tunneled HTTPS endpoints (ngrok)
- Generic support for any CLI-based AI coding tool with no modifications required.

The specification is broken into **phases**, each ending in a **primitive** that must be validated before continuing.

---

# **PHASE 1 — Core Architectural Primitives**

## **1.1 Primitive: Process Manager**
**Goal**: A minimal Electron backend that can launch arbitrary CLI tools, track PID, and capture raw stdout/stderr streams.

### **Requirements**
- Electron main process spawns child processes.
- Output is captured line-by-line in a structured format.
- Input can be sent via STDIN.
- Must work with any CLI tool, unchanged.
- Supports persistent process registry (ID, type, path, state).

### **Validation Criteria**
- Launch any AI CLI (Claude Code, Aider, etc.) and see raw output streaming into a debug pane.
- Send simple commands via STDIN.
- Kill and restart processes.

---

## **1.2 Primitive: Unified Session Model**
**Goal**: A generic model for a “Session” that abstracts Claude Code, Aider, Codex, etc. into the same interface.

### **Requirements**
- Attributes:
  - `sessionId`
  - `sessionName`
  - `toolType` (claude, aider, opencode, custom)
  - `cwd` (working dir)
  - `state` (idle, busy)
  - `stdinMode` (terminal vs. AI)
  - `contextUsage` (%)
  - `stdoutLog[]`
  - `semanticLog[]` (future)
  - `artifacts[]`
- Pluggable command templates per tool type:
  - Start command
  - Resume command (if applicable)
  - Batch/script command flags

### **Validation Criteria**
- Create a session pointing to Claude Code or Aider and confirm identical behaviors via the unified object.
- Switching toolType requires no UI changes.

---

## **1.3 Primitive: Dual-Mode Input Router**
**Goal**: Toggle between:
1. **Terminal Mode** → sends raw shell commands to the OS.
2. **AI Interaction Mode** → sends input to the AI process.

### **Requirements**
- UI toggle switch.
- Terminal mode uses node-pty or equivalent pseudoterminal.
- AI mode uses direct STDIN to the assistant process.
- Visual indication of current mode.

### **Validation Criteria**
- Send `ls` in terminal mode and get directory listing.
- Send message in AI mode and receive assistant output.
- No cross-contamination.

---

# **PHASE 2 — UI Foundations**

## **2.1 Primitive: Obsidian-Inspired Visual System**
**Goal**: Core layout and theming.

### **Requirements**
- Fixed-width fonts everywhere.
- Theme engine with:
  - Dracula (default)
  - Dark
  - Light
  - Monokai
- Minimalistic panel layout:
  - Session list (left)
  - Workspace panel (center)
  - Logs/Artifacts panel (right)
- Responsive grid that collapses elegantly for mobile web.

### **Validation Criteria**
- Theme switching works live.
- Layout remains stable on window resize.
- Mobile view loads via localhost.

---

## **2.2 Primitive: Keyboard-First Navigation**
**Goal**: Achieve Linear/Superhuman responsiveness.

### **Requirements**
- Global shortcuts:
  - `⌘K / Ctrl+K` command palette
  - `⌘1,2,3` for switching major panels
  - `⌘⇧N` create new session
  - `⌘[` and `⌘]` cycle sessions
- Per-session shortcuts:
  - Toggle terminal/AI mode
  - Kill/restart instance
- Low-latency event pipeline (< 16ms UI update target)

### **Validation Criteria**
- Command palette works.
- All shortcuts trigger instantly.
- No perceptible lag (< ~30ms worst case).

---

# **PHASE 3 — Session Intelligence Layer**

## **3.1 Primitive: Auto-Generated Description**
**Goal**: Session auto-describes its purpose based on recent activity.

### **Requirements**
- Analyze last N messages.
- Generate a one-sentence summary.
- Update after every user instruction.
- Display under session name.

### **Validation Criteria**
- Summary updates correctly when switching tasks.
- Descriptions feel accurate.

---

## **3.2 Primitive: Semantic Worklog Engine**
**Goal**: Maintain a human-readable summary of activity per instance.

### **Requirements**
- Summaries generated incrementally:
  - What tasks were attempted?
  - What results occurred?
  - What files changed?
  - What errors occurred?
- Stored as structured entries.

### **Validation Criteria**
- After a session with multiple commands, worklog renders meaningful history.
- Semantic entries correlate with artifacts/diffs.

---

## **3.3 Primitive: Context Window Analyzer**
**Goal**: Display % context used for each assistant.

### **Requirements**
- Query tool APIs for context usage when available (Claude Code supports this).
- Estimate context via tokenization fallback for tools lacking API.
- Show progress bar (0–100%).

### **Validation Criteria**
- Claude Code sessions show real usage.
- Other tools display estimated usage.

---

# **PHASE 4 — Workspace Intelligence**

## **4.1 Primitive: Dual Workspace Modes**
**Goal**: Behavior changes depending on whether the session is in a Git repo.

### **Requirements**
- Auto-detect Git repo.
- If **Git workspace**:
  - Show “Changed Files” list (`git diff --name-only`)
  - On click → show full diff
- If **Non-Git workspace**:
  - Track file changes (created, modified, deleted)
  - Display artifact list
  - Link artifacts to semantic worklog

### **Validation Criteria**
- Switching between Git and non-Git folders produces different UI.
- Diffs display cleanly.
- Artifacts tracked reliably.

---

# **PHASE 5 — State, Status & Control Layer**

## **5.1 Primitive: Status Indicators**
**Goal**: Show live state of each instance.

### **Requirements**
- Green = idle / awaiting input.
- Red = busy / processing.
- Update state based on stdout patterns & timing.

### **Validation Criteria**
- Status flips to “busy” on any processing.
- Returns to “idle” after output completion.

---

## **5.2 Primitive: Session Lifecycle Controls**
**Goal**: Full process management.

### **Requirements**
- Buttons:
  - Start
  - Resume
  - Stop/Kill
  - Duplicate session
- Safe shutdown logic.

### **Validation Criteria**
- Perform lifecycle control on all supported tools.
- No orphaned processes.

---

# **PHASE 6 — Remote Access & Tunneling**

## **6.1 Primitive: Local Web Server**
**Goal**: Expose a web-based interface with responsive layout.

### **Requirements**
- Serves:
  - Session list
  - Log viewer
  - Input pane
  - Mobile-friendly navigation
- Read-only mode toggle (security)

### **Validation Criteria**
- Accessed from phone on LAN.
- Full session control works.

---

## **6.2 Primitive: Integrated ngrok Tunneling**
**Goal**: One-click public remote access.

### **Requirements**
- User enters ngrok API key once.
- A button toggles tunnel on/off.
- Electron app retrieves and displays:
  - Public URL
  - Connection status
- Automatic reconnect on failure.

### **Validation Criteria**
- Tunnel spins up with one click.
- Mobile access works over LTE.
- Reconnecting maintains session state.

---

# **PHASE 7 — Performance & Polish**

## **7.1 Primitive: High-Responsiveness Engine**
**Goal**: Match Linear/Superhuman’s feel.

### **Requirements**
- Pre-render critical views.
- Use React + TypeScript + Recoil/Zustand for low latency.
- GPU rendering hints (CSS transform layering).
- WebSocket bridge with main process for real-time output.

### **Validation Criteria**
- Session switching < 50ms.
- Keyboard commands < 30ms response.
- Streaming output renders with minimal delay.

---

## **7.2 Primitive: Extension & Plugin System**
**Goal**: Allow future support for more AI tools or features.

### **Requirements**
- Configurable tool definitions:
  - Startup commands
  - Flags
  - Output parsing rules
- User-added tool templates.

### **Validation Criteria**
- Adding a new tool requires no core code modification.
- YAML/JSON templates work successfully.

---

# **PHASE 8 — Final Integration & UX Polish**

## **8.1 Primitive: Unified Project Pane**
**Goal**: Provide high-level visibility across all sessions.

### **Requirements**
- Master session dashboard:
  - Status indicators
  - Descriptions
  - Context bars
  - Git/non-Git badges
- Global search.

### **Validation Criteria**
- Dashboard accurately reflects all instance states.
- Search finds sessions, logs, and artifacts.

---

## **8.2 Primitive: Multi-Device Continuity**
**Goal**: Seamless transition between desktop and mobile.

### **Requirements**
- Shared session state between desktop UI and web UI.
- Live sync of logs and output streams.

### **Validation Criteria**
- Actions performed on phone instantly reflect on desktop.
- Desktop input reflects on mobile viewer.

---

# **TECHNICAL STACK DECISIONS**

### **Electron**
- Desktop environment  
- Mobility via embedded webserver  

### **Frontend**
- React  
- TypeScript  
- Zustand (store)  
- Tailwind or custom styling engine  
- Monaco editor for diff rendering  

### **Backend**
- Node.js  
- node-pty for terminal mode  
- Child process spawn for AI tools  
- Fastify or Express for local web server  
- WebSocket bridge for real-time updates  

### **Remote Access**
- ngrok (free tier)  


