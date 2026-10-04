/**
 * Changing an agent's provider (PS-1, PS-4), as pure state. The overlay that
 * draws it (`ManageOverlays.tsx`) and the App's key handling read this file.
 * The swap itself runs on the host (`switchAgentProvider`): it keeps every tab,
 * parks what belongs to the old provider, and answers with what it could not
 * park. This file only chooses the provider and sends the one `agents.update`.
 */

import {
	getAgentDisplayName,
	type AgentRecord,
	type ClientResult,
	type MaestroClient,
	type ProviderInfo,
} from '../../shared/maestro-lib';
import { agentSshRemoteId, availableProviders } from './form';

export interface ProviderChoice {
	id: string;
	label: string;
	/** The provider the agent runs on now. */
	current: boolean;
}

/** What a finished swap leaves on the overlay: a summary, and every line the host could not park. */
export interface ProviderSwapDone {
	summary: string;
	notices: string[];
}

/** Only providers installed where the agent runs are offered (PS-4). */
export function providerChoices(
	providers: readonly ProviderInfo[],
	agent: AgentRecord
): ProviderChoice[] {
	return (
		availableProviders({ providers: [...providers] })
			// The host refuses `terminal`; it is never an agent provider.
			.filter((provider) => provider.id !== 'terminal')
			.map((provider) => ({
				id: provider.id,
				label: provider.version ? `${provider.name} ${provider.version}` : provider.name,
				current: provider.id === agent.toolType,
			}))
	);
}

/** The picker opens on the agent's own provider, else the first row. */
export function providerPickerStart(choices: readonly ProviderChoice[]): number {
	return Math.max(
		0,
		choices.findIndex((choice) => choice.current)
	);
}

/** Which installed providers apply to this agent: probed on its SSH remote, when it has one. */
export async function loadProviderChoices(
	client: MaestroClient,
	agent: AgentRecord
): Promise<ClientResult<ProviderChoice[]>> {
	const remoteId = agentSshRemoteId(agent);
	const result = await client.providers.list(remoteId ? { sshRemoteId: remoteId } : undefined);
	return result.ok ? { ok: true, value: providerChoices(result.value, agent) } : result;
}

/** Sends the swap. Choosing the provider the agent is already on sends nothing. */
export async function submitProviderSwap(
	client: MaestroClient,
	agent: AgentRecord,
	choices: readonly ProviderChoice[],
	index: number
): Promise<ClientResult<ProviderSwapDone>> {
	const choice = choices[index];
	if (!choice) {
		return {
			ok: false,
			error: { code: 'invalid', message: 'That provider is gone.', method: 'agents.update' },
		};
	}
	const name = getAgentDisplayName(choice.id);
	if (choice.current) {
		return { ok: true, value: { summary: `${agent.name} is already on ${name}.`, notices: [] } };
	}
	const result = await client.agents.update(agent.id, { provider: choice.id });
	if (!result.ok) return result;
	return {
		ok: true,
		value: {
			summary: `Switched ${agent.name} to ${name}. Every tab was kept.`,
			notices: result.value.notices ?? [],
		},
	};
}
