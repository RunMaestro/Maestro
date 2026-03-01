/**
 * Agent Definitions
 *
 * Contains the configuration definitions for all supported AI agents.
 * This includes CLI arguments, configuration options, and default settings.
 */

import type { AgentCapabilities } from './capabilities';

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
 */
interface SelectConfigOption extends BaseConfigOption {
	type: 'select';
	default: string;
	options: string[];
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
 * Full agent configuration including runtime detection state
 */
export interface AgentConfig {
	id: string;
	name: string;
	binaryName: string;
	command: string;
	args: string[]; // Base args always included (excludes batch mode prefix)
	available: boolean;
	path?: string;
	customPath?: string; // User-specified custom path (shown in UI even if not available)
	detectedVersion?: string; // Version string detected by running `<binary> --version`
	requiresPty?: boolean; // Whether this agent needs a pseudo-terminal
	configOptions?: AgentConfigOption[]; // Agent-specific configuration
	hidden?: boolean; // If true, agent is hidden from UI (internal use only)
	capabilities: AgentCapabilities; // Agent feature capabilities

	// Argument builders for dynamic CLI construction
	// These are optional - agents that don't have them use hardcoded behavior
	batchModePrefix?: string[]; // Args added before base args for batch mode (e.g., ['run'] for OpenCode)
	batchModeArgs?: string[]; // Args only applied in batch mode (e.g., ['--skip-git-repo-check'] for Codex exec)
	jsonOutputArgs?: string[]; // Args for JSON output format (e.g., ['--format', 'json'])
	resumeArgs?: (sessionId: string) => string[]; // Function to build resume args
	readOnlyArgs?: string[]; // Args for read-only/plan mode (e.g., ['--agent', 'plan'])
	modelArgs?: (modelId: string) => string[]; // Function to build model selection args (e.g., ['--model', modelId])
	yoloModeArgs?: string[]; // Args for YOLO/full-access mode (e.g., ['--dangerously-bypass-approvals-and-sandbox'])
	workingDirArgs?: (dir: string) => string[]; // Function to build working directory args (e.g., ['-C', dir])
	imageArgs?: (imagePath: string) => string[]; // Function to build image attachment args (e.g., ['-i', imagePath] for Codex)
	promptArgs?: (prompt: string) => string[]; // Function to build prompt args (e.g., ['-p', prompt] for OpenCode)
	noPromptSeparator?: boolean; // If true, don't add '--' before the prompt in batch mode (OpenCode doesn't support it)
	defaultEnvVars?: Record<string, string>; // Default environment variables for this agent (merged with user customEnvVars)
	versionArgs?: string[]; // Args to run for version detection (e.g., ['--version'])
	readOnlyEnvOverrides?: Record<string, string>; // Env var overrides applied in read-only mode (replaces keys from defaultEnvVars)
}

/**
 * Agent definition without runtime detection state (used for static definitions)
 */
export type AgentDefinition = Omit<
	AgentConfig,
	'available' | 'path' | 'capabilities' | 'detectedVersion'
>;

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
		binaryName: process.platform === 'win32' ? 'powershell.exe' : 'bash',
		command: process.platform === 'win32' ? 'powershell.exe' : 'bash',
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
		versionArgs: ['--version'],
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
		//   - Read-only: --sandbox read-only (can only read files, overrides YOLO)
		batchModePrefix: ['exec'], // Codex uses 'exec' subcommand for batch mode
		batchModeArgs: ['--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check'], // Args only valid on 'exec' subcommand
		jsonOutputArgs: ['--json'], // JSON output format (must come before resume subcommand)
		resumeArgs: (sessionId: string) => ['resume', sessionId], // Resume with session/thread ID
		readOnlyArgs: ['--sandbox', 'read-only'], // Read-only/plan mode
		yoloModeArgs: ['--dangerously-bypass-approvals-and-sandbox'], // Full access mode
		modelArgs: (modelId: string) => ['-m', modelId], // Model selection (e.g., '-m gpt-4o')
		workingDirArgs: (dir: string) => ['-C', dir], // Set working directory
		imageArgs: (imagePath: string) => ['-i', imagePath], // Image attachment: codex exec -i /path/to/image.png
		versionArgs: ['--version'],
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
				key: 'contextWindow',
				type: 'number',
				label: 'Context Window Size',
				description:
					'Maximum context window size in tokens. Required for context usage display. Common values: 400000 (GPT-5.2/5.3), 128000 (GPT-4o).',
				default: 400000, // Default for GPT-5.2+ models
			},
		],
	},
	{
		id: 'gemini-cli',
		name: 'Gemini CLI',
		binaryName: 'gemini',
		command: 'gemini',
		args: [],
		versionArgs: ['--version'],
	},
	{
		id: 'qwen3-coder',
		name: 'Qwen3 Coder',
		binaryName: 'qwen3-coder',
		command: 'qwen3-coder',
		args: [],
		versionArgs: ['--version'],
	},
	{
		id: 'opencode',
		name: 'OpenCode',
		binaryName: 'opencode',
		command: 'opencode',
		args: [], // Base args (none for OpenCode - batch mode uses 'run' subcommand)
		versionArgs: ['--version'],
		// OpenCode CLI argument builders
		// Batch mode: opencode run --format json [--model provider/model] [--session <id>] [--agent plan] "prompt"
		// YOLO mode (auto-approve all permissions) is enabled via OPENCODE_CONFIG_CONTENT env var.
		// This prevents OpenCode from prompting for permission on external_directory access, which would hang in batch mode.
		batchModePrefix: ['run'], // OpenCode uses 'run' subcommand for batch mode
		jsonOutputArgs: ['--format', 'json'], // JSON output format
		resumeArgs: (sessionId: string) => ['--session', sessionId], // Resume with session ID
		readOnlyArgs: ['--agent', 'plan'], // Read-only/plan mode
		modelArgs: (modelId: string) => ['--model', modelId], // Model selection (e.g., 'ollama/qwen3:8b')
		imageArgs: (imagePath: string) => ['-f', imagePath], // Image/file attachment: opencode run -f /path/to/image.png -- "prompt"
		noPromptSeparator: true, // OpenCode doesn't need '--' before prompt - yargs handles positional args
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
		// In read-only mode, strip blanket permission grants so the plan agent can't auto-approve file writes.
		// Keep question tool disabled to prevent stdin hangs in batch mode.
		readOnlyEnvOverrides: {
			OPENCODE_CONFIG_CONTENT: '{"permission":{"question":"deny"},"tools":{"question":false}}',
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
		versionArgs: ['--version'],

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
		id: 'aider',
		name: 'Aider',
		binaryName: 'aider',
		command: 'aider',
		args: [], // Base args (placeholder - to be configured when implemented)
		versionArgs: ['--version'],
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
