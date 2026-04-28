import { describe, it, expect } from 'vitest';

import { MAIN_MIN_WIDTH, applyMainMinWidthGuard, getPanelMode } from '../panelModes';

describe('getPanelMode', () => {
	describe('phone tier', () => {
		it('puts both panels in overlay regardless of open state', () => {
			expect(getPanelMode('phone', false, false)).toEqual({
				leftMode: 'overlay',
				rightMode: 'overlay',
			});
			expect(getPanelMode('phone', true, false)).toEqual({
				leftMode: 'overlay',
				rightMode: 'overlay',
			});
			expect(getPanelMode('phone', false, true)).toEqual({
				leftMode: 'overlay',
				rightMode: 'overlay',
			});
			expect(getPanelMode('phone', true, true)).toEqual({
				leftMode: 'overlay',
				rightMode: 'overlay',
			});
		});
	});

	describe('desktop tier', () => {
		it('puts both panels inline regardless of open state', () => {
			expect(getPanelMode('desktop', false, false)).toEqual({
				leftMode: 'inline',
				rightMode: 'inline',
			});
			expect(getPanelMode('desktop', true, false)).toEqual({
				leftMode: 'inline',
				rightMode: 'inline',
			});
			expect(getPanelMode('desktop', false, true)).toEqual({
				leftMode: 'inline',
				rightMode: 'inline',
			});
			expect(getPanelMode('desktop', true, true)).toEqual({
				leftMode: 'inline',
				rightMode: 'inline',
			});
		});
	});

	describe('tablet tier', () => {
		it('prefers left inline and right overlay when both panels are open', () => {
			expect(getPanelMode('tablet', true, true)).toEqual({
				leftMode: 'inline',
				rightMode: 'overlay',
			});
		});

		it('gives the inline slot to the right panel when only it is open', () => {
			expect(getPanelMode('tablet', false, true)).toEqual({
				leftMode: 'overlay',
				rightMode: 'inline',
			});
		});

		it('gives the inline slot to the left panel when only it is open', () => {
			expect(getPanelMode('tablet', true, false)).toEqual({
				leftMode: 'inline',
				rightMode: 'overlay',
			});
		});

		it('defaults to left inline / right overlay when neither panel is open', () => {
			expect(getPanelMode('tablet', false, false)).toEqual({
				leftMode: 'inline',
				rightMode: 'overlay',
			});
		});
	});
});

describe('applyMainMinWidthGuard', () => {
	const base = { leftInlineWidth: 240, rightInlineWidth: 320 } as const;

	it('returns modes unchanged when main would stay at or above the floor', () => {
		// viewport 1200 - 240 (left inline) - 320 (right inline) = 640 >= 420
		const result = applyMainMinWidthGuard(
			{ leftMode: 'inline', rightMode: 'inline' },
			{ ...base, viewportWidth: 1200, mostRecentlyOpened: null }
		);
		expect(result).toEqual({ leftMode: 'inline', rightMode: 'inline' });
	});

	it('leaves overlay modes alone when nothing is inline', () => {
		const result = applyMainMinWidthGuard(
			{ leftMode: 'overlay', rightMode: 'overlay' },
			{ ...base, viewportWidth: 200, mostRecentlyOpened: 'left' }
		);
		expect(result).toEqual({ leftMode: 'overlay', rightMode: 'overlay' });
	});

	it('demotes the most-recently-opened panel first when both are inline and main is squeezed', () => {
		// viewport 960 - 240 - 320 = 400 < 420; MRO=right -> right becomes overlay.
		const result = applyMainMinWidthGuard(
			{ leftMode: 'inline', rightMode: 'inline' },
			{ ...base, viewportWidth: 960, mostRecentlyOpened: 'right' }
		);
		expect(result).toEqual({ leftMode: 'inline', rightMode: 'overlay' });
	});

	it('demotes the left panel when it is the most-recently-opened', () => {
		const result = applyMainMinWidthGuard(
			{ leftMode: 'inline', rightMode: 'inline' },
			{ ...base, viewportWidth: 960, mostRecentlyOpened: 'left' }
		);
		expect(result).toEqual({ leftMode: 'overlay', rightMode: 'inline' });
	});

	it('falls back to demoting the right panel when recency is null', () => {
		const result = applyMainMinWidthGuard(
			{ leftMode: 'inline', rightMode: 'inline' },
			{ ...base, viewportWidth: 960, mostRecentlyOpened: null }
		);
		expect(result).toEqual({ leftMode: 'inline', rightMode: 'overlay' });
	});

	it('demotes the single inline panel when only one is inline and still squeezed', () => {
		// viewport 600 - 240 = 360 < 420; left inline / right overlay → left overlay.
		const result = applyMainMinWidthGuard(
			{ leftMode: 'inline', rightMode: 'overlay' },
			{ ...base, viewportWidth: 600, mostRecentlyOpened: 'left' }
		);
		expect(result).toEqual({ leftMode: 'overlay', rightMode: 'overlay' });
	});

	it('cascades: demotes the other inline panel when one demotion is not enough', () => {
		// viewport 500 - 240 - 320 = -60. Demote MRO=right → main = 260, still < 420.
		// Cascade demotes the left panel too.
		const result = applyMainMinWidthGuard(
			{ leftMode: 'inline', rightMode: 'inline' },
			{ ...base, viewportWidth: 500, mostRecentlyOpened: 'right' }
		);
		expect(result).toEqual({ leftMode: 'overlay', rightMode: 'overlay' });
	});

	it('honors the minMainWidth override', () => {
		// viewport 800 - 240 - 320 = 240 >= 200 (custom floor) → no change.
		const result = applyMainMinWidthGuard(
			{ leftMode: 'inline', rightMode: 'inline' },
			{ ...base, viewportWidth: 800, mostRecentlyOpened: null, minMainWidth: 200 }
		);
		expect(result).toEqual({ leftMode: 'inline', rightMode: 'inline' });
	});

	it('ignores MRO hints that point at a panel that is already overlay', () => {
		// MRO=left but left is already overlay → fall through to right demotion.
		const result = applyMainMinWidthGuard(
			{ leftMode: 'overlay', rightMode: 'inline' },
			{ ...base, viewportWidth: 600, mostRecentlyOpened: 'left' }
		);
		expect(result).toEqual({ leftMode: 'overlay', rightMode: 'overlay' });
	});

	it('MAIN_MIN_WIDTH is 420', () => {
		expect(MAIN_MIN_WIDTH).toBe(420);
	});
});
