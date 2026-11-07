/**
 * ModelsTab - where the agent's model runs, and what its requests pass
 * through on the way.
 *
 * Each section is a slot the modal fills: `runOn` (the model target picker),
 * `tiers` (where a `low`, `medium` or `high` task launches, for a modal that
 * edits an existing agent) and `gateway` (`GatewayUrlField`, plus the Maestro
 * token proxy mode and its Background requests picker where the modal offers
 * them) and `systemOne` (whether this agent may ask System One, for a modal
 * that edits an existing agent). A modal with none gets a quiet empty state
 * rather than a blank panel.
 */

import type { ReactNode } from 'react';
import { BrainCircuit } from 'lucide-react';
import { EmptyStatePlaceholder } from '../ui/EmptyStatePlaceholder';
import { AgentSettingsPanel, type AgentSettingsPanelBaseProps } from './AgentSettingsPanel';

export interface ModelsTabProps extends AgentSettingsPanelBaseProps {
	runOn?: ReactNode;
	tiers?: ReactNode;
	gateway?: ReactNode;
	systemOne?: ReactNode;
}

export function ModelsTab({ theme, idPrefix, runOn, tiers, gateway, systemOne }: ModelsTabProps) {
	const empty = !runOn && !tiers && !gateway && !systemOne;
	return (
		<AgentSettingsPanel
			theme={theme}
			idPrefix={idPrefix}
			tab="models"
			intro="Where this agent's model runs, and what its requests pass through."
		>
			{runOn}
			{tiers}
			{gateway}
			{systemOne}
			{empty && (
				<EmptyStatePlaceholder
					theme={theme}
					icon={<BrainCircuit className="w-10 h-10" />}
					title="Nothing to set here yet."
				/>
			)}
		</AgentSettingsPanel>
	);
}
