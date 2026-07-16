import { Tag } from 'lucide-react';
import type { Theme } from '../../../../../types';
import { ToggleButtonGroup } from '../../../../ToggleButtonGroup';
import { SettingsSectionHeading } from '../../../SettingsSectionHeading';
import { ToggleSettingRow } from '../../DisplayTab/components/ToggleSettingRow';

type TabPlacement = 'end' | 'after-current';

interface TabBehaviorSectionProps {
	theme: Theme;
	automaticTabNamingEnabled: boolean;
	setAutomaticTabNamingEnabled: (enabled: boolean) => void;
	newTabPlacement: TabPlacement;
	setNewTabPlacement: (placement: TabPlacement) => void;
	newBrowserTabPlacement: TabPlacement;
	setNewBrowserTabPlacement: (placement: TabPlacement) => void;
	newTerminalPlacement: TabPlacement;
	setNewTerminalPlacement: (placement: TabPlacement) => void;
	openedFilePlacement: TabPlacement;
	setOpenedFilePlacement: (placement: TabPlacement) => void;
}

export function TabBehaviorSection({
	theme,
	automaticTabNamingEnabled,
	setAutomaticTabNamingEnabled,
	newTabPlacement,
	setNewTabPlacement,
	newBrowserTabPlacement,
	setNewBrowserTabPlacement,
	newTerminalPlacement,
	setNewTerminalPlacement,
	openedFilePlacement,
	setOpenedFilePlacement,
}: TabBehaviorSectionProps) {
	return (
		<div data-setting-id="general-tab-behavior">
			<SettingsSectionHeading icon={Tag}>Tab Behavior</SettingsSectionHeading>
			<div
				className="p-3 rounded border space-y-3"
				style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgMain }}
			>
				<ToggleSettingRow
					theme={theme}
					title={
						<span className="font-medium" style={{ color: theme.colors.textMain }}>
							Automatically name tabs based on first message
						</span>
					}
					description={
						<span style={{ color: theme.colors.textDim }}>
							When you send your first message to a new tab, an AI will analyze it and generate a
							descriptive tab name. The naming request runs in parallel and leaves no history.
						</span>
					}
					checked={automaticTabNamingEnabled}
					onChange={setAutomaticTabNamingEnabled}
					ariaLabel="Automatically name tabs based on first message"
					clickableRow
				/>

				<div>
					<div className="font-medium" style={{ color: theme.colors.textMain }}>
						New tab placement
					</div>
					<div className="text-xs opacity-50 mt-0.5 mb-2" style={{ color: theme.colors.textDim }}>
						Where new AI tabs appear in the tab bar.
					</div>
					<ToggleButtonGroup
						options={[
							{ value: 'end' as const, label: 'End of list' },
							{ value: 'after-current' as const, label: 'After current tab' },
						]}
						value={newTabPlacement}
						onChange={setNewTabPlacement}
						theme={theme}
					/>
				</div>

				<div>
					<div className="font-medium" style={{ color: theme.colors.textMain }}>
						New browser tab placement
					</div>
					<div className="text-xs opacity-50 mt-0.5 mb-2" style={{ color: theme.colors.textDim }}>
						Where new browser tabs appear in the tab bar.
					</div>
					<ToggleButtonGroup
						options={[
							{ value: 'end' as const, label: 'End of list' },
							{ value: 'after-current' as const, label: 'After current tab' },
						]}
						value={newBrowserTabPlacement}
						onChange={setNewBrowserTabPlacement}
						theme={theme}
					/>
				</div>

				<div>
					<div className="font-medium" style={{ color: theme.colors.textMain }}>
						New terminal placement
					</div>
					<div className="text-xs opacity-50 mt-0.5 mb-2" style={{ color: theme.colors.textDim }}>
						Where new terminal tabs appear in the tab bar.
					</div>
					<ToggleButtonGroup
						options={[
							{ value: 'end' as const, label: 'End of list' },
							{ value: 'after-current' as const, label: 'After current tab' },
						]}
						value={newTerminalPlacement}
						onChange={setNewTerminalPlacement}
						theme={theme}
					/>
				</div>

				<div>
					<div className="font-medium" style={{ color: theme.colors.textMain }}>
						Opened file placement
					</div>
					<div className="text-xs opacity-50 mt-0.5 mb-2" style={{ color: theme.colors.textDim }}>
						Where opened file preview tabs appear in the tab bar.
					</div>
					<ToggleButtonGroup
						options={[
							{ value: 'end' as const, label: 'End of list' },
							{ value: 'after-current' as const, label: 'After current tab' },
						]}
						value={openedFilePlacement}
						onChange={setOpenedFilePlacement}
						theme={theme}
					/>
				</div>
			</div>
		</div>
	);
}
