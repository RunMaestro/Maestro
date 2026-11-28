/**
 * BrowserViewportControl - the browser toolbar's picker for the width a tab
 * shows its page at (Fit, Desktop, Laptop, Tablet, Phone).
 *
 * One icon per preset, the way design tools offer device sizes, so the bar
 * costs the address field one small block of room. Each icon's tooltip says
 * what it is and how wide.
 */

import { Laptop, Maximize2, Monitor, Smartphone, Tablet } from 'lucide-react';
import { SegmentedControl, type SegmentedOption } from '../ui/SegmentedControl';
import {
	BROWSER_VIEWPORT_PRESETS,
	browserViewportLabel,
	describeBrowserViewport,
	type BrowserViewportPreset,
} from '../../../shared/browserViewport';
import type { Theme } from '../../types';

const ICON_CLASS = 'w-3.5 h-3.5';

const PRESET_ICONS: Record<BrowserViewportPreset, React.ReactNode> = {
	fit: <Maximize2 className={ICON_CLASS} />,
	desktop: <Monitor className={ICON_CLASS} />,
	laptop: <Laptop className={ICON_CLASS} />,
	tablet: <Tablet className={ICON_CLASS} />,
	phone: <Smartphone className={ICON_CLASS} />,
};

const OPTIONS: ReadonlyArray<SegmentedOption<BrowserViewportPreset>> = BROWSER_VIEWPORT_PRESETS.map(
	(preset) => ({
		value: preset,
		label: browserViewportLabel(preset),
		title: `Viewport: ${describeBrowserViewport(preset)}`,
		icon: PRESET_ICONS[preset],
	})
);

export const BROWSER_VIEWPORT_CONTROL_TEST_ID = 'browser-tab-viewport';

interface BrowserViewportControlProps {
	theme: Theme;
	value: BrowserViewportPreset;
	onChange: (preset: BrowserViewportPreset) => void;
}

export function BrowserViewportControl({ theme, value, onChange }: BrowserViewportControlProps) {
	return (
		// The address field is the one that gives way when the row is tight.
		<div className="shrink-0">
			<SegmentedControl
				value={value}
				onChange={onChange}
				options={OPTIONS}
				theme={theme}
				ariaLabel="Viewport width"
				testId={BROWSER_VIEWPORT_CONTROL_TEST_ID}
				iconOnly
			/>
		</div>
	);
}
