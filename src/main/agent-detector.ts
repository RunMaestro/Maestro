import { execFileNoThrow } from './utils/execFile';
import { logger } from './utils/logger';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { AgentCapabilities, getAgentCapabilities } from './agent-capabilities';
import { expandTilde, detectNodeVersionManagerBinPaths } from '../shared/pathUtils';

// Re-export AgentCapabilities for convenience
export { AgentCapabilities } from './agent-capabilities';

// Configuration option types for agent-specific settings
export interface AgentConfigOption {
	key: string; // Storage key
	type: 'checkbox' | 'text' | 'number' | 'select';
	label: string; // UI label
	description: string; // Help text
	default: any; // Default value
	options?: string[]; // For select type
	argBuilder?: (value: any) => string[]; // Converts config value to CLI args
}

export interface AgentConfig {
	id: string;
	name: string;
	binaryName: string;
	command: string;
	args: string[]; // Base args always included (excludes batch mode prefix)
	available: boolean;
	path?: string;
	customPath?: string; // User-specified custom path (shown in UI even if not available)
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
}

export const AGENT_DEFINITIONS: Omit<AgentConfig, 'available' | 'path' | 'capabilities'>[] = [
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
		workingDirArgs: (dir: string) => ['-C', dir], // Set working directory
		imageArgs: (imagePath: string) => ['-i', imagePath], // Image attachment: codex exec -i /path/to/image.png
		// Agent-specific configuration options shown in UI
		configOptions: [
			{
				key: 'contextWindow',
				type: 'number',
				label: 'Context Window Size',
				description:
					'Maximum context window size in tokens. Required for context usage display. Common values: 400000 (GPT-5.2), 128000 (GPT-4o).',
				default: 400000, // Default for GPT-5.2 models
			},
		],
	},
	{
		id: 'gemini-cli',
		name: 'Gemini CLI',
		binaryName: 'gemini',
		command: 'gemini',
		args: [],
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
		modelArgs: (modelId: string) => ['--model', modelId], // Model selection (e.g., 'ollama/qwen3:8b')
		imageArgs: (imagePath: string) => ['-f', imagePath], // Image/file attachment: opencode run -f /path/to/image.png -- "prompt"
		noPromptSeparator: true, // OpenCode doesn't need '--' before prompt - yargs handles positional args
		// Default env vars: enable YOLO mode (allow all permissions including external_directory)
		// Users can override by setting customEnvVars in agent config
		defaultEnvVars: {
			OPENCODE_CONFIG_CONTENT: '{"permission":{"*":"allow","external_directory":"allow"}}',
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
		id: 'aider',
		name: 'Aider',
		binaryName: 'aider',
		command: 'aider',
		args: [], // Base args (placeholder - to be configured when implemented)
	},
];

export class AgentDetector {
	private cachedAgents: AgentConfig[] | null = null;
	private detectionInProgress: Promise<AgentConfig[]> | null = null;
	private customPaths: Record<string, string> = {};
	// Cache for model discovery results: agentId -> { models, timestamp }
	private modelCache: Map<string, { models: string[]; timestamp: number }> = new Map();
	// Cache TTL: 5 minutes (model lists don't change frequently)
	private readonly MODEL_CACHE_TTL_MS = 5 * 60 * 1000;

	/**
	 * Set custom paths for agents (from user configuration)
	 */
	setCustomPaths(paths: Record<string, string>): void {
		this.customPaths = paths;
		// Clear cache when custom paths change
		this.cachedAgents = null;
	}

	/**
	 * Get the current custom paths
	 */
	getCustomPaths(): Record<string, string> {
		return { ...this.customPaths };
	}

	/**
	 * Detect which agents are available on the system
	 * Uses promise deduplication to prevent parallel detection when multiple calls arrive simultaneously
	 */
	async detectAgents(): Promise<AgentConfig[]> {
		if (this.cachedAgents) {
			return this.cachedAgents;
		}

		// If detection is already in progress, return the same promise to avoid parallel runs
		if (this.detectionInProgress) {
			return this.detectionInProgress;
		}

		// Start detection and track the promise
		this.detectionInProgress = this.doDetectAgents();
		try {
			return await this.detectionInProgress;
		} finally {
			this.detectionInProgress = null;
		}
	}

	/**
	 * Internal method that performs the actual agent detection
	 */
	private async doDetectAgents(): Promise<AgentConfig[]> {
		const agents: AgentConfig[] = [];
		const expandedEnv = this.getExpandedEnv();

		logger.info(`Agent detection starting. PATH: ${expandedEnv.PATH}`, 'AgentDetector');

		for (const agentDef of AGENT_DEFINITIONS) {
			const customPath = this.customPaths[agentDef.id];
			let detection: { exists: boolean; path?: string };

			// If user has specified a custom path, check that first
			if (customPath) {
				detection = await this.checkCustomPath(customPath);
				if (detection.exists) {
					logger.info(
						`Agent "${agentDef.name}" found at custom path: ${detection.path}`,
						'AgentDetector'
					);
				} else {
					logger.warn(
						`Agent "${agentDef.name}" custom path not valid: ${customPath}`,
						'AgentDetector'
					);
					// Fall back to PATH detection
					detection = await this.checkBinaryExists(agentDef.binaryName);
					if (detection.exists) {
						logger.info(
							`Agent "${agentDef.name}" found in PATH at: ${detection.path}`,
							'AgentDetector'
						);
					}
				}
			} else {
				detection = await this.checkBinaryExists(agentDef.binaryName);

				if (detection.exists) {
					logger.info(`Agent "${agentDef.name}" found at: ${detection.path}`, 'AgentDetector');
				} else if (agentDef.binaryName !== 'bash') {
					// Don't log bash as missing since it's always present, log others as warnings
					logger.warn(
						`Agent "${agentDef.name}" (binary: ${agentDef.binaryName}) not found. ` +
							`Searched in PATH: ${expandedEnv.PATH}`,
						'AgentDetector'
					);
				}
			}

			agents.push({
				...agentDef,
				available: detection.exists,
				path: detection.path,
				customPath: customPath || undefined,
				capabilities: getAgentCapabilities(agentDef.id),
			});
		}

		const availableAgents = agents.filter((a) => a.available);
		const isWindows = process.platform === 'win32';

		// On Windows, log detailed path info to help debug shell execution issues
		if (isWindows) {
			logger.info(`Agent detection complete (Windows)`, 'AgentDetector', {
				platform: process.platform,
				agents: availableAgents.map((a) => ({
					id: a.id,
					name: a.name,
					path: a.path,
					pathExtension: a.path ? path.extname(a.path) : 'none',
					// .exe = direct execution, .cmd = requires shell
					willUseShell: a.path
						? a.path.toLowerCase().endsWith('.cmd') ||
							a.path.toLowerCase().endsWith('.bat') ||
							!path.extname(a.path)
						: true,
				})),
			});
		} else {
			logger.info(
				`Agent detection complete. Available: ${availableAgents.map((a) => a.name).join(', ') || 'none'}`,
				'AgentDetector'
			);
		}

		this.cachedAgents = agents;
		return agents;
	}

	/**
	 * Check if a custom path points to a valid executable
	 * On Windows, also tries .cmd and .exe extensions if the path doesn't exist as-is
	 */
	private async checkCustomPath(customPath: string): Promise<{ exists: boolean; path?: string }> {
		const isWindows = process.platform === 'win32';

		// Expand tilde to home directory (Node.js fs doesn't understand ~)
		const expandedPath = expandTilde(customPath);

		// Helper to check if a specific path exists and is a file
		const checkPath = async (pathToCheck: string): Promise<boolean> => {
			try {
				const stats = await fs.promises.stat(pathToCheck);
				return stats.isFile();
			} catch {
				return false;
			}
		};

		try {
			// First, try the exact path provided (with tilde expanded)
			if (await checkPath(expandedPath)) {
				// Check if file is executable (on Unix systems)
				if (!isWindows) {
					try {
						await fs.promises.access(expandedPath, fs.constants.X_OK);
					} catch {
						logger.warn(`Custom path exists but is not executable: ${customPath}`, 'AgentDetector');
						return { exists: false };
					}
				}
				// Return the expanded path so it can be used directly
				return { exists: true, path: expandedPath };
			}

			// On Windows, if the exact path doesn't exist, try with .cmd and .exe extensions
			if (isWindows) {
				const lowerPath = expandedPath.toLowerCase();
				// Only try extensions if the path doesn't already have one
				if (!lowerPath.endsWith('.cmd') && !lowerPath.endsWith('.exe')) {
					// Try .exe first (preferred), then .cmd
					const exePath = expandedPath + '.exe';
					if (await checkPath(exePath)) {
						logger.debug(`Custom path resolved with .exe extension`, 'AgentDetector', {
							original: customPath,
							resolved: exePath,
						});
						return { exists: true, path: exePath };
					}

					const cmdPath = expandedPath + '.cmd';
					if (await checkPath(cmdPath)) {
						logger.debug(`Custom path resolved with .cmd extension`, 'AgentDetector', {
							original: customPath,
							resolved: cmdPath,
						});
						return { exists: true, path: cmdPath };
					}
				}
			}

			return { exists: false };
		} catch {
			return { exists: false };
		}
	}

	/**
	 * Build an expanded PATH that includes common binary installation locations.
	 * This is necessary because packaged Electron apps don't inherit shell environment.
	 */
	private getExpandedEnv(): NodeJS.ProcessEnv {
		const home = os.homedir();
		const env = { ...process.env };
		const isWindows = process.platform === 'win32';

		// Platform-specific paths
		let additionalPaths: string[];

		if (isWindows) {
			// Windows-specific paths
			const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
			const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
			const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
			const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';

			additionalPaths = [
				// Claude Code PowerShell installer (irm https://claude.ai/install.ps1 | iex)
				// This is the primary installation method - installs claude.exe to ~/.local/bin
				path.join(home, '.local', 'bin'),
				// Claude Code winget install (winget install --id Anthropic.ClaudeCode)
				path.join(localAppData, 'Microsoft', 'WinGet', 'Links'),
				path.join(programFiles, 'WinGet', 'Links'),
				path.join(localAppData, 'Microsoft', 'WinGet', 'Packages'),
				path.join(programFiles, 'WinGet', 'Packages'),
				// npm global installs (Claude Code, Codex CLI, Gemini CLI)
				path.join(appData, 'npm'),
				path.join(localAppData, 'npm'),
				// Claude Code CLI install location (npm global)
				path.join(appData, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'cli'),
				// Codex CLI install location (npm global)
				path.join(appData, 'npm', 'node_modules', '@openai', 'codex', 'bin'),
				// User local programs
				path.join(localAppData, 'Programs'),
				path.join(localAppData, 'Microsoft', 'WindowsApps'),
				// Python/pip user installs (for Aider)
				path.join(appData, 'Python', 'Scripts'),
				path.join(localAppData, 'Programs', 'Python', 'Python312', 'Scripts'),
				path.join(localAppData, 'Programs', 'Python', 'Python311', 'Scripts'),
				path.join(localAppData, 'Programs', 'Python', 'Python310', 'Scripts'),
				// Git for Windows (provides bash, common tools)
				path.join(programFiles, 'Git', 'cmd'),
				path.join(programFiles, 'Git', 'bin'),
				path.join(programFiles, 'Git', 'usr', 'bin'),
				path.join(programFilesX86, 'Git', 'cmd'),
				path.join(programFilesX86, 'Git', 'bin'),
				// Node.js
				path.join(programFiles, 'nodejs'),
				path.join(localAppData, 'Programs', 'node'),
				// Scoop package manager (OpenCode, other tools)
				path.join(home, 'scoop', 'shims'),
				path.join(home, 'scoop', 'apps', 'opencode', 'current'),
				// Chocolatey (OpenCode, other tools)
				path.join(process.env.ChocolateyInstall || 'C:\\ProgramData\\chocolatey', 'bin'),
				// Go binaries (some tools installed via 'go install')
				path.join(home, 'go', 'bin'),
				// Windows system paths
				path.join(process.env.SystemRoot || 'C:\\Windows', 'System32'),
				path.join(process.env.SystemRoot || 'C:\\Windows'),
			];
		} else {
			// Unix-like paths (macOS/Linux)
			additionalPaths = [
				'/opt/homebrew/bin', // Homebrew on Apple Silicon
				'/opt/homebrew/sbin',
				'/usr/local/bin', // Homebrew on Intel, common install location
				'/usr/local/sbin',
				`${home}/.local/bin`, // User local installs (pip, etc.)
				`${home}/.npm-global/bin`, // npm global with custom prefix
				`${home}/bin`, // User bin directory
				`${home}/.claude/local`, // Claude local install location
				`${home}/.opencode/bin`, // OpenCode installer default location
				'/usr/bin',
				'/bin',
				'/usr/sbin',
				'/sbin',
			];
		}

		const currentPath = env.PATH || '';
		// Use platform-appropriate path delimiter
		const pathParts = currentPath.split(path.delimiter);

		// Add paths that aren't already present
		for (const p of additionalPaths) {
			if (!pathParts.includes(p)) {
				pathParts.unshift(p);
			}
		}

		env.PATH = pathParts.join(path.delimiter);
		return env;
	}

	/**
	 * On Windows, directly probe known installation paths for a binary.
	 * This is more reliable than `where` command which may fail in packaged Electron apps.
	 * Returns the first existing path found, preferring .exe over .cmd.
	 */
	private async probeWindowsPaths(binaryName: string): Promise<string | null> {
		const home = os.homedir();
		const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
		const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
		const programFiles = process.env.ProgramFiles || 'C:\\Program Files';

		// Define known installation paths for each binary, in priority order
		// Prefer .exe (standalone installers) over .cmd (npm wrappers)
		const knownPaths: Record<string, string[]> = {
			claude: [
				// PowerShell installer (primary method) - installs claude.exe
				path.join(home, '.local', 'bin', 'claude.exe'),
				// Winget installation
				path.join(localAppData, 'Microsoft', 'WinGet', 'Links', 'claude.exe'),
				path.join(programFiles, 'WinGet', 'Links', 'claude.exe'),
				// npm global installation - creates .cmd wrapper
				path.join(appData, 'npm', 'claude.cmd'),
				path.join(localAppData, 'npm', 'claude.cmd'),
				// WindowsApps (Microsoft Store style)
				path.join(localAppData, 'Microsoft', 'WindowsApps', 'claude.exe'),
			],
			codex: [
				// npm global installation (primary method for Codex)
				path.join(appData, 'npm', 'codex.cmd'),
				path.join(localAppData, 'npm', 'codex.cmd'),
				// Possible standalone in future
				path.join(home, '.local', 'bin', 'codex.exe'),
			],
			opencode: [
				// Scoop installation (recommended for OpenCode)
				path.join(home, 'scoop', 'shims', 'opencode.exe'),
				path.join(home, 'scoop', 'apps', 'opencode', 'current', 'opencode.exe'),
				// Chocolatey installation
				path.join(
					process.env.ChocolateyInstall || 'C:\\ProgramData\\chocolatey',
					'bin',
					'opencode.exe'
				),
				// Go install
				path.join(home, 'go', 'bin', 'opencode.exe'),
				// npm (has known issues on Windows, but check anyway)
				path.join(appData, 'npm', 'opencode.cmd'),
			],
			gemini: [
				// npm global installation
				path.join(appData, 'npm', 'gemini.cmd'),
				path.join(localAppData, 'npm', 'gemini.cmd'),
			],
			aider: [
				// pip installation
				path.join(appData, 'Python', 'Scripts', 'aider.exe'),
				path.join(localAppData, 'Programs', 'Python', 'Python312', 'Scripts', 'aider.exe'),
				path.join(localAppData, 'Programs', 'Python', 'Python311', 'Scripts', 'aider.exe'),
				path.join(localAppData, 'Programs', 'Python', 'Python310', 'Scripts', 'aider.exe'),
			],
		};

		const pathsToCheck = knownPaths[binaryName] || [];

		for (const probePath of pathsToCheck) {
			try {
				await fs.promises.access(probePath, fs.constants.F_OK);
				logger.debug(`Direct probe found ${binaryName}`, 'AgentDetector', { path: probePath });
				return probePath;
			} catch {
				// Path doesn't exist, continue to next
			}
		}

		return null;
	}

	/**
	 * On macOS/Linux, directly probe known installation paths for a binary.
	 * This is necessary because packaged Electron apps don't inherit shell aliases,
	 * and 'which' may fail to find binaries in non-standard locations.
	 * Returns the first existing executable path found.
	 */
	private async probeUnixPaths(binaryName: string): Promise<string | null> {
		const home = os.homedir();

		// Get dynamic paths from Node version managers (nvm, fnm, volta, etc.)
		const versionManagerPaths = detectNodeVersionManagerBinPaths();

		// Define known installation paths for each binary, in priority order
		const knownPaths: Record<string, string[]> = {
			claude: [
				// Claude Code default installation location (irm https://claude.ai/install.ps1 equivalent on macOS)
				path.join(home, '.claude', 'local', 'claude'),
				// User local bin (pip, manual installs)
				path.join(home, '.local', 'bin', 'claude'),
				// Homebrew on Apple Silicon
				'/opt/homebrew/bin/claude',
				// Homebrew on Intel Mac
				'/usr/local/bin/claude',
				// npm global with custom prefix
				path.join(home, '.npm-global', 'bin', 'claude'),
				// User bin directory
				path.join(home, 'bin', 'claude'),
				// Add paths from Node version managers (nvm, fnm, volta, etc.)
				...versionManagerPaths.map((p) => path.join(p, 'claude')),
			],
			codex: [
				// User local bin
				path.join(home, '.local', 'bin', 'codex'),
				// Homebrew paths
				'/opt/homebrew/bin/codex',
				'/usr/local/bin/codex',
				// npm global
				path.join(home, '.npm-global', 'bin', 'codex'),
				// Add paths from Node version managers (nvm, fnm, volta, etc.)
				...versionManagerPaths.map((p) => path.join(p, 'codex')),
			],
			opencode: [
				// OpenCode installer default location
				path.join(home, '.opencode', 'bin', 'opencode'),
				// Go install location
				path.join(home, 'go', 'bin', 'opencode'),
				// User local bin
				path.join(home, '.local', 'bin', 'opencode'),
				// Homebrew paths
				'/opt/homebrew/bin/opencode',
				'/usr/local/bin/opencode',
				// Add paths from Node version managers (nvm, fnm, volta, etc.)
				...versionManagerPaths.map((p) => path.join(p, 'opencode')),
			],
			gemini: [
				// npm global paths
				path.join(home, '.npm-global', 'bin', 'gemini'),
				'/opt/homebrew/bin/gemini',
				'/usr/local/bin/gemini',
				// Add paths from Node version managers (nvm, fnm, volta, etc.)
				...versionManagerPaths.map((p) => path.join(p, 'gemini')),
			],
			aider: [
				// pip installation
				path.join(home, '.local', 'bin', 'aider'),
				// Homebrew paths
				'/opt/homebrew/bin/aider',
				'/usr/local/bin/aider',
				// Add paths from Node version managers (in case installed via npm)
				...versionManagerPaths.map((p) => path.join(p, 'aider')),
			],
		};

		const pathsToCheck = knownPaths[binaryName] || [];

		for (const probePath of pathsToCheck) {
			try {
				// Check both existence and executability
				await fs.promises.access(probePath, fs.constants.F_OK | fs.constants.X_OK);
				logger.debug(`Direct probe found ${binaryName}`, 'AgentDetector', { path: probePath });
				return probePath;
			} catch {
				// Path doesn't exist or isn't executable, continue to next
			}
		}

		return null;
	}

	/**
	 * Check if a binary exists in PATH
	 * On Windows, this also handles .cmd and .exe extensions properly
	 */
	private async checkBinaryExists(binaryName: string): Promise<{ exists: boolean; path?: string }> {
		const isWindows = process.platform === 'win32';

		// First try direct file probing of known installation paths
		// This is more reliable than which/where in packaged Electron apps
		if (isWindows) {
			const probedPath = await this.probeWindowsPaths(binaryName);
			if (probedPath) {
				return { exists: true, path: probedPath };
			}
			logger.debug(`Direct probe failed for ${binaryName}, falling back to where`, 'AgentDetector');
		} else {
			// macOS/Linux: probe known paths first
			const probedPath = await this.probeUnixPaths(binaryName);
			if (probedPath) {
				return { exists: true, path: probedPath };
			}
			logger.debug(`Direct probe failed for ${binaryName}, falling back to which`, 'AgentDetector');
		}

		try {
			// Use 'which' on Unix-like systems, 'where' on Windows
			const command = isWindows ? 'where' : 'which';

			// Use expanded PATH to find binaries in common installation locations
			// This is critical for packaged Electron apps which don't inherit shell env
			const env = this.getExpandedEnv();
			const result = await execFileNoThrow(command, [binaryName], undefined, env);

			if (result.exitCode === 0 && result.stdout.trim()) {
				// Get all matches (Windows 'where' can return multiple)
				// Handle both Unix (\n) and Windows (\r\n) line endings
				const matches = result.stdout
					.trim()
					.split(/\r?\n/)
					.map((p) => p.trim())
					.filter((p) => p);

				if (process.platform === 'win32' && matches.length > 0) {
					// On Windows, prefer .exe over .cmd over extensionless
					// This helps with proper execution handling
					const exeMatch = matches.find((p) => p.toLowerCase().endsWith('.exe'));
					const cmdMatch = matches.find((p) => p.toLowerCase().endsWith('.cmd'));

					// Return the best match: .exe > .cmd > first result
					let bestMatch = exeMatch || cmdMatch || matches[0];

					// If the first match doesn't have an extension, check if .cmd or .exe version exists
					// This handles cases where 'where' returns a path without extension
					if (
						!bestMatch.toLowerCase().endsWith('.exe') &&
						!bestMatch.toLowerCase().endsWith('.cmd')
					) {
						const cmdPath = bestMatch + '.cmd';
						const exePath = bestMatch + '.exe';

						// Check if the .exe or .cmd version exists
						try {
							await fs.promises.access(exePath, fs.constants.F_OK);
							bestMatch = exePath;
							logger.debug(`Found .exe version of ${binaryName}`, 'AgentDetector', {
								path: exePath,
							});
						} catch {
							try {
								await fs.promises.access(cmdPath, fs.constants.F_OK);
								bestMatch = cmdPath;
								logger.debug(`Found .cmd version of ${binaryName}`, 'AgentDetector', {
									path: cmdPath,
								});
							} catch {
								// Neither .exe nor .cmd exists, use the original path
							}
						}
					}

					logger.debug(`Windows binary detection for ${binaryName}`, 'AgentDetector', {
						allMatches: matches,
						selectedMatch: bestMatch,
						isCmd: bestMatch.toLowerCase().endsWith('.cmd'),
						isExe: bestMatch.toLowerCase().endsWith('.exe'),
					});

					return {
						exists: true,
						path: bestMatch,
					};
				}

				return {
					exists: true,
					path: matches[0], // First match for Unix
				};
			}

			return { exists: false };
		} catch {
			return { exists: false };
		}
	}

	/**
	 * Get a specific agent by ID
	 */
	async getAgent(agentId: string): Promise<AgentConfig | null> {
		const agents = await this.detectAgents();
		return agents.find((a) => a.id === agentId) || null;
	}

	/**
	 * Clear the cache (useful if PATH changes)
	 */
	clearCache(): void {
		this.cachedAgents = null;
	}

	/**
	 * Clear the model cache for a specific agent or all agents
	 */
	clearModelCache(agentId?: string): void {
		if (agentId) {
			this.modelCache.delete(agentId);
		} else {
			this.modelCache.clear();
		}
	}

	/**
	 * Discover available models for an agent that supports model selection.
	 * Returns cached results if available and not expired.
	 *
	 * @param agentId - The agent identifier (e.g., 'opencode')
	 * @param forceRefresh - If true, bypass cache and fetch fresh model list
	 * @returns Array of model names, or empty array if agent doesn't support model discovery
	 */
	async discoverModels(agentId: string, forceRefresh = false): Promise<string[]> {
		const agent = await this.getAgent(agentId);

		if (!agent || !agent.available) {
			logger.warn(`Cannot discover models: agent ${agentId} not available`, 'AgentDetector');
			return [];
		}

		// Check if agent supports model selection
		if (!agent.capabilities.supportsModelSelection) {
			logger.debug(`Agent ${agentId} does not support model selection`, 'AgentDetector');
			return [];
		}

		// Check cache unless force refresh
		if (!forceRefresh) {
			const cached = this.modelCache.get(agentId);
			if (cached && Date.now() - cached.timestamp < this.MODEL_CACHE_TTL_MS) {
				logger.debug(`Returning cached models for ${agentId}`, 'AgentDetector');
				return cached.models;
			}
		}

		// Run agent-specific model discovery command
		const models = await this.runModelDiscovery(agentId, agent);

		// Cache the results
		this.modelCache.set(agentId, { models, timestamp: Date.now() });

		return models;
	}

	/**
	 * Run the agent-specific model discovery command.
	 * Each agent may have a different way to list available models.
	 */
	private async runModelDiscovery(agentId: string, agent: AgentConfig): Promise<string[]> {
		const env = this.getExpandedEnv();
		const command = agent.path || agent.command;

		// Agent-specific model discovery commands
		switch (agentId) {
			case 'opencode': {
				// OpenCode: `opencode models` returns one model per line
				const result = await execFileNoThrow(command, ['models'], undefined, env);

				if (result.exitCode !== 0) {
					logger.warn(
						`Model discovery failed for ${agentId}: exit code ${result.exitCode}`,
						'AgentDetector',
						{ stderr: result.stderr }
					);
					return [];
				}

				// Parse output: one model per line (e.g., "opencode/gpt-5-nano", "ollama/gpt-oss:latest")
				const models = result.stdout
					.split('\n')
					.map((line) => line.trim())
					.filter((line) => line.length > 0);

				logger.info(`Discovered ${models.length} models for ${agentId}`, 'AgentDetector', {
					models,
				});
				return models;
			}

			default:
				// For agents without model discovery implemented, return empty array
				logger.debug(`No model discovery implemented for ${agentId}`, 'AgentDetector');
				return [];
		}
	}
}
