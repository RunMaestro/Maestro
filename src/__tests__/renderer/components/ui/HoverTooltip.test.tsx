/**
 * @file HoverTooltip.test.tsx
 * @description Tests for the portaled hover tooltip.
 *
 * The behavior under test is the `maxWidth` mode: a tooltip carrying a full
 * sentence has to wrap and stay inside the window, where the default single-line
 * mode would run a sentence off the edge of the screen.
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
	it('keeps a short label on one line by default', () => {
		const tip = open(
			<HoverTooltip theme={mockTheme} label="Short">
				<span>trigger</span>
			</HoverTooltip>
		);

		expect(tip.className).toContain('whitespace-nowrap');
		expect(tip.style.maxWidth).toBe('');
	});

	// A sentence-length label in nowrap mode becomes a ribbon as wide as the text,
	// which the viewport clamp can only slide around, not shrink.
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
