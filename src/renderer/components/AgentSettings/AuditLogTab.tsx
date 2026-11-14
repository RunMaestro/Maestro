/**
 * AuditLogTab - the audit log of one agent: the folder, the switch and Verify
 * Log. The panel is `AgentCotExportSection`, which saves itself, so the modal
 * that mounts the tab holds none of its state.
 *
 * Edit Agent only, and only in the desktop app (`isCotExportAvailable()`). The
 * tab has no deep link: see `AUDIT_LOG_TAB_ID`.
 */

import {
	AgentCotExportSection,
	type AgentCotExportSectionProps,
} from '../NewInstanceModal/AgentCotExportSection';
import { AgentSettingsPanel, type AgentSettingsPanelBaseProps } from './AgentSettingsPanel';
import { AUDIT_LOG_TAB_ID } from './agentSettingsTabs';

export interface AuditLogTabProps
	extends AgentSettingsPanelBaseProps, Omit<AgentCotExportSectionProps, 'theme'> {}

export function AuditLogTab({ theme, idPrefix, ...section }: AuditLogTabProps) {
	return (
		<AgentSettingsPanel theme={theme} idPrefix={idPrefix} tab={AUDIT_LOG_TAB_ID}>
			<AgentCotExportSection theme={theme} {...section} />
		</AgentSettingsPanel>
	);
}
