# Maestro

> A unified, highly-responsive developer IDE for managing multiple AI coding assistants simultaneously.

Maestro is a desktop application built with Electron that allows you to run and manage multiple AI coding tools (Claude Code, Aider, OpenCode, etc.) in parallel with a Linear/Superhuman-level responsive interface.

## Features

- 🚀 **Multi-Instance Management** - Run multiple AI assistants and terminal sessions simultaneously
- 🎨 **Beautiful UI** - Obsidian-inspired themes with keyboard-first navigation
- 🔄 **Dual-Mode Input** - Switch between terminal and AI interaction modes seamlessly
- 📊 **Context Tracking** - Monitor token usage and context windows in real-time
- 🌐 **Remote Access** - Built-in web server with optional ngrok/Cloudflare tunneling
- 🎯 **Git Integration** - Automatic git status, diff tracking, and workspace detection
- ⚡ **Keyboard Shortcuts** - Full keyboard control with customizable shortcuts
- 📝 **Session Management** - Group, rename, and organize your sessions
- 🎭 **Multiple Themes** - Dracula, Monokai, GitHub Light, and Solarized

## Quick Start

### Prerequisites

- Node.js 20+
- npm or yarn
- Git (optional, for git-aware features)

### Installation

```bash
# Clone the repository
git clone https://github.com/yourusername/maestro.git
cd maestro

# Install dependencies
npm install

# Run in development mode
npm run dev

# Build for production
npm run build

# Package for distribution
npm run package
```

### Platform-Specific Builds

```bash
# macOS only
npm run package:mac

# Windows only
npm run package:win

# Linux only
npm run package:linux
```

## Development

### Project Structure

```
maestro/
├── src/
│   ├── main/              # Electron main process
│   │   ├── index.ts       # Main entry point
│   │   ├── process-manager.ts  # CLI tool spawning
│   │   ├── web-server.ts  # Remote access server
│   │   ├── preload.ts     # IPC bridge
│   │   └── utils/         # Utilities
│   └── renderer/          # React frontend
│       ├── App.tsx        # Main UI component
│       ├── main.tsx       # Renderer entry
│       └── index.css      # Styles
├── build/                 # App icons
├── .github/workflows/     # CI/CD
└── dist/                  # Build output
```

### Tech Stack

**Backend (Electron Main)**
- Electron 28+
- TypeScript
- node-pty (terminal emulation)
- Fastify (web server)
- electron-store (settings persistence)

**Frontend (Renderer)**
- React 18
- TypeScript
- Tailwind CSS
- Vite
- Lucide React (icons)

### Development Scripts

```bash
# Start dev server with hot reload
npm run dev

# Build main process only
npm run build:main

# Build renderer only
npm run build:renderer

# Full production build
npm run build

# Start built application
npm start
```

## Building for Release

### 1. Prepare Icons

Place your application icons in the `build/` directory:
- `icon.icns` - macOS (512x512 or 1024x1024)
- `icon.ico` - Windows (256x256)
- `icon.png` - Linux (512x512)

### 2. Update Version

Update version in `package.json`:
```json
{
  "version": "0.1.0"
}
```

### 3. Build Distributables

```bash
# Build for all platforms
npm run package

# Platform-specific
npm run package:mac    # Creates .dmg and .zip
npm run package:win    # Creates .exe installer
npm run package:linux  # Creates .AppImage, .deb, .rpm
```

Output will be in the `release/` directory.

## GitHub Actions Workflow

The project includes automated builds via GitHub Actions:

1. **Create a release tag:**
   ```bash
   git tag v0.1.0
   git push origin v0.1.0
   ```

2. **GitHub Actions will automatically:**
   - Build for macOS, Windows, and Linux
   - Create release artifacts
   - Publish a GitHub Release with downloads

## Configuration

Settings are stored in:
- **macOS**: `~/Library/Application Support/maestro/`
- **Windows**: `%APPDATA%/maestro/`
- **Linux**: `~/.config/maestro/`

### Configuration Files

- `maestro-settings.json` - User preferences (theme, shortcuts, API keys)
- `maestro-sessions.json` - Session persistence
- `maestro-groups.json` - Session groups

## Architecture

### Process Management

Maestro uses a dual-process model:

1. **PTY Processes** - For terminal sessions (full shell emulation)
2. **Child Processes** - For AI tools (Claude Code, Aider, etc.)

All processes are managed through IPC (Inter-Process Communication) with secure context isolation.

### Security

- ✅ Context isolation enabled
- ✅ No node integration in renderer
- ✅ Secure IPC via preload script
- ✅ No shell injection (uses `execFile` instead of `exec`)
- ✅ Input sanitization for all user inputs

## Keyboard Shortcuts

| Action | Shortcut |
|--------|----------|
| Quick Actions | `⌘K` / `Ctrl+K` |
| Toggle Sidebar | `⌘B` / `Ctrl+B` |
| Toggle Right Panel | `⌘\` / `Ctrl+\` |
| New Instance | `⌘N` / `Ctrl+N` |
| Kill Instance | `⌘⌫` / `Ctrl+Backspace` |
| Previous Instance | `⌘⇧{` / `Ctrl+Shift+{` |
| Next Instance | `⌘⇧}` / `Ctrl+Shift+}` |
| Switch AI/Shell Mode | `⌘J` / `Ctrl+J` |
| Show Shortcuts | `⌘/` / `Ctrl+/` |

*All shortcuts are customizable in Settings*

## Remote Access

Maestro includes a built-in web server for remote access:

1. **Local Access**: `http://localhost:8000`
2. **LAN Access**: `http://[your-ip]:8000`
3. **Public Access**: Enable ngrok/Cloudflare tunnel in Settings

### Enabling Public Tunnels

1. Get an ngrok auth token from https://ngrok.com
2. Open Settings → Network
3. Enter your ngrok API key
4. Click the tunnel button on any session
