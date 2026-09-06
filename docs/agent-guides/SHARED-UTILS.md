<!-- Verified 2026-04-10 against origin/rc (06e5a2eb3) -->

# Shared Utilities Reference

All utilities in Maestro organized by category. Each entry lists the file path, function name, signature, purpose, and which process it runs in (Main, Renderer, or Both via `src/shared/`).

---

## IDs & UUIDs

| Function       | File                        | Signature      | Process  | Purpose                                                                                    |
| -------------- | --------------------------- | -------------- | -------- | ------------------------------------------------------------------------------------------ |
| `generateUUID` | `src/shared/uuid.ts`        | `() => string` | Both     | RFC 4122 v4 UUID via Math.random(). Used for session IDs, history entry IDs.               |
| `generateId`   | `src/renderer/utils/ids.ts` | `() => string` | Renderer | Wrapper around `crypto.randomUUID()`. Cryptographically secure. Used for UI-generated IDs. |

---

## Agent IDs & Metadata

| Function / Constant       | File                                | Signature                                                                 | Process  | Purpose                                                                                                                                                                                                                                                    |
| ------------------------- | ----------------------------------- | ------------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AGENT_IDS`               | `src/shared/agentIds.ts`            | `readonly string[]`                                                       | Both     | Single source of truth: `['terminal', 'claude-code', 'codex', 'gemini-cli', 'qwen3-coder', 'opencode', 'factory-droid', 'copilot-cli']`                                                                                                                    |
| `AgentId`                 | `src/shared/agentIds.ts`            | Type derived from `AGENT_IDS`                                             | Both     | Union type of all valid agent IDs.                                                                                                                                                                                                                         |
| `isValidAgentId`          | `src/shared/agentIds.ts`            | `(id: string) => id is AgentId`                                           | Both     | Type guard for agent ID validation.                                                                                                                                                                                                                        |
| `AGENT_DISPLAY_NAMES`     | `src/shared/agentMetadata.ts`       | `Record<AgentId, string>`                                                 | Both     | Internal constant backing `getAgentDisplayName`. **Prefer `getAgentDisplayName()`** for external use - it falls back to the raw id for unknown agents.                                                                                                     |
| `getAgentDisplayName`     | `src/shared/agentMetadata.ts`       | `(agentId: AgentId \| string) => string`                                  | Both     | Get display name, falls back to raw id.                                                                                                                                                                                                                    |
| `BETA_AGENTS`             | `src/shared/agentMetadata.ts`       | `ReadonlySet<AgentId>`                                                    | Both     | Internal constant backing `isBetaAgent`. Currently contains `opencode`, `factory-droid`, and `copilot-cli`. **Prefer `isBetaAgent()`** for external use.                                                                                                   |
| `isBetaAgent`             | `src/shared/agentMetadata.ts`       | `(agentId: AgentId \| string) => boolean`                                 | Both     | Check if an agent is in beta.                                                                                                                                                                                                                              |
| `getAgentLoginCommand`    | `src/shared/agentMetadata.ts`       | `(agentId, customPath?) => AgentLoginCommand \| null`                     | Both     | Re-authentication command for an agent. Returns `null` for `terminal` and for unknown ids: never guess a command to run in a shell. Pass the agent's `customPath` so a non-PATH install still works.                                                       |
| `formatAgentLoginCommand` | `src/shared/agentMetadata.ts`       | `(login, syntax?: LoginShellSyntax) => string`                            | Both     | Render a login command as the single line typed into a shell. Quotes a binary path containing spaces, and in PowerShell prefixes the call operator `&` - without it PowerShell echoes the quoted path instead of running it. `syntax` defaults to `posix`. |
| `loginShellSyntaxFor`     | `src/shared/agentMetadata.ts`       | `(shellId: string, isWindows: boolean) => LoginShellSyntax`               | Both     | Map a Maestro shell id to its command-line dialect (`posix` \| `powershell` \| `cmd`). Everything is `posix` off Windows; Git Bash and WSL stay `posix` on it. Feed the result to `formatAgentLoginCommand`.                                               |
| `DEFAULT_CONTEXT_WINDOWS` | `src/shared/agentConstants.ts`      | `Partial<Record<AgentId, number>>`                                        | Both     | Default context window sizes per agent (e.g., claude-code: 200000).                                                                                                                                                                                        |
| `FALLBACK_CONTEXT_WINDOW` | `src/shared/agentConstants.ts`      | `number` (200000)                                                         | Both     | Fallback when agent has no entry in DEFAULT_CONTEXT_WINDOWS.                                                                                                                                                                                               |
| `COMBINED_CONTEXT_AGENTS` | `src/shared/agentConstants.ts`      | `ReadonlySet<AgentId>`                                                    | Both     | Agents with combined input+output context windows (currently: codex).                                                                                                                                                                                      |
| `getModelFamily`          | `src/renderer/utils/modelFamily.ts` | `(modelId: string) => string`                                             | Renderer | Vendor label for a model id ('Claude', 'OpenAI', 'Gemini', ... else 'Other'). Reads the last segment of a provider-qualified id. Display aid only.                                                                                                         |
| `groupModelsByFamily`     | `src/renderer/utils/modelFamily.ts` | `(models: string[]) => Array<{family: string \| null; models: string[]}>` | Renderer | Group a model catalog by vendor for a picker. Returns one unlabelled group when everything shares a family, so no lone header appears.                                                                                                                     |

---

## Model & Effort Options (Renderer)

An agent's model list, effort levels, and agent-level defaults are fetched
through one hook, and the tab > session > agent-default ladder is applied by one
resolver. Both live in `src/renderer/hooks/agent/useAgentModelEffortOptions.ts`
and are shared by the composer pills (`ModelEffortPills`) and the keyboard-only
picker (`ModelEffortModal`), so the two surfaces cannot disagree about what an
agent offers or what a tab is currently running.

| Function                     | Signature                                                                        | Purpose                                                                                                                                                                                                                                   |
| ---------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `useAgentModelEffortOptions` | `(agentId?: string) => { models, efforts, defaultModel, defaultEffort, loaded }` | Fetches all four with a stale guard. Probes BOTH `effort` and `reasoningEffort` config keys, since agents split between them. `loaded` is false until every lookup settles - an empty list means "still loading" and "not offered" alike. |
| `resolveModelEffort`         | `(tab, session, { defaultModel, defaultEffort }) => { model, effort }`           | Applies tab override > session override > agent default > empty. Do NOT re-derive this ladder inline - it drifts.                                                                                                                         |

Effort options are agent-scoped, not model-scoped: the underlying CLIs expose a
single list per agent, and a model with no reasoning budget just ignores the
flag. Don't invent per-model effort lists without a data source for them.

---

## Agent Environment (`src/shared/agentEnvironment.ts` - Both)

An agent's environment is assembled from three layers, each edited in a different
pane, so "which profile is this agent actually running as?" is a question no
single settings screen can answer. This module does the same merge the spawner
does and reports WHERE each surviving value came from.

Precedence (later wins), mirroring `process:spawnTerminalTab`:

1. `global` - Settings -> Environment, applies to every process Maestro spawns
2. `agent` - Settings -> Agents, applies to every agent of one provider
3. `session` - this agent's own overrides, from Edit Agent

| Function                  | Signature                                              | Purpose                                                                                                                                                                                            |
| ------------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `resolveAgentEnvironment` | `(layers: AgentEnvironmentLayers) => ResolvedEnvVar[]` | Merge the three layers, key-sorted. Each entry carries the winning `source` plus `shadowedBy`, the layers it overrode. Empty-string values are kept: `FOO=` is a real override, not an absent one. |
| `isSecretEnvKey`          | `(key: string) => boolean`                             | Whether a value should be masked until revealed. Matched loosely on purpose - a false positive costs one click, a false negative puts a live key on screen during a screen share.                  |
| `maskEnvValue`            | `(value: string) => string`                            | Mask a secret, keeping the last four characters so one credential is still tellable from another. Values of 8 characters or fewer are masked whole.                                                |
| `envSourceLabel`          | `(source: EnvVarSource) => string`                     | Human label for a layer: `Global`, `Provider`, `This agent`.                                                                                                                                       |

**Do NOT re-derive this merge inline.** The precedence has to match the spawner's
or the UI describes a process nobody is running. Render the result with
[`<EnvVarList>`](UI-PATTERNS.md), which owns the masking and the source badges.
This is distinct from `Settings/EnvVarsEditor`, which EDITS one layer.

---

## Platform Detection

### Both Processes (`src/shared/platformDetection.ts`)

| Function            | Signature       | Purpose                                                       |
| ------------------- | --------------- | ------------------------------------------------------------- |
| `isWindows()`       | `() => boolean` | Platform is `win32`. Resolved at call time (mockable).        |
| `isMacOS()`         | `() => boolean` | Platform is `darwin`.                                         |
| `isLinux()`         | `() => boolean` | Platform is `linux`. Also the fallback when nothing resolves. |
| `getWhichCommand()` | `() => string`  | Returns `'where'` on Windows, `'which'` on Unix.              |

Resolution order: `globalThis.process.platform` first, then the preload bridge at
`globalThis.maestro.platform`, then `'linux'`. The bare `process` identifier is
never touched (that throws a `ReferenceError` in the renderer sandbox).

**The `'browser'` sentinel.** The renderer loads a `process` polyfill
(`src/renderer/public/process-shim.js`) so vendor libs reading `process.env` /
`process.platform` don't throw. It reports `platform: 'browser'`, which is NOT a
real platform - `platformDetection.ts` explicitly rejects that value and falls
through to the preload bridge. Treating it as real is how every macOS renderer
started looking non-Mac and Settings rendered "Ctrl+0" on a Mac. Do not add a
new `process.platform` read in renderer code.

### Renderer Process (`src/renderer/utils/platformUtils.ts`)

Prefer these in renderer-only code - they read the preload bridge directly and
never see the shim.

| Function                   | Signature                      | Purpose                                                        |
| -------------------------- | ------------------------------ | -------------------------------------------------------------- |
| `isWindowsPlatform()`      | `() => boolean`                | Uses `window.maestro.platform` (from preload bridge).          |
| `isMacOSPlatform()`        | `() => boolean`                | Uses `window.maestro.platform`.                                |
| `isLinuxPlatform()`        | `() => boolean`                | Uses `window.maestro.platform`.                                |
| `getRevealLabel(platform)` | `(platform: string) => string` | Platform-appropriate "Reveal in Finder/Explorer/File Manager". |
| `getOpenInLabel(platform)` | `(platform: string) => string` | Platform-appropriate "Open in Finder/Explorer/File Manager".   |

For user-visible modifier keys, don't branch on the platform yourself - use the
[Shortcut Formatter](#shortcut-formatter-srcrendererutilsshortcutformatterts)
helpers below.

### WSL Detection (`src/main/utils/wslDetector.ts` - Main only)

| Function                       | Signature                       | Purpose                                               |
| ------------------------------ | ------------------------------- | ----------------------------------------------------- |
| `isWsl()`                      | `() => boolean`                 | Cached detection via `/proc/version`.                 |
| `isWindowsMountPath(filepath)` | `(filepath: string) => boolean` | Checks if path is `/mnt/[a-z]/...`.                   |
| `checkWslEnvironment(cwd)`     | `(cwd: string) => boolean`      | Log warning if running from Windows mount in WSL.     |
| `getWslWarningMessage()`       | `() => string`                  | User-friendly warning about WSL+Windows mount issues. |

---

## Path & Version Utilities (`src/shared/pathUtils.ts` - Both)

| Function                               | Signature                                       | Purpose                                                                  |
| -------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------ |
| `expandTilde(filePath, homeDir?)`      | `(string, string?) => string`                   | Expand `~` to home directory. Node fs doesn't handle tilde.              |
| `encodeClaudeProjectPath(projectPath)` | `(string) => string`                            | Replace non-alphanumeric chars with `-`. Matches Claude Code's encoding. |
| `parseVersion(version)`                | `(string) => number[]`                          | Parse `"v22.10.0"` or `"0.15.0-rc.1"` to `[22, 10, 0]`.                  |
| `compareVersions(a, b)`                | `(string, string) => number`                    | Semver comparison. Returns 1, -1, or 0. Handles pre-release tags.        |
| `detectNodeVersionManagerBinPaths()`   | `() => string[]`                                | Find nvm, fnm, volta, mise, asdf, n bin paths on Unix.                   |
| `buildExpandedPath(customPaths?)`      | `(string[]?) => string`                         | Build PATH with platform-specific binary locations added.                |
| `buildExpandedEnv(customEnvVars?)`     | `(Record<string,string>?) => NodeJS.ProcessEnv` | Copy of process.env with expanded PATH + custom vars.                    |

---

## String Utilities

### Shared (`src/shared/stringUtils.ts` - Both)

| Function                        | Signature            | Purpose                                                                                                                                                                                                                                    |
| ------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `stripAnsiCodes(text)`          | `(string) => string` | Remove ANSI escape codes, OSC sequences, iTerm2/VSCode shell integration sequences. Handles SSH edge cases.                                                                                                                                |
| `safeDecodeURIComponent(value)` | `(string) => string` | Percent-decode, returning the raw input on malformed escapes (`%`, `%ZZ`) instead of throwing `URIError`. Use for ANY untrusted path/href - agent output and Windows/non-ASCII paths routinely carry a bare `%`. Swallows only `URIError`. |

## Font Utilities (`src/shared/fontStack.ts` - Both)

| Export                                           | Signature                                                              | Purpose                                                                                                                                                                                                                                                              |
| ------------------------------------------------ | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `withMonoFallback(family)`                       | `(string \| undefined \| null) => string`                              | Guarantee a CSS font-family degrades to monospace, not the browser's serif default. Apply where the `fontFamily` setting becomes a CSS value, not at the source (the picker `<select>` needs the raw name). No-ops when the value already carries a generic keyword. |
| `resolveSurfaceFont(surfaceFont, interfaceFont)` | `(string \| undefined \| null, string \| undefined \| null) => string` | Resolve a per-surface font setting against the interface font, then apply the fallback. The empty string means "inherit", so this is what that empty string MEANS - see the note below.                                                                              |
| `MONO_FALLBACK_STACK`                            | `string`                                                               | The safe monospace chain appended by `withMonoFallback` (`ui-monospace` -> ... -> `monospace`). Matches the file-preview surfaces so the whole app degrades to the same faces.                                                                                       |
| `SANS_FALLBACK_STACK`                            | `string`                                                               | The proportional counterpart, for the sans typography preset. Leads with each platform's own UI face so it looks native, and ends in `sans-serif`.                                                                                                                   |
| `WORDMARK_FONT_STACK`                            | `string`                                                               | The MAESTRO wordmark's font. Fixed, and deliberately NOT derived from any setting - a brand mark that changes identity with the reading font is a bug. Kept in sync by hand with the two `index.html` splash rules, which paint before any JavaScript runs.          |

The font picker stores a bare name (`Roboto Mono`) with no generic fallback, which resolves to serif on iOS / the web-desktop bundle. Do NOT re-derive a fallback chain inline; call `withMonoFallback(s.fontFamily)` at the render site.

**Every surface font stores the empty string to mean "inherit the interface font"** (terminal, chat, file preview, file editor), so a surface the user never touches keeps following the UI. `resolveSurfaceFont` is the one place that chain is resolved, which is what keeps the pickers, the rendered surfaces, and any future surface from disagreeing about what empty means: a surface that re-derives it and forgets the `.trim()` renders a whitespace-only family, which resolves to nothing and drops the pane to the browser default. In the renderer, read it through `useSurfaceFontFamily()` / `useSurfaceTypography()` (`src/renderer/hooks/ui/useSurfaceTypography.ts`) rather than calling the resolver against the store by hand - those also apply the one hop of surface-to-surface inheritance (a surface may follow the TERMINAL, not just the interface font).

**A fallback chain is not sufficient on its own for the terminal.** It only covers a font that fails to RESOLVE. A configured font can resolve perfectly and simply not be fixed-pitch, and xterm sizes its grid from the advance of `W` and then puts every glyph on that pitch, so narrow letters trail a gap (`Cl aude`) while wide ones sit flush - the appended generic is never reached because nothing ever fell through to it. CSS cannot be asked whether a family is fixed-pitch, so `isFixedPitchStack()` / `resolveTerminalFontFamily()` in `src/renderer/utils/fixedPitchFont.ts` MEASURE it on a canvas and override to `MONO_FALLBACK_STACK` only on evidence (unmeasurable input keeps the user's font). The two mechanisms cover different failures and compose; the terminal calls the shared helper for the chain rather than carrying its own. That module serves every surface showing shell text, not just the terminal (the command-mode composer and the shell command card ride it too). A local duplicate of the chain (`ensureMonospaceFallback`) has shipped twice now - once in `XTerminal.tsx` and once in `fixedPitchFont.ts` - and was folded back in both times; do not reintroduce one.

## JSON Utilities (`src/shared/jsonUtils.ts` - Both)

| Function           | Signature                         | Purpose                                                                   |
| ------------------ | --------------------------------- | ------------------------------------------------------------------------- |
| `stripJsonBom`     | `(value: string) => string`       | Remove a leading UTF-8 BOM from JSON text before parsing.                 |
| `parseJsonWithBom` | `<T = unknown>(value: string): T` | `JSON.parse` wrapper that tolerates a leading BOM in persisted JSON text. |

### Search Highlighting (`src/renderer/utils/highlightMatches.tsx` - Renderer)

| Function                                     | Signature                               | Purpose                                                                                                                                                                                        |
| -------------------------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `splitOnMatches(text, query)`                | `(string, string) => MatchSegment[]`    | Split `text` into alternating plain/match segments, each carrying its `start` offset. The one matcher the other two are built from, so escaping and match parity cannot drift.                 |
| `highlightMatches(text, query, accentColor)` | `(string, string, string) => ReactNode` | Wrap every case-insensitive occurrence of `query` in an accent-colored `<mark>`. Used by the CSV table and its row detail modal.                                                               |
| `searchMatchRanges(text, query)`             | `(string, string) => { from, to }[]`    | The same hits as byte ranges, for `MarkdownEditorHandle.setSearchMatches`. Use it rather than re-deriving offsets, or a pane's rendered half and its source half disagree about what is a hit. |

### Main Process (`src/main/utils/stripAnsi.ts`)

| Function         | Signature            | Purpose                                                                            |
| ---------------- | -------------------- | ---------------------------------------------------------------------------------- |
| `stripAnsi(str)` | `(string) => string` | Similar ANSI stripping with regex constants. Used for SSH command output cleaning. |

---

## Formatting (`src/shared/formatters.ts` - Both)

| Function                               | Signature                              | Purpose                                                                           |
| -------------------------------------- | -------------------------------------- | --------------------------------------------------------------------------------- |
| `formatSize(bytes)`                    | `(number) => string`                   | File size: `"1.5 MB"`, `"256 KB"`. Auto-scales B/KB/MB/GB/TB.                     |
| `formatNumber(num)`                    | `(number) => string`                   | Large numbers: `"1.5k"`, `"2.3M"`.                                                |
| `formatTokens(tokens)`                 | `(number) => string`                   | Token counts with `~` prefix: `"~1K"`, `"~2M"`.                                   |
| `formatTokensCompact(tokens)`          | `(number) => string`                   | Token counts without `~`: `"1.5K"`, `"2.3M"`.                                     |
| `formatRelativeTime(dateOrTimestamp)`  | `(Date \| number \| string) => string` | `"just now"`, `"5m ago"`, `"2h ago"`, `"Dec 3"`.                                  |
| `formatCacheAge(cacheAgeMs)`           | `(number \| null) => string`           | Cache age labels from elapsed milliseconds: `"just now"`, `"5m ago"`, `"2h ago"`. |
| `formatCalendarDay(isoDay)`            | `(string) => string`                   | A `YYYY-MM-DD` day for display: `"Jul 10, 2026"`. Parsed as LOCAL, not UTC.       |
| `formatElapsedTimeColon(seconds)`      | `(number) => string`                   | Timer style: `"5:12"`, `"1:30:45"`.                                               |
| `fileTimestampSlug(dateOrTimestamp?)`  | `(Date \| number?) => string`          | `"20260713-142530"` for a generated file name. Local time, sorts chronologically. |
| `formatCost(cost)`                     | `(number) => string`                   | USD: `"$1.23"`, `"<$0.01"`, `"$0.00"`.                                            |
| `estimateTokenCount(text)`             | `(string) => number`                   | Estimate at ~4 chars/token.                                                       |
| `truncatePath(path, maxLength?)`       | `(string, number?) => string`          | `".../parent/current"` format. Default max 35 chars.                              |
| `getParentDir(path)`                   | `(string) => string`                   | Return the parent directory segment of a path.                                    |
| `isAbsolutePath(path)`                 | `(string) => boolean`                  | True for Unix (`/x`), Windows drive (`C:\x`, `C:/x`), UNC paths.                  |
| `getBasename(path)`                    | `(string) => string`                   | Final path segment; handles `/` and `\`, ignores trailing sep.                    |
| `joinPath(base, ...segments)`          | `(string, ...string[]) => string`      | Join onto a base using the separator the base uses. Renderer-safe (no `path`).    |
| `truncateCommand(command, maxLength?)` | `(string, number?) => string`          | Single-line with ellipsis. Default max 40 chars.                                  |

---

## Durations (`src/shared/duration.ts` - Both)

**Never write another unit ladder.** Every "how long was that?" string renders from one
engine here. There used to be a dozen hand-rolled copies of the same
divide-by-86400000 loop, each drifting on the details that matter (where the ladder
stops, whether a zero segment is padded, whether a countdown rounds up). Those are real
product decisions, so they are options on `humanizeDuration`, not separate functions.

All of these are re-exported from `src/shared/formatters.ts`, so either import path
works. `duration.ts` is canonical and is where new duration work belongs.

| Function                             | Signature                     | Purpose                                                                                                                                                                                            |
| ------------------------------------ | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `humanizeDuration(ms, options?)`     | `(number, opts?) => string`   | The engine. Reach for it when no preset fits.                                                                                                                                                      |
| `formatDurationHuman(ms)`            | `(number) => string`          | Hour-capped, zero-padded: `"45s"`, `"5m 30s"`, `"2h 15m"`, `"30h 0m"`. The default.                                                                                                                |
| `formatDurationCompact(ms)`          | `(number) => string`          | Drops seconds past a minute: `"45s"`, `"5m"`, `"2h 15m"`.                                                                                                                                          |
| `formatDurationVerbose(ms)`          | `(number) => string`          | Words: `"5 minutes 30 seconds"`, `"1 hour 15 minutes"`.                                                                                                                                            |
| `formatDurationParts(ms)`            | `(number) => string`          | Up to four segments: `"500ms"`, `"2m 30s"`, `"1h 15m 20s"`, `"3d 2h 15m"`.                                                                                                                         |
| `formatDurationDecimal(ms)`          | `(number) => string`          | One decimal, one unit, for CLI columns: `"5.2s"`, `"1.5h"`.                                                                                                                                        |
| `formatDurationLong(ms)`             | `(number) => string`          | Abbreviated, ladders to years: `"6d 7h"`, `"3w 2d"`, `"1y 7w"`.                                                                                                                                    |
| `formatDurationWords(ms, maxUnits?)` | `(number, number?) => string` | Prose with months: `"1 day, 12 hours"`, `"2 months, 1 week"`.                                                                                                                                      |
| `formatActiveTime(ms)`               | `(number) => string`          | Uppercase stat pills: `"<1M"`, `"5M"`, `"2H 30M"`, `"1D"`.                                                                                                                                         |
| `formatElapsedTime(ms)`              | `(number) => string`          | `formatDurationHuman` plus sub-second precision: `"500ms"`, `"5m 12s"`.                                                                                                                            |
| `formatElapsedTicker(ms)`            | `(number) => string`          | Live ticker with a leading `0m` below an hour: `"0m 3s"`, `"1h 0m 5s"`. ThinkingStatusPill and Auto Run elapsed on that pill use this, not `formatElapsedTime`.                                    |
| `formatElapsedTickerCompact(ms)`     | `(number) => string`          | Same ladder without the padded lead: `"3s"`, `"20m 4s"`, `"1h 2m 5s"`. For a counter inside a chip or sentence, where a bare seconds count reads fine below a minute but `1203s` does not past it. |

`DURATION_MS` gives each unit's size in ms - use it instead of redeclaring
`const DAY = 86400000`. `DURATION_LADDER_FULL` / `_DAYS` / `_HOURS` are the prebuilt
ladders.

### `humanizeDuration` options

| Option            | Default    | Effect                                                                                                       |
| ----------------- | ---------- | ------------------------------------------------------------------------------------------------------------ |
| `units`           | full       | Which rungs to use, largest first. The ceiling decides whether 30 hours is `"1d 6h"` or `"30h"`.             |
| `maxUnits`        | `2`        | How many rungs to print.                                                                                     |
| `style`           | `'short'`  | `short` → `2h`, `long` → `2 hours` (pluralized), `caps` → `2H`.                                              |
| `separator`       | `' '`      | Glue between rungs; prose usually wants `', '`.                                                              |
| `keepZeroUnits`   | `false`    | Pad interior zeros (`"2h 0m"`) for steady-width columns. Leading zeros never print unless `keepLeadingZero`. |
| `keepLeadingZero` | `false`    | With `keepZeroUnits`, also print a zero of the first ladder unit: `"0m 3s"`.                                 |
| `adjacentUnits`   | `false`    | Print only the leading rung and the one below it: `"1h"`, not `"1h 59s"`. Overrides `maxUnits`.              |
| `round`           | `'floor'`  | `ceil` for countdowns, so a live ticker never reads `"0s"` with time left.                                   |
| `fallback`        | `"0s"`-ish | Printed below the smallest rung. Negative and non-finite input lands here rather than throwing.              |

Calendar math is approximate on purpose: a year is 365 days, a month is the average
Gregorian month (30.44 days, so twelve can never print as "12 months"). Anything needing
true calendar arithmetic must use `Date`, not this module.

---

## Sleep-Aware Durations (`src/shared/sleepTracking.ts` - Both)

**Any duration that measures work must not count machine sleep.** `Date.now() - start`
does count it: the wall clock runs through a suspend, so an overnight sleep turns a
20-minute Auto Run into an 8-hour one. The Page Visibility API does not save you either -
a system suspend never fires `visibilitychange`, because the window stays "visible" while
the whole process is frozen. Only `powerMonitor` in the main process sees the
suspend/resume pair.

`createSleepTracker()` is the shared math. Each process owns exactly one instance, and you
use the process-local wrapper rather than the factory:

| Process  | Module                                 | Fed by                                      |
| -------- | -------------------------------------- | ------------------------------------------- |
| Main     | `src/main/utils/sleep-tracker.ts`      | `powerMonitor` suspend/resume in `index.ts` |
| Renderer | `src/renderer/services/systemSleep.ts` | the `app:systemResume` IPC payload          |

Both expose the same shape:

| Function                        | Purpose                                                                                       |
| ------------------------------- | --------------------------------------------------------------------------------------------- |
| `beginSleepAwareSpan()`         | Open a span. Keep the returned object: a start timestamp alone can't tell you what was sleep. |
| `sleepAwareElapsedMs(span)`     | Elapsed time with sleep removed. Never negative.                                              |
| `getTotalSleepMs()`             | Cumulative measured sleep since the process started.                                          |
| `onSystemSleep(handler)`        | (Renderer) Subscribe to each measured gap - for live trackers that pause their own clock.     |
| `sleepAwareElapsedSince(start)` | (Renderer) For a display that only has a stored `startTime` and can't hold a span.            |

Prefer a span. `sleepAwareElapsedSince()` reads a bounded log of recent wakes and exists
for UI that reads a start timestamp out of state (the Auto Run pill, the thinking timer).

Live trackers that pause and resume their own clock (`useTimeTracking`) subscribe with
`onSystemSleep()` and walk their stored timestamps forward by the gap, clamped to the live
span so a platform that DID fire a hide/show pair can't subtract the same sleep twice.

---

## Group Chat Activity (`src/shared/groupChatActivity.ts` - Both)

`computeGroupChatActivity(entries)` rolls a group chat's history log up into working time,
tokens, and cost. Both the Group Chat Info overlay and the HTML export call it, so an
export can't disagree with the app about how much work a chat did.

**Never present the span between the first and last message as effort.** A group chat is a
room, not a task: a chat used twice a week reports hundreds of hours without anyone doing
anything. Working time is the UNION of the busy intervals, so participants running in
PARALLEL collapse into one interval rather than summing - three agents working the same ten
minutes is ten minutes of chat time, not thirty.

Each entry covers `[timestamp - elapsedTimeMs, timestamp]` because a history entry is
stamped when a turn ENDS. Entries recorded before per-turn timing existed carry no
`elapsedTimeMs` and degenerate to points, which is what `GROUP_CHAT_ACTIVITY_STITCH_MS`
(5 minutes) is for: turns closer together than the stitch are one block of work, an
overnight gap ends it. Without it an older chat reports `0m`, which is a worse lie than the
elapsed span it replaced.

`turnsWithTokens` / `turnsWithCost` are the coverage counts. Render a dash rather than a
zero when they are 0 - a chat whose turns reported no usage is UNKNOWN, not free.

The producing half lives in `src/main/group-chat/group-chat-turn-metrics.ts`: group chat
turns are batch processes spawned and reaped in the MAIN process, so they never reach the
renderer's per-turn stats row and nothing else can measure them.

---

## Emoji Utilities (`src/shared/emojiUtils.ts` - Both)

| Function                           | Signature                    | Purpose                                         |
| ---------------------------------- | ---------------------------- | ----------------------------------------------- |
| `stripLeadingEmojis(str)`          | `(string) => string`         | Remove leading emojis for alphabetical sorting. |
| `compareNamesIgnoringEmojis(a, b)` | `(string, string) => number` | Compare names ignoring leading emojis.          |

---

## Git Utilities (`src/shared/gitUtils.ts` - Both)

| Function                           | Signature                      | Purpose                                                                                                                    |
| ---------------------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `parseGitStatusPorcelain(stdout)`  | `(string) => GitFileStatus[]`  | Parse `git status --porcelain` output.                                                                                     |
| `countUncommittedChanges(stdout)`  | `(string) => number`           | Count from porcelain output.                                                                                               |
| `hasUncommittedChanges(stdout)`    | `(string) => boolean`          | Quick check from porcelain output.                                                                                         |
| `parseGitNumstat(stdout)`          | `(string) => GitNumstatFile[]` | Parse `git diff --numstat` into additions/deletions.                                                                       |
| `parseGitBehindAhead(stdout)`      | `(string) => GitBehindAhead`   | Parse `git rev-list --left-right --count`.                                                                                 |
| `parseGitBranches(stdout)`         | `(string) => string[]`         | Parse branch list, dedup remote/local, filter HEAD.                                                                        |
| `parseGitTags(stdout)`             | `(string) => string[]`         | Parse `git tag --list`.                                                                                                    |
| `cleanBranchName(stdout)`          | `(string) => string`           | Trim branch name from `git rev-parse`.                                                                                     |
| `cleanGitPath(stdout)`             | `(string) => string`           | Trim path from git output.                                                                                                 |
| `remoteUrlToBrowserUrl(remoteUrl)` | `(string) => string \| null`   | Convert SSH/HTTPS git URLs to browser-friendly URLs.                                                                       |
| `sanitizeGitBranchName(input)`     | `(string, options?) => string` | Sanitize user input into a git branch name. Use `{ allowIncomplete: true }` for controlled inputs before final validation. |
| `isImageFile(filePath)`            | `(string) => boolean`          | Check extension against known image types.                                                                                 |
| `getImageMimeType(ext)`            | `(string) => string`           | Get MIME type for image extension.                                                                                         |

---

## File Categories (`src/shared/fileCategories.ts` - Both)

One extension table that answers two questions at once: "can Maestro open this
file?" and "which bucket is it in?". `isPreviewableFile` is DERIVED from
`getFileCategory`, so the two cannot disagree - a file that classifies into a
bucket but refuses to open, or one that opens but is invisible under every
filter pill, are both impossible by construction. Audio and video are not
listed here; they resolve through `getMediaKind()` in `mediaTypes.ts`, which is
the single source of truth for what Chromium can decode.

Powers the Fuzzy File Search category pills (All / Code / Docs / Data / Media).
Do NOT hand-roll another `TEXT_EXTENSIONS` set - the private copies inside
`FileSearchModal` are what this replaced. Distinct from the sets in
`src/renderer/utils/fileExplorerIcons/shared.ts`, which exist to pick an ICON
and are split much more finely (lockfiles, test folders, config folders); pick
by question, and do not merge them.

| Function / Constant                 | Signature                                         | Purpose                                                                                    |
| ----------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `getFileCategory(path)`             | `(string) => FileCategory \| null`                | Bucket a file, or `null` when Maestro cannot open it. `null` != `'other'`.                 |
| `isPreviewableFile(path)`           | `(string) => boolean`                             | Whether the file is listable/openable. Derived from `getFileCategory`.                     |
| `matchesFileCategory(path, filter)` | `(string, FileCategoryFilter) => boolean`         | Filter predicate. `'all'` passes everything, including unclassified files.                 |
| `getFileExtension(path)`            | `(string) => string`                              | Lowercase extension of the basename. `.gitignore` has none; parent-directory dots ignored. |
| `FILE_CATEGORIES`                   | `readonly ['code','docs','data','media','other']` | Bucket vocabulary, in pill order.                                                          |
| `FILE_CATEGORY_LABELS`              | `Record<FileCategoryFilter, string>`              | Human labels for the pills.                                                                |

## Markdown File Links (`src/renderer/utils/fileLinks/` - Renderer)

Everything behind a clickable `[[wiki]]`, `path/to/file.md`, `~/note.md`, or
absolute-path reference in rendered markdown. `matcher.ts` is the pure
resolution core shared by the Rich tier (`remarkFileLinks`) and the Fast tier
(`markdownItAdapter`), so the two preview tiers cannot disagree about what a
reference points at.

A surface can sit over more than ONE root. The Auto Run panel resolves
`[[Playbook]]` against its playbooks folder and `[[Notes/Thing]]` against the
agent's project, and those trees have different roots so they cannot be
concatenated as nodes - union their INDICES with `mergeFileTreeIndices`, whose
argument order decides which tree wins a shared basename. Resolving against only
one root is what left every cross-project link in an Auto Run document as inert
text while the same link worked in a file-preview tab.

<!-- doc-refs-ignore:start -->

`resolve.ts` is the other half: what a click handler does with the path the
plugin hands back. That path is project-RELATIVE for anything matched in the
tree and absolute for everything else, and agents quote `src/foo.ts:42`
constantly, so every consumer needs the same strip-then-join. Do NOT hand-roll
it - a surface that skips the join hands a bare `Notes/Thing.md` to a reader
expecting an absolute path and silently opens nothing.

<!-- doc-refs-ignore:end -->

| Function                                       | Signature                                             | Purpose                                                                        |
| ---------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------ |
| `buildFileTreeIndices(fileTree)`               | `(FileNode[]) => FileTreeIndices`                     | Index one tree. Memoize per tree; both plugins take prebuilt indices.          |
| `mergeFileTreeIndices(...sets)`                | `(...(FileTreeIndices \| null)[]) => FileTreeIndices` | Union several roots. Earlier sets win a shared basename; nullish sets skipped. |
| `findClosestMatch(ref, indices, cwd)`          | `(string, FileTreeIndices, string) => string \| null` | Resolve a `[[wiki]]` reference. Exact path, then basename, then cwd proximity. |
| `validatePathReference(ref, indices)`          | `(string, FileTreeIndices) => string \| null`         | Stricter: exact path only (with or without `.md`). Used for bare path text.    |
| `toRelativePath(absPath, projectRoot)`         | `(string, string \| undefined) => string \| null`     | Absolute -> project-relative. `null` when outside the root.                    |
| `resolveFileReference(projectRoot, reference)` | `(string, string) => string`                          | Path a reader can open. Absolute verbatim, else joined onto the root.          |
| `stripLineColumnSuffix(path)`                  | `(string) => string`                                  | Drop a trailing `:42` / `:42:7`.                                               |

## Media Types (`src/shared/mediaTypes.ts` - Both)

Audio/video detection plus the `maestro-media://` stream URL format used by the
file preview's `MediaViewer`. Unlike images (which `fs:readFile` inlines as a
base64 data URL), media is streamed: the main process returns a short stream URL
and `src/main/media/media-stream.ts` serves range requests off disk, so a
multi-GB recording never crosses IPC or lands in the renderer heap.

| Function / Constant                       | Signature                                  | Purpose                                                                                              |
| ----------------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `getMediaKind(filePath)`                  | `(string) => 'audio' \| 'video' \| null`   | Classify a path. Only formats Chromium can decode; mkv/avi stay null so they keep the binary path.   |
| `isMediaFile(filePath)`                   | `(string) => boolean`                      | Whether the path names playable media.                                                               |
| `getMediaMimeType(filePath)`              | `(string) => string \| null`               | MIME type for the `content-type` header.                                                             |
| `buildMediaStreamUrl(token, absPath)`     | `(string, string) => string`               | Build a stream URL. Main process only - use `buildLocalMediaStreamUrl()` so the boot token is right. |
| `parseMediaStreamUrl(url, expectedToken)` | `(string, string) => string \| null`       | Validate token/host/extension and recover the path.                                                  |
| `isMediaStreamUrl(value)`                 | `(string \| null \| undefined) => boolean` | Cheap check for "is this `fs:readFile` result a stream URL".                                         |
| `MEDIA_PLAYBACK_RATES`                    | `readonly number[]`                        | Speed ladder shown in the transport.                                                                 |
| `normalizePlaybackRate(value)`            | `(unknown) => number`                      | Clamp a persisted/CLI-supplied rate to 0.25-4, falling back to 1.                                    |

### Media Items (`src/renderer/utils/mediaItems.ts` - Renderer)

| Function                                | Signature                                                    | Purpose                                                                     |
| --------------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------- |
| `getOpenedMediaKind(name, content)`     | `(string, string) => MediaKind \| null`                      | The one predicate for "is this opened file playable media".                 |
| `mediaItemId(sessionId, path)`          | `(string, string) => string`                                 | Queue identity. Same agent + path re-uses the entry, so re-opening resumes. |
| `stepMediaItem(items, activeId, steps)` | `(MediaItem[], string \| null, number) => MediaItem \| null` | Prev/next target. Open order, no wrapping; null at the ends.                |
| `pushMediaHistory(history, item, max)`  | `(MediaItem[], MediaItem, number) => MediaItem[]`            | Recently played, newest first, deduped and capped.                          |
| `trimMediaQueue(items, limit, keepId)`  | `(MediaItem[], number, string \| null) => MediaItem[]`       | Caps the persisted queue, oldest first, never dropping the loaded item.     |
| `sanitizeMediaItems(value)`             | `(unknown) => MediaItem[]`                                   | Coerce a persisted queue off disk, dropping anything malformed.             |
| `sanitizeMediaTimes(value, knownIds)`   | `(unknown, Set<string>) => Record<string, number>`           | Same for the seconds maps (positions, durations); drops unqueued IDs.       |
| `formatMediaTime(seconds)`              | `(number \| undefined) => string`                            | Clock time for a fractional media second; `--:--` when unknown.             |

`openFileUrl(href, onFileClick)` in `src/renderer/utils/openFileUrl.ts` is the one
handler for a `file://` link clicked in markdown. The file-link plugins emit
`file://` for any path OUTSIDE the project root, so sending every one of them to
`shell.openPath` quietly routed media around the player and into the OS. It
returns whether it took the href, so callers `if (openFileUrl(...)) return;`.

**Media never becomes a file preview tab.** `handleOpenFileTab()` diverts it to
`useMediaPlaybackStore.openMedia()` before a tab can be created, and the only
surface it appears on is the floating player. Do not add an in-panel placement.

`getOpenedMediaKind` takes the filename and content as separate scalars on
purpose, and the filename must still carry its extension: a `FilePreviewTab`
splits `name` from `extension` (`'song'` + `'.mp3'`), so passing `tab.name`
directly classifies everything as non-media. The content check is what keeps a
remote file (no local stream to serve) on the binary "open externally" path.

Floating-widget geometry math lives in `src/renderer/utils/mediaFloatGeometry.ts`
(`fitMediaFloatRect`, `initialMediaFloatRect`, `mediaFloatHeight`,
`mediaFloatResizeWidth`, `sanitizeMediaFloat`), split out of the component so the
off-screen-recovery and aspect-fitting cases are testable without a DOM.

**Height is derived, never stored.** The frame is chrome plus a stage, and the
stage belongs to the media: audio has no picture so the frame collapses to the
controls, and video gets exactly its own `videoWidth / videoHeight` or it plays
inside black bars. So width is the only size the user picks, and it is remembered
per kind. The chrome half of the math is measured at runtime (`transportHeight`
reported by `MediaViewer`) because the transport's height comes out of font
metrics - a hard-coded constant letterboxes video on whichever platform it was
not tuned on.

---

## Template Variables (`src/shared/templateVariables.ts` - Both)

| Function / Constant                              | Signature                                      | Purpose                                                                                                         |
| ------------------------------------------------ | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `TEMPLATE_VARIABLES`                             | `Array<{variable, description, autoRunOnly?}>` | All available template variables with docs.                                                                     |
| `TEMPLATE_VARIABLES_GENERAL`                     | Same array filtered                            | Excludes Auto Run-only variables.                                                                               |
| `substituteTemplateVariables(template, context)` | `(string, TemplateContext) => string`          | Case-insensitive replacement of `{{VAR}}` placeholders. Handles agent, path, date/time, git, context variables. |

---

## Additional Directories (`src/shared/additionalDirectories.ts` - Both)

Extra directories an agent may read from and/or write to beyond its working directory. Grants live on `Session.additionalDirectories` (`AdditionalDirectory[]`, from `src/shared/types.ts`) and are **enforced only by the system prompt** - nothing sandboxes the agent process.

| Function                                         | Signature                                                                             | Purpose                                                                                                                           |
| ------------------------------------------------ | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `normalizeAdditionalDirectories(dirs, homeDir?)` | `(AdditionalDirectory[] \| undefined, string?) => AdditionalDirectory[] \| undefined` | Call at save time in every form. Expands `~`, trims, drops blank paths, de-dupes (last row wins), returns `undefined` when empty. |
| `formatAdditionalDirectoriesForPrompt(dirs)`     | `(AdditionalDirectory[] \| undefined) => string`                                      | Renders the `{{ADDITIONAL_DIRECTORIES}}` markdown block (heading + access table). Returns `''` when there are no grants.          |

`read` and `write` are independent: read-only (reference material), write-only (a drop box the agent must never read back), or both. A row with neither flag is inert and never reaches the prompt.

**Two enforcement layers, and they are not equivalent:**

- **Prompt (every agent):** carries the full read/write nuance, including write-only. Only as good as the agent's obedience.
- **Native (agents with `capabilities.supportsAdditionalDirectories`):** actually enforced by the provider via `--add-dir`, but coarser. No CLI today can express "write but never read", so a native grant opens the directory and the prompt holds the line on the finer rule.

Providers translate grants to their own CLI vocabulary in `additionalDirArgs` (`src/main/agents/definitions.ts`) using these building blocks. The flags look identical across providers and are NOT: Claude Code / Copilot-CLI `--add-dir` grants tool access (read+write), Codex `--add-dir` adds a writable sandbox root.

| Function                    | Signature                                                       | Purpose                                                                                           |
| --------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `dirsWithAnyAccess(dirs)`   | `(AdditionalDirectory[] \| undefined) => AdditionalDirectory[]` | Grants the agent may touch at all. For access-style flags (Claude, Copilot).                      |
| `dirsWithWriteAccess(dirs)` | `(AdditionalDirectory[] \| undefined) => AdditionalDirectory[]` | Grants the agent may write. For writable-root flags (Codex).                                      |
| `repeatDirFlag(flag, dirs)` | `(string, AdditionalDirectory[]) => string[]`                   | Emit `<flag> <path>` once per dir. Never use a variadic list - it swallows the prompt positional. |

Adding a provider? See [PROVIDER-SUPPORT.md → Step 3.5](../../PROVIDER-SUPPORT.md#step-35-additional-directories). `agent-completeness.test.ts` fails CI if `supportsAdditionalDirectories` and `additionalDirArgs` disagree.

UI: use `<AdditionalDirectoriesSection>` (`src/renderer/components/shared/`) - do NOT hand-roll a row editor. It is already wired into NewInstanceModal, EditAgentModal, and the Wizard's DirectorySelectionScreen. Pass `nativelyEnforced` from the selected agent's capability so the copy doesn't promise enforcement the provider can't deliver.

---

## Auto Run Document Scanning (`src/shared/markdownTaskScan.ts` - Both)

Fence-aware primitives every Auto Run document scanner rides. Shared because the desktop engine (`src/renderer/hooks/batch/`) and the CLI engine (`src/cli/services/batch-processor.ts`, which cannot import from the renderer) must read a document identically.

| Function / Constant                   | Signature                                            | Purpose                                                                             |
| ------------------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `forEachMarkdownLine(content, visit)` | `(string, (line, index) => boolean \| void) => void` | Walk lines, skipping fenced code blocks. Return `false` from `visit` to stop early. |
| `UNCHECKED_TASK_REGEX`                | `RegExp`                                             | An unchecked checkbox: `- [ ] task` (also `*`, `+`).                                |
| `CHECKED_TASK_COUNT_REGEX`            | `RegExp`                                             | A checked checkbox: `- [x] task` (also `X`, `✓`, `✔`).                              |
| `CHECKED_TASK_REGEX`                  | `RegExp` (global)                                    | Rewrite checked boxes back to unchecked (reset-on-completion).                      |

Do NOT hand-roll another line loop. A scanner that forgets the fence bookkeeping fires on a playbook that merely DOCUMENTS the marker syntax, and hand-rolled copies drift on closing-fence length, tilde fences, and CRLF.

---

## Auto Run Staging (`src/renderer/utils/autoRunStaging.ts` - Renderer)

Three pure helpers behind the Files tab's **Stage Documents for Auto Run** entry. The playbooks folder appears in the file tree like any other directory, so these answer what turning part of it into a run list takes: is this path inside the agent's Auto Run folder, and which documents does it resolve to. The entry serves three menu contexts - a folder (its whole subtree), a single markdown file (itself), and a multi-selection (the union) - so a path resolver and a folder resolver are both needed.

| Function                                                   | Signature                              | Purpose                                                                                                                        |
| ---------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `relativeToAutoRunFolder(absolutePath, autoRunFolder)`     | `(string?, string?) => string \| null` | Path relative to the Auto Run folder, `''` for the folder itself, `null` when outside it. Normalizes `\` and trailing slashes. |
| `collectAutoRunDocsInFolder(relativeFolder, documentList)` | `(string, string[]) => string[]`       | Document ids under that folder, nested included. `''` means every document. Order follows `documentList`.                      |
| `autoRunDocIdForFile(fileAbsolutePath, autoRunFolder)`     | `(string?, string?) => string \| null` | Document id for one file, `null` outside the Auto Run folder or when it isn't `.md`. Drops only the extension.                 |

Document ids are always reconciled against the batch store's `documentList`, NOT read off the file tree. The tree is truncated on large workspaces and the run list only accepts ids the Auto Run loader already knows about, so deriving them from a partial tree stages names the modal cannot resolve. `autoRunDocIdForFile` builds a candidate id from the path, and the caller (`useFileContextMenu`) filters it through `documentList` - which also emits the result in loader order, so a staged selection reads the same way the Auto Run panel does. A shared-prefix sibling (`plans-old/` next to `plans/`) must not match - that is what the trailing-slash normalization and the `${root}/` prefix test are for.

---

## Model Tiers & Effort (`src/shared/modelTiers.ts` - Both)

One vocabulary (`low | medium | high`) for two independent axes: which model runs the turn (**tier**) and how hard it thinks (**effort**). The levels are ladder POSITIONS, not literal provider values - Claude's ceiling is `max`, Codex's floor is `minimal`.

| Function / Constant                   | Signature                                           | Purpose                                                                               |
| ------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `TIER_LEVELS`                         | `readonly ['low', 'medium', 'high']`                | The vocabulary. Both axes use it.                                                     |
| `asTierLevel(value)`                  | `(unknown) => ModelTier \| undefined`               | Narrow an untrusted value to a rung.                                                  |
| `resolveTierModel(toolType, tier)`    | `(ToolType, ModelTier) => string \| undefined`      | Model for a tier. `undefined` = no mapping, inherit the agent's model **and say so**. |
| `resolveEffortLevel(toolType, level)` | `(ToolType, EffortLevel) => string \| undefined`    | Provider effort string for a level. `undefined` = provider has no effort knob.        |
| `supportsTierSelection(toolType)`     | `(ToolType) => boolean`                             | Whether this provider can act on a tier hint at all.                                  |
| `supportsEffortSelection(toolType)`   | `(ToolType) => boolean`                             | Whether this provider can act on an effort hint at all.                               |
| `cheapTurnSettings(toolType)`         | `(ToolType) => { model?: string; effort?: string }` | Bottom of both ladders. Used to pin throwaway synopsis turns.                         |

Tier maps ship only where model IDs are stable (`claude-code` permanent aliases, `factory-droid`). Do NOT add one for a provider that discovers its catalogue at runtime (`codex`, `copilot-cli`, `opencode`): a shipped guess rots into naming a model the user cannot run. `undefined` must never become a silent substitution.

`cheapTurnSettings` is safe only because a synopsis is a LEAF - every caller discards the `agentSessionId` it returns. A future caller that adopts that id has to revisit the pin first, or the tab silently continues on the cheap model.

---

## Auto Run Model Hints (`src/shared/autorunModelHints.ts`, `src/shared/autorunTurnSettings.ts` - Both)

`<!-- MAESTRO:MODEL tier="high" effort="high" -->` sets the model and effort. **Placement is the scope**, and there is no third syntax: a marker on its OWN line applies from there down until the next standalone marker (above the first task that is the whole document, under a section heading it is that phase), while a marker at the END of a task line applies to that ONE task and the next task reverts. Resolution is recomputed before every dispatch rather than tracked as run state, so editing a document mid-run takes effect on the next task.

| Function                                                         | File                     | Purpose                                                                                                                |
| ---------------------------------------------------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `findActiveModelHint(content)`                                   | `autorunModelHints.ts`   | The hint governing the next task, or `null`. Prevailing standalone marker with that task's inline marker layered over. |
| `findAllModelHints(content)`                                     | `autorunModelHints.ts`   | Every marker in order, tagged with its scope, for authoring-time validation.                                           |
| `parseModelMarker(inner, line, scope?)`                          | `autorunModelHints.ts`   | Parse one marker's attributes. Records invalid values instead of dropping them.                                        |
| `resolveTurnSettings(toolType, hint, agentModel?, agentEffort?)` | `autorunTurnSettings.ts` | Join hint + provider capability into `{ model, effort, notes, warnings }`.                                             |
| `describeTurnSettings(resolved)`                                 | `autorunTurnSettings.ts` | One-line summary for a log line or History entry. `null` when the document set no hint.                                |

Precedence: the document's hint (if the provider can act on it), then the agent's configured value, then the provider default. A hint the provider cannot honor falls back **and warns** - the whole point is that an unresolvable hint is loud.

Two rules the scopes turn on, both of which look like details and are not:

- **The scopes layer PER AXIS.** An inline marker that names only `tier` keeps the prevailing `effort`. Merging wholesale would make `tier="high"` on a task inside a high-effort section quietly LOWER its effort to the agent default.
- **`'default'` survives parsing rather than collapsing to `undefined`.** Both mean "use the agent's value" at resolution time, but they differ when scopes merge: a task saying `tier="default"` must override a document-wide `tier="high"`, while a task saying nothing about `tier` must inherit it. That is how one task opts out of a document-wide hint.

A checked task is stepped over entirely, marker and all. That keeps a half-finished phase on the setting the rest of it needs, and stops a completed task's inline marker from leaking onto the tasks below it.

---

## Tree Utilities (`src/shared/treeUtils.ts` - Both)

| Function                                | Signature                                    | Purpose                                                       |
| --------------------------------------- | -------------------------------------------- | ------------------------------------------------------------- |
| `walkTree(nodes, options)`              | `<T>(TreeNode[], WalkTreeOptions<T>) => T[]` | Generic recursive tree walker with onFile/onFolder callbacks. |
| `walkTreePartitioned(nodes, basePath?)` | `(TreeNode[], string?) => PartitionedPaths`  | Walk tree, return `{ files: Set, folders: Set }`.             |
| `getAllFilePaths(nodes, basePath?)`     | `(TreeNode[], string?) => string[]`          | Convenience: all file paths.                                  |
| `getAllFolderPaths(nodes, basePath?)`   | `(TreeNode[], string?) => string[]`          | Convenience: all folder paths.                                |
| `buildFileIndex(nodes, basePath?)`      | `(TreeNode[], string?) => FilePathEntry[]`   | Build flat index with `{ relativePath, filename }`.           |

---

## Synopsis Parsing (`src/shared/synopsis.ts` - Both)

| Function / Constant           | Signature                    | Purpose                                                                                                                            |
| ----------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `NOTHING_TO_REPORT`           | `string`                     | Sentinel token AI agents return when nothing meaningful happened.                                                                  |
| `isNothingToReport(response)` | `(string) => boolean`        | Check if response contains the sentinel token.                                                                                     |
| `parseSynopsis(response)`     | `(string) => ParsedSynopsis` | Parse AI synopsis into `{ shortSummary, fullSynopsis, nothingToReport }`. Filters template placeholders and conversational filler. |

---

## Director's Notes Narrative (`src/shared/directorNotesNarrative.ts` - Both)

The Director's Notes synopsis agent emits a structured JSON narrative. This module is the ONLY place that turns that raw string into a `DirectorNotesNarrative` or back into prose. Do not hand-roll JSON extraction, repair, or markdown conversion at a call site.

| Function / Constant                  | Signature                            | Purpose                                                                                                                                                                         |
| ------------------------------------ | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `parseDirectorNotesNarrative(raw)`   | `(string) => ParseNarrativeResult`   | Strict parse. Tolerates a code fence or stray prose around the object; rejects any structural deviation with a precise error. Never throws.                                     |
| `recoverDirectorNotesNarrative(raw)` | `(string) => RecoverNarrativeResult` | Best-effort salvage, called ONLY after a strict failure: repairs a cut-off response and raw control characters, drops malformed items, and returns a `reason` the UI must show. |
| `narrativeToMarkdown(narrative)`     | `(DirectorNotesNarrative) => string` | Render the narrative as markdown prose (`##` section headings + bullets). Used by Plain Mode, Copy, Save, and the CLI's markdown/text output.                                   |

Rendering rule: no surface may display the raw structured output as if it were the report. Show the narrative (or the salvaged one plus `NarrativeParseError`'s recovery banner); on total failure show the banner with the raw text behind its disclosure.

---

## History Utilities (`src/shared/history.ts` - Both)

| Function / Constant                  | Signature                                            | Purpose                                                                                                                                                         |
| ------------------------------------ | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HISTORY_VERSION`                    | `number` (1)                                         | Current history file format version.                                                                                                                            |
| `MAX_ENTRIES_PER_SESSION`            | `number` (5000)                                      | Max history entries per session file.                                                                                                                           |
| `ORPHANED_SESSION_ID`                | `string` (`'_orphaned'`)                             | Session ID for entries without associated sessions.                                                                                                             |
| `sanitizeSessionId(sessionId)`       | `(string) => string`                                 | Replace non-safe chars with underscore for filesystem.                                                                                                          |
| `paginateEntries(entries, options?)` | `<T>(T[], PaginationOptions?) => PaginatedResult<T>` | Apply limit/offset pagination. Default: limit 100, offset 0.                                                                                                    |
| `sortEntriesByTimestamp(entries)`    | `(HistoryEntry[]) => HistoryEntry[]`                 | Immutable sort by descending timestamp.                                                                                                                         |
| `ALL_HISTORY_ENTRY_TYPES`            | `readonly HistoryEntryType[]`                        | The ONE list of entry types (`USER`, `AGENT`, `AUTO`, `CUE`), in filter-display order. Iterate it - never re-declare a local copy.                              |
| `isHistoryEntryType(value)`          | `(unknown) => value is HistoryEntryType`             | Type guard for IPC/CLI/plugin payload validation.                                                                                                               |
| `visibleHistoryEntryTypes(cueOn)`    | `(boolean) => HistoryEntryType[]`                    | Types a filter UI should offer; drops `CUE` when the Cue Encore Feature is off.                                                                                 |
| `normalizeHistoryEntryType(entry)`   | `(HistoryEntry) => HistoryEntryType`                 | Re-maps legacy cross-agent consults (`AUTO` + `sourceAgentName`) to `AGENT`.                                                                                    |
| `normalizeHistoryEntries(entries)`   | `(HistoryEntry[]) => HistoryEntry[]`                 | Batch form of the above; returns the same array when nothing changed. Applied at both read chokepoints (`HistoryManager.getEntries`, CLI `readSessionHistory`). |

---

## Logging

### Main Process Logger (`src/main/utils/logger.ts`)

Singleton `logger` instance (class `Logger extends EventEmitter`):

| Method                    | Signature                                            | Purpose                                                                                   |
| ------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `debug/info/warn/error`   | `(message, context?, data?) => void`                 | Standard log levels. Filtered by `minLevel`.                                              |
| `toast`                   | `(message, context?, data?) => void`                 | User-facing notification logs. Always logged.                                             |
| `autorun`                 | `(message, context?, data?) => void`                 | Auto Run workflow tracking. Always logged.                                                |
| `getLogs(filter?)`        | `({ level?, context?, limit? }) => SystemLogEntry[]` | Retrieve buffered logs with optional filtering.                                           |
| `setLogLevel/getLogLevel` | Level control                                        | Default: `'info'`.                                                                        |
| `enableFileLogging()`     | `() => void`                                         | Write to disk. Auto-enabled on Windows. Path: `%APPDATA%/Maestro/logs/maestro-debug.log`. |

### Renderer Logger (`src/renderer/utils/logger.ts`)

Singleton `logger` instance (class `RendererLogger`):

| Method                  | Signature                            | Purpose                                                    |
| ----------------------- | ------------------------------------ | ---------------------------------------------------------- |
| `debug/info/warn/error` | `(message, context?, data?) => void` | Proxies to main process via `window.maestro.logger.log()`. |

### Logger Types (`src/shared/logger-types.ts`)

| Type / Constant                   | Purpose                                                     |
| --------------------------------- | ----------------------------------------------------------- |
| `BaseLogLevel`                    | `'debug' \| 'info' \| 'warn' \| 'error'`                    |
| `MainLogLevel`                    | Extends BaseLogLevel with `'toast' \| 'autorun'`            |
| `LOG_LEVEL_PRIORITY`              | Numeric priority mapping for filtering.                     |
| `DEFAULT_MAX_LOGS`                | 1000 entries in memory buffer.                              |
| `SystemLogEntry`                  | Interface: `{ timestamp, level, message, context?, data? }` |
| `shouldLogLevel(level, minLevel)` | Filter function based on priorities.                        |

---

## Performance Metrics (`src/shared/performance-metrics.ts` - Both)

| Export                       | Signature                                | Purpose                                                                                                      |
| ---------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `PerformanceMetrics` (class) | Constructor: `(context, log?, enabled?)` | Timing collector with `start()/end()`, `mark()/measure()`, `timeAsync()`, `timeSync()`. Disabled by default. |
| `createNoOpMetrics()`        | `() => PerformanceMetrics`               | No-op instance for testing.                                                                                  |
| `formatDuration(durationMs)` | `(number) => string`                     | `"123.45ms"` or `"1.23s"`.                                                                                   |
| `PERFORMANCE_THRESHOLDS`     | Object                                   | Named thresholds: DASHBOARD_LOAD (200ms), SQL_QUERY (50ms), etc.                                             |

Renderer performance integration in `src/renderer/utils/logger.ts`:

- `getRendererPerfMetrics(context)` - Get/create per-component metrics instance
- `setRendererPerfEnabled(enabled)` - Enable/disable all renderer metrics
- `getAllRendererPerfMetrics()` - Collect metrics from all renderer components

---

## Shell & SSH Utilities (Main Process)

### Shell Escape (`src/main/utils/shell-escape.ts`)

| Function                           | Signature                      | Purpose                                                        |
| ---------------------------------- | ------------------------------ | -------------------------------------------------------------- |
| `shellEscape(str)`                 | `(string) => string`           | Single-quote escape for POSIX shells.                          |
| `shellEscapeArgs(args)`            | `(string[]) => string[]`       | Escape array of arguments.                                     |
| `buildShellCommand(command, args)` | `(string, string[]) => string` | Build properly escaped shell command string.                   |
| `shellEscapeForDoubleQuotes(str)`  | `(string) => string`           | Escape `$`, backtick, `\`, `"`, `!` for double-quoted context. |

### Shell Detection (`src/main/utils/shellDetector.ts`)

| Function                   | Signature                    | Purpose                                                                                          |
| -------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------ |
| `detectShells()`           | `() => Promise<ShellInfo[]>` | Detect available shells. Platform-aware (PowerShell/cmd/bash on Windows; zsh/bash/fish on Unix). |
| `getShellCommand(shellId)` | `(string) => string`         | Map shell ID to executable name.                                                                 |

### SSH Spawn Wrapper (`src/main/utils/ssh-spawn-wrapper.ts`)

| Function                                        | Signature                                                                                            | Purpose                                                                                                                                     |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `wrapSpawnWithSsh(config, sshConfig, sshStore)` | `(SshSpawnWrapConfig, AgentSshRemoteConfig?, SshRemoteSettingsStore) => Promise<SshSpawnWrapResult>` | Wrap spawn config with SSH remote execution. Handles prompt embedding (small in CLI, large via stdin). Returns local or SSH-wrapped config. |

---

## Process Execution (Main Process)

### execFile (`src/main/utils/execFile.ts`)

| Function                                          | Signature                                                                              | Purpose                                                                                                                                                                                                                                            |
| ------------------------------------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `execFileNoThrow(command, args?, cwd?, options?)` | `(string, string[], string?, ExecOptions \| NodeJS.ProcessEnv) => Promise<ExecResult>` | Safe command execution. No shell injection. Returns `{ stdout, stderr, exitCode }` - never throws. Handles Windows batch files, stdin input, and timeouts.                                                                                         |
| `execFileStreaming(command, args, options)`       | `(string, string[], ExecStreamingOptions) => ExecStreamingHandle`                      | Streaming sibling of `execFileNoThrow`: calls `onChunk(chunk, 'stdout' \| 'stderr')` as output arrives, plus `{ result, cancel }`. Use for long commands the user watches live (`git pull`/`git push`). Cancel resolves with exitCode `'SIGTERM'`. |
| `needsWindowsShell(command)`                      | `(string) => boolean`                                                                  | Determine if command needs `shell: true` on Windows. `.cmd`/`.bat` need shell; known `.exe` commands (git, node, etc.) do not.                                                                                                                     |

### Network Fetch (`src/main/utils/fetchWithTimeout.ts`)

| Function                                      | Signature                                              | Purpose                                                                                                                                                   |
| --------------------------------------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fetchWithTimeout(url, options?, timeoutMs?)` | `(string, RequestInit?, number?) => Promise<Response>` | The ONLY way to make an HTTP request from the main process. Adds a request budget to `fetch()`, composes rather than clobbers a caller-supplied `signal`. |
| `isFetchTimeoutError(error)`                  | `(unknown) => boolean`                                 | Distinguishes a budget timeout from a caller-initiated abort or a transport failure.                                                                      |
| `DEFAULT_FETCH_TIMEOUT_MS`                    | `number` (30s)                                         | Backstop for callers with no opinion. Latency-sensitive callers pass their own.                                                                           |

A bare `fetch()` has no timeout: a stalled socket hangs the caller forever,
which in the main process means an IPC handler that never settles and a
renderer spinner that never stops. Always use `fetchWithTimeout`.

Do NOT hand-roll `new AbortController()` + `setTimeout` around a `fetch`, and do
NOT add another local `fetchWithTimeout`. There were previously three separate
functions by that exact name with three different signatures (`leaderboard.ts`,
`cue-telemetry.ts`, `bmad-manager.ts`), three more inline copies, and eleven
call sites with no timeout at all.

If a caller needs extra behaviour, wrap this function locally rather than
reimplementing it. `bmad-manager.ts`'s `fetchBmadResource()` is the reference
example: it delegates to `fetchWithTimeout` and adds only its own Sentry
reporting.

### Safe IPC Send (`src/main/utils/safe-send.ts`)

| Function                        | Signature                       | Purpose                                                                                      |
| ------------------------------- | ------------------------------- | -------------------------------------------------------------------------------------------- |
| `createSafeSend(getMainWindow)` | `(GetMainWindow) => SafeSendFn` | Factory for safe IPC message sender. Handles disposed renderer, GPU crashes, window closing. |
| `isWebContentsAvailable(win)`   | `(BrowserWindow?) => boolean`   | Type guard to check if webContents is available.                                             |

---

## IPC Handler Utilities (`src/main/utils/ipcHandler.ts` - Main)

| Function                                 | Signature                                                                                      | Purpose                                        |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `createHandler(options, handler)`        | Wraps handler with try-catch, returns `{ success, ...result }` or `{ success: false, error }`. | For direct use, not ipcMain.handle.            |
| `createDataHandler(options, handler)`    | Same, returns `{ success, data }` format.                                                      | Standard data response.                        |
| `withErrorLogging(options, handler)`     | Wraps with error logging, re-throws on error.                                                  | Transparent error logging.                     |
| `withIpcErrorLogging(options, handler)`  | Same but strips the `_event` arg for ipcMain.handle compatibility.                             | Most common for IPC handlers.                  |
| `createIpcHandler(options, handler)`     | Like `createHandler` but strips `_event` arg.                                                  | For ipcMain.handle with custom response shape. |
| `createIpcDataHandler(options, handler)` | Like `createDataHandler` but strips `_event` arg.                                              | For ipcMain.handle with `{ success, data }`.   |
| `requireProcessManager(getter)`          | `(() => PM \| null) => PM`                                                                     | Throws if ProcessManager not initialized.      |
| `requireDependency(getter, name)`        | `<T>(() => T \| null, string) => T`                                                            | Generic require for nullable dependencies.     |

---

## Network & CLI Detection (Main Process)

### Network (`src/main/utils/networkUtils.ts`)

| Function                  | Signature               | Purpose                                                                    |
| ------------------------- | ----------------------- | -------------------------------------------------------------------------- |
| `getLocalIpAddress()`     | `() => Promise<string>` | Detect local IP via UDP socket to 8.8.8.8, fallback to interface scanning. |
| `getLocalIpAddressSync()` | `() => string`          | Sync version using interface scanning only.                                |

### CLI Detection (`src/main/utils/cliDetection.ts`)

| Function                     | Signature                       | Purpose                                                      |
| ---------------------------- | ------------------------------- | ------------------------------------------------------------ |
| `isCloudflaredInstalled()`   | `() => Promise<boolean>`        | Cached detection of cloudflared binary.                      |
| `isGhInstalled()`            | `() => Promise<boolean>`        | Cached detection of GitHub CLI.                              |
| `resolveGhPath(customPath?)` | `(string?) => Promise<string>`  | Get gh path with auto-detection and custom override.         |
| `detectSshPath()`            | `() => Promise<string \| null>` | Cached detection of ssh binary. Windows fallback to OpenSSH. |
| `resolveSshPath()`           | `() => Promise<string>`         | Get ssh path with fallback to `'ssh'`.                       |

---

## Pricing (`src/shared/modelPricing.ts` - Shared, re-exported by `src/main/utils/pricing.ts`)

Per-model token pricing is the single source of truth in `src/shared/modelPricing.ts` (no Electron imports, so the CLI bundles it directly). The main-process `pricing.ts` is a thin re-export kept as a stable import surface. Prefer the model-aware functions for new code.

| Function                                 | Signature                                 | Purpose                                                                                             |
| ---------------------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `calculateModelCost(tokens, modelId?)`   | `(TokenCounts, string?) => number`        | **Preferred.** USD cost priced for the given model (family fallback, then Sonnet-tier default).     |
| `computeClaudeUsageCost(jsonl)`          | `(string) => ClaudeUsageBreakdown`        | **Preferred.** Parse a Claude session JSONL into grand-total tokens + per-model-accurate cost.      |
| `resolveModelPricing(modelId?)`          | `(string?) => PricingConfig`              | Resolve a model string to its `PricingConfig` (exact → family substring → default).                 |
| `calculateWithPricing(tokens, pricing?)` | `(TokenCounts, PricingConfig?) => number` | USD cost against an explicit pricing config. Defaults to `DEFAULT_MODEL_PRICING` (Sonnet-tier).     |
| `calculateCost(tokens, pricing?)`        | `(TokenCounts, PricingConfig?) => number` | Back-compat alias of `calculateWithPricing`. Prefer `calculateModelCost()` when the model is known. |
| `calculateClaudeCost(...)`               | Individual params version                 | Deprecated. Use `calculateModelCost()` with a model ID, or `calculateCost()`.                       |

`MODEL_PRICING` (exact per-model table) and `DEFAULT_MODEL_PRICING` (unknown-model Sonnet-tier fallback) are also exported. `CLAUDE_PRICING` in `src/main/constants.ts` is now a deprecated re-export of `DEFAULT_MODEL_PRICING`.

**Not Claude-only.** `resolveModelPricing` checks the OpenAI families FIRST (`gpt-5*` and any slug containing `codex`, split by size class into nano / mini / frontier), because a Codex slug contains no Anthropic family word and used to fall straight through to the Sonnet-tier default - pricing GPT tokens at Claude rates. Only the GPT-5 line Codex actually ships is claimed; older OpenAI models still take the default rather than being priced off a family they do not belong to. Codex model slugs are discovered at runtime and version faster than a table can track, so the entries in `MODEL_PRICING` are anchors and the family fallback covers the point releases.

**The two providers disagree about what `input_tokens` means, and that is a pricing input.** Anthropic reports cache reads BESIDE `input_tokens`; OpenAI reports them INSIDE it. `PricingConfig.CACHE_READ_SUBSET_OF_INPUT` carries that on the tier, and `calculateWithPricing` bills only `input - cacheRead` at the input rate when it is set. Without it the cached half of a Codex turn is charged at the full input rate AND again as a cache read, which inverts the whole point of a cache hit. Set it on any provider tier that counts cached tokens inside the input total; leave it off for Anthropic.

---

## Codex Token Accounting (`src/shared/codexTokenUsage.ts` - Shared)

`CodexTokenCounts` is the ONE accumulator for token totals scanned out of a Codex CLI rollout transcript. Feed it events; read `inputTokens` / `outputTokens` / `cachedTokens` / `isEmpty`.

| Method                     | Purpose                                                                |
| -------------------------- | ---------------------------------------------------------------------- |
| `addTurn(usage)`           | A per-turn record: `turn.completed.usage`, or `info.last_token_usage`. |
| `addTokenCountEvent(info)` | A `token_count` event payload's `info`. Picks the right field for you. |

**Codex reports usage in two shapes and only one of them is incremental.** `turn.completed.usage` and `info.last_token_usage` are per-turn; `info.total_token_usage` is the running SESSION TOTAL. Summing the latter across events makes a session with N turns report 1+2+...+N times its real tokens, so cost grows with the SQUARE of the conversation length - on a real corpus that turned 1.3B input tokens into 75B and a ~$350 estimate into ~$250,000, which is how Codex came to outrank Claude on a dashboard driven almost entirely by Claude agents. `addTokenCountEvent` prefers `last_token_usage` and, when only the cumulative total is present, adds the DELTA since the previous event; a total that moves backwards is read as a restarted counter (a resume or a fork) and taken whole rather than clamped to zero.

Reasoning output is folded into `outputTokens` (it bills as output), and `cachedTokens` stays a SUBSET of `inputTokens`, matching how Codex reports it - see `CACHE_READ_SUBSET_OF_INPUT` above. Do NOT hand-roll another sum: the three call sites that did (`main/storage/codex-session-storage.ts` x2, `main/ipc/handlers/agentSessions.ts`) all carried this bug independently.

**A derivation fix needs a cache-version bump.** Both stats caches fingerprint a transcript on its mtime and size, neither of which a parser fix touches, so old numbers would be served forever. `TOKEN_USAGE_CACHE_VERSION` (`main/stats/token-usage/token-usage-cache.ts`) and `GLOBAL_STATS_CACHE_VERSION` (`main/utils/statsCache.ts`) both went to 4 for this.

---

## Stats Cache (`src/main/utils/statsCache.ts` - Main)

| Function                             | Signature                                        | Purpose                                    |
| ------------------------------------ | ------------------------------------------------ | ------------------------------------------ |
| `getStatsCachePath(projectPath)`     | `(string) => string`                             | Per-project stats cache file path.         |
| `loadStatsCache(projectPath)`        | `(string) => Promise<SessionStatsCache \| null>` | Load with version validation.              |
| `saveStatsCache(projectPath, cache)` | `(string, SessionStatsCache) => Promise<void>`   | Save with directory creation.              |
| `getGlobalStatsCachePath()`          | `() => string`                                   | Global stats cache file path.              |
| `loadGlobalStatsCache()`             | `() => Promise<GlobalStatsCache \| null>`        | Load global cache with version validation. |
| `saveGlobalStatsCache(cache)`        | `(GlobalStatsCache) => Promise<void>`            | Save global cache.                         |

## Active Agents in Range (`src/shared/statsActiveAgents.ts` - Both)

| Function                                          | Signature                                      | Purpose                                  |
| ------------------------------------------------- | ---------------------------------------------- | ---------------------------------------- |
| `isAgentActiveInRange(sessionId, bySessionByDay)` | `(string, BySessionByDay?) => boolean`         | Did this agent record work in the range? |
| `countActiveAgents(agents, bySessionByDay)`       | `(readonly {id}[], BySessionByDay?) => number` | How many of these agents did.            |

"Active" is a RANGE question, not a live-status one: an agent counts when it recorded at least one
`query_events` row inside the dashboard's selected range, which covers interactive turns, Auto Run
tasks, execution-queue drains, and Cue runs alike. The Usage Dashboard's Overview card, the Agent
Overview `Total Agents` card, and the Agents tab's "Active only" toggle all read it, so they cannot
disagree about who counts.

Do NOT answer this with `getSessionQueryCount()` from `AgentOverviewCards`: that one falls back to
the PROVIDER total when a session has no rows of its own and is the only visible session for that
provider, which would mark an agent that ran nothing as active because a sibling on the same
provider did.

---

## Renderer-Only Utilities

### Token Counter (`src/renderer/utils/tokenCounter.ts`)

| Function                  | Signature                     | Purpose                                                            |
| ------------------------- | ----------------------------- | ------------------------------------------------------------------ |
| `countTokens(text)`       | `(string) => Promise<number>` | Accurate count using tiktoken cl100k_base. Falls back to estimate. |
| `estimateTokens(text)`    | `(string) => number`          | Sync heuristic: ~4 chars/token.                                    |
| `formatTokenCount(count)` | `(number) => string`          | `"1.2k"`, `"15k"`, `"1.5M"`.                                       |

### Shortcut Formatter (`src/renderer/utils/shortcutFormatter.ts`)

| Function                               | Signature                       | Purpose                                                                              |
| -------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------ |
| `formatKey(key)`                       | `(string) => string`            | Platform-aware key symbol (Mac: `"Meta"` -> `"command"`, Win: `"Meta"` -> `"Ctrl"`). |
| `formatShortcutKeys(keys, separator?)` | `(string[], string?) => string` | Format key array: Mac `"command shift K"`, Win `"Ctrl+Shift+K"`.                     |
| `formatMetaKey()`                      | `() => string`                  | Symbol form: `"command"` on Mac, `"Ctrl"` on Win/Linux.                              |
| `formatMetaKeyName()`                  | `() => string`                  | Prose form: `"Command"` on Mac, `"Ctrl"` on Win/Linux. For sentences and tooltips.   |
| `formatEnterToSend(enterToSend)`       | `(boolean) => string`           | `"Enter"` or `"command + Enter"` / `"Ctrl + Enter"`.                                 |

**Never hard-code a modifier key in UI copy.** Literal `⌘`, `Cmd+`, or `Ctrl+`
in a tooltip, setting description, or help table renders the wrong key on the
other platform. Pass `''` as the separator when you want the tight macOS form
(`formatShortcutKeys(['Meta', 'f'], '')` -> `⌘F`); pass `'+'` (the default) for
the spelled-out platforms.

### Context Usage (`src/renderer/utils/contextUsage.ts`)

| Function                                                                                | Signature                                       | Purpose                                                                              |
| --------------------------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------ |
| `calculateContextTokens(stats, agentId?)`                                               | `(UsageStats, string?) => number`               | Agent-specific context token calculation. Claude: input+cache. OpenAI: input+output. |
| `estimateContextUsage(stats, agentId?)`                                                 | `(UsageStats, string?) => number \| null`       | Estimate context usage %. Returns null for accumulated multi-tool turns.             |
| `calculateContextDisplay(usageStats, contextWindow, agentId?, fallbackPercentage?)`     | Returns `{ tokens, percentage, contextWindow }` | Single source of truth for context gauge rendering.                                  |
| `estimateAccumulatedGrowth(currentUsage, outputTokens, cacheReadTokens, contextWindow)` | `(number, number, number, number) => number`    | Conservative growth estimate during tool-heavy turns. Bounded to 1-3% per turn.      |

### Context Window Precedence (`src/renderer/utils/contextWindowPrecedence.ts`)

**The canonical ranking for "which context window do we divide by".** Any new
surface that needs the effective window MUST resolve through this rather than
re-deriving the order - a divergent copy is how the header gauge and the Context
Timeline disagreed before PR #1221, and findings P1/AD1 exist to keep them in
step.

| Function                                    | Signature                                        | Purpose                                                                |
| ------------------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------- |
| `resolveContextWindow(inputs)`              | `(ContextWindowInputs) => ResolvedContextWindow` | Effective window PLUS the `source` rank that supplied it.              |
| `isStoredContextWindowOverridden(resolved)` | `(ResolvedContextWindow) => boolean`             | True when a stored `customContextWindow` exists but a higher rank won. |

Precedence: `[1m]` model marker > user-edited `customContextWindow` > provider-resolved
report > stored `customContextWindow` of unknown provenance > agent config > raw report.

It returns the winning SOURCE, not just the number, because "is the stored value
overridden?" is unanswerable from the figure alone - a stored 200k and a
provider-reported 200k are numerically identical and opposite in meaning.

Known consumers: `useContextWindow` (header gauge) and `EditAgentModal`'s
override note. `useAgentUsageListener` mirrors the shared ranks for the Context
Timeline with two timeline-only extras interleaved below rank 4; keep the shared
ranks positionally identical there. A THIRD list exists in
`resolveConfiguredContextWindow` (`contextWindowResolver.ts`, Auto Run's
fresh-context picker) which ranks the stored value first unconditionally - it
predates P1/AD1, serves a different purpose, and is deliberately NOT kept in sync.

### Session Helpers (`src/renderer/utils/sessionHelpers.ts`)

| Function                                  | Signature                                                                        | Purpose                                                                                 |
| ----------------------------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `buildSpawnConfigForAgent(options)`       | `(BuildSpawnConfigOptions) => Promise<ProcessConfig \| null>`                    | Build spawn config for an agent. Fetches agent config from main process.                |
| `createSessionForAgent(options)`          | `(CreateSessionForAgentOptions) => Promise<CreateSessionForAgentResult \| null>` | Create session structure + spawn config for agent initialization.                       |
| `agentSupportsContextTransfer(agentType)` | `(ToolType) => Promise<boolean>`                                                 | Check if agent supports receiving merged context.                                       |
| `getSessionSshRemoteId(session)`          | `(SessionSshInfo?) => string \| undefined`                                       | Get effective SSH remote ID. Handles the sshRemoteId vs sessionSshRemoteConfig pitfall. |
| `isSessionRemote(session)`                | `(SessionSshInfo?) => boolean`                                                   | Check if session is SSH remote. Works for both AI and terminal-only sessions.           |

### Session Attention Filter (`src/renderer/utils/sessionAttention.ts`)

Single source of truth for the Left Bar "unread agents only" (a.k.a. "needs attention") filter. Every surface that filters by unread MUST route through these so they never diverge: categorization (`useSessionCategories`), the bell badge + rendered worktree children (`SessionList`), the jump-badge / nav projection (`computeSortedSessions` via `SidebarNavSync`), the collapsed rail (`SkinnySidebar`), and keyboard cycling (`useCycleSession`). Do NOT re-inline the checks - a partial copy is how an auto-running worktree child ends up hidden while its parent stays visible. The active-session carve-out is intentionally NOT here: each surface keeps its own "always show the active agent (or its parent)" rule, since an active idle agent does not itself need attention.

| Function / Type                                          | Signature                                                                       | Purpose                                                                                                                                         |
| -------------------------------------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `AttentionContext`                                       | `{ batchSessionIds: ReadonlySet<string>; stuckOutageIds: ReadonlySet<string> }` | Store-derived inputs the predicate can't read off the Session: Auto Run batch ids (batchStore) + stuck outage ids (retryStore).                 |
| `sessionNeedsAttention(session, ctx)`                    | `(Session, AttentionContext) => boolean`                                        | True when an agent has an unread AI tab, is busy, is in an error state, is auto-running an Auto Run batch, or is stuck auto-retrying an outage. |
| `sessionOrChildrenNeedAttention(session, children, ctx)` | `(Session, readonly Session[] \| undefined, AttentionContext) => boolean`       | Keep a parent visible when it or any worktree child needs attention.                                                                            |
| `outageIdsFromSignature(signature)`                      | `(string) => Set<string>`                                                       | Parse the comma-joined outage signature (`useActiveOutageSessionSignature`) into a lookup set; guards the empty-string case.                    |

For the event-time (non-reactive) path - `useCycleSession`'s `getState()` reads - build the outage set with `getActiveOutageSessionIds()` from `src/renderer/stores/retryStore.ts` and the batch set with `selectActiveBatchSessionIds(useBatchStore.getState())`.

### Sidebar Session Visibility (`src/renderer/utils/sessionVisibility.ts`)

Which agents the Left Bar may surface AT ALL - a different question from the unread filter above (what to show right now) and from `scopeSessionsToOwningWindow()` in `windowTargets.ts` (which window owns an agent). Today it answers exactly one case: the pinned Pianola manager agent PERSISTS in the session store after its Encore flag is switched off (so re-enabling restores the same agent and its chat), and `SessionList` just stops rendering its row. Any other surface that walks `sessions` - `Cmd+[` / `Cmd+]` cycling, arrow-key nav, `Opt+Cmd+NUMBER` jumps, the Starred section - would otherwise still land on a hidden agent and show "Pianola" for a disabled feature. Applied in `SidebarNavSync` (nav projections), `useStarredItems` (starred rows), and `cycleSession` (its own event-time visual order). A new agent that is conditionally hidden belongs in this predicate, not in a fourth open-coded check.

| Function / Type                                  | Signature                                                          | Purpose                                                                                                              |
| ------------------------------------------------ | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `SidebarVisibilityOptions`                       | `{ pianolaEnabled?: boolean }`                                     | Encore flags the predicate needs; omitted / false means Pianola is hidden.                                           |
| `isSessionVisibleInSidebar(session, options)`    | `(VisibilityScopableSession, SidebarVisibilityOptions) => boolean` | True when the agent may appear in the Left Bar and its keyboard orders.                                              |
| `filterSessionsVisibleInSidebar(sessions, opts)` | `<T>(T[], SidebarVisibilityOptions) => T[]`                        | Drop hidden agents. Returns the ORIGINAL array when nothing is filtered, so memoized consumers stay identity-stable. |

### Sentry (`src/renderer/utils/sentry.ts`)

| Function                                   | Signature                                 | Purpose                                 |
| ------------------------------------------ | ----------------------------------------- | --------------------------------------- |
| `captureException(error, captureContext?)` | `(Error \| unknown, { extra? }?) => void` | Report error to Sentry from renderer.   |
| `captureMessage(message, captureContext?)` | `(string, { level?, extra? }?) => void`   | Report message to Sentry from renderer. |

### Tool Activity Labels (`src/renderer/utils/toolActivityLabel.ts`)

`describeToolActivity(toolName, input)` turns one raw agent tool call into ONE short line of plain English (`Read src/App.tsx`, `Ran npm test`, `Edited themes.ts`), returning `{ verb, target }`.

Tool names differ per provider (Claude Code `Read`/`Bash`/`MultiEdit`, OpenCode lowercase `read`/`bash`, Codex `shell`/`apply_patch`/`update_plan`, Copilot `write_to_file`, MCP `mcp__server__tool`), so matching runs on a normalized name. An unrecognized tool still returns a usable `Used <name>` line rather than being dropped, so a provider that ships a new tool degrades to something readable instead of a hole in the feed. It never throws: a raw-string input (Codex `apply_patch` sends a whole diff, not an object) and an argv-array `command` are both handled.

`describeToolActivityStatus(state)` is the other half of the same job: it turns a raw tool-lifecycle payload into `'running' | 'completed' | 'failed'`. **Read the whole payload through it, never `state.status` alone.** Codex reports a shell command that exited non-zero as `status: 'completed'` and puts the failure in `exit_code`, so trusting the word draws a check mark beside a failed build - the exact row an operator is scanning a supervision feed for. Failure signals (non-zero exit code, `isError`/`is_error`) win over the status word. A zero exit code reads as `completed` even when the provider sent no status word at all, since the shell already answered the question. `running` is only what is left when the payload carries neither a recognized terminal word nor a zero exit code - the reading that cannot mislead, because the completion event resolves it. `ToolActivityStatus` is declared here too, and re-exported from `thoughtStreamStore` for consumers of the timeline.

**Do NOT confuse it with `summarizeToolInput()`** (`components/TerminalOutput/utils/toolSummaries.ts`), which builds the VERBOSE in-chat tool cell: every input key as `key=value`, the untruncated command, plus an output preview. Pick by surface - a chat transcript the user reads line by line wants the verbose cell; the Thought Stream's activity feed wants the one-liner, because its whole job is being scannable enough to spot a loop.

---

### Touch Primitives (`src/renderer/utils/touch.ts`)

The desktop renderer also runs on phones (web-desktop build). These are the canonical touch helpers - do NOT re-derive `navigator.vibrate` calls or pointer-media queries. Hoisted out of the legacy mobile bundle (retired in Phase 06); the touch gesture hook `useLongPress` (see [UI-PATTERNS.md](UI-PATTERNS.md)) is built on `triggerHaptic`/`HAPTIC_PATTERNS`.

| Export               | Signature                                         | Purpose                                                                                                                                   |
| -------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `isCoarsePointer`    | `() => boolean`                                   | True when the primary pointer is coarse (finger/stylus). Gate touch-only affordances on it. Falls back to `false` if `matchMedia` throws. |
| `triggerHaptic`      | `(pattern?: number \| readonly number[]) => void` | Fire `navigator.vibrate` when supported; no-op otherwise. Defaults to a 10ms tap.                                                         |
| `supportsHaptics`    | `() => boolean`                                   | Whether `navigator.vibrate` exists.                                                                                                       |
| `HAPTIC_PATTERNS`    | const record                                      | Named vibrate patterns: `tap`, `send`, `interrupt`, `success`, `error`.                                                                   |
| `GESTURE_THRESHOLDS` | const record                                      | `swipeDistance`, `swipeTime`, `pullToRefresh`, `longPress` thresholds.                                                                    |
| `MIN_TOUCH_TARGET`   | `44`                                              | Minimum touch target size (px) per Apple HIG.                                                                                             |

---

## Themes

### Types (`src/shared/theme-types.ts` - Both)

| Type                 | Purpose                                                                               |
| -------------------- | ------------------------------------------------------------------------------------- |
| `ThemeId`            | Union of 17 theme identifiers (dracula, monokai, nord, etc. + custom).                |
| `ThemeMode`          | `'light' \| 'dark' \| 'vibe'`                                                         |
| `ThemeColors`        | 13-property color palette (bgMain, bgSidebar, accent, success, warning, error, etc.). |
| `Theme`              | Complete theme: `{ id, name, mode, colors }`.                                         |
| `isValidThemeId(id)` | Type guard for ThemeId validation.                                                    |

### Definitions (`src/shared/themes.ts` - Both)

| Export                        | Purpose                                              |
| ----------------------------- | ---------------------------------------------------- |
| `THEMES`                      | `Record<ThemeId, Theme>` - All 17 theme definitions. |
| `DEFAULT_CUSTOM_THEME_COLORS` | Dracula colors as default for custom theme.          |
| `getThemeById(themeId)`       | Look up a theme, returns null if not found.          |

### Color Math & Contrast (`src/shared/colorContrast.ts` - Both)

Use these instead of hand-rolling hex math. **Any time you compute a foreground
color for a themed surface, run it through `readableTextOn()`** - a theme whose
accent sits close to its text color will otherwise paint near-identical colors
on top of each other (this is exactly how Mermaid ER attribute rows became
unreadable).

| Export                                               | Purpose                                                                                                                   |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `readableTextOn(preferred, backgrounds, threshold?)` | Returns `preferred` when it clears WCAG AA on **every** background; otherwise nudges it toward white/black until it does. |
| `isReadableOn(fg, backgrounds, threshold?)`          | Boolean form - assert contrast in tests without recomputing ratios.                                                       |
| `contrastRatio(a, b)`                                | WCAG 2.1 ratio (1-21). Returns 21 for unparseable colors so exotic custom-theme values are left alone.                    |
| `relativeLuminance(hex)`                             | WCAG relative luminance, or null if unparseable.                                                                          |
| `hexToRgb(hex)`                                      | `#rrggbb` -> `{r,g,b}` or null (3-digit, `rgb()`, and named colors return null).                                          |
| `adjustBrightness(hex, percent)`                     | Shift toward white (+) or black (-), hue broadly preserved.                                                               |
| `blendColors(c1, c2, ratio)`                         | Mix two colors; `ratio` is how much of `c2` lands in the result.                                                          |
| `transparentize(color, bg, alpha)`                   | Flatten a tint into an opaque color, for renderers that only accept solid fills (SVG/canvas).                             |
| `AA_CONTRAST` / `AA_LARGE_CONTRAST`                  | 4.5 (normal text) and 3 (large text) thresholds.                                                                          |
