/**
 * Per-agent installer dispatcher. Picks the right strategy by agentId.
 */

import type { AgentMcpInstaller } from './types';
import { claudeCodeInstaller } from './claude-code';
import { codexInstaller } from './codex';
import { opencodeInstaller } from './opencode';
import { factoryDroidInstaller } from './factory-droid';

const INSTALLERS: Record<string, AgentMcpInstaller> = {
	[claudeCodeInstaller.agentId]: claudeCodeInstaller,
	[codexInstaller.agentId]: codexInstaller,
	[opencodeInstaller.agentId]: opencodeInstaller,
	[factoryDroidInstaller.agentId]: factoryDroidInstaller,
};

/** All agent ids the coworking installer supports. Drives the Settings UI rows. */
export const COWORKING_SUPPORTED_AGENTS: ReadonlyArray<string> = Object.keys(INSTALLERS);

export function getInstaller(agentId: string): AgentMcpInstaller | null {
	return INSTALLERS[agentId] ?? null;
}

export type { AgentMcpInstaller };
