/**
 * Tests for the BlockView design tokens - the fixed styling vocabulary agents
 * pick from. These pin the semantic-color -> theme mapping, the spacing scale,
 * alignment mapping, and the "presentation" type scale so a stray edit to the
 * one readability lever (TYPE) or a renamed theme slot is caught here.
 */
import { describe, it, expect } from 'vitest';
import {
	resolveBlockColor,
	resolveGap,
	resolveAlign,
	TYPE,
	GAP_PX,
} from '../../../../renderer/components/BlockView/tokens';
import { createMockTheme } from '../../../helpers/mockTheme';

const theme = createMockTheme();

describe('resolveBlockColor', () => {
	it('maps each semantic color to its theme slot', () => {
		expect(resolveBlockColor('success', theme)).toBe(theme.colors.success);
		expect(resolveBlockColor('warning', theme)).toBe(theme.colors.warning);
		expect(resolveBlockColor('error', theme)).toBe(theme.colors.error);
		expect(resolveBlockColor('neutral', theme)).toBe(theme.colors.textDim);
		expect(resolveBlockColor('accent', theme)).toBe(theme.colors.accent);
	});

	it('resolves orange to the fixed hex (no theme slot defines it)', () => {
		expect(resolveBlockColor('orange', theme)).toBe('#f97316');
	});

	it('falls back to the provided fallback, then accent, when color is undefined', () => {
		expect(resolveBlockColor(undefined, theme, '#123456')).toBe('#123456');
		expect(resolveBlockColor(undefined, theme)).toBe(theme.colors.accent);
	});
});

describe('resolveGap', () => {
	it('defaults an unspecified gap to md', () => {
		expect(resolveGap(undefined)).toBe(GAP_PX.md);
	});

	it('resolves each named gap to its px value', () => {
		expect(resolveGap('none')).toBe(0);
		expect(resolveGap('sm')).toBe(10);
		expect(resolveGap('md')).toBe(18);
		expect(resolveGap('lg')).toBe(28);
	});
});

describe('resolveAlign', () => {
	it('maps alignment names to CSS align-items values', () => {
		expect(resolveAlign('center')).toBe('center');
		expect(resolveAlign('end')).toBe('flex-end');
		expect(resolveAlign('start')).toBe('flex-start');
		expect(resolveAlign('stretch')).toBe('stretch');
		expect(resolveAlign(undefined)).toBe('stretch');
	});
});

describe('TYPE scale', () => {
	it('keeps body reading text at the presentation size', () => {
		expect(TYPE.body.fontSize).toBe(15);
		expect(TYPE.label.fontSize).toBe(14);
	});

	it('descends monotonically from display down to caption', () => {
		const order = [
			TYPE.display.fontSize,
			TYPE.title.fontSize,
			TYPE.heading.fontSize,
			TYPE.subheading.fontSize,
		];
		for (let i = 1; i < order.length; i++) {
			expect(order[i]).toBeLessThan(order[i - 1]);
		}
		expect(TYPE.caption.fontSize).toBeLessThan(TYPE.body.fontSize);
	});
});
