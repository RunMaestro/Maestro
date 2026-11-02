/**
 * PeersTab - Peer Agents: the other agents this one may consult or delegate to
 * on its own, plus this agent's advertised specialty. The modal that mounts
 * the tab holds the state. Group Settings edits grants only.
 */

import { PeerAgentsSection, type PeerAgentsSectionProps } from '../shared/PeerAgentsSection';
import { AgentSettingsPanel, type AgentSettingsPanelBaseProps } from './AgentSettingsPanel';
import { NudgeMessageField } from '../NewInstanceModal/NudgeMessageField';

export interface PeersTabProps
	extends AgentSettingsPanelBaseProps, Omit<PeerAgentsSectionProps, 'theme'> {
	peerDescription?: string;
	onPeerDescriptionChange?: (value: string) => void;
}

export function PeersTab({
	theme,
	idPrefix,
	peerDescription,
	onPeerDescriptionChange,
	...peers
}: PeersTabProps) {
	return (
		<AgentSettingsPanel
			theme={theme}
			idPrefix={idPrefix}
			tab="peers"
			intro="This agent reads its peer roster, and the note on each peer, the same way it reads its working directories. It decides on its own when to consult a peer or delegate to one, within the access granted here."
		>
			{onPeerDescriptionChange && (
				<NudgeMessageField
					theme={theme}
					value={peerDescription ?? ''}
					onChange={onPeerDescriptionChange}
					label="How peers see this agent"
					description="Describe this agent's specialty and when to call on it. This description is shared with every agent that can reach it as a peer, including group and worktree peers."
					placeholder="Owns API design and backend services. Consult for endpoint contracts, data models, and service debugging."
					sizeKey="peer-description"
				/>
			)}
			<PeerAgentsSection theme={theme} {...peers} />
		</AgentSettingsPanel>
	);
}
