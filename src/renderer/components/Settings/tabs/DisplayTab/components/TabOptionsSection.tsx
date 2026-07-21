import { ListFilter } from 'lucide-react';
import type { Theme } from '../../../../../types';
import { isMacOS } from '../../../../../../shared/platformDetection';
import { SettingsSectionHeading } from '../../../SettingsSectionHeading';
import { SectionCard } from './SectionCard';
import { ToggleSettingRow } from './ToggleSettingRow';

interface TabOptionsSectionProps {
	theme: Theme;
	showStarredInUnreadFilter: boolean;
	setShowStarredInUnreadFilter: (enabled: boolean) => void;
	showFilePreviewsInUnreadFilter: boolean;
	setShowFilePreviewsInUnreadFilter: (enabled: boolean) => void;
	useCmd0AsLastTab: boolean;
	setUseCmd0AsLastTab: (enabled: boolean) => void;
	showBrowserTabDomain: boolean;
	setShowBrowserTabDomain: (enabled: boolean) => void;
	tabBarWheelScroll: boolean;
	setTabBarWheelScroll: (enabled: boolean) => void;
}

export function TabOptionsSection({
	theme,
	showStarredInUnreadFilter,
	setShowStarredInUnreadFilter,
	showFilePreviewsInUnreadFilter,
	setShowFilePreviewsInUnreadFilter,
	useCmd0AsLastTab,
	setUseCmd0AsLastTab,
	showBrowserTabDomain,
	setShowBrowserTabDomain,
	tabBarWheelScroll,
	setTabBarWheelScroll,
}: TabOptionsSectionProps) {
	const shortcutPrefix = isMacOS() ? 'Command' : 'Ctrl';

	return (
		<div data-setting-id="display-tab-filtering">
			<SettingsSectionHeading icon={ListFilter}>Tab Options</SettingsSectionHeading>
			<SectionCard theme={theme}>
				<ToggleSettingRow
					theme={theme}
					title="Show starred tabs when filtering by unread"
					description="When the unread filter is active, starred tabs remain visible even if they have no unread messages."
					checked={showStarredInUnreadFilter}
					onChange={setShowStarredInUnreadFilter}
					ariaLabel="Show starred tabs when filtering by unread"
				/>
				<ToggleSettingRow
					theme={theme}
					title="Show file preview tabs when filtering by unread"
					description="When the unread filter is active, file preview tabs remain visible instead of being hidden."
					checked={showFilePreviewsInUnreadFilter}
					onChange={setShowFilePreviewsInUnreadFilter}
					ariaLabel="Show file preview tabs when filtering by unread"
					borderTop
				/>
				<ToggleSettingRow
					theme={theme}
					title={`Treat ${shortcutPrefix}+0 as the last tab`}
					description={
						<>
							Maestro-style: {shortcutPrefix}+1-9 jump to tabs 1-9, and {shortcutPrefix}+0 jumps to
							the last tab. Disable to use browser-style: {shortcutPrefix}+1-8 jump to tabs 1-8, and{' '}
							{shortcutPrefix}+9 jumps to the last tab.
						</>
					}
					checked={useCmd0AsLastTab}
					onChange={setUseCmd0AsLastTab}
					ariaLabel={`Treat ${shortcutPrefix}+0 as the last tab`}
					borderTop
				/>
				<ToggleSettingRow
					theme={theme}
					title="Show domain on browser tabs"
					description="Display a small domain pill (e.g. www.google.com) next to the page title on browser tabs. Disable to hide it."
					checked={showBrowserTabDomain}
					onChange={setShowBrowserTabDomain}
					ariaLabel="Show domain on browser tabs"
					borderTop
				/>
				<ToggleSettingRow
					theme={theme}
					title="Scroll tabs with the mouse wheel"
					description="When the tab strip overflows, hover over it and scroll the mouse wheel to pan the tabs left and right. Disable to stop translating vertical wheel movement into tab scrolling; native horizontal gestures like trackpad swipes are unaffected."
					checked={tabBarWheelScroll}
					onChange={setTabBarWheelScroll}
					ariaLabel="Scroll tabs with the mouse wheel"
					borderTop
				/>
			</SectionCard>
		</div>
	);
}
