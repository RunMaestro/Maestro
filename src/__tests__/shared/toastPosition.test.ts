import { describe, it, expect } from 'vitest';
import {
	DEFAULT_TOAST_POSITION,
	TOAST_POSITIONS,
	TOAST_POSITION_LABELS,
	describeToastPosition,
	isLeftToastPosition,
	isToastPosition,
	isTopToastPosition,
	toastSidePanel,
} from '../../shared/toastPosition';

describe('toastPosition', () => {
	it('defaults to the historical bottom-right corner', () => {
		expect(DEFAULT_TOAST_POSITION).toBe('bottom-right');
	});

	it('validates only the four corners', () => {
		for (const position of TOAST_POSITIONS) {
			expect(isToastPosition(position)).toBe(true);
		}
		expect(isToastPosition('center')).toBe(false);
		expect(isToastPosition(undefined)).toBe(false);
		expect(isToastPosition(3)).toBe(false);
	});

	it('labels every position', () => {
		for (const position of TOAST_POSITIONS) {
			expect(TOAST_POSITION_LABELS[position].length).toBeGreaterThan(0);
		}
	});

	it('classifies each corner by edge', () => {
		expect(isTopToastPosition('top-left')).toBe(true);
		expect(isTopToastPosition('top-right')).toBe(true);
		expect(isTopToastPosition('bottom-left')).toBe(false);
		expect(isTopToastPosition('bottom-right')).toBe(false);
		expect(isLeftToastPosition('top-left')).toBe(true);
		expect(isLeftToastPosition('bottom-left')).toBe(true);
		expect(isLeftToastPosition('top-right')).toBe(false);
		expect(isLeftToastPosition('bottom-right')).toBe(false);
	});

	it('picks the side bar on the toast side', () => {
		const widths = { leftSidebarWidth: 256, rightPanelWidth: 384 };
		expect(toastSidePanel('top-left', widths)).toEqual({ width: 256, name: 'Left Bar' });
		expect(toastSidePanel('bottom-left', widths)).toEqual({ width: 256, name: 'Left Bar' });
		expect(toastSidePanel('top-right', widths)).toEqual({ width: 384, name: 'Right Bar' });
		expect(toastSidePanel('bottom-right', widths)).toEqual({ width: 384, name: 'Right Bar' });
	});

	it('describes the stack direction for each edge', () => {
		expect(describeToastPosition('top-left')).toContain('downward');
		expect(describeToastPosition('bottom-right')).toContain('upward');
	});
});
