<!-- Verified 2026-04-10 against origin/rc (06e5a2eb3) -->

# Prompts and Specification Systems

Maestro's prompt system consists of Markdown templates compiled to TypeScript at build time, a template variable substitution engine, and two specification management systems (SpecKit and OpenSpec) that layer user-customizable prompts on top of bundled defaults.

## Prompt Templates

### Build Pipeline

Prompt templates are stored as `.md` files in `src/prompts/`. At build time, `scripts/generate-prompts.mjs` compiles them into `src/generated/prompts.ts` as exported string constants. The barrel file `src/prompts/index.ts` re-exports these constants.

```text
src/prompts/*.md
    |
    v  (scripts/generate-prompts.mjs)
src/generated/prompts.ts
    |
    v  (re-export)
src/prompts/index.ts
```

### Template Inventory

#### Wizard Prompts

| File                                  | Export                                | Purpose                                                     |
| ------------------------------------- | ------------------------------------- | ----------------------------------------------------------- |
| `wizard-system.md`                    | `wizardSystemPrompt`                  | System prompt for the Wizard (Auto Run document generation) |
| `wizard-system-continuation.md`       | `wizardSystemContinuationPrompt`      | Continuation prompt for multi-turn Wizard conversations     |
| `wizard-document-generation.md`       | `wizardDocumentGenerationPrompt`      | Document generation instructions                            |
| `wizard-inline-system.md`             | `wizardInlineSystemPrompt`            | System prompt for the Inline Wizard                         |
| `wizard-inline-iterate.md`            | `wizardInlineIteratePrompt`           | Inline Wizard iteration prompt                              |
| `wizard-inline-new.md`                | `wizardInlineNewPrompt`               | Inline Wizard new document prompt                           |
| `wizard-inline-iterate-generation.md` | `wizardInlineIterateGenerationPrompt` | Inline Wizard iteration generation                          |

#### Auto Run Prompts

| File                  | Export                  | Purpose                                                                                                                                                        |
| --------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `autorun-default.md`  | `autorunDefaultPrompt`  | Default system prompt for Auto Run execution. Provides agent context, git branch, loop iteration, and working folder. Requires synopsis-first response format. |
| `autorun-synopsis.md` | `autorunSynopsisPrompt` | Synopsis extraction prompt                                                                                                                                     |

#### Group Chat Prompts

| File                                | Export                              | Purpose                                                                                                                             |
| ----------------------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `group-chat-moderator-system.md`    | `groupChatModeratorSystemPrompt`    | Moderator system prompt. Instructs the moderator to assist directly for simple tasks and delegate via `@mentions` for complex work. |
| `group-chat-moderator-synthesis.md` | `groupChatModeratorSynthesisPrompt` | Synthesis prompt for reviewing agent responses. Moderator decides whether to continue delegating or summarize.                      |
| `group-chat-participant.md`         | `groupChatParticipantPrompt`        | Participant system prompt. Sets response format (overview first, then details).                                                     |
| `group-chat-participant-request.md` | `groupChatParticipantRequestPrompt` | Per-message request prompt with chat history and moderator's delegation.                                                            |

#### Context Management Prompts

| File                   | Export                   | Purpose                                                                                 |
| ---------------------- | ------------------------ | --------------------------------------------------------------------------------------- |
| `context-grooming.md`  | `contextGroomingPrompt`  | Instructions for consolidating multiple conversation contexts into one coherent context |
| `context-transfer.md`  | `contextTransferPrompt`  | Instructions for transferring context between sessions                                  |
| `context-summarize.md` | `contextSummarizePrompt` | Instructions for summarizing a conversation context                                     |

#### Input Processing

| File                    | Export                   | Purpose                                                 |
| ----------------------- | ------------------------ | ------------------------------------------------------- |
| `image-only-default.md` | `imageOnlyDefaultPrompt` | Default prompt when only images are submitted (no text) |

#### Commands

| File                | Export                | Purpose                          |
| ------------------- | --------------------- | -------------------------------- |
| `commit-command.md` | `commitCommandPrompt` | Prompt for the `/commit` command |

#### System Prompts

| File                       | Export                | Purpose                                                                                                                      |
| -------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `maestro-system-prompt.md` | `maestroSystemPrompt` | Base system prompt injected into all agent sessions. Provides agent name, tool type, conductor profile, and Maestro context. |
| `tab-naming.md`            | `tabNamingPrompt`     | Prompt for automatic tab naming based on conversation content                                                                |
| `director-notes.md`        | `directorNotesPrompt` | Prompt for Director's Notes (unified history + synopsis generation)                                                          |

## Template Variables

Defined in `src/shared/templateVariables.ts`. Variables use `{{VARIABLE_NAME}}` syntax and are case-insensitive.

### Variable Categories

#### Conductor Variables (the Maestro user)

| Variable                | Description                           |
| ----------------------- | ------------------------------------- |
| `{{CONDUCTOR_PROFILE}}` | User's About Me profile from Settings |

#### Agent Variables

| Variable                 | Description                                                      |
| ------------------------ | ---------------------------------------------------------------- |
| `{{AGENT_ID}}`           | Agent UUID (Maestro agent identifier, for CLI targeting)         |
| `{{AGENT_NAME}}`         | Agent display name                                               |
| `{{AGENT_PATH}}`         | Agent home directory path (full path to project)                 |
| `{{AGENT_GROUP}}`        | Agent's group name (if grouped)                                  |
| `{{AGENT_SESSION_ID}}`   | Agent session ID (for conversation continuity)                   |
| `{{AGENT_HISTORY_PATH}}` | Path to agent's history JSON file                                |
| `{{TAB_NAME}}`           | Custom tab name (alias: `SESSION_NAME`)                          |
| `{{TOOL_TYPE}}`          | Agent type (`claude-code`, `codex`, `opencode`, `factory-droid`) |

#### Path Variables

| Variable             | Description                    |
| -------------------- | ------------------------------ |
| `{{CWD}}`            | Current working directory      |
| `{{AUTORUN_FOLDER}}` | Auto Run documents folder path |

#### Auto Run Variables

| Variable            | Description                                           |
| ------------------- | ----------------------------------------------------- |
| `{{DOCUMENT_NAME}}` | Current Auto Run document name (without `.md`)        |
| `{{DOCUMENT_PATH}}` | Full path to current Auto Run document                |
| `{{LOOP_NUMBER}}`   | Current loop iteration (5-digit padded, e.g. `00001`) |

#### Date/Time Variables

| Variable         | Description                           |
| ---------------- | ------------------------------------- |
| `{{DATE}}`       | Current date (`YYYY-MM-DD`)           |
| `{{TIME}}`       | Current time (`HH:MM:SS`)             |
| `{{DATETIME}}`   | Full datetime (`YYYY-MM-DD HH:MM:SS`) |
| `{{TIMESTAMP}}`  | Unix timestamp in milliseconds        |
| `{{DATE_SHORT}}` | Short date (`MM/DD/YY`)               |
| `{{TIME_SHORT}}` | Short time (`HH:MM`)                  |
| `{{YEAR}}`       | Current year                          |
| `{{MONTH}}`      | Current month (`01-12`)               |
| `{{DAY}}`        | Current day (`01-31`)                 |
| `{{WEEKDAY}}`    | Day of week (e.g. `Monday`)           |

#### Git Variables

| Variable          | Description                                 |
| ----------------- | ------------------------------------------- |
| `{{GIT_BRANCH}}`  | Current git branch name (requires git repo) |
| `{{IS_GIT_REPO}}` | `"true"` or `"false"`                       |

#### Context Variables

| Variable            | Description                             |
| ------------------- | --------------------------------------- |
| `{{CONTEXT_USAGE}}` | Current context window usage percentage |

#### Deep Link Variables

| Variable              | Description                                                                |
| --------------------- | -------------------------------------------------------------------------- |
| `{{AGENT_DEEP_LINK}}` | `maestro://` deep link to this agent                                       |
| `{{TAB_DEEP_LINK}}`   | `maestro://` deep link to this agent + active tab                          |
| `{{GROUP_DEEP_LINK}}` | `maestro://` deep link to this agent's group (empty string if not grouped) |

#### Maestro Variables

| Variable               | Description                                                                       |
| ---------------------- | --------------------------------------------------------------------------------- |
| `{{MAESTRO_CLI_PATH}}` | Platform-appropriate path to the `maestro-cli` binary (for use in shell commands) |

#### Cue Variables (Cue automation only)

Variables populated only when a prompt is rendered as part of a Maestro Cue run. Accessed on `context.cue` in the substitution function. See `src/shared/templateVariables.ts` for the full list, which includes:

- **Event metadata:** `{{CUE_EVENT_TYPE}}`, `{{CUE_EVENT_TIMESTAMP}}`, `{{CUE_TRIGGER_NAME}}`, `{{CUE_RUN_ID}}`
- **File change events:** `{{CUE_FILE_PATH}}`, `{{CUE_FILE_NAME}}`, `{{CUE_FILE_DIR}}`, `{{CUE_FILE_EXT}}`, `{{CUE_FILE_CHANGE_TYPE}}`
- **Agent-completion / chained-run events:** `{{CUE_SOURCE_SESSION}}`, `{{CUE_SOURCE_OUTPUT}}`, `{{CUE_SOURCE_STATUS}}`, `{{CUE_SOURCE_EXIT_CODE}}`, `{{CUE_SOURCE_DURATION}}`, `{{CUE_SOURCE_TRIGGERED_BY}}`
- **Task pending events (`task.pending`):** `{{CUE_TASK_FILE}}`, `{{CUE_TASK_FILE_NAME}}`, `{{CUE_TASK_FILE_DIR}}`, `{{CUE_TASK_COUNT}}`, `{{CUE_TASK_LIST}}`, `{{CUE_TASK_CONTENT}}`
- **GitHub events (`github.pull_request`, `github.issue`):** `{{CUE_GH_TYPE}}`, `{{CUE_GH_NUMBER}}`, `{{CUE_GH_TITLE}}`, `{{CUE_GH_AUTHOR}}`, `{{CUE_GH_URL}}`, `{{CUE_GH_BODY}}`, `{{CUE_GH_LABELS}}`, `{{CUE_GH_STATE}}`, `{{CUE_GH_REPO}}`, `{{CUE_GH_BRANCH}}`, `{{CUE_GH_BASE_BRANCH}}`, `{{CUE_GH_ASSIGNEES}}`, `{{CUE_GH_MERGED_AT}}`

### Substitution Flow

Template variables are resolved at runtime by `src/shared/templateVariables.ts` (used from both main and renderer):

1. Callers build a `TemplateContext` object with the current session, git info, group name, Auto Run state, conductor profile, history path, and — for Cue prompts — a `cue` sub-object with event metadata.
2. `substituteTemplateVariables(template, context)` performs case-insensitive replacement of all `{{...}}` patterns.
3. Variables not matched are left as-is (no error for unknown variables).

The `TemplateContext` interface (abbreviated - see `src/shared/templateVariables.ts:148` for the full definition, including the 30+ fields on the `cue` sub-object):

```typescript
interface TemplateContext {
	session: TemplateSessionInfo;
	gitBranch?: string;
	groupName?: string;
	groupId?: string;
	activeTabId?: string;
	autoRunFolder?: string;
	loopNumber?: number;
	// Auto Run document context
	documentName?: string;
	documentPath?: string;
	// History file path for task recall
	historyFilePath?: string;
	// Conductor profile (user's About Me from settings)
	conductorProfile?: string;
	// Cue event context (populated only for Cue automation prompts)
	cue?: {
		eventType?: string;
		eventTimestamp?: string;
		triggerName?: string;
		runId?: string;
		// File change fields
		filePath?: string;
		fileName?: string;
		fileDir?: string;
		fileExt?: string;
		fileChangeType?: string;
		// Source-session fields (agent.completed / chained runs)
		sourceSession?: string;
		sourceOutput?: string;
		sourceStatus?: string;
		sourceExitCode?: string;
		sourceDuration?: string;
		sourceTriggeredBy?: string;
		// task.pending fields
		taskFile?: string;
		taskFileName?: string;
		taskFileDir?: string;
		taskCount?: string;
		taskList?: string;
		taskContent?: string;
		// github.pull_request / github.issue fields
		ghType?: string;
		ghNumber?: string;
		ghTitle?: string;
		ghAuthor?: string;
		ghUrl?: string;
		ghBody?: string;
		ghLabels?: string;
		ghState?: string;
		ghRepo?: string;
		ghBranch?: string;
		ghBaseBranch?: string;
		ghAssignees?: string;
		ghMergedAt?: string;
	};
}
```

## SpecKit System

SpecKit provides structured specification management for software projects. It is integrated from the external `spec-kit` repository and bundled as prompts in `src/prompts/speckit/`.

### Commands

| Command                  | ID              | Description                                                   | Custom? |
| ------------------------ | --------------- | ------------------------------------------------------------- | ------- |
| `/speckit.help`          | `help`          | Learn how to use spec-kit with Maestro                        | Yes     |
| `/speckit.constitution`  | `constitution`  | Create or update the project constitution                     | No      |
| `/speckit.specify`       | `specify`       | Create or update feature specification                        | No      |
| `/speckit.clarify`       | `clarify`       | Identify underspecified areas and ask clarification questions | No      |
| `/speckit.plan`          | `plan`          | Execute implementation planning workflow                      | No      |
| `/speckit.tasks`         | `tasks`         | Generate actionable, dependency-ordered tasks                 | No      |
| `/speckit.analyze`       | `analyze`       | Cross-artifact consistency and quality analysis               | No      |
| `/speckit.checklist`     | `checklist`     | Generate custom checklist for feature                         | No      |
| `/speckit.taskstoissues` | `taskstoissues` | Convert tasks to GitHub issues                                | No      |
| `/speckit.implement`     | `implement`     | Execute tasks using Maestro Auto Run with worktree support    | Yes     |

Commands marked "Custom" (`isCustom: true`) are Maestro-specific additions not from the upstream spec-kit repo.

### Files

Bundled prompts in `src/prompts/speckit/`:

```text
speckit/
  index.ts            # Export barrel
  metadata.json        # Version and source info
  speckit.analyze.md
  speckit.checklist.md
  speckit.clarify.md
  speckit.constitution.md
  speckit.help.md
  speckit.implement.md
  speckit.plan.md
  speckit.specify.md
  speckit.tasks.md
  speckit.taskstoissues.md
```

### Manager (`src/main/speckit-manager.ts`)

The SpecKit manager handles:

1. **Loading bundled prompts** from `src/prompts/speckit/*.md`
2. **Fetching updates** from the GitHub spec-kit repository
3. **User customization** with ability to reset to defaults

Data model:

```typescript
interface SpecKitCommand {
	id: string;
	command: string; // e.g. '/speckit.plan'
	description: string;
	prompt: string; // The full prompt text
	isCustom: boolean; // Whether this is a Maestro-specific command
	isModified: boolean; // Whether user has customized this prompt
}

interface SpecKitMetadata {
	lastRefreshed: string;
	commitSha: string;
	sourceVersion: string;
	sourceUrl: string;
}
```

User customizations are stored in `{userData}/speckit-customizations.json`.

### IPC Handlers

Registered in `src/main/ipc/handlers/speckit.ts`:

| Handler               | Description                                 |
| --------------------- | ------------------------------------------- |
| `speckit:getMetadata` | Get version/source metadata                 |
| `speckit:getPrompts`  | Get all SpecKit commands with their prompts |
| `speckit:getCommand`  | Get a single command by ID                  |
| `speckit:savePrompt`  | Save a user's custom prompt for a command   |
| `speckit:resetPrompt` | Reset a command to its bundled default      |
| `speckit:refresh`     | Fetch latest prompts from GitHub            |

### Renderer Component

`src/renderer/components/SpecKitCommandsPanel.tsx` provides the UI for browsing, running, and customizing SpecKit commands.

## OpenSpec System

OpenSpec provides structured change management for software projects. It follows a three-phase workflow: Proposal, Apply, Archive. It is integrated from the external [Fission-AI/OpenSpec](https://github.com/Fission-AI/OpenSpec) repository.

### Commands

| Command               | ID          | Description                                                          | Custom? |
| --------------------- | ----------- | -------------------------------------------------------------------- | ------- |
| `/openspec.help`      | `help`      | Learn how to use OpenSpec with Maestro                               | Yes     |
| `/openspec.proposal`  | `proposal`  | Create a change proposal with specs, tasks, and optional design docs | No      |
| `/openspec.apply`     | `apply`     | Implement an approved change proposal by executing tasks             | No      |
| `/openspec.archive`   | `archive`   | Archive a completed change after deployment                          | No      |
| `/openspec.implement` | `implement` | Convert OpenSpec tasks to Maestro Auto Run documents                 | Yes     |

### Files

Bundled prompts in `src/prompts/openspec/`:

```text
openspec/
  index.ts             # Export barrel
  metadata.json         # Version and source info
  openspec.apply.md
  openspec.archive.md
  openspec.help.md
  openspec.implement.md
  openspec.proposal.md
```

### Manager (`src/main/openspec-manager.ts`)

Same architecture as SpecKit manager:

1. **Loading bundled prompts** from `src/prompts/openspec/*.md`
2. **Fetching updates** from the GitHub OpenSpec repository
3. **User customization** with ability to reset to defaults

Data model mirrors SpecKit:

```typescript
interface OpenSpecCommand {
	id: string;
	command: string; // e.g. '/openspec.proposal'
	description: string;
	prompt: string;
	isCustom: boolean;
	isModified: boolean;
}

interface OpenSpecMetadata {
	lastRefreshed: string;
	commitSha: string;
	sourceVersion: string;
	sourceUrl: string;
}
```

User customizations are stored in `{userData}/openspec-customizations.json`.

### IPC Handlers

Registered in `src/main/ipc/handlers/openspec.ts`:

| Handler                | Description                                  |
| ---------------------- | -------------------------------------------- |
| `openspec:getMetadata` | Get version/source metadata                  |
| `openspec:getPrompts`  | Get all OpenSpec commands with their prompts |
| `openspec:getCommand`  | Get a single command by ID                   |
| `openspec:savePrompt`  | Save a user's custom prompt for a command    |
| `openspec:resetPrompt` | Reset a command to its bundled default       |
| `openspec:refresh`     | Fetch latest prompts from GitHub             |

### Renderer Component

`src/renderer/components/OpenSpecCommandsPanel.tsx` provides the UI for browsing, running, and customizing OpenSpec commands.

## Prompt Loading Flow

### At Build Time

1. `scripts/generate-prompts.mjs` reads all `.md` files from `src/prompts/`
2. Each file is converted to a TypeScript string constant export
3. The generated file is written to `src/generated/prompts.ts`
4. `src/prompts/index.ts` re-exports all constants

### At Runtime (Standard Prompts)

1. Main process imports prompt constants from `src/prompts/index.ts`
2. Prompt text is used directly (e.g., `groupChatModeratorSystemPrompt`)
3. Template variables (`{{...}}`) are replaced at call sites using `String.replace()`
4. The fully resolved prompt is passed to the agent spawn configuration

### At Runtime (SpecKit/OpenSpec)

1. On IPC call, the manager reads bundled prompts from the compiled module
2. User customizations are loaded from `{userData}/*-customizations.json`
3. Customized prompts override bundled defaults (per command ID)
4. The resolved prompt is returned to the renderer
5. The renderer sends the prompt to the active agent session

### At Runtime (Auto Run / System Prompt)

1. The renderer collects session context into a `TemplateContext` object
2. `substituteTemplateVariables(template, context)` performs case-insensitive substitution
3. Git branch is fetched asynchronously if the session is in a git repo
4. The conductor profile is loaded from settings
5. The fully resolved prompt is sent to the agent

## Key Source Files

| File                                                | Purpose                                             |
| --------------------------------------------------- | --------------------------------------------------- |
| `src/prompts/index.ts`                              | Prompt barrel file (re-exports generated constants) |
| `src/prompts/*.md`                                  | Raw prompt templates                                |
| `src/prompts/speckit/*.md`                          | Bundled SpecKit prompts                             |
| `src/prompts/openspec/*.md`                         | Bundled OpenSpec prompts                            |
| `scripts/generate-prompts.mjs`                      | Build-time prompt compiler                          |
| `src/generated/prompts.ts`                          | Generated TypeScript prompt constants               |
| `src/shared/templateVariables.ts`                   | Template variable definitions and types             |
| `src/renderer/utils/templateVariables.ts`           | Runtime template substitution                       |
| `src/main/speckit-manager.ts`                       | SpecKit prompt loading, updates, and customization  |
| `src/main/openspec-manager.ts`                      | OpenSpec prompt loading, updates, and customization |
| `src/main/ipc/handlers/speckit.ts`                  | SpecKit IPC handlers                                |
| `src/main/ipc/handlers/openspec.ts`                 | OpenSpec IPC handlers                               |
| `src/renderer/components/SpecKitCommandsPanel.tsx`  | SpecKit UI                                          |
| `src/renderer/components/OpenSpecCommandsPanel.tsx` | OpenSpec UI                                         |
