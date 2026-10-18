/**
 * ThroughputGaugeSettingsPopover - the gear menu on the Throughput Gauge.
 *
 * Every setting the Encore tile offers, one segmented row each, plus Reset peak,
 * so the user can retune the gauge without leaving it. The rows come from
 * `THROUGHPUT_GAUGE_SETTING_CONTROLS`, the same list the Encore tile and the CLI
 * read, and every change is validated by `applyThroughputGaugeSettingsPatch`.
 * A choice (or Reset peak) closes the popover: it covers the gauge it tunes, so
 * the result is only visible once it is gone.
 *
 * Portaled to the body because the card clips its own overflow. It grows away
 * from the screen edge the card sits nearest: the card opens parked
 * bottom-left, where a menu hanging below the gear would be clamped back over
 * the gear itself.
 *
 * Escape closes the popover and goes no further: a portal still propagates
 * through the React tree, so without stopping it here one press would also
 * reach the card's own Escape handling.
 */

import { memo, useCallback, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { RotateCcw } from 'lucide-react';

import {
	applyThroughputGaugeSettingsPatch,
	THROUGHPUT_GAUGE_SETTING_CONTROLS,
	type ThroughputGaugeSettingControl,
} from '../../../shared/throughputGauge';
import { EscCloseButton } from '../ui/EscCloseButton';
import { SegmentedControl } from '../ui/SegmentedControl';
import {
	useAnchoredMenuPosition,
	type AnchoredMenuPlacement,
} from '../../hooks/ui/useAnchoredMenuPosition';
import { useFocusOnMount } from '../../hooks/utils/useFocusAfterRender';
import { useEventListener } from '../../hooks/utils/useEventListener';
import { useSettingsStore } from '../../stores/settingsStore';
import { useThroughputGaugeStore } from '../../stores/throughputGaugeStore';
import type { Theme } from '../../types';

/** The segmented bar works in strings; the window option values are numbers. */
function segmentsFor(control: ThroughputGaugeSettingControl) {
	return control.options.map((option) => ({ value: String(option.value), label: option.label }));
}

/** Grow toward the roomier half of the screen. */
function placementFor(anchor: HTMLElement | null): AnchoredMenuPlacement {
	const rect = anchor?.getBoundingClientRect();
	return rect && rect.top > window.innerHeight / 2 ? 'above' : 'below';
}

interface ThroughputGaugeSettingsPopoverProps {
	theme: Theme;
	/** The gear button. Clicks on it count as inside, so it can toggle the popover. */
	anchorRef: RefObject<HTMLElement | null>;
	onClose: () => void;
}

export const ThroughputGaugeSettingsPopover = memo(function ThroughputGaugeSettingsPopover({
	theme,
	anchorRef,
	onClose,
}: ThroughputGaugeSettingsPopoverProps) {
	const menuRef = useRef<HTMLDivElement>(null);
	const settings = useSettingsStore((s) => s.throughputGaugeSettings);
	const setSettings = useSettingsStore((s) => s.setThroughputGaugeSettings);
	const resetPeak = useThroughputGaugeStore((s) => s.resetPeak);

	// Decided once, at open: flipping while open would jump the menu under the cursor.
	const [placement] = useState(() => placementFor(anchorRef.current));
	const { left, top, maxHeight, ready } = useAnchoredMenuPosition(menuRef, anchorRef, {
		placement,
		align: 'end',
	});

	// Take focus so Escape reaches this popover, not whatever had it before.
	useFocusOnMount(menuRef, 0);

	const choose = (control: ThroughputGaugeSettingControl, raw: string) => {
		const option = control.options.find((o) => String(o.value) === raw);
		if (!option) return;
		const result = applyThroughputGaugeSettingsPatch(settings, { [control.field]: option.value });
		if (!result.ok) return;
		setSettings(result.settings);
		onClose();
	};

	const handleResetPeak = () => {
		resetPeak();
		onClose();
	};

	const handleKeyDown = useCallback(
		(e: KeyboardEvent) => {
			if (e.key !== 'Escape' || e.metaKey || e.ctrlKey || e.altKey) return;
			e.preventDefault();
			e.stopPropagation();
			onClose();
		},
		[onClose]
	);

	// The popover is not a DOM descendant of the gear, so both count as inside.
	useEventListener(
		'mousedown',
		(e) => {
			const target = e.target as Node;
			if (menuRef.current?.contains(target) || anchorRef.current?.contains(target)) return;
			onClose();
		},
		{ target: document }
	);

	return createPortal(
		<div
			ref={menuRef}
			data-testid="throughput-gauge-settings"
			role="dialog"
			aria-label="Throughput gauge settings"
			tabIndex={-1}
			onKeyDown={handleKeyDown}
			// Above the card (60), far below modals so it never covers an overlay.
			className="fixed z-[100] w-64 p-2 rounded shadow-xl border overflow-y-auto select-none outline-none space-y-2"
			style={{
				left,
				top,
				maxHeight,
				opacity: ready ? 1 : 0,
				backgroundColor: theme.colors.bgActivity,
				borderColor: theme.colors.border,
			}}
		>
			<div className="flex items-center gap-2 pl-1">
				<span
					className="text-2xs uppercase tracking-wide flex-1"
					style={{ color: theme.colors.textDim }}
				>
					Gauge settings
				</span>
				<EscCloseButton
					theme={theme}
					onClose={onClose}
					label="Close gauge settings (Esc)"
					testId="throughput-gauge-settings-close"
				/>
			</div>

			{THROUGHPUT_GAUGE_SETTING_CONTROLS.map((control) => (
				<div key={control.field} className="space-y-1">
					<div className="text-xs pl-1" style={{ color: theme.colors.textDim }}>
						{control.label}
					</div>
					<SegmentedControl
						value={String(settings[control.field])}
						onChange={(raw) => choose(control, raw)}
						options={segmentsFor(control)}
						theme={theme}
						ariaLabel={`Gauge ${control.label.toLowerCase()}`}
						testId={`throughput-gauge-setting-${control.field}`}
					/>
				</div>
			))}

			<button
				type="button"
				onClick={handleResetPeak}
				className="w-full flex items-center justify-center gap-1.5 px-2 py-1 rounded border text-xs hover:opacity-80"
				style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
				data-testid="throughput-gauge-reset-peak"
			>
				<RotateCcw className="w-3 h-3" aria-hidden />
				Reset peak
			</button>
		</div>,
		document.body
	);
});
