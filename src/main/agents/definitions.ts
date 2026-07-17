/**
 * Agent Definitions
 *
 * Contains the configuration definitions for all supported AI agents.
 * This includes CLI arguments, configuration options, and default settings.
 */

import type {
	AdditionalDirectory,
	AgentCapabilities,
	AgentConfig as BaseAgentConfig,
} from '../../shared/types';
import { AGENT_IDS, type AgentId } from '../../shared/agentRegistry';
import { isWindows } from '../../shared/platformDetection';
import {
	dirsWithAnyAccess,
	dirsWithWriteAccess,
	repeatDirFlag,
} from '../../shared/additionalDirectories';
export type { AgentCapabilities } from '../../shared/types';

// ============ Configuration Types ============

/**
 * Base configuration option fields shared by all types
 */
interface BaseConfigOption {
	key: string; // Storage key
	label: string; // UI label
	description: string; // Help text
}

/**
 * Checkbox configuration option (boolean value)
 */
interface CheckboxConfigOption extends BaseConfigOption {
	type: 'checkbox';
	default: boolean;
	argBuilder?: (value: boolean) => string[];
}

/**
 * Text configuration option (string value)
 */
interface TextConfigOption extends BaseConfigOption {
	type: 'text';
	default: string;
	argBuilder?: (value: string) => string[];
}

/**
 * Number configuration option (numeric value)
 */
interface NumberConfigOption extends BaseConfigOption {
	type: 'number';
	default: number;
	argBuilder?: (value: number) => string[];
}

/**
 * Select configuration option (string value from predefined options)
 *
 * Options can be:
 * - Static: `options` array provided directly (e.g., Factory Droid reasoning effort)
 * - Dynamic: `dynamic: true` with optional `options` as fallback.
 *   Dynamic options are fetched at runtime via `agents:getConfigOptions` IPC.
 */
interface SelectConfigOption extends BaseConfigOption {
	type: 'select';
	default: string;
	options?: string[]; // Static options (or fallback for dynamic). Optional when dynamic is true.
	dynamic?: boolean; // If true, options are fetched at runtime via discoverConfigOptions()
	argBuilder?: (value: string) => string[];
}

/**
 * Configuration option types for agent-specific settings.
 * Uses discriminated union for full type safety.
 */
export type AgentConfigOption =
	| CheckboxConfigOption
	| TextConfigOption
	| NumberConfigOption
	| SelectConfigOption;

/**
 * Full agent configuration including runtime detection state.
 * Extends the serializable BaseAgentConfig (from shared/types) with
 * function-typed fields for CLI argument building (main process only).
 */
export interface AgentConfig extends BaseAgentConfig {
	// Narrow optionals to required for the main process full config
	binaryName: string;
	command: string;
	args: string[];
	capabilities: AgentCapabilities;
	// Override configOptions with the richer local type that includes argBuilder
	configOptions?: AgentConfigOption[];

	// Argument builders for dynamic CLI construction (function-typed, not serializable)
	// These are optional - agents that don't have them use hardcoded behavior
	batchModePrefix?: string[]; // Args added before base args for batch mode (e.g., ['run'] for OpenCode)
	batchModeArgs?: string[]; // Args only applied in batch mode (e.g., ['--skip-git-repo-check'] for Codex exec)
	jsonOutputArgs?: string[]; // Args for JSON output format (e.g., ['--format', 'json'])
	resumeArgs?: (sessionId: string) => string[]; // Function to build resume args
	readOnlyArgs?: string[]; // Args for read-only/plan mode (e.g., ['--agent', 'plan'])
	noToolsArgs?: string[]; // Args that disable ALL tool use, forcing a pure text response (e.g., ['--tools', ''] for Claude). Used by tab naming so a task-like first message produces a name instead of triggering a real agentic investigation.
	modelArgs?: (modelId: string) => string[]; // Function to build model selection args (e.g., ['--model', modelId])
	workingDirArgs?: (dir: string) => string[]; // Function to build working directory args (e.g., ['-C', dir])
	/**
	 * Build the CLI args that grant the agent access to directories outside its
	 * working directory (Maestro's "Additional Directories").
	 *
	 * The provider owns the whole mapping, not just one path, because the CLIs do
	 * NOT agree on what a grant means:
	 *   - Claude Code / Copilot-CLI: `--add-dir` allows tool ACCESS to the dir (read + write).
	 *   - Codex: `--add-dir` adds a WRITABLE root to the sandbox; reads are governed separately.
	 * Handing each provider the full `AdditionalDirectory[]` lets it decide which
	 * grants its flag can actually express and drop the rest.
	 *
	 * Set this iff `capabilities.supportsAdditionalDirectories` is true - the
	 * agent-completeness test enforces both directions. Agents that leave it
	 * undefined fall back to prompt-only enforcement via
	 * `{{ADDITIONAL_DIRECTORIES}}`, which every agent gets regardless.
	 */
	additionalDirArgs?: (dirs: AdditionalDirectory[]) => string[];
	imageArgs?: (imagePath: string) => string[]; // Function to build image attachment args (e.g., ['-i', imagePath] for Codex)
	imagePromptBuilder?: (imagePaths: string[]) => string; // Function to embed image references into the prompt (e.g., Copilot @mentions)
	promptArgs?: (prompt: string) => string[]; // Function to build prompt args (e.g., ['-p', prompt] for OpenCode)
	noPromptSeparator?: boolean; // If true, don't add '--' before the prompt in batch mode (OpenCode doesn't support it)
	defaultEnvVars?: Record<string, string>; // Default environment variables for this agent (merged with user customEnvVars)
	readOnlyEnvOverrides?: Record<string, string>; // Env var overrides applied in read-only mode (replaces keys from defaultEnvVars)
	batchModeEnvVars?: Record<string, string>; // Env vars applied ONLY to CLI batch spawns (maestro-cli send). Not applied to desktop UI or --live path. Use for settings that only make sense in short-lived non-interactive sessions (e.g., disabling background tasks).

	/**
	 * Binary used when this agent is spawned in API/headless mode (e.g. `claude --print`).
	 * When set together with `interactiveCommand`, the spawner picks between the two based on
	 * the per-tab Claude interactive mode resolution. When unset, `command` is the only binary
	 * (i.e. the agent has no interactive variant). Phase 2 only populates this for `claude-code`.
	 */
	apiCommand?: string;

	/**
	 * Args used in API/headless mode. Composed with custom args, model args, resume args, etc.
	 * by `buildAgentArgs()` exactly like `args`. Set alongside `apiCommand`.
	 */
	apiModeArgs?: string[];

	/**
	 * Binary used when this agent is spawned in interactive mode. For `claude-code`, this is
	 * `maestro-p` - a wrapper that drives Claude's TUI to preserve the user's Max plan quota.
	 * SSH-enabled tabs always skip this and use `apiCommand` instead, since interactive mode
	 * requires the real claude TUI binary to be present locally.
	 */
	interactiveCommand?: string;

	/**
	 * Args used in interactive mode. Composed with custom args, model args, resume args, etc.
	 * just like `args`/`apiModeArgs`. For `claude-code`, these are forwarded by `maestro-p`
	 * into the underlying claude TUI invocation.
	 */
	interactiveModeArgs?: string[];
}

/**
 * Agent definition without runtime detection state (used for static definitions)
 */
export type AgentDefinition = Omit<AgentConfig, 'available' | 'path' | 'capabilities' | 'id'> & {
	id: AgentId;
};

// ============ Agent Definitions ============

/**
 * Static definitions for all supported agents.
 * These are the base configurations before runtime detection adds availability info.
 */
export const AGENT_DEFINITIONS: AgentDefinition[] = [
	{
		id: 'terminal',
		name: 'Terminal',
		// Use platform-appropriate default shell
		binaryName: isWindows() ? 'powershell.exe' : 'bash',
		command: isWindows() ? 'powershell.exe' : 'bash',
		args: [],
		requiresPty: true,
		hidden: true, // Internal agent, not shown in UI
	},
	{
		id: 'claude-code',
		name: 'Claude Code',
		binaryName: 'claude',
		// `command` + `args` remain the API-mode default so non-mode-aware spawn sites continue
		// to work unchanged. The `apiCommand`/`interactiveCommand` pair is consulted by the
		// desktop spawner (see `src/main/ipc/handlers/process.ts`) to pick a binary per turn
		// based on per-tab Claude interactive mode state.
		command: 'claude',
		args: ['--print', '--verbose', '--output-format', 'stream-json'],
		apiCommand: 'claude',
		apiModeArgs: ['--print', '--verbose', '--output-format', 'stream-json'],
		interactiveCommand: 'maestro-p',
		// maestro-p forwards these to the underlying claude TUI invocation.
		interactiveModeArgs: [],
		// Full permission mode: bypass all Claude permission checks. In 'standard'
		// mode the permission relay mediates each tool call instead.
		fullAccessArgs: ['--dangerously-skip-permissions'],
		resumeArgs: (sessionId: string) => ['--resume', sessionId], // Resume with session ID; works for both api and interactive (forwarded by maestro-p)
		readOnlyArgs: ['--permission-mode', 'plan'], // Read-only/plan mode
		readOnlyCliEnforced: true, // CLI enforces read-only via --permission-mode plan
		// `--add-dir` allows tool access to a dir (read AND write), so it maps to
		// every grant the user made. It cannot express "write but never read" -
		// the {{ADDITIONAL_DIRECTORIES}} prompt block carries that rule.
		additionalDirArgs: (dirs) => repeatDirFlag('--add-dir', dirsWithAnyAccess(dirs)),
		noToolsArgs: ['--tools', ''], // `--tools ""` disables every built-in tool (used by tab naming)
		modelArgs: (modelId: string) => ['--model', modelId], // Model selection: claude --model sonnet
		// Disable Claude Code's background-task feature across every spawn path (desktop UI, CLI batch, --live, SSH).
		// Two motivations: (a) batch sessions exit before background tasks finish, losing results (#861); and (b) the
		// `Bash run_in_background` + `Monitor` poll wrapper deadlocks on a self-matching `pgrep -f` when the watched
		// regex appears in the wrapper's own argv - observed multiple times in long-running desktop tabs, where the
		// claude process sits forever waiting on a zsh `until` loop that can never satisfy its exit predicate.
		// Users who need background tasks can override via Shell Configuration or per-agent customEnvVars.
		defaultEnvVars: {
			CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
		},
		configOptions: [
			{
				key: 'model',
				type: 'text',
				label: 'Model',
				description:
					'Model override (e.g., "sonnet", "opus", "haiku", or full name like "claude-sonnet-4-6"). Leave empty to use the default.',
				default: '',
				argBuilder: (value: string) => {
					if (value && value.trim()) {
						return ['--model', value.trim()];
					}
					return [];
				},
			},
			{
				key: 'effort',
				type: 'select',
				label: 'Effort',
				description: 'How much effort the model should put into its response.',
				dynamic: true,
				// Static safety net used when runtime discovery scrapes nothing from the
				// Claude CLI (e.g. Anthropic rewords --help / the validation warning again).
				// Without this the effort pill and dropdown vanish entirely. Discovery still
				// wins when it succeeds, so newly-added levels surface automatically.
				options: ['', 'low', 'medium', 'high', 'xhigh', 'max'],
				default: '',
				argBuilder: (value: string) => (value && value.trim() ? ['--effort', value.trim()] : []),
			},
		],
	},
	{
		id: 'codex',
		name: 'Codex',
		binaryName: 'codex',
		command: 'codex',
		// Base args for interactive mode (no flags that are exec-only)
		args: [],
		// Codex CLI argument builders
		// Batch mode: codex [-C dir] exec --json --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check [--sandbox read-only] [resume <id>] -- "prompt"
		// `-C` is a root-level global flag and MUST appear before the `exec` subcommand
		// or Codex silently ignores it (see #959). buildAgentArgs prepends workingDirArgs accordingly.
		// Sandbox modes:
		//   - Default (YOLO): --dangerously-bypass-approvals-and-sandbox (full system access, required by Maestro)
		//   - Read-only: --sandbox read-only (can only read files, overrides YOLO permissions)
		// NOTE: --dangerously-bypass-approvals-and-sandbox is needed for ALL non-interactive exec
		// invocations (including read-only) to bypass the interactive approval UI. The --sandbox
		// flag independently controls what permissions the agent has.
		batchModePrefix: ['exec'], // Codex uses 'exec' subcommand for batch mode
		batchModeArgs: ['--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check'], // Args only valid on 'exec' subcommand
		jsonOutputArgs: ['--json'], // JSON output format (must come before resume subcommand)
		resumeArgs: (sessionId: string) => ['resume', sessionId], // Resume with session/thread ID
		readOnlyArgs: [
			'--sandbox',
			'read-only',
			'--dangerously-bypass-approvals-and-sandbox',
			'--skip-git-repo-check',
		], // Read-only/plan mode - includes bypass flags for non-interactive execution (sandbox read-only overrides YOLO permissions)
		readOnlyCliEnforced: true, // CLI enforces read-only via --sandbox read-only
		// Codex's `--add-dir` is narrower than Claude's: it adds a WRITABLE root to
		// the sandbox ("Additional directories that should be writable alongside the
		// primary workspace"). So only write grants map to it. Read-only grants are
		// left to the sandbox's read policy plus the prompt block.
		additionalDirArgs: (dirs) => repeatDirFlag('--add-dir', dirsWithWriteAccess(dirs)),
		yoloModeArgs: ['--dangerously-bypass-approvals-and-sandbox'], // Full access mode
		workingDirArgs: (dir: string) => ['-C', dir], // Set working directory
		imageArgs: (imagePath: string) => ['-i', imagePath], // Image attachment: codex exec -i /path/to/image.png
		modelArgs: (modelId: string) => ['-m', modelId], // Model selection: codex exec -m gpt-5.3-codex
		// Agent-specific configuration options shown in UI
		configOptions: [
			{
				key: 'model',
				type: 'text',
				label: 'Model',
				description:
					'Model override (e.g., gpt-5.3-codex, o3). Leave empty to use the default from ~/.codex/config.toml.',
				default: '', // Empty = use Codex's default model from config.toml
				argBuilder: (value: string) => {
					if (value && value.trim()) {
						return ['-m', value.trim()];
					}
					return [];
				},
			},
			{
				key: 'reasoningEffort',
				type: 'select',
				label: 'Reasoning Effort',
				description: 'How much the model should reason before responding.',
				dynamic: true,
				// Static fallback used when ~/.codex/models_cache.json hasn't been
				// written yet (e.g. fresh install) so the dropdown still renders.
				options: ['', 'minimal', 'low', 'medium', 'high', 'xhigh'],
				default: '',
				argBuilder: (value: string) =>
					value && value.trim() ? ['-c', `reasoning.effort="${value.trim()}"`] : [],
			},
		],
	},
	{
		id: 'gemini-cli',
		name: 'Gemini CLI',
		hidden: true, // Not shipping; superseded by Antigravity. Kept for type/back-compat, hidden from UI.
		binaryName: 'gemini',
		command: 'gemini',
		args: [],
		batchModePrefix: [],
		batchModeArgs: ['-y'],
		jsonOutputArgs: ['--output-format', 'stream-json'],
		resumeArgs: (sessionId: string) => ['--resume', sessionId],
		// Note: --approval-mode plan requires experimental.plan to be enabled in Gemini CLI config.
		// Until that feature is generally available, read-only behavior is enforced via system
		// prompt instructions instead. The -y flag is still needed for non-interactive execution
		// (tab naming, context grooming) to prevent approval prompts from hanging batch mode.
		readOnlyArgs: ['-y'],
		readOnlyCliEnforced: false, // No CLI-level read-only enforcement; prompt-only
		yoloModeArgs: ['-y'],
		workingDirArgs: (dir: string) => ['--include-directories', dir],
		imageArgs: undefined,
		modelArgs: (modelId: string) => ['-m', modelId],
		promptArgs: (prompt: string) => ['-p', prompt],
		configOptions: [
			{
				key: 'model',
				type: 'select' as const,
				label: 'Model',
				description:
					'Model to use. Auto lets Gemini route between Pro and Flash based on task complexity.',
				options: [
					'',
					'auto',
					'pro',
					'flash',
					'flash-lite',
					'gemini-2.5-pro',
					'gemini-2.5-flash',
					'gemini-3-pro-preview',
					'gemini-3-flash-preview',
				],
				default: '',
				argBuilder: (value: string) => (value && value.trim() ? ['-m', value.trim()] : []),
			},
			{
				key: 'contextWindow',
				type: 'number' as const,
				label: 'Context Window Size',
				description:
					'Maximum context window size in tokens. Common values: 1048576 (Gemini 2.5 Pro), 32767 (Gemini 2.5 Flash).',
				default: 1048576,
			},
		],
	},
	{
		id: 'qwen3-coder',
		name: 'Qwen3 Coder',
		binaryName: 'qwen',
		command: 'qwen',
		args: [],
		batchModePrefix: [],
		batchModeArgs: ['-y'],
		jsonOutputArgs: ['--output-format', 'stream-json'],
		resumeArgs: (sessionId: string) => ['--resume', sessionId],
		// Qwen Code (qwen-code v0.19.x) ships a first-class `--approval-mode plan` that denies
		// write/shell/edit tools in non-interactive mode (read-only analysis). It does not need
		// `-y` to avoid hangs (non-interactive plan/default denies tools rather than prompting),
		// and `-y` (YOLO) would auto-approve writes, defeating read-only intent.
		readOnlyArgs: ['--approval-mode', 'plan'],
		readOnlyCliEnforced: true, // CLI enforces read-only via --approval-mode plan
		yoloModeArgs: ['-y'],
		workingDirArgs: (dir: string) => ['--include-directories', dir],
		imageArgs: undefined,
		modelArgs: (modelId: string) => ['-m', modelId],
		promptArgs: (prompt: string) => ['-p', prompt],
		configOptions: [
			{
				key: 'model',
				type: 'text',
				label: 'Model',
				description:
					'Model passed to -m. Qwen Code is multi-provider, so any model id works (e.g. coder-model, qwen3-coder-plus, qwen3.5-plus, or an OpenAI-compatible id like openai/gpt-4o). Leave blank for the account/plan default.',
				default: '',
				argBuilder: (value: string) => (value && value.trim() ? ['-m', value.trim()] : []),
			},
			{
				key: 'contextWindow',
				type: 'number' as const,
				label: 'Context Window Size',
				description:
					'Maximum context window size in tokens. Qwen3-Coder supports a native 256K (262144) context window.',
				default: 262144,
			},
		],
	},
	{
		id: 'hermes',
		name: 'Hermes',
		binaryName: 'hermes',
		command: 'hermes',
		args: [],
		batchModePrefix: ['chat'],
		batchModeArgs: ['-Q', '--yolo'],
		yoloModeArgs: ['--yolo'],
		promptArgs: (prompt: string) => ['-q', prompt],
		modelArgs: (modelId: string) => ['-m', modelId],
		imageArgs: (imagePath: string) => ['--image', imagePath],
		configOptions: [
			{
				key: 'model',
				type: 'text',
				label: 'Model',
				description:
					'Documented Hermes model override (for example, anthropic/claude-sonnet-4-20250514). Leave empty for the CLI default.',
				default: '',
				argBuilder: (value: string) => (value.trim() ? ['-m', value.trim()] : []),
			},
			{
				key: 'contextWindow',
				type: 'number',
				label: 'Context Window Size',
				description:
					'Fallback context window size in tokens until Hermes reports a runtime-specific value.',
				default: 200000,
			},
		],
	},
	{
		id: 'pi',
		name: 'Pi',
		binaryName: 'pi',
		command: 'pi',
		args: [],
		batchModePrefix: ['-p'],
		jsonOutputArgs: ['--mode', 'json'],
		noPromptSeparator: true,
		resumeArgs: (sessionId: string) => ['--session', sessionId],
		readOnlyArgs: ['--tools', 'read,grep,find,ls'],
		readOnlyCliEnforced: true,
		noToolsArgs: ['--no-tools'],
		modelArgs: (modelId: string) => ['--model', modelId],
		imageArgs: (imagePath: string) => [`@${imagePath}`],
		configOptions: [
			{
				key: 'model',
				type: 'text',
				label: 'Model',
				description:
					'Documented Pi model override (for example, claude-sonnet-4.5). Leave empty for the CLI default.',
				default: '',
				argBuilder: (value: string) => (value.trim() ? ['--model', value.trim()] : []),
			},
			{
				key: 'contextWindow',
				type: 'number',
				label: 'Context Window Size',
				description:
					'Fallback context window size in tokens until Pi reports a runtime-specific value.',
				default: 200000,
			},
		],
	},
	{
		id: 'omp',
		name: 'Oh My Pi',
		binaryName: 'omp',
		command: 'omp',
		args: [],
		batchModePrefix: ['-p'],
		jsonOutputArgs: ['--mode', 'json'],
		// No noPromptSeparator: use Maestro's default '--' end-of-options separator
		// before the prompt. omp supports '--', so prompts beginning with '-' or
		// '---' (markdown front matter) reach the model instead of being parsed as flags.
		resumeArgs: (sessionId: string) => ['--resume', sessionId],
		readOnlyArgs: ['--tools', 'read,grep,glob'], // Read-only: restrict to read/search tools (search->grep, find->glob aliases)
		readOnlyCliEnforced: true,
		noToolsArgs: ['--no-tools'], // Tab naming disables all tools so a task-like first message yields a name, not a real agentic run (mirrors Pi)
		modelArgs: (modelId: string) => ['--model', modelId],
		workingDirArgs: (dir: string) => ['--cwd', dir],
		imageArgs: (imagePath: string) => [`@${imagePath}`],
		configOptions: [
			{
				key: 'model',
				type: 'text',
				label: 'Model',
				description:
					'Fuzzy model override passed to --model (for example, opus, gpt-5.2, or openai/gpt-5.2). Multi-provider; leave empty for the CLI default.',
				default: '',
				argBuilder: (value: string) => (value && value.trim() ? ['--model', value.trim()] : []),
			},
			{
				key: 'contextWindow',
				type: 'number',
				label: 'Context Window Size',
				description:
					'Fallback context window size in tokens until Oh My Pi reports a runtime-specific value.',
				default: 200000,
			},
		],
	},
	{
		id: 'opencode',
		name: 'OpenCode',
		binaryName: 'opencode',
		command: 'opencode',
		args: [], // Base args (none for OpenCode - batch mode uses 'run' subcommand)
		// OpenCode CLI argument builders
		// Batch mode: opencode run --format json [--model provider/model] [--session <id>] [--agent plan] "prompt"
		// YOLO mode (auto-approve all permissions) is enabled via OPENCODE_CONFIG_CONTENT env var.
		// This prevents OpenCode from prompting for permission on external_directory access, which would hang in batch mode.
		batchModePrefix: ['run'], // OpenCode uses 'run' subcommand for batch mode
		jsonOutputArgs: ['--format', 'json'], // JSON output format
		resumeArgs: (sessionId: string) => ['--session', sessionId], // Resume with session ID
		readOnlyArgs: ['--agent', 'plan'], // Read-only/plan mode
		readOnlyCliEnforced: true, // CLI enforces read-only via --agent plan
		modelArgs: (modelId: string) => ['--model', modelId], // Model selection (e.g., 'ollama/qwen3:8b')
		imageArgs: (imagePath: string) => ['-f', imagePath], // Image/file attachment: opencode run -f /path/to/image.png -- "prompt"
		// Use '--' separator before prompt to prevent yargs from misinterpreting
		// leading '---' (YAML frontmatter in slash command prompts) as flags (#527)
		// Default env vars: enable YOLO mode (allow all permissions including external_directory)
		// Disable the question tool via both methods:
		// - "question": "deny" in permission block (per OpenCode GitHub issue workaround)
		// - "question": false in tools block (original approach)
		// The question tool waits for stdin input which hangs batch mode
		// Users can override by setting customEnvVars in agent config
		defaultEnvVars: {
			OPENCODE_CONFIG_CONTENT:
				'{"permission":{"*":"allow","external_directory":"allow","question":"deny"},"tools":{"question":false}}',
		},
		// In read-only mode, keep blanket permission grants to prevent stdin prompts that hang batch mode.
		// Read-only enforcement comes from --agent plan (readOnlyArgs), not env config.
		// Keep question tool disabled to prevent stdin hangs in batch mode.
		readOnlyEnvOverrides: {
			OPENCODE_CONFIG_CONTENT:
				'{"permission":{"*":"allow","external_directory":"allow","question":"deny"},"tools":{"question":false}}',
		},
		// Agent-specific configuration options shown in UI
		configOptions: [
			{
				key: 'model',
				type: 'text',
				label: 'Model',
				description:
					'Model to use (e.g., "ollama/qwen3:8b", "anthropic/claude-sonnet-4-20250514"). Leave empty for default.',
				default: '', // Empty string means use OpenCode's default model
				argBuilder: (value: string) => {
					// Only add --model arg if a model is specified
					if (value && value.trim()) {
						return ['--model', value.trim()];
					}
					return [];
				},
			},
			{
				key: 'contextWindow',
				type: 'number',
				label: 'Context Window Size',
				description:
					'Maximum context window size in tokens. Required for context usage display. Varies by model (e.g., 400000 for Claude/GPT-5.2, 128000 for GPT-4o).',
				default: 128000, // Default for common models (GPT-4, etc.)
			},
		],
	},
	{
		id: 'factory-droid',
		name: 'Factory Droid',
		binaryName: 'droid',
		command: 'droid',
		args: [], // Base args for interactive mode (none)
		requiresPty: false, // Batch mode uses child process

		// Batch mode: droid exec [options] "prompt"
		batchModePrefix: ['exec'],
		// Always skip permissions in batch mode (like Claude Code's --dangerously-skip-permissions)
		// Maestro requires full access to work properly
		batchModeArgs: ['--skip-permissions-unsafe'],

		// JSON output for parsing
		jsonOutputArgs: ['-o', 'stream-json'],

		// Session resume: -s <id> (requires a prompt)
		resumeArgs: (sessionId: string) => ['-s', sessionId],

		// Read-only mode is DEFAULT in droid exec (no flag needed)
		readOnlyArgs: [],
		readOnlyCliEnforced: true, // exec is read-only by default (no flag needed)

		// YOLO mode (same as batchModeArgs, kept for explicit yoloMode requests)
		yoloModeArgs: ['--skip-permissions-unsafe'],

		// Working directory
		workingDirArgs: (dir: string) => ['--cwd', dir],

		// File/image input
		imageArgs: (imagePath: string) => ['-f', imagePath],

		// Prompt is positional argument (no separator needed)
		noPromptSeparator: true,

		// Default env vars - don't set NO_COLOR as it conflicts with FORCE_COLOR
		defaultEnvVars: {},

		// UI config options
		// Model IDs from droid CLI (exact IDs required)
		// NOTE: autonomyLevel is NOT configurable - Maestro always uses --skip-permissions-unsafe
		// which conflicts with --auto. This matches Claude Code's behavior.
		configOptions: [
			{
				key: 'model',
				type: 'select',
				label: 'Model',
				description: 'Model to use for Factory Droid',
				// Model IDs from `droid exec --help`
				options: [
					'', // Empty = use droid's default
					// OpenAI models
					'gpt-5.1',
					'gpt-5.1-codex',
					'gpt-5.1-codex-max',
					'gpt-5.2',
					// Claude models
					'claude-sonnet-4-5-20250929',
					'claude-opus-4-5-20251101',
					'claude-haiku-4-5-20251001',
					// Google models
					'gemini-3-pro-preview',
				],
				default: '', // Empty = use droid's default
				argBuilder: (value: string) => (value && value.trim() ? ['-m', value.trim()] : []),
			},
			{
				key: 'reasoningEffort',
				type: 'select',
				label: 'Reasoning Effort',
				description: 'How much the model should reason before responding',
				options: ['', 'low', 'medium', 'high'],
				default: '', // Empty = use droid's default reasoning
				argBuilder: (value: string) => (value && value.trim() ? ['-r', value.trim()] : []),
			},
			{
				key: 'contextWindow',
				type: 'number',
				label: 'Context Window Size',
				description: 'Maximum context window in tokens (for UI display)',
				default: 200000,
			},
		],
	},
	{
		id: 'copilot-cli',
		name: 'Copilot-CLI',
		binaryName: 'copilot',
		command: 'copilot',
		args: [], // Base args for interactive mode (default copilot)
		requiresPty: true, // Interactive Copilot exits immediately when launched over plain pipes without a TTY
		// GitHub Copilot CLI argument builders
		// Interactive mode: copilot (default)
		// Batch mode: copilot -p "prompt" --output-format json --allow-all
		// `--allow-all` is the documented equivalent of
		// --allow-all-tools + --allow-all-paths + --allow-all-urls; required
		// for non-interactive runs so Copilot never stops to confirm.
		batchModePrefix: [], // No exec subcommand needed
		batchModeArgs: ['--allow-all'], // Unattended: full permissions (tools + paths + urls)
		jsonOutputArgs: ['--output-format', 'json'], // JSONL output
		resumeArgs: (sessionId: string) => [`--resume=${sessionId}`], // Resume with session ID (--continue or --resume=sessionId)
		readOnlyArgs: [
			'--allow-tool=read,url',
			'--deny-tool=write,shell,memory,github',
			'--no-ask-user',
		], // Enforce read-only by denying write/shell/memory/github actions at the Copilot CLI layer
		readOnlyCliEnforced: true, // CLI-enforced via explicit tool permission rules
		// `--add-dir <directory>` adds a dir to Copilot's allowed list (read + write),
		// repeatable. Same coarseness caveat as Claude Code.
		additionalDirArgs: (dirs) => repeatDirFlag('--add-dir', dirsWithAnyAccess(dirs)),
		modelArgs: (modelId: string) => ['--model', modelId], // Model selection
		yoloModeArgs: ['--allow-all'], // Full permissions (same as batchModeArgs; Copilot treats --yolo as an alias)
		imagePromptBuilder: (imagePaths: string[]) =>
			imagePaths.length > 0
				? `Use these attached images as context:\n${imagePaths.map((imagePath) => `@${imagePath}`).join('\n')}\n\n`
				: '',
		promptArgs: (prompt: string) => ['-p', prompt], // Batch mode prompt arg
		// Agent-specific configuration options
		//
		// Deliberately omitted: --autopilot, --allow-all-paths, --allow-all-urls,
		// --experimental, --screen-reader. The batch path always runs with
		// --allow-all so path/url toggles are moot, and --autopilot is an
		// interactive-mode follow-up behavior that has no effect on -p runs.
		// Experimental/screen-reader are user preferences rather than agent
		// config and can be set via Custom CLI Args if needed.
		configOptions: [
			{
				key: 'model',
				type: 'text',
				label: 'Model',
				description:
					'Model to use. Pickable from models.dev catalog or type a custom model name. Leave empty for default.',
				default: '', // Empty = use Copilot's default model
				argBuilder: (value: string) => {
					if (value && value.trim()) {
						return ['--model', value.trim()];
					}
					return [];
				},
			},
			{
				key: 'contextWindow',
				type: 'number',
				label: 'Context Window Size',
				description:
					'Maximum context window size in tokens. Required for context usage display. Varies by model.',
				default: 200000, // Default for Claude/GPT-5 models
			},
			{
				key: 'reasoningEffort',
				type: 'select',
				label: 'Reasoning Effort',
				description:
					'Reasoning budget for models that support it (GPT-5 Codex, o-series). ' +
					'Leave empty to use the model default. Non-reasoning models ignore this flag.',
				options: ['', 'low', 'medium', 'high', 'xhigh'],
				default: '',
				argBuilder: (value: string) =>
					value && value.trim() ? ['--reasoning-effort', value.trim()] : [],
			},
		],
	},
	{
		id: 'grok',
		name: 'Grok CLI',
		binaryName: 'grok',
		command: 'grok',
		args: [], // Base args for interactive mode (default grok TUI)
		requiresPty: false, // Batch mode (-p/--single) works over plain pipes
		// Known limitation: like Codex, Maestro drives grok in batch mode only
		// (-p/--single per turn, --resume to chain turns). There is no interactive
		// PTY integration - the grok TUI is not wired into Maestro's terminal
		// (capabilities: requiresPromptToStart: true).
		//
		// Grok CLI argument builders (verified against `grok --help` v0.2.93)
		// Batch mode: grok --cwd <dir> -p "prompt" --output-format streaming-json --always-approve
		batchModePrefix: [], // No subcommand needed; -p/--single triggers headless mode
		// YOLO required by Maestro, mirroring Claude Code's --dangerously-skip-permissions.
		// --always-approve (boolean auto-approve), NOT ['--permission-mode',
		// 'bypassPermissions'], for two reasons (same pattern as Copilot's --allow-all):
		// 1. grok's clap hard-errors on a repeated --permission-mode ("cannot be
		//    used multiple times"), so batchModeArgs carrying the flag would crash
		//    read-only CLI runs where readOnlyArgs adds --permission-mode plan
		//    (the CLI spawner keeps non-yolo batch args in read-only mode).
		// 2. Cue spawns set yoloMode alongside batch mode, and buildAgentArgs'
		//    flag dedup would collapse a repeated value-flag pair into a stray
		//    positional ("bypassPermissions") that grok parses as a prompt; a
		//    boolean flag dedups cleanly.
		// Keep batchModeArgs === yoloModeArgs so the CLI read-only filter strips it.
		batchModeArgs: ['--always-approve'],
		jsonOutputArgs: ['--output-format', 'streaming-json'], // JSONL event stream on stdout
		promptArgs: (prompt: string) => ['-p', prompt], // Single-turn headless prompt
		resumeArgs: (sessionId: string) => ['--resume', sessionId], // Resume by session UUID
		readOnlyArgs: ['--permission-mode', 'plan'], // Read-only/plan mode
		readOnlyCliEnforced: true, // CLI enforces read-only via --permission-mode plan
		// No noToolsArgs (tab naming falls back to the same graceful path as
		// Codex/Copilot: batch mode + readOnlyArgs). Verified live on v0.2.93:
		// grok has no reliable "disable ALL tools" switch. `--tools ""` is
		// treated as unset (the write tool still ran), and `--disallowed-tools`
		// works per-tool but silently accepts unknown names while the built-in
		// list is undocumented, ~31 names, and version-dependent - a hard-coded
		// list would silently rot, and MCP-provided tools are outside its reach.
		// Do not add noToolsArgs unless grok ships a verified all-off flag.
		yoloModeArgs: ['--always-approve'],
		workingDirArgs: (dir: string) => ['--cwd', dir], // Set working directory
		// modelArgs and configOptions.model.argBuilder both emit -m; trim both
		// so desktop spawn and settings UI stay aligned.
		modelArgs: (modelId: string) => {
			const trimmed = modelId.trim();
			return trimmed ? ['-m', trimmed] : [];
		},
		// Agent-specific configuration options shown in UI
		configOptions: [
			{
				key: 'model',
				type: 'select',
				label: 'Model',
				description:
					'Model to use (see `grok models`). Leave empty for the default model (grok-4.5).',
				dynamic: true, // Discovered from ~/.grok/models_cache.json (or `grok models`) at runtime
				// Static fallback used when ~/.grok/models_cache.json hasn't been
				// written yet and the CLI is unreachable, so the dropdown still renders.
				options: ['', 'grok-4.5', 'grok-composer-2.5-fast'],
				default: '', // Empty = use grok's default model (grok-4.5)
				argBuilder: (value: string) => {
					if (value && value.trim()) {
						return ['-m', value.trim()];
					}
					return [];
				},
			},
			{
				key: 'reasoningEffort',
				type: 'select',
				label: 'Reasoning Effort',
				description:
					"How much the model should reason before responding. Leave empty for the model default (high). Note: 'none' is model-dependent - the default model (grok-4.5) rejects it; grok-composer-2.5-fast accepts it.",
				// Accepted values discovered empirically from grok v0.2.93: a bogus value
				// errors with "Use none, minimal, low, medium, high, xhigh, max, or a
				// model menu option id". Live runs confirmed all seven work on
				// grok-composer-2.5-fast; grok-4.5 rejects 'none' server-side
				// (HTTP 400 "This model does not support reasoning_effort value none")
				// but accepts the other six.
				options: ['', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
				default: '',
				argBuilder: (value: string) =>
					value && value.trim() ? ['--reasoning-effort', value.trim()] : [],
			},
			{
				key: 'contextWindow',
				type: 'number',
				label: 'Context Window Size',
				description:
					'Maximum context window size in tokens. 500000 for grok-4.5, 200000 for grok-composer-2.5-fast.',
				default: 500000, // Matches DEFAULT_CONTEXT_WINDOWS grok entry (grok-4.5)
			},
		],
	},
];

/**
 * Get an agent definition by ID (without runtime detection state)
 */
export function getAgentDefinition(agentId: string): AgentDefinition | undefined {
	return AGENT_DEFINITIONS.find((def) => def.id === agentId);
}

/**
 * Get all agent IDs
 */
export function getAgentIds(): string[] {
	return [...AGENT_IDS];
}

/**
 * Get all visible (non-hidden) agent definitions
 */
export function getVisibleAgentDefinitions(): AgentDefinition[] {
	return AGENT_DEFINITIONS.filter((def) => !def.hidden);
}
