/**
 * Agent Capabilities System
 *
 * Defines what features each AI agent supports. This enables Maestro to:
 * - Show/hide UI features based on agent capabilities
 * - Use correct APIs and formats for each agent
 * - Handle agent differences in a consistent way
 *
 * When adding a new agent, define its capabilities here.
 *
 * The AgentCapabilities interface and DEFAULT_CAPABILITIES constant are
 * defined canonically in src/shared/types.ts and re-exported here so that
 * existing `from './capabilities'` imports keep working.
 */

import type { AgentCapabilities } from '../../types';
import { DEFAULT_CAPABILITIES } from '../../types';

export type { AgentCapabilities };
export { DEFAULT_CAPABILITIES };

/**
 * Investigation evidence, not public availability or a launch authorization.
 * The pinned source documents tool approval rules, not CLI root grants, and
 * rejects additionalDirectories on ACP resume. No binary/version is qualified.
 */
export const GROK_DIRECTORY_GRANT_SUPPORT = {
	cliReadRoots: 'unverified',
	cliWritableRoots: 'unverified',
	acpResumeRoots: 'unsupported',
	supportedVersionRange: null,
} as const;

/**
 * What each true Grok capability rests on. Investigation
 * evidence, not qualification: no Grok binary is qualified (`qualifiedVersions`
 * is empty, the pinned candidate 1.0.70 has no native case run), so a true flag
 * here means the production builder and consumers exist and the behavior was
 * observed on an earlier binary or pinned by deterministic suites, never that
 * the feature is certified. The version difference is not expressed by the
 * public boolean: the route selector refuses an unqualified or unbound version
 * (`selectGrokRoute`, `native.qualified`), managed hosts refuse every Grok
 * effect, and readiness stays false while Grok is in BETA_AGENTS. A capability
 * whose production path refuses, or that rests on nothing but a provisional
 * claim, is false in AGENT_CAPABILITIES.grok and listed under `withheld`.
 */
export const GROK_CAPABILITY_EVIDENCE = Object.freeze({
	candidateVersion: '1.0.70',
	qualifiedVersions: Object.freeze([] as string[]),
	retained: Object.freeze({
		supportsReadOnlyMode:
			'readOnlyArgs plan + deny Bash(*) observed on 1.0.5; containment unqualified (A11-F05). readOnlyCliEnforced stays true because false would keep --always-approve in CLI read-only runs (resolveCliBatchModeArgs); managed read-only refuses Grok. No --sandbox profile is appended (flagDecisions --sandbox)',
		supportsCostTracking: 'end.total_cost_usd observed on 1.0.41; unknown cost stays unknown',
		supportsUsageStats: 'per-call usage and end totals observed on 1.0.41',
		supportsContextExport:
			'GrokSessionStorage reads chat_history.jsonl; scoped extraction pinned by phase04 fixtures',
		supportsWizard:
			'streaming-json text deltas carry the structured reply; phase05 deterministic suites, native wizard cases not-run',
		supportsStandardPermissionMode:
			'A standard plan runs on GrokAcpSpawner (runsOnGrokAcpRoute); each ACP permission request is asked of the person through the permission relay consent session (grokConsentAuthority) and only allow_once is selected; ACP request port suites pin it deterministically, live round trip not-run. Local target only: SSH is refused before spawn (acp-remote-route), managed hosts refuse the grok-acp route',
	}),
	withheld: Object.freeze({
		supportsImageInput:
			'no host producer of EmbeddedImageSupport: the desktop prompt-file plan refuses every Grok image turn (grok-image-host-bounds-producer-absent)',
		supportsImageInputOnResume:
			'same refusal as supportsImageInput; resume image delivery never observed',
		supportsContextMerge:
			'PROVISIONAL since the merge formatter landed: deterministic only, grooming relies on unqualified read-only enforcement, every phase 11 native case not-run',
	}),
	/**
	 * What a Maestro-owned launch inherits from other vendors' configuration
	 * as `grok inspect --json` 1.0.70 reports it with an empty
	 * isolated GROK_HOME. Probe and decision: src/main/agents/grok-inspect-probe.ts.
	 */
	inheritedConfiguration: Object.freeze({
		compatCells:
			'Switched off for every Maestro-owned launch (GROK_COMPAT_ISOLATION_ENV_VARS, defaultEnvVars plus readOnlyEnvOverrides). Before: all 13 externalCompat cells enabled, source default, 12 Claude skills enabled. After the ten GROK_{CLAUDE,CURSOR}_{AGENTS,HOOKS,MCPS,RULES,SKILLS}_ENABLED=false vars: those ten cells enabled false, source env, every Claude skill and hook compatibilityStatus disabled; the three sessions cells stay on (documented staged and inert). Offline basis: docs/user-guide/05-configuration.md and 26-config-reference.md (env > config.toml > default).',
		permissionFiles:
			'NOT isolable on 1.0.70. permissions.sources still lists ~/.claude/settings.local.json (settings) with 3 rules loaded after every compat cell is off; no compat cell covers it, the binary carries no env var for it (GROK_CLAUDE_* names are the five surfaces only), CLAUDE_CONFIG_DIR does not move it, and a native [permission] table in GROK_HOME/config.toml is merged beside it rather than replacing it. docs/user-guide/22-permissions-and-safety.md section 3 documents the read as unconditional. grokReadOnlyIsolationProblem() names each such file and refuses the read-only composition on an observed report; the probe itself is refused by runProviderProbe (no proven Grok probe lifetime), so no launch consults it yet.',
		projectTrust:
			'grok inspect --json reports projectTrusted false for an untrusted folder (the Maestro checkout included); --add-dir is refused there. Maestro grants no trust (no --trust) and records the observed value only.',
	}),
	/**
	 * Project memory: what a listed session now shows of Grok's
	 * native memory versus what still keeps supportsProjectMemory false.
	 */
	projectMemory: Object.freeze({
		observed:
			"GrokSessionStorage (src/main/storage/grok-session-storage.ts, parseGrokPromptContext) reads each session's prompt_context.json as a fourth bounded source beside summary.json, chat_history.jsonl and usage.json, and exposes nativeMetadata.nativeMemory: memory_v2_enabled, memory_global_path and memory_workspace_path (kept only under the account root), agents_md_files (kept only under the account or project root; relative entries resolve against the project), prompt_mode and is_non_interactive. File contents are never read; a dropped path is counted, a malformed file marks the source partial (invalid-prompt-context) and the session still lists. Real 1.0.70 sessions record memory_v2_enabled true with memory paths under GROK_HOME/memory-v2 and an empty agents_md_files list, so the entry shape for a loaded AGENTS.md is accepted as a bare path or an object with path, unobserved.",
		unverified:
			'supportsProjectMemory stays false: the facts are a per-session record of what the prompt was built from, not a binding. Unverified: that the workspace memory directory Grok picks (memory-v2/workspaces/<slug>) is stable for a Maestro agent cwd and account, that a Maestro-owned launch under an isolated GROK_HOME reads and writes the same scope a person sees, and any live case writing a memory in one turn and reading it back in a resumed one. Rules (AGENTS.md) and translated knowledge do not certify it.',
	}),
	/**
	 * Decisions on native 1.0.70 flags Maestro could emit but does not, each
	 * with its offline basis. The decided-flags ledger (grok-flag-ledger.ts) points at these.
	 */
	flagDecisions: Object.freeze({
		'--sandbox':
			'Unused. Offline basis: 1.0.70 writes docs/user-guide/18-sandbox.md into GROK_HOME; built-ins are off, workspace, devbox, read-only, strict, and read-only writes only GROK_HOME and temp dirs; an isolated `grok --sandbox read-only inspect --json` logged ProfileApplied enforced:true on macos/seatbelt. Not appended to readOnlyArgs because the profile is fixed per session: a resume naming another profile is refused ("cannot resume this session under sandbox profile"), every saved session records sandbox_profile "off", so a read-only turn on an existing tab would fail and a later full turn on a read-only session would stay write-confined. Also fails open (a built-in profile that cannot apply warns and runs unenforced) and child-network blocking is a no-op on macOS. Settling probe: a live resume of an "off" session with --sandbox read-only, and a per-session profile record in Maestro before any wiring',
		'--rules':
			'Unused; the system prompt stays embedded in the first turn and skipped on resume (supportsAppendSystemPrompt false). Offline basis: `grok --help` 1.0.70 says "Extra rules to append to the system prompt"; docs/user-guide/12-project-rules.md says --rules (alias --append-system-prompt, absent from --help) wraps the text in a <human_rules> block appended after the default prompt, never replacing it; a saved session prompt_context.json records no rules, so a resumed process would need them again, which matches the planner\'s every-turn flag delivery. Semantics match, the planner does not: applySystemPromptDelivery (turns/args.ts) and the CLI spawner emit the literal --append-system-prompt and, on a local Windows host, --append-system-prompt-file, which grok has no form of; the ACP route (`grok agent stdio`, every Standard turn) takes no --rules at all, while the capability is read per provider, not per route; and Maestro\'s multi-kilobyte prompt on argv is the overflow DESIGN.md forbids without a qualified file path. Wiring needs a per-provider append flag in the planner, a route-aware delivery that keeps the embed for ACP, and a live resume case proving --rules applies per process',
		'--json-schema':
			'Unused; a utility-turn candidate only. Offline basis: `grok help` 1.0.70 says it constrains output to the schema and implies --output-format json; docs/user-guide/14-headless-mode.md says the result carries structured_output, a failure ends with error_max_structured_output_retries, and a kept plan sends no build follow-up. Chat turns parse --output-format streaming-json events (jsonOutputArgs), so the flag cannot ride a chat turn. Candidate call sites: generateTabName (src/main/ipc/handlers/tabNaming.ts, buildAgentArgs) and the Quick Chat route question (askRoutingModel in src/renderer/services/quickChatRouter.ts through groomContext in src/main/utils/context-groomer.ts). Wiring needs those turns to drop jsonOutputArgs and read structured_output from the single json result, plus a live case for an explicit streaming-json beside it',
		'--system-prompt-override':
			"Unused, deliberately. Offline basis: `grok --help` 1.0.70 says it overrides the agent's system prompt (compat alias --system-prompt); docs/user-guide/12-project-rules.md says the text replaces the default prompt verbatim. Maestro's prompt is added context, never a replacement for the provider's tool, safety and environment instructions, and it is no permission control",
	}),
});

/**
 * Capability definitions for each supported agent.
 *
 * NOTE: These are the current known capabilities. As agents evolve,
 * these may need to be updated. When in doubt, set capabilities to false
 * and mark them as "Unverified" or "PLACEHOLDER" until tested.
 *
 * Agents marked as PLACEHOLDER have not been integrated yet - their
 * capabilities are conservative defaults that should be updated when
 * the agent CLI becomes available and can be tested.
 */
export const AGENT_CAPABILITIES: Record<string, AgentCapabilities> = {
	/**
	 * Claude Code - Full-featured AI coding assistant from Anthropic
	 * https://github.com/anthropics/claude-code
	 */
	'claude-code': {
		supportsResume: true, // --resume flag
		supportsReadOnlyMode: true, // --permission-mode plan
		supportsStandardPermissionMode: true, // standard mode via the permission relay (--permission-prompt-tool)
		supportsJsonOutput: true, // --output-format stream-json
		supportsSessionId: true, // session_id in JSON output
		supportsImageInput: true, // Supports image attachments
		supportsImageInputOnResume: true, // Can send images via --input-format stream-json on resumed sessions
		supportsSlashCommands: true, // /help, /compact, etc.
		supportsSessionStorage: true, // ~/.claude/projects/
		supportsCostTracking: true, // Cost info in usage stats
		supportsUsageStats: true, // Token counts in output
		supportsBatchMode: true, // --print flag
		requiresPromptToStart: false, // Claude Code can run in --print mode waiting for input
		supportsStreaming: true, // Stream JSON events
		supportsResultMessages: true, // "result" event type
		supportsModelSelection: true, // --model flag (aliases: sonnet, opus, haiku, or full model names)
		supportsStreamJsonInput: true, // --input-format stream-json for images via stdin
		supportsPromptViaStdin: true, // `claude -p` reads the prompt from stdin
		supportsThinkingDisplay: true, // Emits streaming assistant messages
		supportsContextMerge: true, // Can receive merged context via prompts
		supportsContextExport: true, // Session storage supports context export
		supportsWizard: true, // Supports inline wizard structured output
		supportsGroupChatModeration: true, // Can serve as group chat moderator
		usesJsonLineOutput: false, // Uses stream-json, not JSONL
		usesCombinedContextWindow: false, // Claude has separate input/output limits
		supportsAppendSystemPrompt: true, // --append-system-prompt flag
		supportsProjectMemory: true, // $CLAUDE_CONFIG_DIR/projects/<path>/memory/
		supportsAdditionalDirectories: true, // --add-dir <directories...> (verified against the installed CLI)
	},

	/**
	 * Terminal - Internal agent for shell sessions
	 * Not a real AI agent, used for terminal process management
	 */
	terminal: {
		supportsResume: false,
		supportsReadOnlyMode: false,
		supportsJsonOutput: false,
		supportsSessionId: false,
		supportsImageInput: false,
		supportsImageInputOnResume: false,
		supportsSlashCommands: false,
		supportsSessionStorage: false,
		supportsCostTracking: false,
		supportsUsageStats: false,
		supportsBatchMode: false,
		requiresPromptToStart: false,
		supportsStreaming: true, // PTY streams output
		supportsResultMessages: false,
		supportsModelSelection: false,
		supportsStreamJsonInput: false,
		supportsPromptViaStdin: false, // Terminal sessions have no prompt to deliver
		supportsThinkingDisplay: false, // Terminal is not an AI agent
		supportsContextMerge: false, // Terminal is not an AI agent
		supportsContextExport: false, // Terminal has no AI context
		supportsWizard: false,
		supportsGroupChatModeration: false,
		usesJsonLineOutput: false,
		usesCombinedContextWindow: false,
		supportsAppendSystemPrompt: false,
		supportsProjectMemory: false,
		supportsAdditionalDirectories: false,
	},

	/**
	 * Codex - OpenAI's Codex CLI
	 * https://github.com/openai/codex
	 *
	 * Verified capabilities based on CLI testing (v0.111.0+) and documentation review.
	 * See .maestro/playbooks/Codex-Support.md for investigation details.
	 */
	codex: {
		supportsResume: true, // exec resume <id> (v0.30.0+) - Verified
		supportsReadOnlyMode: true, // --sandbox read-only - Verified
		supportsStandardPermissionMode: true, // Native app-server approval requests (opt-in transport)
		supportsJsonOutput: true, // --json flag - Verified
		supportsSessionId: true, // thread_id in thread.started event - Verified
		supportsImageInput: true, // -i, --image flag - Documented
		supportsImageInputOnResume: true, // Images are written to disk and paths embedded in prompt text (codex exec resume doesn't support -i flag)
		// Skills from Codex skills/list (including plugins/system skills) and
		// legacy on-disk prompts. Maestro expands slash entries before sending;
		// built-in TUI commands need their own integration.
		supportsSlashCommands: true,
		supportsSessionStorage: true, // ~/.codex/sessions/YYYY/MM/DD/*.jsonl - Verified
		supportsCostTracking: false, // Token counts only - Codex doesn't provide cost, pricing varies by model
		supportsUsageStats: true, // usage in turn.completed events - Verified
		supportsBatchMode: true, // exec subcommand - Verified
		requiresPromptToStart: true, // Codex requires 'exec' subcommand with prompt, no interactive mode via PTY
		supportsStreaming: true, // Streams JSONL events - Verified
		supportsResultMessages: false, // All messages are agent_message type (no distinct result) - Verified
		supportsModelSelection: true, // -m, --model flag - Documented
		supportsStreamJsonInput: false, // Uses -i, --image flag instead
		supportsPromptViaStdin: true, // `codex exec` reads the prompt from stdin
		supportsThinkingDisplay: true, // Emits reasoning tokens (o3/o4-mini)
		supportsContextMerge: true, // Can receive merged context via prompts
		supportsContextExport: true, // Session storage supports context export
		supportsWizard: true, // Supports inline wizard structured output
		supportsGroupChatModeration: true, // Can serve as group chat moderator
		usesJsonLineOutput: true, // Uses JSONL output format
		usesCombinedContextWindow: true, // OpenAI models use combined context window
		supportsAppendSystemPrompt: false,
		supportsProjectMemory: true, // $CODEX_HOME/memories/ (account-wide, written by Codex memories)
		supportsAdditionalDirectories: true, // --add-dir <DIR>, repeatable. Codex scopes it to WRITABLE roots.
		imageResumeMode: 'prompt-embed', // codex exec resume doesn't support -i; embed file paths in prompt text
	},

	/**
	 * Gemini CLI - Google's Gemini model CLI
	 *
	 * PLACEHOLDER: Most capabilities set to false until Gemini CLI is stable
	 * and can be tested. Update this configuration when integrating the agent.
	 */
	'gemini-cli': {
		supportsResume: false,
		supportsReadOnlyMode: false,
		supportsJsonOutput: false,
		supportsSessionId: false,
		supportsImageInput: true, // Gemini supports multimodal
		supportsImageInputOnResume: false, // Not yet investigated
		supportsSlashCommands: false,
		supportsSessionStorage: false,
		supportsCostTracking: false,
		supportsUsageStats: false,
		supportsBatchMode: false,
		requiresPromptToStart: false, // Not yet investigated
		supportsStreaming: true, // Likely streams
		supportsResultMessages: false,
		supportsModelSelection: false, // Not yet investigated
		supportsStreamJsonInput: false,
		supportsPromptViaStdin: true, // Gemini CLI reads the prompt from stdin
		supportsThinkingDisplay: false, // Not yet investigated
		supportsContextMerge: false, // Not yet investigated - PLACEHOLDER
		supportsContextExport: false, // Not yet investigated - PLACEHOLDER
		supportsWizard: false, // PLACEHOLDER
		supportsGroupChatModeration: false, // PLACEHOLDER
		usesJsonLineOutput: false, // PLACEHOLDER
		usesCombinedContextWindow: false, // PLACEHOLDER
		supportsAppendSystemPrompt: false,
		supportsProjectMemory: false,
		supportsAdditionalDirectories: false, // Unverified - no Gemini CLI available to probe
	},

	/**
	 * Antigravity CLI (`agy`) - Google's terminal coding agent, the CLI surface of
	 * Antigravity and the successor to the Gemini CLI effort above.
	 *
	 * Capabilities below are derived from the published headless-mode contract
	 * (https://antigravity.google/docs/cli/headless) rather than from a live run,
	 * so the agent ships as beta. Anything the docs do not state outright is left
	 * false rather than guessed at.
	 */
	antigravity: {
		supportsResume: true, // --conversation <id>
		supportsReadOnlyMode: false, // No flag makes it read-only; workspace writes stay auto-allowed
		supportsJsonOutput: true, // --output-format stream-json
		supportsSessionId: true, // conversation_id on init/step_update/result
		supportsImageInput: true, // Verified (agy 1.2.16): image path in the prompt, opened with view_file
		supportsImageInputOnResume: true, // Verified: same prompt path works with --conversation <id>
		supportsSlashCommands: false, // Slash commands are TUI-only, not exposed to headless runs
		supportsSessionStorage: true, // AntigravitySessionStorage reads conversation_summaries.db + conversations/<id>.db (local only)
		supportsCostTracking: false, // usage reports tokens only, no cost
		supportsUsageStats: true, // usage: input/output/thinking/cache_read/total tokens
		supportsBatchMode: true, // -p / --print / --prompt
		requiresPromptToStart: true, // Headless runs require -p; there is no idle non-interactive mode
		supportsStreaming: true, // stream-json emits step_update deltas
		supportsResultMessages: true, // Terminal `result` event
		supportsModelSelection: true, // --model <slug>
		supportsStreamJsonInput: false, // No stdin stream-json input format
		supportsThinkingDisplay: true, // Thinking text is read from the conversation store (antigravity-step-store.ts)
		supportsContextMerge: true, // Context can be delivered through the prompt
		supportsContextExport: false, // Requires session storage
		supportsWizard: false, // Structured-output wizard flow unverified against a live CLI
		supportsGroupChatModeration: false, // Unverified
		usesJsonLineOutput: true, // stream-json is newline-delimited JSON
		usesCombinedContextWindow: false, // Gemini reports input and output separately
		supportsAppendSystemPrompt: false,
		supportsProjectMemory: false,
		supportsPromptViaStdin: false, // Docs give the prompt as `-p "<text>"`; stdin delivery is unstated
		supportsAdditionalDirectories: false, // No documented flag for extra workspace roots
	},

	/**
	 * Qwen3 Coder - Alibaba's Qwen coding agent (Qwen Code CLI)
	 *
	 * Qwen Code is a Gemini CLI fork that exposes the same stream-json headless
	 * interface. Capabilities mirror the Gemini/Claude stream-json integration.
	 * Session storage is deferred until verified against a live
	 * Coding-plan account (beta scope).
	 */
	'qwen3-coder': {
		supportsResume: true, // --resume <sessionId> headless resume (resumeArgs wired)
		supportsReadOnlyMode: true, // CLI-enforced via --approval-mode plan (readOnlyArgs in definitions.ts)
		supportsStandardPermissionMode: true, // Native ACP approval requests (opt-in transport)
		supportsJsonOutput: true,
		supportsSessionId: true,
		supportsImageInput: false, // No image CLI args wired (imageArgs undefined); enable when wired
		supportsImageInputOnResume: false,
		supportsSlashCommands: false,
		supportsSessionStorage: false, // Deferred to keep beta scope
		supportsCostTracking: false, // Local/plan model - no cost
		supportsUsageStats: true,
		supportsBatchMode: true,
		requiresPromptToStart: false,
		supportsStreaming: true,
		supportsResultMessages: true,
		supportsModelSelection: true,
		supportsStreamJsonInput: false,
		supportsPromptViaStdin: true, // Gemini CLI fork - same stdin prompt handling
		supportsThinkingDisplay: true,
		supportsContextMerge: true,
		supportsContextExport: false,
		supportsWizard: false,
		supportsGroupChatModeration: false,
		usesJsonLineOutput: true,
		usesCombinedContextWindow: false,
		supportsAppendSystemPrompt: false,
		supportsProjectMemory: false,
		supportsAdditionalDirectories: false, // Unverified - no directory-grant flag confirmed for this CLI
	},

	/**
	 * Hermes - plain-text batch integration based on documented CLI behavior.
	 * Structured output and session features remain gated because Hermes does not
	 * expose a stable protocol Maestro can consume.
	 */
	hermes: {
		supportsResume: false,
		supportsStandardPermissionMode: true, // Native Runs API approvals (opt-in transport)
		supportsReadOnlyMode: false,
		supportsJsonOutput: false,
		supportsSessionId: false,
		supportsImageInput: true,
		supportsImageInputOnResume: false,
		supportsSlashCommands: false,
		supportsSessionStorage: false,
		supportsCostTracking: false,
		supportsUsageStats: false,
		supportsBatchMode: true,
		requiresPromptToStart: true,
		supportsStreaming: true,
		supportsResultMessages: false,
		supportsModelSelection: true,
		supportsStreamJsonInput: false,
		supportsPromptViaStdin: true, // Requires --query-file -; bare stdin opens the interactive TUI (#1657)
		supportsThinkingDisplay: false,
		supportsContextMerge: true,
		supportsContextExport: false,
		supportsWizard: false,
		supportsGroupChatModeration: false,
		usesJsonLineOutput: false,
		usesCombinedContextWindow: false,
		supportsAppendSystemPrompt: false,
		supportsProjectMemory: false,
		supportsAdditionalDirectories: false, // Unverified - no directory-grant flag confirmed for this CLI
	},

	/**
	 * Pi - JSONL batch integration based on the documented `--mode json` protocol.
	 * Pi emits session IDs, message deltas, tool events, and usage statistics.
	 * Pi accepts session IDs through `--session` and enforces read-only mode with a tool allowlist.
	 */
	pi: {
		supportsResume: true,
		supportsReadOnlyMode: true,
		supportsJsonOutput: true,
		supportsSessionId: true,
		supportsImageInput: true,
		supportsImageInputOnResume: true,
		supportsSlashCommands: false,
		supportsSessionStorage: false,
		supportsCostTracking: true,
		supportsUsageStats: true,
		supportsBatchMode: true,
		requiresPromptToStart: true,
		supportsStreaming: true,
		supportsResultMessages: true,
		supportsModelSelection: true,
		supportsStreamJsonInput: false,
		supportsPromptViaStdin: true, // Unverified - keeps the pre-existing Windows behavior
		supportsThinkingDisplay: true,
		supportsContextMerge: true,
		supportsContextExport: false,
		supportsWizard: false,
		supportsGroupChatModeration: false,
		usesJsonLineOutput: true,
		usesCombinedContextWindow: false,
		supportsAppendSystemPrompt: false,
		supportsProjectMemory: false,
		supportsAdditionalDirectories: false, // Unverified - no directory-grant flag confirmed for this CLI
	},

	/**
	 * Oh My Pi - JSON event-stream batch integration via `omp -p --mode json`.
	 * Oh My Pi emits a session id, streaming message deltas, tool lifecycle
	 * events, and per-message usage/cost. It resumes sessions through `--resume`
	 * and selects models with a fuzzy `--model` matcher.
	 */
	omp: {
		supportsResume: true,
		supportsReadOnlyMode: true, // --tools read,grep,glob restricts to read-only tools - Verified
		supportsJsonOutput: true,
		supportsSessionId: true,
		supportsImageInput: true,
		supportsImageInputOnResume: true,
		supportsSlashCommands: false,
		supportsSessionStorage: true, // ~/.omp/agent/sessions/<cwd-slug>/*.jsonl (local; SSH is a follow-up)
		supportsCostTracking: true,
		supportsUsageStats: true,
		supportsBatchMode: true,
		requiresPromptToStart: true,
		supportsStreaming: true,
		supportsResultMessages: true,
		supportsModelSelection: true,
		supportsStreamJsonInput: false,
		supportsPromptViaStdin: false, // VERIFIED: omp takes the prompt as a positional arg only; piping it to stdin makes the run exit 0 with no output
		supportsThinkingDisplay: true,
		supportsContextMerge: true,
		supportsContextExport: false,
		supportsWizard: false,
		supportsGroupChatModeration: false,
		usesJsonLineOutput: true,
		usesCombinedContextWindow: false,
		// omp exposes only the inline `--append-system-prompt` flag, not the
		// `--append-system-prompt-file` variant that Maestro's Windows-local
		// delivery path emits when this is true. Enabling it would break omp on
		// Windows (unknown flag), and the flag name is not overridable per agent.
		supportsAppendSystemPrompt: false,
		supportsProjectMemory: false,
		supportsAdditionalDirectories: false, // PLACEHOLDER - unverified
	},

	/**
	 * OpenCode - Open source coding assistant
	 * https://github.com/opencode-ai/opencode
	 *
	 * Verified capabilities based on CLI testing and documentation review.
	 * See .maestro/playbooks/OpenCode-Support.md for investigation details.
	 */
	opencode: {
		supportsResume: true, // --session flag (sessionID in output) - Verified
		supportsReadOnlyMode: true, // --agent plan (plan mode) - Verified
		supportsJsonOutput: true, // --format json - Verified
		supportsSessionId: true, // sessionID in JSON output (camelCase) - Verified
		supportsImageInput: true, // -f, --file flag documented - Documented
		supportsImageInputOnResume: true, // -f flag works with --session flag - Documented
		supportsSlashCommands: true, // Built-in + custom commands via .opencode/commands/ and opencode.json
		supportsSessionStorage: true, // ~/.local/share/opencode/storage/ (JSON files) - Verified
		supportsCostTracking: true, // part.cost in step_finish events - Verified
		supportsUsageStats: true, // part.tokens in step_finish events - Verified
		supportsBatchMode: true, // run subcommand (auto-approves all permissions) - Verified
		requiresPromptToStart: true, // OpenCode requires 'run' subcommand with prompt, no interactive mode via PTY
		supportsStreaming: true, // Streams JSONL events - Verified
		supportsResultMessages: true, // step_finish with part.reason:"stop" - Verified
		supportsModelSelection: true, // --model provider/model (e.g., 'ollama/qwen3:8b') - Verified
		supportsStreamJsonInput: false, // Uses positional arguments for prompt
		supportsPromptViaStdin: true, // `opencode run` reads the prompt from stdin
		supportsThinkingDisplay: true, // Emits streaming text chunks
		supportsContextMerge: true, // Can receive merged context via prompts
		supportsContextExport: true, // Session storage supports context export
		supportsWizard: true, // Supports inline wizard structured output
		supportsGroupChatModeration: true, // Can serve as group chat moderator
		usesJsonLineOutput: true, // Uses JSONL output format
		usesCombinedContextWindow: false, // Depends on model provider
		supportsAppendSystemPrompt: false,
		supportsProjectMemory: false,
		supportsAdditionalDirectories: false, // No directory-grant flag (--dir only relocates the cwd)
	},

	/**
	 * Factory Droid - Enterprise AI coding assistant from Factory
	 * https://docs.factory.ai/cli
	 *
	 * Verified capabilities based on CLI testing (droid exec --help) and session file analysis.
	 */
	'factory-droid': {
		supportsResume: true, // -s, --session-id <id> (requires a prompt) - Verified
		supportsReadOnlyMode: true, // Default mode (no --auto flags) - Verified
		supportsStandardPermissionMode: true, // Native ACP approval requests (opt-in transport)
		supportsJsonOutput: true, // -o stream-json - Verified
		supportsSessionId: true, // UUID in session filenames - Verified
		supportsImageInput: true, // -f, --file flag - Verified
		supportsImageInputOnResume: true, // -f works with -s flag - Verified
		supportsSlashCommands: false, // Factory uses different command system
		supportsSessionStorage: true, // ~/.factory/sessions/ (JSONL files) - Verified
		supportsCostTracking: false, // Token counts only in settings.json, no USD cost
		supportsUsageStats: true, // tokenUsage in settings.json - Verified
		supportsBatchMode: true, // droid exec subcommand - Verified
		requiresPromptToStart: true, // Requires prompt argument for exec
		supportsStreaming: true, // stream-json format - Verified
		supportsResultMessages: true, // Can detect end of conversation
		supportsModelSelection: true, // -m, --model flag - Verified
		supportsStreamJsonInput: true, // --input-format stream-json - Verified
		supportsPromptViaStdin: true, // Unverified - keeps the pre-existing Windows behavior
		supportsThinkingDisplay: true, // Emits thinking content in messages - Verified
		supportsContextMerge: true, // Can receive merged context via prompts
		supportsContextExport: true, // Session files are exportable
		supportsWizard: true, // Supports wizard structured output flow
		supportsGroupChatModeration: true, // Can serve as group chat moderator
		usesJsonLineOutput: true, // Uses JSONL output format
		usesCombinedContextWindow: false, // Depends on model provider
		supportsAppendSystemPrompt: false,
		supportsProjectMemory: false,
		supportsAdditionalDirectories: false, // Unverified - no Droid CLI available to probe
	},

	/**
	 * GitHub Copilot CLI - AI coding assistant from GitHub
	 * https://github.com/github/copilot-cli
	 *
	 * Capabilities based on verified CLI help output (copilot --help).
	 * Conservative approach: only mark capabilities as true if explicitly verified.
	 */
	'copilot-cli': {
		supportsResume: true, // --continue, --resume[=sessionId]
		supportsReadOnlyMode: true, // Maestro enforces read-only via Copilot's CLI tool permission rules
		supportsJsonOutput: true, // --output-format json (JSONL)
		supportsSessionId: true, // result event includes sessionId
		supportsImageInput: true, // Copilot supports @file/@image mentions; Maestro maps uploads to temp-file mentions
		supportsImageInputOnResume: true, // Prompt-based @image mentions work for resumed sessions as well
		supportsSlashCommands: true, // Interactive mode supports slash commands
		supportsSessionStorage: true, // ~/.copilot/session-state/<session-id>/
		supportsCostTracking: false, // Not verified
		supportsUsageStats: true, // session.shutdown event includes modelMetrics with per-model token counts
		supportsBatchMode: true, // -p, --prompt <text> for batch mode
		requiresPromptToStart: false, // Default interactive mode works without prompt, -i flag allows initial prompt
		supportsStreaming: true, // Streams assistant/tool execution events as JSONL
		supportsResultMessages: true, // assistant.message with phase=final_answer
		supportsModelSelection: true, // --model <model>
		supportsStreamJsonInput: false, // Not verified
		supportsPromptViaStdin: true, // Unverified - keeps the pre-existing Windows behavior
		supportsThinkingDisplay: true, // assistant.reasoning events are rendered through Maestro's thinking-chunk pipeline
		supportsContextMerge: true, // Can receive merged context via prompts
		supportsContextExport: true, // Session storage supports context export
		supportsWizard: true, // Wizard structured output works with Copilot JSON final_answer events
		supportsGroupChatModeration: true, // Group chat moderation uses the standard batch-mode orchestration path
		supportsAppendSystemPrompt: false, // No --append-system-prompt equivalent
		supportsProjectMemory: false, // No project memory mechanism
		supportsAdditionalDirectories: true, // --add-dir <directory>, repeatable (verified against the installed CLI)
		usesJsonLineOutput: true, // --output-format json produces JSONL
		usesCombinedContextWindow: true, // Copilot's own usage layer reports cumulative input (includes cache) regardless of underlying model, so the gauge math must follow the combined formula
	},

	/**
	 * Grok CLI - xAI's Grok coding agent CLI
	 *
	 * Capabilities verified against captured output from grok v0.2.93
	 * (streaming-json fixtures). Notable: the streaming-json stdout stream
	 * carries NO token usage/cost; the session ID arrives only on the final
	 * "end" event.
	 *
	 * 0.2.93 also emitted no tool events, but grok 1.x does
	 * (`tool_call` / `tool_call_update`) and the parser reads them - see the
	 * TOOL EVENTS note in grok-output-parser.ts.
	 */
	grok: {
		supportsResume: true, // Verified: -r/--resume <sessionId>; resume turn preserved the same sessionId in the end event
		supportsReadOnlyMode: true, // Verified: --permission-mode plan (grok --help v0.2.93)
		supportsJsonOutput: true, // Verified: --output-format streaming-json emits one JSON object per line
		supportsSessionId: true, // Verified: camelCase sessionId (UUIDv7) on the final end event (no init event exists)
		supportsImageInput: false, // Withheld (GROK_CAPABILITY_EVIDENCE): no host image-bounds producer, so the prompt-file plan refuses image turns
		supportsImageInputOnResume: false, // Withheld with supportsImageInput
		supportsSlashCommands: false, // Conservative default: not investigated in headless mode
		supportsSessionStorage: true, // Verified: GrokSessionStorage reads ~/.grok/sessions/<percent-encoded-cwd>/<session-uuid>/
		supportsCostTracking: true, // Verified (grok 1.0.41): end.total_cost_usd per turn; usage.json costUsdTicks per session
		supportsUsageStats: true, // Verified (grok 1.0.41): a usage line per model call, turn totals on end
		supportsBatchMode: true, // Verified: -p/--single <PROMPT> headless mode
		requiresPromptToStart: true, // Headless turns require a prompt source; no interactive PTY integration
		supportsStreaming: true, // Verified: token-sized thought/text deltas stream on stdout
		supportsResultMessages: true, // Verified: distinct final end event with stopReason/sessionId/requestId
		supportsModelSelection: true, // Verified: -m/--model flag; grok models lists grok-4.5 and grok-composer-2.5-fast
		supportsStreamJsonInput: false, // Conservative default: no --input-format stream-json equivalent in grok --help
		supportsPromptViaStdin: false, // Pinned native source has no raw-stdin prompt reader; use the owned JSON prompt file
		supportsThinkingDisplay: true, // Verified: thought delta events precede text deltas
		supportsContextMerge: false, // Withheld: the merge formatter is pinned deterministically only; live native evidence is not-run
		supportsContextExport: true, // Verified: session storage reads full transcripts (chat_history.jsonl), same export path as siblings
		supportsWizard: true, // Streaming-json text deltas carry structured JSON wizard replies; discovery uses --always-approve + --max-turns 8 + --no-subagents (not plan - plan blocks read/fetch needed for discovery)
		supportsGroupChatModeration: false, // Conservative default: moderation flow not yet exercised
		supportsStandardPermissionMode: true, // Retained (GROK_CAPABILITY_EVIDENCE): ACP stdio route with in-app approvals, local target only
		usesJsonLineOutput: true, // Verified: streaming-json is JSONL (one JSON object per line); also gates CLI batch spawning (spawnJsonLineAgent)
		usesCombinedContextWindow: false, // Conservative default: on-disk signals.json reports a single contextTokensUsed but gauge math is unverified
		supportsAppendSystemPrompt: false, // --rules decided unused (GROK_CAPABILITY_EVIDENCE.flagDecisions): no file form, no ACP form; embed once and skip on resume
		supportsProjectMemory: false, // Native legacy/v2 memory exists and prompt_context.json facts are observed per session (GROK_CAPABILITY_EVIDENCE.projectMemory); selected account/workspace binding is unverified. Rules and translated knowledge do not certify it.
		supportsAdditionalDirectories: false, // See GROK_DIRECTORY_GRANT_SUPPORT; no qualified native root-grant builder
	},
};

/**
 * Get capabilities for a specific agent.
 *
 * @param agentId - The agent identifier (e.g., 'claude-code', 'opencode')
 * @returns AgentCapabilities for the agent, or DEFAULT_CAPABILITIES if unknown
 */
export function getAgentCapabilities(agentId: string): AgentCapabilities {
	return AGENT_CAPABILITIES[agentId] || { ...DEFAULT_CAPABILITIES };
}

/**
 * Whether a provider can read attached images.
 *
 * The one rule the renderer's attach gate and main's send gate share. Only a
 * KNOWN `supportsImageInput: false` refuses: a missing capability object (an
 * unknown provider, a capability lookup that has not settled, or a room with no
 * moderator) allows, which is the behaviour both surfaces had before the gate.
 */
export function agentCanReadImages(
	capabilities: Pick<AgentCapabilities, 'supportsImageInput'> | null | undefined
): boolean {
	return capabilities?.supportsImageInput !== false;
}

/**
 * Whether the provider with this id can read attached images. An unknown or
 * missing id allows: only a provider Maestro knows to be text-only refuses.
 */
export function agentIdCanReadImages(agentId: string | null | undefined): boolean {
	if (!agentId) return true;
	return agentCanReadImages(AGENT_CAPABILITIES[agentId]);
}

/**
 * Check if an agent has a specific capability.
 *
 * @param agentId - The agent identifier
 * @param capability - The capability key to check
 * @returns true if the agent supports the capability
 */
export function hasCapability(agentId: string, capability: keyof AgentCapabilities): boolean {
	const capabilities = getAgentCapabilities(agentId);
	return !!capabilities[capability];
}
