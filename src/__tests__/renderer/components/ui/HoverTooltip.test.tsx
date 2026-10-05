/**
 * @file HoverTooltip.test.tsx
 * @description Tests for the portaled hover tooltip.
 *
 * Every tooltip must remain inside the viewport. Callers may use `maxWidth`
 * to request a narrower wrapping boundary, but not to exceed the viewport cap.
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { HoverTooltip } from '../../../../renderer/components/ui/HoverTooltip';
import { mockTheme } from '../../../helpers/mockTheme';

function open(ui: React.ReactElement) {
	render(ui);
	fireEvent.mouseEnter(screen.getByText('trigger').parentElement!);
	return screen.getByRole('tooltip');
}

describe('HoverTooltip', () => {
	it('keeps every tooltip within the viewport by default', () => {
		const original = window.innerWidth;
		Object.defineProperty(window, 'innerWidth', { value: 200, configurable: true });
		try {
			const tip = open(
				<HoverTooltip
					theme={mockTheme}
					label="A default tooltip can contain enough text to exceed the available viewport width."
				>
					<span>trigger</span>
				</HoverTooltip>
			);

			expect(tip.className).not.toContain('whitespace-nowrap');
			expect(tip.style.maxWidth).toBe('184px');
		} finally {
			Object.defineProperty(window, 'innerWidth', { value: original, configurable: true });
		}
	});

	it('preserves the single-line label alignment and line height with a nonshrinking shortcut', () => {
		const tip = open(
			<HoverTooltip theme={mockTheme} label="Run" shortcut="Ctrl+Enter">
				<span>trigger</span>
			</HoverTooltip>
		);
		expect(tip.className).toContain('items-center');
		expect(tip.className).not.toContain('leading-snug');
		expect(screen.getByText('Ctrl+Enter').className).toContain('shrink-0');
	});

	// Sentence-length labels must wrap; position clamping alone cannot keep a
	// non-wrapping tooltip inside the viewport.
	it('wraps and caps its width when given a maxWidth', () => {
		const tip = open(
			<HoverTooltip
				theme={mockTheme}
				maxWidth={260}
				label="Mark that you checked this entry yourself. Entirely optional, and only a bookmark for your own review pass."
			>
				<span>trigger</span>
			</HoverTooltip>
		);

		expect(tip.className).not.toContain('whitespace-nowrap');
		expect(tip.style.maxWidth).toBe('260px');
	});

	it('never lets the cap exceed the window, so the clamp has room to work', () => {
		const original = window.innerWidth;
		Object.defineProperty(window, 'innerWidth', { value: 200, configurable: true });
		try {
			const tip = open(
				<HoverTooltip theme={mockTheme} maxWidth={600} label="A long explanatory sentence.">
					<span>trigger</span>
				</HoverTooltip>
			);
			// 200 minus the 8px viewport margin on each side.
			expect(tip.style.maxWidth).toBe('184px');
		} finally {
			Object.defineProperty(window, 'innerWidth', { value: original, configurable: true });
		}
	});
});
