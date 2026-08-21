import {
	AGENT_PICKER_META,
	PICKABLE_AGENT_IDS,
	getAgentDisplayName,
} from '../../../../../../shared/agentMetadata';
import type { AgentTile } from '../types';

/**
 * Provider tiles for the wizard strip, derived from the shared picker registry
 * so the wizard, the New Agent modal, and the Group Chat moderator dropdown
 * always offer the same providers in the same order.
 *
 * `supported` stays on the tile because the strip still renders a dimmed
 * "Coming soon" state for a provider that is announced but not wired yet.
 * Everything derived here is wired, so it is always true.
 */
export const AGENT_TILES: AgentTile[] = PICKABLE_AGENT_IDS.map((id) => {
	const meta = AGENT_PICKER_META[id]!;
	return {
		id,
		name: getAgentDisplayName(id),
		supported: true,
		description: meta.description,
		brandColor: meta.brandColor,
	};
});
