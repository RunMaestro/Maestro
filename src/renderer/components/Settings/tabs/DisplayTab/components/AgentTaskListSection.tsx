import { ListChecks } from 'lucide-react';
import type { Theme } from '../../../../../types';
import { SettingsSectionHeading } from '../../../SettingsSectionHeading';
import { SectionCard } from './SectionCard';
import { ToggleSettingRow } from './ToggleSettingRow';

interface AgentTaskListSectionProps {
	theme: Theme;
	showAgentTaskListBar: boolean;
	setShowAgentTaskListBar: (value: boolean) => void;
	autoExpandAgentTaskListBar: boolean;
	setAutoExpandAgentTaskListBar: (value: boolean) => void;
}

export function AgentTaskListSection({
	theme,
	showAgentTaskListBar,
	setShowAgentTaskListBar,
	autoExpandAgentTaskListBar,
	setAutoExpandAgentTaskListBar,
}: AgentTaskListSectionProps) {
	return (
		<div>
			<SettingsSectionHeading icon={ListChecks}>Agent Task List</SettingsSectionHeading>
			<SectionCard theme={theme}>
				<div data-setting-id="display-agent-task-list-bar">
					<ToggleSettingRow
						theme={theme}
						title="Dock the task list above the composer"
						description="Pin the agent's current checklist in a collapsible bar above the input box so it doesn't scroll away. Only appears once an agent writes a checklist; the inline cards in the conversation are unaffected."
						checked={showAgentTaskListBar}
						onChange={setShowAgentTaskListBar}
						ariaLabel="Dock the task list above the composer"
					/>
				</div>
				<div data-setting-id="display-agent-task-list-auto-expand">
					<ToggleSettingRow
						theme={theme}
						title="Expand it automatically"
						description="Open the docked bar to the full checklist each time the agent writes a new one, instead of the one-line summary. Collapsing it applies to that checklist only."
						checked={autoExpandAgentTaskListBar}
						onChange={setAutoExpandAgentTaskListBar}
						ariaLabel="Expand the docked task list automatically"
						disabled={!showAgentTaskListBar}
						borderTop
						className={showAgentTaskListBar ? '' : 'opacity-50'}
					/>
				</div>
			</SectionCard>
		</div>
	);
}
