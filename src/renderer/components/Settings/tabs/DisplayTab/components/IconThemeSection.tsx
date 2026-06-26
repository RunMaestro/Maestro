import { Palette } from 'lucide-react';
import { ToggleButtonGroup } from '../../../../ToggleButtonGroup';
import type { Theme } from '../../../../../types';
import type { FileExplorerIconTheme } from '../../../../../utils/fileExplorerIcons/shared';
import { SettingsSectionHeading } from '../../../SettingsSectionHeading';

interface IconThemeSectionProps {
	theme: Theme;
	fileExplorerIconTheme: FileExplorerIconTheme;
	setFileExplorerIconTheme: (value: FileExplorerIconTheme) => void;
}

export function IconThemeSection({
	theme,
	fileExplorerIconTheme,
	setFileExplorerIconTheme,
}: IconThemeSectionProps) {
	return (
		<div data-setting-id="display-icon-theme">
			<SettingsSectionHeading icon={Palette}>Files Pane Icon Theme</SettingsSectionHeading>
			<ToggleButtonGroup
				options={[
					{ value: 'default', label: 'Default' },
					{ value: 'rich', label: 'Rich' },
				]}
				value={fileExplorerIconTheme}
				onChange={setFileExplorerIconTheme}
				theme={theme}
			/>
			<p className="text-xs opacity-50 mt-2">
				Rich uses Material Icon Theme style file and folder SVGs in the Files pane. Default
				preserves Maestro&apos;s current icon behavior.
			</p>
		</div>
	);
}
