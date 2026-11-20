/**
 * SshTab - where the agent's process runs: the SSH remote selector with its
 * remote working directory override and history sync toggles.
 */

import { SshRemoteSelector, type SshRemoteSelectorProps } from '../shared/SshRemoteSelector';
import { AgentSettingsPanel, type AgentSettingsPanelBaseProps } from './AgentSettingsPanel';

export interface SshTabProps
	extends AgentSettingsPanelBaseProps, Omit<SshRemoteSelectorProps, 'theme' | 'compact'> {}

export function SshTab({ theme, idPrefix, ...selector }: SshTabProps) {
	return (
		<AgentSettingsPanel theme={theme} idPrefix={idPrefix} tab="ssh">
			<SshRemoteSelector theme={theme} {...selector} />
		</AgentSettingsPanel>
	);
}
