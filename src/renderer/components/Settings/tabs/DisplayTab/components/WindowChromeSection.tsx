import { AppWindow } from 'lucide-react';
import type { Theme } from '../../../../../types';
import { SettingsSectionHeading } from '../../../SettingsSectionHeading';
import { SectionCard } from './SectionCard';
import { ToggleSettingRow } from './ToggleSettingRow';

interface WindowChromeSectionProps {
	theme: Theme;
	useNativeTitleBar: boolean;
	setUseNativeTitleBar: (enabled: boolean) => void;
	autoHideMenuBar: boolean;
	setAutoHideMenuBar: (enabled: boolean) => void;
}

export function WindowChromeSection({
	theme,
	useNativeTitleBar,
	setUseNativeTitleBar,
	autoHideMenuBar,
	setAutoHideMenuBar,
}: WindowChromeSectionProps) {
	return (
		<div data-setting-id="display-window-chrome">
			<SettingsSectionHeading icon={AppWindow}>Window Chrome</SettingsSectionHeading>
			<SectionCard theme={theme}>
				<ToggleSettingRow
					theme={theme}
					title="Use native title bar"
					description="Use the OS native title bar instead of Maestro's custom title bar. Requires restart."
					checked={useNativeTitleBar}
					onChange={setUseNativeTitleBar}
				/>
				<ToggleSettingRow
					theme={theme}
					title="Auto-hide menu bar"
					description="Hide the application menu bar. Press Alt to toggle visibility. Applies to Windows and Linux. Requires restart."
					checked={autoHideMenuBar}
					onChange={setAutoHideMenuBar}
					borderTop
				/>
			</SectionCard>
		</div>
	);
}
