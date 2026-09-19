import { Tag } from 'lucide-react';
import type { Theme } from '../../../../../types';
import { ToggleButtonGroup } from '../../../../ToggleButtonGroup';
import { ToggleSwitch } from '../../../../ui/ToggleSwitch';
import { SettingsSectionHeading } from '../../../SettingsSectionHeading';

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
	filePreviewModeEnabled: boolean;
	setFilePreviewModeEnabled: (enabled: boolean) => void;
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
	filePreviewModeEnabled,
	setFilePreviewModeEnabled,
}: TabBehaviorSectionProps) {
	return (
		<div data-setting-id="general-tab-behavior">
			<SettingsSectionHeading icon={Tag}>Tab Behavior</SettingsSectionHeading>
			<div
				className="p-3 rounded border space-y-3"
				style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgMain }}
			>
				<div
					className="flex items-center justify-between cursor-pointer"
					onClick={() => setAutomaticTabNamingEnabled(!automaticTabNamingEnabled)}
					role="button"
					tabIndex={0}
					onKeyDown={(e) => {
						if (e.key === 'Enter' || e.key === ' ') {
							e.preventDefault();
							setAutomaticTabNamingEnabled(!automaticTabNamingEnabled);
						}
					}}
				>
					<div className="flex-1 pr-3">
						<div className="font-medium" style={{ color: theme.colors.textMain }}>
							Automatically name tabs based on first message
						</div>
						<div className="text-xs opacity-70 mt-0.5">
							When you send your first message to a new tab, an AI will analyze it and generate a
							descriptive tab name. The naming request runs in parallel and leaves no history.
						</div>
					</div>
					<ToggleSwitch
						checked={automaticTabNamingEnabled}
						onChange={setAutomaticTabNamingEnabled}
						theme={theme}
						ariaLabel="Automatically name tabs based on first message"
					/>
				</div>

				<div
					data-setting-id="general-file-preview-mode"
					className="flex items-center justify-between cursor-pointer"
					onClick={() => setFilePreviewModeEnabled(!filePreviewModeEnabled)}
					role="button"
					tabIndex={0}
					onKeyDown={(e) => {
						if (e.key === 'Enter' || e.key === ' ') {
							e.preventDefault();
							setFilePreviewModeEnabled(!filePreviewModeEnabled);
						}
					}}
				>
					<div className="flex-1 pr-3">
						<div className="font-medium" style={{ color: theme.colors.textMain }}>
							Single-click opens files in a preview tab
						</div>
						<div className="text-xs opacity-70 mt-0.5">
							Browse a codebase without collecting tabs: a single click in the file tree opens the
							file in one replaceable preview tab, shown in italics, and the next file you click
							reuses it. Double-click the file or its tab, or start editing, to keep the tab. Taps
							on a touchscreen always open a permanent tab.
						</div>
					</div>
					<ToggleSwitch
						checked={filePreviewModeEnabled}
						onChange={setFilePreviewModeEnabled}
						theme={theme}
						ariaLabel="Single-click opens files in a preview tab"
					/>
				</div>

				<div>
					<div className="font-medium" style={{ color: theme.colors.textMain }}>
						New tab placement
					</div>
					<div className="text-xs opacity-70 mt-0.5 mb-2">
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
					<div className="text-xs opacity-70 mt-0.5 mb-2">
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
					<div className="text-xs opacity-70 mt-0.5 mb-2">
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
					<div className="text-xs opacity-70 mt-0.5 mb-2">
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
