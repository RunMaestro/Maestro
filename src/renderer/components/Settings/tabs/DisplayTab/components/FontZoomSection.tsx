import { ZoomIn } from 'lucide-react';
import type { Theme } from '../../../../../types';
import { SettingsSectionHeading } from '../../../SettingsSectionHeading';
import { ToggleButtonGroup } from '../../../../ToggleButtonGroup';
import { formatShortcutKeys } from '../../../../../utils/shortcutFormatter';
import { FONT_ZOOM_DEFAULT } from '../../../../../../shared/typography';

interface FontZoomSectionProps {
	theme: Theme;
	fontZoom: number;
	setFontZoom: (value: number) => void;
}

/**
 * Global zoom - a multiplier over every surface size at once.
 *
 * Distinct from the per-surface sizes above it, and the distinction is the
 * point: those describe the relationship BETWEEN surfaces (a 13px terminal
 * beside a 15px chat), while this scales the whole set without disturbing that
 * relationship. Bundling them into one number is what the old single global
 * font size did, and it is why a user could not have both.
 *
 * Presets rather than a stepper because zoom is a coarse accommodation - the
 * fine resolution belongs to the per-surface sizes.
 */
export function FontZoomSection({ theme, fontZoom, setFontZoom }: FontZoomSectionProps) {
	const zoomIn = formatShortcutKeys(['Meta', '=']);
	const zoomOut = formatShortcutKeys(['Meta', '-']);
	const zoomReset = formatShortcutKeys(['Meta', 'Shift', '0']);

	return (
		<div data-setting-id="display-font-zoom">
			<SettingsSectionHeading icon={ZoomIn}>Zoom</SettingsSectionHeading>
			<p className="text-xs opacity-70 mb-2 -mt-1">
				Scales every surface above by the same amount, so the sizes you set relative to each other
				stay that way. {zoomIn} / {zoomOut} to adjust, {zoomReset} to reset.
			</p>
			<ToggleButtonGroup
				options={[
					{ value: 0.8, label: '80%' },
					{ value: 0.9, label: '90%' },
					{ value: FONT_ZOOM_DEFAULT, label: '100%' },
					{ value: 1.1, label: '110%' },
					{ value: 1.25, label: '125%' },
					{ value: 1.5, label: '150%' },
				]}
				value={fontZoom}
				onChange={setFontZoom}
				theme={theme}
			/>
		</div>
	);
}
