// Source: src/__tests__/renderer/components/DocumentGraph/previewPaneSizing.test.ts
// Source: src/__tests__/renderer/components/DocumentGraph/previewCharLimit.test.ts
import { describe as describeSourceSuite } from 'vitest';
import { describe } from 'vitest';
import { expect } from 'vitest';
import { it } from 'vitest';
import { previewMaxWidthForContainer } from '../../../../renderer/components/DocumentGraph/previewPaneSizing';
import { PREVIEW_DEFAULT_WIDTH } from '../../../../renderer/components/DocumentGraph/previewPaneSizing';
import { PREVIEW_GRAPH_RESERVE } from '../../../../renderer/components/DocumentGraph/previewPaneSizing';
import { PREVIEW_MAX_WIDTH } from '../../../../renderer/components/DocumentGraph/previewPaneSizing';
import { PREVIEW_MIN_WIDTH } from '../../../../renderer/components/DocumentGraph/previewPaneSizing';
import { clampPreviewCharLimit } from '../../../../renderer/components/DocumentGraph/previewCharLimit';
import { formatPreviewCharLimit } from '../../../../renderer/components/DocumentGraph/previewCharLimit';
import { isPreviewOff } from '../../../../renderer/components/DocumentGraph/previewCharLimit';
import { nextPreviewCharLimit } from '../../../../renderer/components/DocumentGraph/previewCharLimit';
import { PREVIEW_CHAR_LIMIT_CYCLE } from '../../../../renderer/components/DocumentGraph/previewCharLimit';
import { PREVIEW_CHAR_LIMIT_MAX } from '../../../../renderer/components/DocumentGraph/previewCharLimit';
import { PREVIEW_CHAR_LIMIT_OFF } from '../../../../renderer/components/DocumentGraph/previewCharLimit';
describeSourceSuite('previewPaneSizing', () => {
	describe('previewPaneSizing', () => {
		it('keeps the default between the stored bounds', () => {
			expect(PREVIEW_DEFAULT_WIDTH).toBeGreaterThanOrEqual(PREVIEW_MIN_WIDTH);
			expect(PREVIEW_DEFAULT_WIDTH).toBeLessThanOrEqual(PREVIEW_MAX_WIDTH);
		});

		it('reserves a strip of graph beside the pane', () => {
			expect(previewMaxWidthForContainer(1000)).toBe(1000 - PREVIEW_GRAPH_RESERVE);
		});

		it('never returns less than the minimum, however narrow the container', () => {
			expect(previewMaxWidthForContainer(240)).toBe(PREVIEW_MIN_WIDTH);
			expect(previewMaxWidthForContainer(1)).toBe(PREVIEW_MIN_WIDTH);
		});

		it('caps at the stored maximum on a very wide container', () => {
			expect(previewMaxWidthForContainer(6000)).toBe(PREVIEW_MAX_WIDTH);
		});

		it('falls back to the stored maximum before the container is measured', () => {
			// A 0 width means the ResizeObserver has not reported yet. Clamping to the
			// minimum here would paint the remembered width narrow and then jump.
			expect(previewMaxWidthForContainer(0)).toBe(PREVIEW_MAX_WIDTH);
			expect(previewMaxWidthForContainer(Number.NaN)).toBe(PREVIEW_MAX_WIDTH);
		});
	});
});
describeSourceSuite('previewCharLimit', () => {
	describe('nextPreviewCharLimit', () => {
		it('lengthens the preview one stop per step', () => {
			expect(nextPreviewCharLimit(PREVIEW_CHAR_LIMIT_OFF)).toBe(50);
			expect(nextPreviewCharLimit(50)).toBe(100);
			expect(nextPreviewCharLimit(100)).toBe(200);
		});

		it('wraps from the longest preview back to Off', () => {
			expect(nextPreviewCharLimit(PREVIEW_CHAR_LIMIT_MAX)).toBe(PREVIEW_CHAR_LIMIT_OFF);
		});

		it('completes a full cycle back to where it started', () => {
			let limit = PREVIEW_CHAR_LIMIT_OFF;
			const seen = [limit];
			for (let i = 0; i < PREVIEW_CHAR_LIMIT_CYCLE.length - 1; i++) {
				limit = nextPreviewCharLimit(limit);
				seen.push(limit);
			}
			expect(seen).toEqual([...PREVIEW_CHAR_LIMIT_CYCLE]);
			expect(nextPreviewCharLimit(limit)).toBe(PREVIEW_CHAR_LIMIT_OFF);
		});

		it('advances a between-stops slider value forwards, not backwards', () => {
			// The slider steps by 50, so values the cycle does not list are reachable.
			expect(nextPreviewCharLimit(150)).toBe(200);
			expect(nextPreviewCharLimit(450)).toBe(500);
		});

		it('recovers from an out-of-range or non-numeric limit', () => {
			expect(nextPreviewCharLimit(-40)).toBe(50);
			expect(nextPreviewCharLimit(9999)).toBe(PREVIEW_CHAR_LIMIT_OFF);
			expect(nextPreviewCharLimit(Number.NaN)).toBe(PREVIEW_CHAR_LIMIT_OFF);
		});
	});

	describe('clampPreviewCharLimit', () => {
		it('keeps Off rather than treating 0 as a floor violation', () => {
			expect(clampPreviewCharLimit(0)).toBe(PREVIEW_CHAR_LIMIT_OFF);
			expect(clampPreviewCharLimit(-10)).toBe(PREVIEW_CHAR_LIMIT_OFF);
		});

		it('caps at the longest preview the slider offers', () => {
			expect(clampPreviewCharLimit(9999)).toBe(PREVIEW_CHAR_LIMIT_MAX);
			expect(clampPreviewCharLimit(250)).toBe(250);
		});
	});

	describe('isPreviewOff', () => {
		it('is true only at or below the sentinel', () => {
			expect(isPreviewOff(0)).toBe(true);
			expect(isPreviewOff(-1)).toBe(true);
			expect(isPreviewOff(50)).toBe(false);
			expect(isPreviewOff(Number.NaN)).toBe(true);
		});
	});

	describe('formatPreviewCharLimit', () => {
		it('names the sentinel rather than printing 0', () => {
			expect(formatPreviewCharLimit(PREVIEW_CHAR_LIMIT_OFF)).toBe('Off');
			expect(formatPreviewCharLimit(200)).toBe('200');
		});
	});
});
