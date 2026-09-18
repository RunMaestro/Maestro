/**
 * Resolve the provider a Director's Notes synopsis run should spawn.
 *
 * Every synopsis surface (desktop IPC, web server callback, CLI through the web
 * server) funnels its `provider` value through here so "auto" means the same
 * thing everywhere and the availability error reads the same way.
 */

import type { AgentDetector } from '../agents';
import type { ToolType } from '../../shared/types';
import {
	isAutoSynopsisProvider,
	pickFirstAvailableProvider,
	SYNOPSIS_PROVIDER_PREFERENCE,
	type SynopsisProviderChoice,
} from '../../shared/directorNotesProvider';

export interface ResolvedSynopsisProvider {
	/** The agent to spawn. */
	provider: ToolType;
	/** True when auto-selection chose it rather than the conductor. */
	auto: boolean;
}

/**
 * Turn a requested provider (or the `'auto'` sentinel) into a concrete agent.
 *
 * Returns an `error` string instead of throwing because both callers hand it
 * straight back to the user as `SynopsisResult.error`.
 */
export async function resolveSynopsisProvider(
	requested: SynopsisProviderChoice,
	agentDetector: AgentDetector
): Promise<ResolvedSynopsisProvider | { error: string }> {
	if (isAutoSynopsisProvider(requested)) {
		const detected = await agentDetector.detectAgents();
		const availableIds = detected.filter((a) => a.available).map((a) => a.id);
		const picked = pickFirstAvailableProvider(availableIds);
		if (!picked) {
			return {
				error:
					"No supported AI provider is installed for Director's Notes. Install one of: " +
					`${SYNOPSIS_PROVIDER_PREFERENCE.join(', ')}.`,
			};
		}
		return { provider: picked, auto: true };
	}

	const agent = await agentDetector.getAgent(requested);
	if (!agent || !agent.available) {
		return {
			error: `Agent "${requested}" is not available. Please install it or select a different provider in Settings > Director's Notes.`,
		};
	}
	return { provider: requested, auto: false };
}
