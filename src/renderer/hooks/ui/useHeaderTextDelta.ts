/**
 * Correct the Left Bar header's width thresholds for the current interface font.
 *
 * Those thresholds ("show the wordmark at >= 232px", "show the OFFLINE label at
 * >= 256px") are pixel literals, measured when Maestro was always Roboto Mono at
 * a 14px root. The interface font is a user setting now, so a proportional face
 * at a larger root renders the same strings wider and the header's own labels
 * collide - which is what put the OFFLINE pill underneath the hamburger.
 *
 * Rather than re-deriving each threshold from scratch (which would need every
 * constant split into its icon/padding share and its text share, and would rot
 * again the next time the chrome moves), this measures only what actually
 * changed: how much wider each label is now than it was at the baseline. Each
 * threshold shifts by that delta. A threshold that was right at the baseline
 * stays right, for any font, at any size, at any zoom.
 */

import { useMemo } from 'react';
import { useSettingsStore } from '../../stores/settingsStore';
import { measureTextWidth } from '../../utils/measureTextWidth';
import { withMonoFallback, WORDMARK_FONT_STACK } from '../../../shared/fontStack';
import { resolveSurfaceFontSize } from '../../../shared/typography';

/**
 * The font the header's width constants were calibrated against: Maestro's
 * original interface font, at the 14px root it shipped with. Deliberately a
 * literal rather than a reference to the current default - it records history,
 * so changing the default must not silently re-baseline every threshold.
 */
const BASELINE_FONT_FAMILY = 'Roboto Mono, Menlo, "Courier New", monospace';
const BASELINE_ROOT_PX = 14;

/** The wordmark: `text-lg font-bold tracking-widest`. */
const WORDMARK_TEXT = 'MAESTRO';
const WORDMARK_SIZE_EM = 1.125; // text-lg
const WORDMARK_TRACKING_EM = 0.1; // tracking-widest

/**
 * The LIVE toggle's label. Measured with the wider of the two strings it can
 * hold: a threshold that only fits "LIVE" would let "OFFLINE" collide, and
 * OFFLINE is the state the app spends most of its time in.
 */
const LIVE_LABEL_TEXT = 'OFFLINE';
const LIVE_LABEL_SIZE_PX = 10; // text-[10px]

export interface HeaderTextDelta {
	/** Extra px the wordmark needs versus the baseline font. >= 0. */
	wordmark: number;
	/** Extra px the LIVE/OFFLINE label needs versus the baseline font. >= 0. */
	liveLabel: number;
}

function widthDelta(
	text: string,
	currentFont: string,
	baselineFont: string,
	currentSpacing: number,
	baselineSpacing: number
): number {
	const current = measureTextWidth(text, currentFont, currentSpacing);
	const baseline = measureTextWidth(text, baselineFont, baselineSpacing);
	// measureTextWidth returns 0 with no canvas (jsdom, a headless build). Both
	// readings are 0 there, so the delta is 0 and every caller keeps its original
	// constant - the pre-existing behaviour, rather than a collapsed header.
	if (current === 0 || baseline === 0) return 0;
	// Never negative. A narrower font could otherwise pull a threshold below the
	// chrome it also has to account for, showing a label that does not fit.
	return Math.max(0, current - baseline);
}

/**
 * How much wider the header's labels are in the current font than in the one
 * its thresholds were measured against. Add to a threshold to correct it.
 */
export function useHeaderTextDelta(): HeaderTextDelta {
	const fontFamily = useSettingsStore((s) => s.fontFamily);
	const fontSize = useSettingsStore((s) => s.fontSize);
	const fontZoom = useSettingsStore((s) => s.fontZoom);

	return useMemo(() => {
		// The thresholds compare against a sidebar width in real pixels, so the
		// measurement has to be in rendered pixels too - zoom included.
		const rootPx = resolveSurfaceFontSize(fontSize, fontSize, fontZoom);
		const family = withMonoFallback(fontFamily);

		const wordmarkPx = rootPx * WORDMARK_SIZE_EM;
		const baselineWordmarkPx = BASELINE_ROOT_PX * WORDMARK_SIZE_EM;

		return {
			// Measured in the BRAND font on both sides, not the interface font.
			// The wordmark is pinned to WORDMARK_FONT_STACK (see Wordmark.tsx), so
			// changing the interface font no longer changes its width - only the
			// root size does, since `text-lg` is a rem size. Measuring it against
			// the interface family would reserve header width for a widening that
			// cannot happen, and would hide the wordmark earlier than necessary.
			wordmark: widthDelta(
				WORDMARK_TEXT,
				`bold ${wordmarkPx}px ${WORDMARK_FONT_STACK}`,
				`bold ${baselineWordmarkPx}px ${WORDMARK_FONT_STACK}`,
				wordmarkPx * WORDMARK_TRACKING_EM,
				baselineWordmarkPx * WORDMARK_TRACKING_EM
			),
			liveLabel: widthDelta(
				LIVE_LABEL_TEXT,
				// This label is `text-[10px]`, an absolute size, so it does NOT grow
				// with the root - only the family changes it. Measured at the literal
				// size on both sides so the delta reflects only that.
				`bold ${LIVE_LABEL_SIZE_PX}px ${family}`,
				`bold ${LIVE_LABEL_SIZE_PX}px ${BASELINE_FONT_FAMILY}`,
				0,
				0
			),
		};
	}, [fontFamily, fontSize, fontZoom]);
}
