/**
 * ModelsTab - which model the agent runs and where, and what its requests pass
 * through on the way.
 *
 * Each section is a slot the modal fills: `model` (`AgentModelSection`: the
 * Model field, which also lists Local Models source models, with effort and
 * the other model options),
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
	model?: ReactNode;
	tiers?: ReactNode;
	gateway?: ReactNode;
	systemOne?: ReactNode;
}

export function ModelsTab({ theme, idPrefix, model, tiers, gateway, systemOne }: ModelsTabProps) {
	const empty = !model && !tiers && !gateway && !systemOne;
	return (
		<AgentSettingsPanel
			theme={theme}
			idPrefix={idPrefix}
			tab="models"
			intro="Which model this agent runs and where, and what its requests pass through."
		>
			{model}
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
