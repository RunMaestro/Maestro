/**
 * PeersTab - Peer Agents: the other agents this one may consult or delegate to
 * on its own. The panel is the intro line and `PeerAgentsSection`; every prop
 * but the panel's own goes straight to the section, and the modal that mounts
 * the tab holds the state.
 */

import { PeerAgentsSection, type PeerAgentsSectionProps } from '../shared/PeerAgentsSection';
import { AgentSettingsPanel, type AgentSettingsPanelBaseProps } from './AgentSettingsPanel';

export interface PeersTabProps
	extends AgentSettingsPanelBaseProps, Omit<PeerAgentsSectionProps, 'theme'> {}

export function PeersTab({ theme, idPrefix, ...peers }: PeersTabProps) {
	return (
		<AgentSettingsPanel
			theme={theme}
			idPrefix={idPrefix}
			tab="peers"
			intro="This agent reads its peer roster, and the note on each peer, the same way it reads its working directories. It decides on its own when to consult a peer or delegate to one, within the access granted here."
		>
			<PeerAgentsSection theme={theme} {...peers} />
		</AgentSettingsPanel>
	);
}
