/**
 * Agent Definitions
 *
 * Contains the configuration definitions for all supported AI agents.
 * This includes CLI arguments, configuration options, and default settings.
 */

import type { AgentCapabilities, AgentConfig as BaseAgentConfig } from '../../shared/types';
import { isWindows } from '../../shared/platformDetection';
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
	modelArgs?: (modelId: string) => string[]; // Function to build model selection args (e.g., ['--model', modelId])
	workingDirArgs?: (dir: string) => string[]; // Function to build working directory args (e.g., ['-C', dir])
	imageArgs?: (imagePath: string) => string[]; // Function to build image attachment args (e.g., ['-i', imagePath] for Codex)
	imagePromptBuilder?: (imagePaths: string[]) => string; // Function to embed image references into the prompt (e.g., Copilot @mentions)
	promptArgs?: (prompt: string) => string[]; // Function to build prompt args (e.g., ['-p', prompt] for OpenCode)
	noPromptSeparator?: boolean; // If true, don't add '--' before the prompt in batch mode (OpenCode doesn't support it)
	defaultEnvVars?: Record<string, string>; // Default environment variables for this agent (merged with user customEnvVars)
	readOnlyEnvOverrides?: Record<string, string>; // Env var overrides applied in read-only mode (replaces keys from defaultEnvVars)
	batchModeEnvVars?: Record<string, string>; // Env vars applied ONLY to CLI batch spawns (maestro-cli send). Not applied to desktop UI or --live path. Use for settings that only make sense in short-lived non-interactive sessions (e.g., disabling background tasks).
}

/**
 * Agent definition without runtime detection state (used for static definitions)
 */
export type AgentDefinition = Omit<AgentConfig, 'available' | 'path' | 'capabilities'>;

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
		command: 'claude',
		// YOLO mode (--dangerously-skip-permissions) is always enabled - Maestro requires it
		args: [
			'--print',
			'--verbose',
			'--output-format',
			'stream-json',
			'--dangerously-skip-permissions',
		],
		resumeArgs: (sessionId: string) => ['--resume', sessionId], // Resume with session ID
		readOnlyArgs: ['--permission-mode', 'plan'], // Read-only/plan mode
		readOnlyCliEnforced: true, // CLI enforces read-only via --permission-mode plan
		modelArgs: (modelId: string) => ['--model', modelId], // Model selection: claude --model sonnet
		// Batch-mode env vars (CLI `maestro-cli send` default path only — not --live, not desktop UI).
		// Background tasks cannot complete before a short-lived batch session exits, so results are lost (#861).
		batchModeEnvVars: {
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
		// Batch mode: codex exec --json --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check [--sandbox read-only] [-C dir] [resume <id>] -- "prompt"
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
		], // Read-only/plan mode — includes bypass flags for non-interactive execution (sandbox read-only overrides YOLO permissions)
		readOnlyCliEnforced: true, // CLI enforces read-only via --sandbox read-only
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
				default: '',
				argBuilder: (value: string) =>
					value && value.trim() ? ['-c', `reasoning.effort="${value.trim()}"`] : [],
			},
		],
	},
	{
		id: 'gemini-cli',
		name: 'Gemini CLI',
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
		binaryName: 'qwen3-coder',
		command: 'qwen3-coder',
		args: [],
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
	return AGENT_DEFINITIONS.map((def) => def.id);
}

/**
 * Get all visible (non-hidden) agent definitions
 */
export function getVisibleAgentDefinitions(): AgentDefinition[] {
	return AGENT_DEFINITIONS.filter((def) => !def.hidden);
}
