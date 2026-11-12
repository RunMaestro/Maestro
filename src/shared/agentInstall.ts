/**
 * Agent Install - how to install each provider CLI, and how to tell that a
 * failed turn failed because the CLI is not there at all.
 *
 * A turn whose binary cannot be started used to surface as a bare
 * `Agent exited with code 1` (or `spawn codex ENOENT`), which gives the user
 * nothing to act on: the fix lives entirely outside Maestro, in a terminal they
 * have to think of opening. Classifying the failure as `agent_not_installed`
 * lets the error name the problem and print the install command for the
 * platform the user is actually on, as text they can copy.
 *
 * Safe to import from the main process and the renderer.
 */

import type { AgentId } from './agentIds';
import { getAgentDisplayName } from './agentMetadata';

/** Platforms an install command is written for. Matches `process.platform`. */
export type InstallPlatform = 'darwin' | 'linux' | 'win32';

/**
 * How one provider CLI is installed.
 *
 * Commands are complete shell lines the user pastes into a terminal, so they
 * must parse in the common shells on each platform: a POSIX command must run in
 * Fish as well as bash/zsh, and a Windows line must run unchanged from both
 * PowerShell and cmd.exe. That is why a PowerShell-only installer is wrapped in
 * `powershell -Command` rather than written as a bare `irm ... | iex`.
 */
export interface AgentInstallInfo {
	/** Install command per platform. A missing platform has no one-line install. */
	commands: Partial<Record<InstallPlatform, string>>;
	/** The provider's own install documentation, for anything the command cannot cover. */
	docsUrl: string;
}

/**
 * Install metadata per agent. `null` means Maestro has no install path to offer
 * (the Terminal agent is a plain shell; the providers at the bottom have no
 * verified install line yet).
 *
 * Keyed by AgentId so adding a new agent forces a decision here.
 */
const AGENT_INSTALL_INFO: Record<AgentId, AgentInstallInfo | null> = {
	terminal: null,
	'claude-code': {
		commands: {
			darwin: 'curl -fsSL https://claude.ai/install.sh | bash',
			linux: 'curl -fsSL https://claude.ai/install.sh | bash',
			win32:
				'powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://claude.ai/install.ps1 | iex"',
		},
		docsUrl: 'https://docs.anthropic.com/en/docs/claude-code/setup',
	},
	codex: {
		commands: {
			darwin: 'npm install -g @openai/codex',
			linux: 'npm install -g @openai/codex',
			win32: 'npm install -g @openai/codex',
		},
		docsUrl: 'https://github.com/openai/codex#installing-and-running-codex-cli',
	},
	'gemini-cli': {
		commands: {
			darwin: 'npm install -g @google/gemini-cli',
			linux: 'npm install -g @google/gemini-cli',
			win32: 'npm install -g @google/gemini-cli',
		},
		docsUrl: 'https://github.com/google-gemini/gemini-cli#-installation',
	},
	'qwen3-coder': null,
	opencode: {
		commands: {
			darwin: 'npm install -g opencode-ai',
			linux: 'npm install -g opencode-ai',
			win32: 'npm install -g opencode-ai',
		},
		docsUrl: 'https://opencode.ai/docs/',
	},
	'factory-droid': {
		commands: {
			darwin: 'curl -fsSL https://app.factory.ai/cli | sh',
			linux: 'curl -fsSL https://app.factory.ai/cli | sh',
			win32:
				'powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://app.factory.ai/cli/windows | iex"',
		},
		docsUrl: 'https://docs.factory.ai/cli/getting-started/quickstart',
	},
	'copilot-cli': {
		commands: {
			darwin: 'npm install -g @github/copilot',
			linux: 'npm install -g @github/copilot',
			win32: 'npm install -g @github/copilot',
		},
		docsUrl: 'https://github.com/github/copilot-cli#installation',
	},
	// No verified one-line install yet. The error still says "not installed";
	// it just names no command, because a guessed install line runs in the
	// user's shell. Add an entry once the provider's install path is confirmed.
	antigravity: null,
	hermes: null,
	pi: null,
	omp: null,
	grok: null,
};

/**
 * Install metadata for an agent, or null when Maestro has none (unknown ids
 * included - we never guess a command to run in a shell).
 */
export function getAgentInstallInfo(agentId: AgentId | string): AgentInstallInfo | null {
	if (!Object.prototype.hasOwnProperty.call(AGENT_INSTALL_INFO, agentId)) return null;
	return AGENT_INSTALL_INFO[agentId as AgentId];
}

/** Narrow a `process.platform`-style string to a platform with install commands. */
export function toInstallPlatform(platform: string): InstallPlatform | null {
	return platform === 'darwin' || platform === 'linux' || platform === 'win32' ? platform : null;
}

/**
 * The one-line install command for an agent on a platform, or null when there
 * is no install path for that pairing.
 */
export function getAgentInstallCommand(
	agentId: AgentId | string,
	platform: InstallPlatform | string
): string | null {
	const info = getAgentInstallInfo(agentId);
	const target = toInstallPlatform(platform);
	if (!info || !target) return null;
	return info.commands[target] ?? null;
}

/**
 * What a turn's failure looked like, as far as telling "the CLI is not there"
 * apart from "the CLI ran and failed".
 */
export interface MissingBinaryEvidence {
	/** `error.code` from a failed `child_process.spawn` (`ENOENT`, `EACCES`, ...). */
	errorCode?: string;
	/** Exit code of a process that did start. */
	exitCode?: number | null;
	/** Everything the process wrote to stderr. Stdout is deliberately NOT read. */
	stderr?: string;
	/**
	 * The executable Maestro actually launched, when the caller knows it. An
	 * exit-status report can name a CHILD command ("sh: git: not found"), so the
	 * name in stderr is compared with this before calling the provider missing.
	 */
	command?: string;
}

/** GNU `env` quotes the missing interpreter with ASCII or UTF-8 quotes. */
const RUNTIME_MISSING_PATTERN =
	/\benv:\s*['"‘’]?(node|bun|deno|python3?)['"‘’]?:\s*No such file or directory/i;

/** Interpreters whose absence behind `/usr/bin/env` has its own remedy. */
export type MissingBinaryRuntime = 'node' | 'bun' | 'deno' | 'python';

/** Why a binary could not be run, and which runtime was missing when relevant. */
export interface MissingBinaryClassification {
	reason: 'not-found' | 'runtime-missing';
	runtime?: MissingBinaryRuntime;
}

const RUNTIME_LABELS: Record<MissingBinaryRuntime, string> = {
	node: 'Node.js',
	bun: 'Bun',
	deno: 'Deno',
	python: 'Python',
};

/** Display name for an interpreter named by a failed `/usr/bin/env` line. */
export function missingRuntimeLabel(runtime: MissingBinaryRuntime): string {
	return RUNTIME_LABELS[runtime];
}

/** The interpreter named by the stderr line, or null when the line does not name one. */
function missingRuntimeFromStderr(stderr: string): MissingBinaryRuntime | null {
	const match = stderr.match(RUNTIME_MISSING_PATTERN);
	if (!match) return null;
	const runtime = match[1].toLowerCase();
	return runtime === 'python3' ? 'python' : (runtime as MissingBinaryRuntime);
}

function normalizeExecutableName(name: string): string {
	const unquoted = name.trim().replace(/^['"‘’`]+|['"‘’`]+$/g, '');
	const base = unquoted.split(/[\\/]/).pop() ?? unquoted;
	return base.replace(/\.(cmd|exe|bat|ps1)$/i, '').toLowerCase();
}

/** The executable named by a shell's failure, or null when the wording is unknown. */
function missingExecutableFromStderr(stderr: string): string | null {
	const commandNotFound = stderr.match(/command not found:\s*([^\s:]+)/i);
	if (commandNotFound) return commandNotFound[1];

	const fish = stderr.match(/Unknown command:\s*([^\s]+)/i);
	if (fish) return fish[1];

	const posix = stderr.match(/(?:^|[\s:])([^\s:]+):\s*not found\b/i);
	if (posix) return posix[1];

	const windowsQuoted = stderr.match(/'([^']+)'\s+is not recognized as/i);
	if (windowsQuoted) return windowsQuoted[1];

	const windowsTerm = stderr.match(/^\s*([^\s:]+)\s*:\s*The term\s+'([^']+)'\s+is not recognized/i);
	if (windowsTerm) return windowsTerm[2];

	return null;
}

/**
 * Why the binary could not be run, or null when the evidence does not say.
 *
 * - `not-found`: the binary is not on disk or not on PATH. `ENOENT` from the
 *   spawn, a shell's exit 127 WITH its "command not found" wording, or Windows'
 *   "is not recognized" (cmd exits 9009, a PowerShell wrapper exits 1).
 * - `runtime-missing`: the binary exists, but the interpreter its shebang names
 *   does not (`env: node: No such file or directory`). The classification
 *   carries which runtime (`node`, `bun`, `deno`, `python`) was named, so the
 *   message can give the right remedy. Node is the nvm/volta case: an
 *   npm-installed CLI found in a Node version directory, run from a PATH where
 *   that Node is not.
 *
 * Only stderr is consulted. Stdout carries the agent's own transcript, which
 * can legitimately quote "command not found" from a tool call it ran.
 *
 * Exit-status evidence also requires `command`: a started CLI can propagate a
 * 127 from a child it ran, so the missing name in stderr must match the binary
 * Maestro launched. `ENOENT` is different, because it comes from the spawn of
 * that binary rather than from output.
 */
export function classifyMissingBinary(
	evidence: MissingBinaryEvidence
): MissingBinaryClassification | null {
	if (evidence.errorCode === 'ENOENT') return { reason: 'not-found' };

	const stderr = evidence.stderr ?? '';
	// `/usr/bin/env` with no node on PATH. Only a shell reports this as a 127;
	// a direct spawn of a script whose interpreter is missing is an ENOENT.
	const runtime = evidence.exitCode === 127 ? missingRuntimeFromStderr(stderr) : null;
	if (runtime) return { reason: 'runtime-missing', runtime };

	if (evidence.exitCode !== 127 && evidence.exitCode !== 9009 && evidence.exitCode !== 1) {
		return null;
	}

	const missing = missingExecutableFromStderr(stderr);
	if (!missing || !evidence.command) return null;
	return normalizeExecutableName(missing) === normalizeExecutableName(evidence.command)
		? { reason: 'not-found' }
		: null;
}

/**
 * The user-facing message for an agent whose CLI cannot be started. Names the
 * provider and the concrete reason, then the exact install command for the
 * platform it was given, so the user can copy it into a terminal. When no
 * command is known, the message points at the provider's install guide instead
 * of inventing a line to run.
 */
export function agentNotInstalledMessage(
	agentId: AgentId | string,
	reason: 'not-found' | 'runtime-missing',
	platform?: InstallPlatform | string,
	runtime: MissingBinaryRuntime = 'node'
): string {
	const name = getAgentDisplayName(agentId);
	const cli = agentCliLabel(agentId);
	const command = platform ? getAgentInstallCommand(agentId, platform) : null;
	const docsUrl = getAgentInstallInfo(agentId)?.docsUrl;

	if (reason === 'runtime-missing') {
		const label = missingRuntimeLabel(runtime);
		if (runtime === 'node') {
			return `${cli} is installed, but the runtime it needs (${label}) is not on PATH. Restore ${label} to PATH first (for example with \`nvm use\`), then send the message again. Reinstall the CLI under that ${label} only if it still does not start.`;
		}
		return `${cli} is installed, but the runtime it needs (${label}) is not on PATH. Install ${label} or put it on PATH, then send the message again.`;
	}

	const remedy = command
		? `Install it with: ${command}`
		: docsUrl
			? `Install it from ${docsUrl}`
			: `Follow the ${name} install guide.`;
	return `${cli} not installed. Maestro could not find the ${name} command on this machine's PATH. ${remedy}`;
}

/**
 * "Codex CLI", but "Gemini CLI" rather than "Gemini CLI CLI" for a provider
 * whose display name already says it.
 */
export function agentCliLabel(agentId: AgentId | string): string {
	const name = getAgentDisplayName(agentId);
	return /\bcli$/i.test(name) ? name : `${name} CLI`;
}
