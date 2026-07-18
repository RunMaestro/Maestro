<!-- Verified 2026-04-10 against origin/rc (06e5a2eb3) -->

# Prompts and Specification Systems

Maestro's prompt system consists of disk-backed Markdown templates, a template variable substitution engine, and two specification management systems (SpecKit and OpenSpec) that layer user-customizable prompts on top of bundled defaults.

## Prompt Templates

### Runtime Ownership

Prompt templates are stored as `.md` files in `src/prompts/`. At runtime, `src/main/prompt-manager.ts` loads the core prompt catalog from disk through `src/shared/promptDefinitions.ts`; packaged applications read from `Resources/prompts/core/`. Callers import the catalog directly from `src/shared/promptDefinitions.ts`.

```text
src/shared/promptDefinitions.ts
    |
    v  (catalog of IDs and filenames)
src/main/prompt-manager.ts
    |
    v  (loads disk-backed prompt files)
Resources/prompts/core/*.md
```

### Template Inventory

#### Wizard Prompts

| File                                  | Prompt ID                          | Purpose                                                     |
| ------------------------------------- | ---------------------------------- | ----------------------------------------------------------- |
| `wizard-system.md`                    | `wizard-system`                    | System prompt for the Wizard (Auto Run document generation) |
| `wizard-system-continuation.md`       | `wizard-system-continuation`       | Continuation prompt for multi-turn Wizard conversations     |
| `wizard-document-generation.md`       | `wizard-document-generation`       | Document generation instructions                            |
| `wizard-inline-system.md`             | `wizard-inline-system`             | System prompt for the Inline Wizard                         |
| `wizard-inline-iterate.md`            | `wizard-inline-iterate`            | Inline Wizard iteration prompt                              |
| `wizard-inline-new.md`                | `wizard-inline-new`                | Inline Wizard new document prompt                           |
| `wizard-inline-iterate-generation.md` | `wizard-inline-iterate-generation` | Inline Wizard iteration generation                          |

#### Auto Run Prompts

| File                  | Prompt ID          | Purpose                                                                                                                                                        |
| --------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `autorun-default.md`  | `autorun-default`  | Default system prompt for Auto Run execution. Provides agent context, git branch, loop iteration, and working folder. Requires synopsis-first response format. |
| `autorun-synopsis.md` | `autorun-synopsis` | Synopsis extraction prompt                                                                                                                                     |

#### Group Chat Prompts

| File                                | Prompt ID                        | Purpose                                                                                                                             |
| ----------------------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `group-chat-moderator-system.md`    | `group-chat-moderator-system`    | Moderator system prompt. Instructs the moderator to assist directly for simple tasks and delegate via `@mentions` for complex work. |
| `group-chat-moderator-synthesis.md` | `group-chat-moderator-synthesis` | Synthesis prompt for reviewing agent responses. Moderator decides whether to continue delegating or summarize.                      |
| `group-chat-participant.md`         | `group-chat-participant`         | Participant system prompt. Sets response format (overview first, then details).                                                     |
| `group-chat-participant-request.md` | `group-chat-participant-request` | Per-message request prompt with chat history and moderator's delegation.                                                            |

#### Context Management Prompts

| File                   | Prompt ID           | Purpose                                                                                 |
| ---------------------- | ------------------- | --------------------------------------------------------------------------------------- |
| `context-grooming.md`  | `context-grooming`  | Instructions for consolidating multiple conversation contexts into one coherent context |
| `context-transfer.md`  | `context-transfer`  | Instructions for transferring context between sessions                                  |
| `context-summarize.md` | `context-summarize` | Instructions for summarizing a conversation context                                     |

#### Input Processing

| File                    | Prompt ID            | Purpose                                                 |
| ----------------------- | -------------------- | ------------------------------------------------------- |
| `image-only-default.md` | `image-only-default` | Default prompt when only images are submitted (no text) |

#### Commands

| File                | Prompt ID        | Purpose                          |
| ------------------- | ---------------- | -------------------------------- |
| `commit-command.md` | `commit-command` | Prompt for the `/commit` command |

#### System Prompts

| File                       | Prompt ID               | Purpose                                                                                                                      |
| -------------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `maestro-system-prompt.md` | `maestro-system-prompt` | Base system prompt injected into all agent sessions. Provides agent name, tool type, conductor profile, and Maestro context. |
| `tab-naming.md`            | `tab-naming`            | Prompt for automatic tab naming based on conversation content                                                                |
| `director-notes.md`        | `director-notes`        | Prompt for Director's Notes (unified history + synopsis generation)                                                          |

## Template Variables

The runtime authority is `src/shared/templateVariables.ts` (`TEMPLATE_VARIABLES`, `autoRunOnly`, and `cueOnly`). The complete user-facing catalog is owned by [Prompt Customization → Template Variables](../prompt-customization.md#template-variables).

This internal architecture guide deliberately does not repeat the variable table: both prompt templates and slash commands resolve the same runtime registry. Cue-only variables are likewise source-owned because their availability depends on the event payload assembled at execution time.

### Substitution Flow

Template variables are resolved at runtime by `src/shared/templateVariables.ts` (used from both main and renderer):

1. Callers build a `TemplateContext` object with the current session, git info, group name, Auto Run state, conductor profile, history path, and - for Cue prompts - a `cue` sub-object with event metadata.
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

The public command catalog and workflow guidance are owned by [Spec-Kit Commands](../speckit-commands.md). The runtime authority for command IDs, descriptions, and `isCustom` is `src/prompts/speckit/metadata.json` together with the bundled prompt files; this guide keeps the manager architecture below without duplicating that factual catalog.

### Files

Bundled prompts in `src/prompts/speckit/`:

```text
speckit/
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
The public command catalog and workflow guidance are owned by [OpenSpec Commands](../openspec-commands.md). The runtime authority for command IDs, descriptions, and `isCustom` is `src/prompts/openspec/metadata.json` together with the bundled prompt files; this guide keeps the manager architecture below without duplicating that factual catalog.

### Files

Bundled prompts in `src/prompts/openspec/`:

```text
openspec/
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

### At Runtime (Standard Prompts)

1. `src/main/prompt-manager.ts` uses `CORE_PROMPTS` from `src/shared/promptDefinitions.ts` to resolve prompt IDs to disk filenames
2. The main process loads bundled prompt text from `src/prompts/*.md` in development or `Resources/prompts/core/*.md` when packaged
3. User customizations override bundled content from `core-prompts-customizations.json`
4. Template variables (`{{...}}`) are replaced at call sites using `String.replace()`
5. The fully resolved prompt is passed to the agent spawn configuration

The renderer collects session context into a `TemplateContext` object, `substituteTemplateVariables(template, context)` performs case-insensitive substitution, git branch is fetched asynchronously if the session is in a git repo, and the conductor profile is loaded from settings before the fully resolved prompt is sent to the agent.

## Key Source Files

| File                                                | Purpose                                                    |
| --------------------------------------------------- | ---------------------------------------------------------- |
| `src/shared/promptDefinitions.ts`                   | Core prompt IDs, filenames, descriptions, and categories   |
| `src/main/prompt-manager.ts`                        | Disk-backed core prompt loading and customization owner    |
| `src/prompts/*.md`                                  | Core prompt templates copied to packaged runtime resources |
| `src/prompts/speckit/*.md`                          | Bundled SpecKit prompts                                    |
| `src/prompts/openspec/*.md`                         | Bundled OpenSpec prompts                                   |
| `src/shared/templateVariables.ts`                   | Template variable definitions and types                    |
| `src/renderer/utils/templateVariables.ts`           | Runtime template substitution                              |
| `src/main/speckit-manager.ts`                       | SpecKit prompt loading, updates, and customization         |
| `src/main/openspec-manager.ts`                      | OpenSpec prompt loading, updates, and customization        |
| `src/main/ipc/handlers/speckit.ts`                  | SpecKit IPC handlers                                       |
| `src/main/ipc/handlers/openspec.ts`                 | OpenSpec IPC handlers                                      |
| `src/renderer/components/SpecKitCommandsPanel.tsx`  | SpecKit UI                                                 |
| `src/renderer/components/OpenSpecCommandsPanel.tsx` | OpenSpec UI                                                |
