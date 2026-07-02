# Maestro Mobile

A chat-only companion app to Maestro desktop, targeting iOS and Android via Expo.

## What this is

This is the native mobile client for [Maestro](https://maestro.sh), providing chat access to your Maestro agents from iOS and Android devices. It connects to a running Maestro desktop instance over WebSocket to display session history, send prompts, and receive streaming assistant responses.

The mobile app is NOT a standalone product - it requires a running Maestro desktop app to function.

## Upstream provenance

This codebase started from [EvanBacon/chat-template](https://github.com/EvanBacon/chat-template) at commit `40379fcbc8d57025e09eef77ae129b7b30b100c7`.

**We are NOT tracking upstream.** The code is now ours and has been modified to integrate with Maestro's WebSocket protocol and session management. Do not attempt to merge upstream changes - evaluate and cherry-pick individual features if needed.

## Prerequisites

- **Xcode 15+** with iOS 17+ SDK (for iOS development)
- **CocoaPods** (`sudo gem install cocoapods`)
- **JDK 17** (for Android development)
- **Android Studio** with SDK 34 and an emulator or device
- **Node.js 18+** and npm

## First-time setup

### 1. Install dependencies

From the `apps/mobile/` directory:

```bash
npm install
cd ios && pod install && cd ..
```

Or if the `ios/` directory doesn't exist yet:

```bash
npm install
npx expo prebuild --platform ios
```

### 2. Run on iOS Simulator

From the repo root:

```bash
npm run dev:mobile:ios
```

This builds the dev client, boots the iPhone 16 Pro simulator, and connects Metro.

### 3. Pair with Maestro desktop

On first launch, the mobile app will automatically navigate to the QR scanner screen. No manual configuration is required.

1. Ensure Maestro desktop is running
2. Go to **Settings > Mobile Devices > Pair New Device**
3. A QR code will appear with a short-lived pairing code (valid for 5 minutes)
4. Point the mobile app's camera at the QR code
5. The app will exchange the code for a long-lived token and store it securely in the device keychain
6. You should now see "Connected" status and your agents will appear in the drawer

The pairing credentials persist across app restarts and survive for 90 days. If you need to re-pair (e.g., after revoking the device from desktop), the app will automatically return to the QR scanner.

### 4. Verify the connection

1. The app should show "Connected" status at the top
2. The first session from your Maestro desktop will be selected automatically
3. Type a message and send - you should see the assistant response stream in

## Status (M3 - Milestone 3: Shippable with Pairing)

The v1 mobile app is feature-complete and shippable. All three milestones have landed:

- **M1 (Hardcoded Chat Works):** Core chat functionality with streaming, markdown rendering
- **M2 (Real App Shell):** Drawer navigation, tab switching, lifecycle management, theme bridging
- **M3 (Shippable with Pairing):** QR pairing, SecureStore persistence, offline queue, test suite, CI gate

### What works

- **QR code pairing:** Scan a QR code from Maestro desktop Settings > Mobile Devices to pair your device. Credentials are stored securely using `expo-secure-store`. No manual config file editing required. Pairing tokens are long-lived (90 days) and survive app/desktop restarts.
- **Offline queue:** Commands typed while disconnected are persisted to AsyncStorage and automatically dispatched in FIFO order when the connection is restored. Queue survives app cold restarts.
- **Session navigation via drawer:** Drawer lists all Sessions (agents) from the connected Maestro desktop, showing session name, agent type badge (Claude Code / Codex / OpenCode / Factory Droid / Copilot CLI / Terminal), and colored state dot (green=idle, yellow=thinking, red=disconnected, pulsing orange=connecting)
- **Tab switching within sessions:** In-screen horizontal tab strip displays AI tabs for the active session. Tapping a pill switches tabs via WebSocket round-trip to desktop
- **Lifecycle management:** `useMaestroConnection` wrapper hook handles AppState and NetInfo events - disconnects immediately on background, reconnects on foreground, handles network changes gracefully. Streaming buffers stale after 10s background are discarded on reconnect
- **Connection status indicator:** Thin pill at top of chat shows "Connected" (green), "Connecting..." (pulsing orange), "Reconnecting..." (yellow), or "Disconnected" (red). Prompt input disables when not connected
- **Full Maestro markdown rendering:**
  - Paragraphs, inline code, fenced code blocks with syntax highlighting (light/dark themes)
  - Headings (h1-h6) with proper mobile sizing
  - Lists (ordered/unordered), links, images (via expo-image with blurhash placeholder)
  - Tables (View-based rows/cells), blockquotes, thematic breaks
  - `[[wiki-link]]` syntax rendered as tappable links with file icon (fires "File preview not available" toast)
- **Accent color from Maestro theme:** Drawer active row, tab strip active pill, send button, links, and streaming cursor all use accent color bridged from the desktop theme
- WebSocket connection to Maestro desktop with auth
- Prompt sending to desktop agent (AI mode only)
- Streaming assistant response rendering with commit on idle
- Tool events shown as "Running: <toolName>" (collapsed, no rich UI)
- **Jest test suite:** 118 tests across 7 test suites covering storage adapter, QR parsing, streaming reconciliation, offline queue replay, and connection lifecycle
- **PR CI gate:** `mobile-checks` job runs TypeScript, ESLint, Jest, and expo-doctor on pull requests touching mobile or shared code

### What doesn't work yet (planned for future milestones)

- Terminal mode (AI mode only for v1)

### Out of scope for v1

Per the design decision log, these features are explicitly deferred to future versions:

**Automation & orchestration:**

- Auto Run (playbook execution from mobile)
- Maestro Cue (event-driven automation)
- Group Chat / Symphony (multi-agent coordination)
- Marketplace (playbook discovery and import)

**Advanced UI features:**

- Git Diff viewing
- Mobile-side settings (beyond pairing management)
- Rich tool-call UI (expandable tool details, diffs, file previews)
- File preview on `[[wiki-link]]` tap (shows toast only)
- Math/LaTeX rendering (displays raw LaTeX as inline code)
- Bionify text formatting

**Connectivity & discovery:**

- Push notifications
- Background refresh
- mDNS/Bonjour discovery (requires manual LAN connection)
- Hosted relay for remote access (LAN-only in v1)

**Distribution & CI:**

- TestFlight automation
- EAS Build CI integration
- `expo export --platform web` (native-only in v1)
- End-to-end (e2e) UI tests

**Maintenance:**

- Upstream chat-template tracking (hard fork - evaluate features individually)

## Distribution

v1 distribution is manual. A formal distribution pipeline (EAS Build CI, automatic TestFlight uploads) is a v2 concern.

### Building for TestFlight

From a Mac with Xcode and valid Apple Developer credentials:

```bash
cd apps/mobile
npx eas build -p ios --profile preview
```

This produces an `.ipa` file. Download it from the EAS dashboard and upload to App Store Connect / TestFlight manually via Transporter or the web interface.

### Development builds

For local development and simulator testing:

```bash
# From repo root
npm run dev:mobile:ios    # iOS Simulator
npm run dev:mobile:android # Android Emulator
```

## Design decisions

The mobile app's architecture was shaped by a 17-decision design session covering:

- App structure (sibling app vs monorepo integration)
- Code sharing strategy (Metro watchFolders + path aliases + shims)
- Navigation model (drawer for Sessions, in-screen tabs for AI tabs)
- Theming approach (accent from Maestro, surfaces from chat-template)
- Pairing flow (QR + short-lived code + long-lived hashed token)
- Streaming reconciliation (buffer-and-commit model)
- Offline behavior (queue to AsyncStorage, FIFO replay)
- Test strategy (Jest + jest-expo, 5 focused test concerns)
- CI strategy (PR-only path-filtered checks, no EAS Build)

The full decision log is captured in the M1/M2/M3 playbook documents at `.maestro/playbooks/2026-06-19-Mobile-Expo-App/`.

## Code rules

### Browser globals are banned

ESLint enforces a `no-restricted-globals` rule that prevents accidental use of browser-only APIs in React Native code. The following globals are banned everywhere in `apps/mobile/**/*.ts*`:

- `window` - Use React Native APIs or a shim
- `document` - Use React Native components
- `localStorage` - Use AsyncStorage or expo-secure-store
- `sessionStorage` - Use AsyncStorage or app state
- `navigator` - Use React Native APIs or expo-device

**Exception:** Files under `apps/mobile/shims/` are exempt. This directory contains platform-specific implementations that provide web-compatible APIs for shared code.

To lint the mobile app:

```bash
npm run lint:mobile
```

## Testing

Run the Jest test suite:

```bash
cd apps/mobile
npm test
```

Or from the repo root:

```bash
npm run test:mobile
```

The test suite covers 5 focused concerns per decision 14A:

1. **Storage adapter** (`src/storage/__tests__/asyncStorageAdapter.test.ts`) - round-trip set/get/remove, null when key missing, JSON-serializable values, key isolation
2. **QR payload parsing** (`src/pairing/__tests__/parseQrPayload.test.ts`) - valid URLs, missing params, malformed URL, wrong scheme, URL-encoded host
3. **Streaming reconciliation** (`src/streaming/__tests__/streamingReconciliation.test.ts`) - assistant text appends to buffer, tool events render discretely, session_state_change to idle commits buffer
4. **Offline queue replay** (`src/__tests__/offlineQueueReplay.test.ts`) - FIFO ordering, failed dispatch re-queues, capacity limits, persistence via storage adapter
5. **Connection lifecycle** (`src/hooks/__tests__/useMaestroConnection.test.ts`) - connect/disconnect on AppState changes, staleness after 10s background, network change handling
