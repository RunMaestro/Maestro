/**
 * Tests for ToggleSwitch component
 *
 * Verifies RTL-aware toggle switch behavior using inset-inline-start
 * positioning instead of translateX, ensuring correct rendering and
 * automatic mirroring in both LTR and RTL layouts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { ToggleSwitch } from '../../../../renderer/components/ui/ToggleSwitch';
import type { Theme } from '../../../../renderer/types';

const mockTheme: Theme = {
	id: 'test-theme',
	name: 'Test Theme',
	mode: 'dark',
	colors: {
		bgMain: '#1a1a1a',
		bgSidebar: '#242424',
		bgActivity: '#2a2a2a',
		textMain: '#ffffff',
		textDim: '#888888',
		accent: '#3b82f6',
		accentForeground: '#ffffff',
		border: '#333333',
		error: '#ef4444',
		success: '#22c55e',
		warning: '#f59e0b',
		cursor: '#ffffff',
		terminalBg: '#1a1a1a',
	},
};

describe('ToggleSwitch', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe('rendering', () => {
		it('should render as a button when onChange is provided', () => {
			const onChange = vi.fn();
			render(
				<ToggleSwitch
					checked={false}
					onChange={onChange}
					theme={mockTheme}
					ariaLabel="Test toggle"
				/>
			);

			const button = screen.getByRole('switch');
			expect(button).toBeDefined();
			expect(button.tagName).toBe('BUTTON');
		});

		it('should render as a div when onChange is omitted', () => {
			const { container } = render(<ToggleSwitch checked={false} theme={mockTheme} />);

			expect(screen.queryByRole('switch')).toBeNull();
			const div = container.firstElementChild;
			expect(div?.tagName).toBe('DIV');
		});

		it('should set aria-checked matching checked prop', () => {
			const onChange = vi.fn();
			const { rerender } = render(
				<ToggleSwitch
					checked={false}
					onChange={onChange}
					theme={mockTheme}
					ariaLabel="Test toggle"
				/>
			);

			expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false');

			rerender(
				<ToggleSwitch
					checked={true}
					onChange={onChange}
					theme={mockTheme}
					ariaLabel="Test toggle"
				/>
			);

			expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true');
		});

		it('should apply ariaLabel to the button', () => {
			render(
				<ToggleSwitch
					checked={false}
					onChange={vi.fn()}
					theme={mockTheme}
					ariaLabel="Enable feature"
				/>
			);

			expect(screen.getByLabelText('Enable feature')).toBeDefined();
		});
	});

	describe('interaction', () => {
		it('should call onChange when clicked', () => {
			const onChange = vi.fn();
			render(
				<ToggleSwitch
					checked={false}
					onChange={onChange}
					theme={mockTheme}
					ariaLabel="Test toggle"
				/>
			);

			fireEvent.click(screen.getByRole('switch'));
			expect(onChange).toHaveBeenCalledTimes(1);
		});
	});

	describe('RTL positioning via inset-inline-start', () => {
		it('should use insetInlineStart for knob positioning (unchecked, md)', () => {
			const { container } = render(
				<ToggleSwitch checked={false} onChange={vi.fn()} theme={mockTheme} size="md" />
			);

			const knob = container.querySelector('span');
			expect(knob?.style.insetInlineStart).toBe('2px');
		});

		it('should use insetInlineStart for knob positioning (checked, md)', () => {
			const { container } = render(
				<ToggleSwitch checked={true} onChange={vi.fn()} theme={mockTheme} size="md" />
			);

			const knob = container.querySelector('span');
			expect(knob?.style.insetInlineStart).toBe('22px');
		});

		it('should use correct positions for sm size', () => {
			const { container, rerender } = render(
				<ToggleSwitch checked={false} onChange={vi.fn()} theme={mockTheme} size="sm" />
			);

			const knob = container.querySelector('span');
			expect(knob?.style.insetInlineStart).toBe('2px');

			rerender(<ToggleSwitch checked={true} onChange={vi.fn()} theme={mockTheme} size="sm" />);

			expect(knob?.style.insetInlineStart).toBe('18px');
		});

		it('should use correct positions for lg size', () => {
			const { container, rerender } = render(
				<ToggleSwitch checked={false} onChange={vi.fn()} theme={mockTheme} size="lg" />
			);

			const knob = container.querySelector('span');
			expect(knob?.style.insetInlineStart).toBe('4px');

			rerender(<ToggleSwitch checked={true} onChange={vi.fn()} theme={mockTheme} size="lg" />);

			expect(knob?.style.insetInlineStart).toBe('26px');
		});

		it('should not use translateX for knob positioning', () => {
			const { container } = render(
				<ToggleSwitch checked={true} onChange={vi.fn()} theme={mockTheme} />
			);

			const knob = container.querySelector('span');
			expect(knob?.style.transform).toBe('');
		});

		it('should have transition on inset-inline-start for animation', () => {
			const { container } = render(
				<ToggleSwitch checked={false} onChange={vi.fn()} theme={mockTheme} />
			);

			const knob = container.querySelector('span');
			expect(knob?.style.transition).toContain('inset-inline-start');
		});
	});

	describe('theming', () => {
		it('should use accent color when checked', () => {
			const { container } = render(
				<ToggleSwitch checked={true} onChange={vi.fn()} theme={mockTheme} />
			);

			const track = container.firstElementChild as HTMLElement;
			// JSDOM normalizes hex to rgb
			expect(track.style.backgroundColor).toBe('rgb(59, 130, 246)');
		});

		it('should use border color when unchecked', () => {
			const { container } = render(
				<ToggleSwitch checked={false} onChange={vi.fn()} theme={mockTheme} />
			);

			const track = container.firstElementChild as HTMLElement;
			expect(track.style.backgroundColor).toBe('rgb(51, 51, 51)');
		});

		it('should support custom activeColor', () => {
			const { container } = render(
				<ToggleSwitch checked={true} onChange={vi.fn()} theme={mockTheme} activeColor="#ff0000" />
			);

			const track = container.firstElementChild as HTMLElement;
			expect(track.style.backgroundColor).toBe('rgb(255, 0, 0)');
		});

		it('should support custom inactiveColor', () => {
			const { container } = render(
				<ToggleSwitch
					checked={false}
					onChange={vi.fn()}
					theme={mockTheme}
					inactiveColor="#00ff00"
				/>
			);

			const track = container.firstElementChild as HTMLElement;
			expect(track.style.backgroundColor).toBe('rgb(0, 255, 0)');
		});
	});

	describe('className', () => {
		it('should apply additional className to track element', () => {
			const { container } = render(
				<ToggleSwitch checked={false} onChange={vi.fn()} theme={mockTheme} className="opacity-50" />
			);

			const track = container.firstElementChild as HTMLElement;
			expect(track.className).toContain('opacity-50');
		});
	});
});
