import { describe, it, expect } from 'vitest';
import {
	PILL_DENSITIES,
	COMPACT_PRIOR_INDEX,
	pillRowWidthPx,
	resolvePillDensity,
} from '../../../../renderer/components/History/historyPillDensity';
import { RIGHT_PANEL_PILL_FONT_REM } from '../../../../renderer/constants/rightPanel';

/**
 * Measured label widths are the one input a test cannot get from jsdom, which
 * has no layout engine. These stand in for "all four labels rendered together
 * at the base size": roughly 16 uppercase characters of a proportional bold
 * face at a 9px em, which is what the pills render at a 16px root.
 */
const FOUR_LABELS_PX = 92;
const REM_PX = 16;

describe('historyPillDensity', () => {
	describe('the ladder itself', () => {
		it('gives up the icon before it gives up type size', () => {
			// The icon repeats what the pill already spells out in words, so it is
			// the only thing here that can go without costing the user information.
			const firstIconless = PILL_DENSITIES.findIndex((d) => !d.icon);
			const firstSmaller = PILL_DENSITIES.findIndex((d) => d.fontRem < RIGHT_PANEL_PILL_FONT_REM);
			expect(firstIconless).toBeGreaterThan(-1);
			expect(firstSmaller).toBeGreaterThan(firstIconless);
		});

		it('never widens as it descends', () => {
			// A rung that needed more room than the one above it would make the
			// search be monotonic in name only.
			const widths = PILL_DENSITIES.map((d) => pillRowWidthPx(d, FOUR_LABELS_PX, 4, REM_PX));
			for (let i = 1; i < widths.length; i++) {
				expect(widths[i]).toBeLessThan(widths[i - 1]);
			}
		});

		it('sizes every rung in rem, so Cmd+= still scales the pills', () => {
			// A rung that froze a pixel size would stop responding to zoom while
			// everything around it kept growing.
			for (const d of PILL_DENSITIES) {
				expect(d.fontRem).toBeGreaterThan(0);
				expect(d.padXRem).toBeGreaterThan(0);
			}
		});

		it('keeps the bottom rung readable', () => {
			// The ladder buys room, it does not buy it at any price.
			const smallest = PILL_DENSITIES[PILL_DENSITIES.length - 1].fontRem;
			expect(smallest).toBeGreaterThanOrEqual(RIGHT_PANEL_PILL_FONT_REM * 0.75);
		});
	});

	describe('picking a rung', () => {
		it('uses the full-size rung when the row has room', () => {
			expect(
				resolvePillDensity({
					availableWidth: 600,
					labelsWidth: FOUR_LABELS_PX,
					count: 4,
					remPx: REM_PX,
					compact: false,
					enabled: true,
				})
			).toBe(PILL_DENSITIES[0]);
		});

		it('steps down rather than overflowing when the row is squeezed', () => {
			// This is the reported bug: at this width the full-size row does not
			// fit, and the overflow used to cut the search and help buttons off the
			// ends of a centred row.
			const full = pillRowWidthPx(PILL_DENSITIES[0], FOUR_LABELS_PX, 4, REM_PX);
			const chosen = resolvePillDensity({
				availableWidth: full - 20,
				labelsWidth: FOUR_LABELS_PX,
				count: 4,
				remPx: REM_PX,
				compact: false,
				enabled: true,
			});
			expect(chosen).not.toBe(PILL_DENSITIES[0]);
			expect(pillRowWidthPx(chosen, FOUR_LABELS_PX, 4, REM_PX)).toBeLessThanOrEqual(full - 20);
		});

		it('goes no further than it has to', () => {
			// Stepping straight to the smallest rung whenever anything overflows
			// would shrink the pills far more than the panel actually asked for.
			const second = pillRowWidthPx(PILL_DENSITIES[1], FOUR_LABELS_PX, 4, REM_PX);
			expect(
				resolvePillDensity({
					availableWidth: second + 2,
					labelsWidth: FOUR_LABELS_PX,
					count: 4,
					remPx: REM_PX,
					compact: false,
					enabled: true,
				})
			).toBe(PILL_DENSITIES[1]);
		});

		it('fits four pills at the narrowest panel the resize handle allows', () => {
			// RIGHT_PANEL_MIN_WIDTH is 360; the row also carries two 32px buttons
			// and their gaps, and the panel has its own horizontal padding.
			const available = 360 - 24 - 32 * 2 - 12 * 2;
			const chosen = resolvePillDensity({
				availableWidth: available,
				labelsWidth: FOUR_LABELS_PX,
				count: 4,
				remPx: REM_PX,
				compact: false,
				enabled: true,
			});
			expect(pillRowWidthPx(chosen, FOUR_LABELS_PX, 4, REM_PX)).toBeLessThanOrEqual(available);
		});

		it('needs less room with Cue off, because that is one pill fewer', () => {
			// The count is exactly what a static width threshold could not see.
			const four = pillRowWidthPx(PILL_DENSITIES[0], FOUR_LABELS_PX, 4, REM_PX);
			const three = pillRowWidthPx(PILL_DENSITIES[0], FOUR_LABELS_PX * 0.8, 3, REM_PX);
			expect(three).toBeLessThan(four);
		});

		it('needs more room at a larger interface font, at the same panel width', () => {
			// The other thing the threshold could not see. Same 420px panel, two
			// different answers.
			const atFifteen = resolvePillDensity({
				availableWidth: 240,
				labelsWidth: 86,
				count: 4,
				remPx: 15,
				compact: false,
				enabled: true,
			});
			const atTwenty = resolvePillDensity({
				availableWidth: 240,
				labelsWidth: 115,
				count: 4,
				remPx: 20,
				compact: false,
				enabled: true,
			});
			expect(PILL_DENSITIES.indexOf(atTwenty)).toBeGreaterThan(PILL_DENSITIES.indexOf(atFifteen));
		});

		it('falls back to the bottom rung when even that overflows', () => {
			// Better a clipped pill than a clipped control; the row's
			// overflow-hidden decides which one gets cut.
			expect(
				resolvePillDensity({
					availableWidth: 10,
					labelsWidth: FOUR_LABELS_PX,
					count: 4,
					remPx: REM_PX,
					compact: false,
					enabled: true,
				})
			).toBe(PILL_DENSITIES[PILL_DENSITIES.length - 1]);
		});
	});

	describe('before the measurements land', () => {
		it("uses the caller's compact prediction while width is still 0", () => {
			// useElementWidth reports 0 until its first observation, so the very
			// first paint has nothing to measure against.
			expect(
				resolvePillDensity({
					availableWidth: 0,
					labelsWidth: 0,
					count: 4,
					remPx: REM_PX,
					compact: true,
					enabled: true,
				})
			).toBe(PILL_DENSITIES[COMPACT_PRIOR_INDEX]);
		});

		it('assumes full size when the caller predicts a wide panel', () => {
			expect(
				resolvePillDensity({
					availableWidth: 0,
					labelsWidth: 0,
					count: 4,
					remPx: REM_PX,
					compact: false,
					enabled: true,
				})
			).toBe(PILL_DENSITIES[0]);
		});

		it('ignores a stale available width when only the labels are unmeasured', () => {
			// Both halves of the comparison have to be real, or the row would pick
			// a rung from an available width and a label width of zero - which
			// always fits, and always at full size.
			expect(
				resolvePillDensity({
					availableWidth: 40,
					labelsWidth: 0,
					count: 4,
					remPx: REM_PX,
					compact: true,
					enabled: true,
				})
			).toBe(PILL_DENSITIES[COMPACT_PRIOR_INDEX]);
		});

		it('leaves the ladder alone when the row does not own the leftover width', () => {
			// A flex-shrink-0 row measures its own natural width, which says nothing
			// about whether its neighbours still fit.
			expect(
				resolvePillDensity({
					availableWidth: 40,
					labelsWidth: FOUR_LABELS_PX,
					count: 4,
					remPx: REM_PX,
					compact: false,
					enabled: false,
				})
			).toBe(PILL_DENSITIES[0]);
		});
	});
});
