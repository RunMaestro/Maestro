/**
 * Agent Install - how to install each provider CLI, and how to tell that a
 * failed turn failed because the CLI is not there at all.
 *
 * A turn whose binary cannot be started used to surface as a bare
 * `Agent exited with code 1` (or `spawn codex ENOENT`), which gives the user
 * nothing to act on: the fix lives entirely outside Maestro, in a terminal they
 * have to think of opening. Classifying the failure as `agent_not_installed`
 * lets the error dialog name the problem and offer the install command for the
 * platform the user is actually on.
 *
 * Safe to import from the main process, the renderer, and the CLI.
 */

import type { AgentId } from './agentIds';
import { getAgentDisplayName } from './agentMetadata';

/** Platforms an install command is written for. Matches `process.platform`. */
export type InstallPlatform = 'darwin' | 'linux' | 'win32';

/**
 * How one provider CLI is installed.
 *
 * Commands are complete shell lines. Windows lines must run unchanged from both
 * PowerShell and cmd.exe, because the install shell is the user's default shell
 * and either can be configured - so a PowerShell-only installer is wrapped in
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
 * (the Terminal agent is a plain shell; Qwen3 Coder is not shipped yet).
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
}

/**
 * Why the binary could not be run, or null when the evidence does not say.
 *
 * - `not-found`: the binary is not on disk or not on PATH. `ENOENT` from the
 *   spawn, a shell's exit 127 ("command not found"), or Windows' "is not
 *   recognized" (cmd exits 9009, a PowerShell wrapper exits 1).
 * - `runtime-missing`: the binary exists, but the interpreter its shebang names
 *   does not (`env: node: No such file or directory`). This is the nvm/volta
 *   case: an npm-installed CLI found in a Node version directory, run from a
 *   PATH where that Node is not. Reinstalling under the active Node fixes it.
 *
 * Only stderr is consulted. Stdout carries the agent's own transcript, which
 * can legitimately quote "command not found" from a tool call it ran.
 */
export function classifyMissingBinary(
	evidence: MissingBinaryEvidence
): 'not-found' | 'runtime-missing' | null {
	if (evidence.errorCode === 'ENOENT') return 'not-found';

	const stderr = evidence.stderr ?? '';
	// `/usr/bin/env node` with no node on PATH. Checked before the exit code so
	// a 127 from env is reported as the runtime, not the CLI, being missing.
	if (/\benv:\s*['"]?(node|bun|deno|python3?)['"]?:\s*No such file or directory/i.test(stderr)) {
		return 'runtime-missing';
	}
	if (evidence.exitCode === 127) return 'not-found';
	if (
		(evidence.exitCode === 9009 || evidence.exitCode === 1) &&
		/is not recognized as (an internal or external command|the name of a cmdlet)/i.test(stderr)
	) {
		return 'not-found';
	}
	return null;
}

/**
 * The user-facing message for an agent whose CLI cannot be started. Names the
 * provider and the concrete reason; the install command itself is offered by
 * the recovery action, not baked into the message.
 */
export function agentNotInstalledMessage(
	agentId: AgentId | string,
	reason: 'not-found' | 'runtime-missing'
): string {
	const name = getAgentDisplayName(agentId);
	const cli = agentCliLabel(agentId);
	if (reason === 'runtime-missing') {
		return `${cli} is installed, but the runtime it needs (Node.js) is not on PATH. Reinstall ${name} under your current Node.js, or fix PATH, then retry.`;
	}
	return `${cli} not installed. Maestro could not find the ${name} command on this machine's PATH.`;
}

/**
 * "Codex CLI", but "Gemini CLI" rather than "Gemini CLI CLI" for a provider
 * whose display name already says it.
 */
export function agentCliLabel(agentId: AgentId | string): string {
	const name = getAgentDisplayName(agentId);
	return /\bcli$/i.test(name) ? name : `${name} CLI`;
}
