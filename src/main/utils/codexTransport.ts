import * as os from 'os';
import * as path from 'path';

export const CODEX_AGENT_ID = 'codex';
export const CODEX_OMX_BINARY = 'omx';
export const CODEX_PROVIDER_BINARY = 'codex';
export const CODEX_DISPLAY_NAME = 'Codex via OMX';
export const LOCAL_CODEX_HOME = path.join(os.homedir(), '.codex');
export const REMOTE_CODEX_HOME = '$HOME/.codex';

export function isCodexAgentId(agentId: string | undefined | null): boolean {
	return agentId === CODEX_AGENT_ID;
}

export function isOmxLikeCommand(commandOrPath: string | undefined | null): boolean {
	if (!commandOrPath || !commandOrPath.trim()) {
		return false;
	}

	const normalized = path
		.basename(commandOrPath.trim())
		.toLowerCase()
		.replace(/\.(cmd|exe|bat|ps1)$/i, '');

	return normalized === CODEX_OMX_BINARY;
}

export function getCodexCustomPathError(customPath: string): string {
	return `Codex now launches through OMX. Custom path must point to the omx executable or remote omx command, not raw codex. Received: ${customPath}`;
}

export function resolveCodexLaunchCommand(
	toolType: string,
	defaultCommand: string,
	customPath?: string
): { command: string; ignoredCustomPath?: string } {
	if (!isCodexAgentId(toolType)) {
		return {
			command: customPath || defaultCommand,
		};
	}

	if (customPath && customPath.trim()) {
		if (isOmxLikeCommand(customPath)) {
			return { command: customPath.trim() };
		}

		return {
			command: defaultCommand || CODEX_OMX_BINARY,
			ignoredCustomPath: customPath,
		};
	}

	return {
		command: defaultCommand || CODEX_OMX_BINARY,
	};
}

export function withCodexHomeEnv(
	toolType: string,
	env: Record<string, string | undefined> | undefined,
	scope: 'local' | 'remote'
): Record<string, string> | undefined {
	if (!isCodexAgentId(toolType)) {
		if (!env) {
			return undefined;
		}
		return Object.fromEntries(
			Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)
		);
	}

	return {
		...Object.fromEntries(
			Object.entries(env || {}).filter((entry): entry is [string, string] => entry[1] !== undefined)
		),
		CODEX_HOME: scope === 'remote' ? REMOTE_CODEX_HOME : LOCAL_CODEX_HOME,
	};
}
