/**
 * Resolve the provider a Director's Notes synopsis run should spawn.
 *
 * Every synopsis surface (desktop IPC, web server callback, CLI through the web
 * server) funnels its `provider` value through here so "auto" means the same
 * thing everywhere and the availability error reads the same way.
 */

import type { AgentDetector } from '../agents';
import type { ToolType } from '../../shared/types';
import { getAgentDisplayName } from '../../shared/agentMetadata';
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
 * The refusal for an explicit pick that detection cannot find. It names the
 * provider the conductor chose and says nothing ran elsewhere, so a stale
 * install or a missing binary path is fixed rather than papered over by a
 * synopsis from a different provider.
 */
function explicitProviderUnavailable(requested: ToolType): string {
	const name = getAgentDisplayName(requested);
	return (
		`Agent "${requested}" is not available. Director's Notes did not run on ${name} and used no ` +
		`other provider. Install ${name} or set its binary path in its agent settings, or select a ` +
		"different provider (or turn on auto-selection) in Settings > Director's Notes."
	);
}

/**
 * Turn a requested provider (or the `'auto'` sentinel) into a concrete agent.
 *
 * Returns an `error` string instead of throwing because both callers hand it
 * straight back to the user as `SynopsisResult.error`. An explicit pick is
 * never replaced: an unavailable one is refused here, and an authentication
 * failure or a provider refusal surfaces from the run itself, on that provider.
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
		return { error: explicitProviderUnavailable(requested) };
	}
	return { provider: requested, auto: false };
}
