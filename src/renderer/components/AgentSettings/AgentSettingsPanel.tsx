/**
 * AgentSettingsPanel - the root every agent settings tab panel shares: the
 * `role="tabpanel"` wiring its tab's `aria-controls` points at, the modal's
 * section spacing, and an optional line of intro copy.
 */

import type { ReactNode } from 'react';
import type { Theme } from '../../types';
import { tabPanelProps } from '../ui/ModalTabStrip';
import type { AgentSettingsTabId } from './agentSettingsTabs';

export interface AgentSettingsPanelBaseProps {
	theme: Theme;
	/** The strip's `idPrefix`, so the panel id matches its tab's `aria-controls`. */
	idPrefix: string;
}

interface AgentSettingsPanelProps extends AgentSettingsPanelBaseProps {
	tab: AgentSettingsTabId;
	intro?: ReactNode;
	children: ReactNode;
}

export function AgentSettingsPanel({
	theme,
	idPrefix,
	tab,
	intro,
	children,
}: AgentSettingsPanelProps) {
	return (
		<div {...tabPanelProps(idPrefix, tab)} className="space-y-5">
			{intro && (
				<p className="text-xs" style={{ color: theme.colors.textDim }}>
					{intro}
				</p>
			)}
			{children}
		</div>
	);
}
