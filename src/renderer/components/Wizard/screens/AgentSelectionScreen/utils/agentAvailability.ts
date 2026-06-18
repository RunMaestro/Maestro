import type { AgentConfig } from '../../../../../types';
import type { AgentTile } from '../types';

export function getVisibleAgents(agents: AgentConfig[]): AgentConfig[] {
	return agents.filter((agent) => !agent.hidden);
}

export function findDetectedAgent(
	detectedAgents: AgentConfig[],
	agentId: string
): AgentConfig | undefined {
	return detectedAgents.find((agent) => agent.id === agentId);
}

export function isAgentAvailable(detectedAgents: AgentConfig[], agentId: string): boolean {
	return findDetectedAgent(detectedAgents, agentId)?.available ?? false;
}

export function countSelectableAgentTiles(
	tiles: AgentTile[],
	detectedAgents: AgentConfig[]
): number {
	return tiles.filter((tile) => tile.supported && isAgentAvailable(detectedAgents, tile.id)).length;
}

export function findFirstSelectableTileIndex(
	tiles: AgentTile[],
	detectedAgents: AgentConfig[]
): number {
	return tiles.findIndex((tile) => tile.supported && isAgentAvailable(detectedAgents, tile.id));
}

export function getConnectionErrors(visibleAgents: AgentConfig[]): string[] {
	return visibleAgents
		.filter((agent: AgentConfig & { error?: string }) => agent.error)
		.map((agent: AgentConfig & { error?: string }) => agent.error)
		.filter((error): error is string => Boolean(error));
}

export function hasSshConnectionFailure(
	visibleAgents: AgentConfig[],
	sshEnabled: boolean | undefined
): boolean {
	const connectionErrors = getConnectionErrors(visibleAgents);
	return (
		Boolean(sshEnabled) &&
		connectionErrors.length > 0 &&
		visibleAgents.every(
			(agent: AgentConfig & { error?: string }) => agent.error || !agent.available
		)
	);
}

export function buildDetectionAnnouncement({
	availableCount,
	totalCount,
	remote,
	autoSelectedClaude,
}: {
	availableCount: number;
	totalCount: number;
	remote: boolean;
	autoSelectedClaude: boolean;
}): string {
	const remoteContext = remote ? ' on remote host' : '';
	const base = `Agent detection complete${remoteContext}. ${availableCount} of ${totalCount} agents available.`;
	return autoSelectedClaude ? `${base} Claude Code automatically selected.` : base;
}

export function buildConfiguringAgent({
	configuringAgentId,
	configuringTile,
	detectedAgent,
}: {
	configuringAgentId: string | null;
	configuringTile: AgentTile | undefined;
	detectedAgent: AgentConfig | undefined;
}): AgentConfig | undefined {
	if (detectedAgent) return detectedAgent;
	if (!configuringAgentId || !configuringTile) return undefined;

	return {
		id: configuringAgentId,
		name: configuringTile.name,
		available: false,
		path: undefined,
		hidden: false,
		capabilities: undefined,
	};
}
