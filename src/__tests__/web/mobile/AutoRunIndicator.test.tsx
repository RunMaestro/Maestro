/**
 * Tests for AutoRunIndicator component
 *
 * @file src/web/mobile/AutoRunIndicator.tsx
 *
 * Tests the AutoRun banner component that displays task progress
 * when batch processing is active on the desktop app.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { AutoRunIndicator } from '../../../web/mobile/AutoRunIndicator';
import type { AutoRunState } from '../../../web/hooks/useWebSocket';

// Mock the ThemeProvider hook
vi.mock('../../../web/components/ThemeProvider', () => ({
	useThemeColors: () => ({
		bgMain: '#0b0b0d',
		bgSidebar: '#111113',
		bgActivity: '#1c1c1f',
		border: '#27272a',
		textMain: '#e4e4e7',
		textDim: '#a1a1aa',
		accent: '#6366f1',
		accentDim: 'rgba(99, 102, 241, 0.2)',
		accentText: '#a5b4fc',
		success: '#22c55e',
		warning: '#eab308',
		error: '#ef4444',
	}),
}));

describe('AutoRunIndicator', () => {
	// Helper to create a valid AutoRunState
	const createAutoRunState = (overrides: Partial<AutoRunState> = {}): AutoRunState => ({
		isRunning: true,
		totalTasks: 10,
		completedTasks: 3,
		currentTaskIndex: 3,
		isStopping: false,
		...overrides,
	});

	describe('render conditions', () => {
		it('returns null when state is null', () => {
			const { container } = render(<AutoRunIndicator state={null} />);
			expect(container.firstChild).toBeNull();
		});

		it('returns null when state is undefined', () => {
			const { container } = render(
				<AutoRunIndicator state={undefined as unknown as AutoRunState} />
			);
			expect(container.firstChild).toBeNull();
		});

		it('returns null when isRunning is false', () => {
			const state = createAutoRunState({ isRunning: false });
			const { container } = render(<AutoRunIndicator state={state} />);
			expect(container.firstChild).toBeNull();
		});

		it('renders when isRunning is true', () => {
			const state = createAutoRunState();
			const { container } = render(<AutoRunIndicator state={state} />);
			expect(container.firstChild).not.toBeNull();
		});

		it('renders with minimal valid state', () => {
			const state: AutoRunState = {
				isRunning: true,
				totalTasks: 1,
				completedTasks: 0,
				currentTaskIndex: 0,
				isStopping: false,
			};
			render(<AutoRunIndicator state={state} />);
			expect(screen.getByText('AutoRun Active')).toBeInTheDocument();
		});
	});

	describe('progress calculation', () => {
		it('calculates progress as 0 when totalTasks is 0', () => {
			const state = createAutoRunState({ totalTasks: 0, completedTasks: 0 });
			render(<AutoRunIndicator state={state} />);
			expect(screen.getByText('0%')).toBeInTheDocument();
		});

		it('calculates progress percentage correctly', () => {
			const state = createAutoRunState({ totalTasks: 10, completedTasks: 5 });
			render(<AutoRunIndicator state={state} />);
			expect(screen.getByText('50%')).toBeInTheDocument();
		});

		it('rounds progress to nearest integer', () => {
			const state = createAutoRunState({ totalTasks: 3, completedTasks: 1 });
			render(<AutoRunIndicator state={state} />);
			// 1/3 = 33.33... rounds to 33
			expect(screen.getByText('33%')).toBeInTheDocument();
		});

		it('shows 100% when all tasks completed', () => {
			const state = createAutoRunState({ totalTasks: 5, completedTasks: 5 });
			render(<AutoRunIndicator state={state} />);
			expect(screen.getByText('100%')).toBeInTheDocument();
		});

		it('shows 0% when no tasks completed', () => {
			const state = createAutoRunState({ totalTasks: 10, completedTasks: 0 });
			render(<AutoRunIndicator state={state} />);
			expect(screen.getByText('0%')).toBeInTheDocument();
		});

		it('handles single task progress', () => {
			const state = createAutoRunState({ totalTasks: 1, completedTasks: 1 });
			render(<AutoRunIndicator state={state} />);
			expect(screen.getByText('100%')).toBeInTheDocument();
		});

		it('handles large task counts', () => {
			const state = createAutoRunState({ totalTasks: 1000, completedTasks: 750 });
			render(<AutoRunIndicator state={state} />);
			expect(screen.getByText('75%')).toBeInTheDocument();
		});
	});

	describe('current task display', () => {
		it('shows current task as 1-indexed', () => {
			const state = createAutoRunState({ currentTaskIndex: 0, totalTasks: 5 });
			render(<AutoRunIndicator state={state} />);
			expect(screen.getByText(/Task 1 of 5/)).toBeInTheDocument();
		});

		it('shows correct task number for middle task', () => {
			const state = createAutoRunState({ currentTaskIndex: 4, totalTasks: 10 });
			render(<AutoRunIndicator state={state} />);
			expect(screen.getByText(/Task 5 of 10/)).toBeInTheDocument();
		});

		it('shows last task correctly', () => {
			const state = createAutoRunState({ currentTaskIndex: 9, totalTasks: 10 });
			render(<AutoRunIndicator state={state} />);
			expect(screen.getByText(/Task 10 of 10/)).toBeInTheDocument();
		});
	});

	describe('completed tasks count', () => {
		it('does not show "(X done)" when completedTasks is 0', () => {
			const state = createAutoRunState({ completedTasks: 0 });
			render(<AutoRunIndicator state={state} />);
			expect(screen.queryByText(/done/)).toBeNull();
		});

		it('shows "(1 done)" when 1 task completed', () => {
			const state = createAutoRunState({ completedTasks: 1 });
			render(<AutoRunIndicator state={state} />);
			expect(screen.getByText(/\(1 done\)/)).toBeInTheDocument();
		});

		it('shows "(N done)" for multiple completed tasks', () => {
			const state = createAutoRunState({ completedTasks: 7 });
			render(<AutoRunIndicator state={state} />);
			expect(screen.getByText(/\(7 done\)/)).toBeInTheDocument();
		});
	});

	describe('session name', () => {
		it('does not show session name when not provided', () => {
			const state = createAutoRunState();
			render(<AutoRunIndicator state={state} />);
			// Should just have "Task X of Y" without any prefix
			const taskInfo = screen.getByText(/Task \d+ of \d+/);
			expect(taskInfo.textContent).not.toContain(' - ');
		});

		it('shows session name when provided', () => {
			const state = createAutoRunState();
			const { container } = render(<AutoRunIndicator state={state} sessionName="My Project" />);
			// Session name is in a span element with " - " suffix
			const span = container.querySelector('span');
			expect(span).not.toBeNull();
			expect(span?.textContent).toContain('My Project');
			expect(span?.textContent).toContain(' - ');
		});

		it('handles empty string session name', () => {
			const state = createAutoRunState();
			const { container } = render(<AutoRunIndicator state={state} sessionName="" />);
			// Empty string should not render - no span element
			const span = container.querySelector('span');
			expect(span).toBeNull();
		});

		it('handles session name with special characters', () => {
			const state = createAutoRunState();
			const specialName = 'Project <test> & "stuff"';
			const { container } = render(<AutoRunIndicator state={state} sessionName={specialName} />);
			const span = container.querySelector('span');
			expect(span?.textContent).toContain(specialName);
		});

		it('handles long session names', () => {
			const state = createAutoRunState();
			const longName = 'A'.repeat(100);
			const { container } = render(<AutoRunIndicator state={state} sessionName={longName} />);
			const span = container.querySelector('span');
			expect(span?.textContent).toContain(longName);
		});
	});

	describe('active vs stopping state', () => {
		describe('active state (isStopping = false)', () => {
			it('shows "AutoRun Active" text', () => {
				const state = createAutoRunState({ isStopping: false });
				render(<AutoRunIndicator state={state} />);
				expect(screen.getByText('AutoRun Active')).toBeInTheDocument();
			});

			it('uses accent color for background', () => {
				const state = createAutoRunState({ isStopping: false });
				const { container } = render(<AutoRunIndicator state={state} />);
				const banner = container.firstChild as HTMLElement;
				expect(banner.style.backgroundColor).toBe('rgb(99, 102, 241)'); // accent color
			});

			it('renders play icon (polygon)', () => {
				const state = createAutoRunState({ isStopping: false });
				const { container } = render(<AutoRunIndicator state={state} />);
				const polygon = container.querySelector('polygon');
				expect(polygon).not.toBeNull();
				expect(polygon?.getAttribute('points')).toBe('5,3 19,12 5,21');
			});

			it('uses accent color for progress badge text', () => {
				const state = createAutoRunState({ isStopping: false });
				const { container } = render(<AutoRunIndicator state={state} />);
				const badge = screen.getByText(/\d+%/);
				expect(badge.style.color).toBe('rgb(99, 102, 241)'); // accent color
			});
		});

		describe('stopping state (isStopping = true)', () => {
			it('shows "Stopping..." text', () => {
				const state = createAutoRunState({ isStopping: true });
				render(<AutoRunIndicator state={state} />);
				expect(screen.getByText('Stopping...')).toBeInTheDocument();
			});

			it('uses warning color for background', () => {
				const state = createAutoRunState({ isStopping: true });
				const { container } = render(<AutoRunIndicator state={state} />);
				const banner = container.firstChild as HTMLElement;
				expect(banner.style.backgroundColor).toBe('rgb(234, 179, 8)'); // warning color
			});

			it('renders pause icon (two rects)', () => {
				const state = createAutoRunState({ isStopping: true });
				const { container } = render(<AutoRunIndicator state={state} />);
				const rects = container.querySelectorAll('rect');
				expect(rects.length).toBe(2);
				// First rect
				expect(rects[0].getAttribute('x')).toBe('6');
				expect(rects[0].getAttribute('y')).toBe('4');
				expect(rects[0].getAttribute('width')).toBe('4');
				expect(rects[0].getAttribute('height')).toBe('16');
				// Second rect
				expect(rects[1].getAttribute('x')).toBe('14');
				expect(rects[1].getAttribute('y')).toBe('4');
				expect(rects[1].getAttribute('width')).toBe('4');
				expect(rects[1].getAttribute('height')).toBe('16');
			});

			it('uses warning color for progress badge text', () => {
				const state = createAutoRunState({ isStopping: true });
				const { container } = render(<AutoRunIndicator state={state} />);
				const badge = screen.getByText(/\d+%/);
				expect(badge.style.color).toBe('rgb(234, 179, 8)'); // warning color
			});
		});
	});

	describe('progress bar', () => {
		it('renders progress bar container', () => {
			const state = createAutoRunState();
			const { container } = render(<AutoRunIndicator state={state} />);
			// Find the progress bar container by its background color
			const progressBars = container.querySelectorAll('[style*="border-radius: 3px"]');
			expect(progressBars.length).toBeGreaterThanOrEqual(1);
		});

		it('sets progress bar width to match percentage', () => {
			const state = createAutoRunState({ totalTasks: 10, completedTasks: 6 });
			const { container } = render(<AutoRunIndicator state={state} />);
			// Find the inner progress bar (white background)
			const progressFill = container.querySelector('[style*="width: 60%"]');
			expect(progressFill).not.toBeNull();
		});

		it('shows 0% width when no progress', () => {
			const state = createAutoRunState({ totalTasks: 10, completedTasks: 0 });
			const { container } = render(<AutoRunIndicator state={state} />);
			const progressFill = container.querySelector('[style*="width: 0%"]');
			expect(progressFill).not.toBeNull();
		});

		it('shows 100% width when complete', () => {
			const state = createAutoRunState({ totalTasks: 5, completedTasks: 5 });
			const { container } = render(<AutoRunIndicator state={state} />);
			const progressFill = container.querySelector('[style*="width: 100%"]');
			expect(progressFill).not.toBeNull();
		});

		it('has transition for smooth animation', () => {
			const state = createAutoRunState();
			const { container } = render(<AutoRunIndicator state={state} />);
			const progressFill = container.querySelector('[style*="transition"]');
			expect(progressFill).not.toBeNull();
		});
	});

	describe('styling', () => {
		it('renders with box shadow', () => {
			const state = createAutoRunState();
			const { container } = render(<AutoRunIndicator state={state} />);
			const banner = container.firstChild as HTMLElement;
			expect(banner.style.boxShadow).toBe('0 2px 8px rgba(0,0,0,0.15)');
		});

		it('renders with correct padding', () => {
			const state = createAutoRunState();
			const { container } = render(<AutoRunIndicator state={state} />);
			const banner = container.firstChild as HTMLElement;
			expect(banner.style.padding).toBe('12px 16px');
		});

		it('uses flex display for layout', () => {
			const state = createAutoRunState();
			const { container } = render(<AutoRunIndicator state={state} />);
			const banner = container.firstChild as HTMLElement;
			expect(banner.style.display).toBe('flex');
		});

		it('lays out as a column to accommodate optional error-recovery actions', () => {
			// Banner uses flex-column so a paused-on-error state can stack the
			// progress row above the Resume/Skip/Abort buttons. The original
			// row of icon + status + badge is still centered inside its own
			// nested wrapper.
			const state = createAutoRunState();
			const { container } = render(<AutoRunIndicator state={state} />);
			const banner = container.firstChild as HTMLElement;
			expect(banner.style.flexDirection).toBe('column');
			const innerRow = banner.firstChild as HTMLElement;
			expect(innerRow.style.alignItems).toBe('center');
		});

		it('has gap between elements', () => {
			const state = createAutoRunState();
			const { container } = render(<AutoRunIndicator state={state} />);
			const banner = container.firstChild as HTMLElement;
			expect(banner.style.gap).toBe('12px');
		});

		it('includes CSS keyframes for pulse animation', () => {
			const state = createAutoRunState();
			const { container } = render(<AutoRunIndicator state={state} />);
			const styleElement = container.querySelector('style');
			expect(styleElement).not.toBeNull();
			expect(styleElement?.textContent).toContain('@keyframes autorun-pulse');
			expect(styleElement?.textContent).toContain('transform: scale(1)');
			expect(styleElement?.textContent).toContain('transform: scale(1.15)');
		});
	});

	describe('icon styling', () => {
		it('renders icon container with correct dimensions', () => {
			const state = createAutoRunState();
			const { container } = render(<AutoRunIndicator state={state} />);
			const iconContainer = container.querySelector('[style*="width: 32px"]');
			expect(iconContainer).not.toBeNull();
			expect((iconContainer as HTMLElement).style.height).toBe('32px');
		});

		it('renders icon container with circular border radius', () => {
			const state = createAutoRunState();
			const { container } = render(<AutoRunIndicator state={state} />);
			const iconContainer = container.querySelector('[style*="border-radius: 50%"]');
			expect(iconContainer).not.toBeNull();
		});

		it('sets animation on icon container', () => {
			const state = createAutoRunState();
			const { container } = render(<AutoRunIndicator state={state} />);
			const iconContainer = container.querySelector('[style*="animation"]');
			expect(iconContainer).not.toBeNull();
			expect((iconContainer as HTMLElement).style.animation).toContain('autorun-pulse');
		});
	});

	describe('text styling', () => {
		it('renders title with correct font size', () => {
			const state = createAutoRunState();
			render(<AutoRunIndicator state={state} />);
			const title = screen.getByText('AutoRun Active');
			expect(title.style.fontSize).toBe('15px');
		});

		it('renders title with bold font weight', () => {
			const state = createAutoRunState();
			render(<AutoRunIndicator state={state} />);
			const title = screen.getByText('AutoRun Active');
			expect(title.style.fontWeight).toBe('700');
		});

		it('renders title with white color', () => {
			const state = createAutoRunState();
			render(<AutoRunIndicator state={state} />);
			const title = screen.getByText('AutoRun Active');
			expect(title.style.color).toBe('white');
		});

		it('renders title with text overflow ellipsis', () => {
			const state = createAutoRunState();
			render(<AutoRunIndicator state={state} />);
			const title = screen.getByText('AutoRun Active');
			expect(title.style.textOverflow).toBe('ellipsis');
		});

		it('renders subtitle with smaller font size', () => {
			const state = createAutoRunState();
			const { container } = render(<AutoRunIndicator state={state} />);
			const subtitle = container.querySelector('[style*="font-size: 12px"]');
			expect(subtitle).not.toBeNull();
		});
	});

	describe('progress badge styling', () => {
		it('renders badge with white background', () => {
			const state = createAutoRunState();
			const { container } = render(<AutoRunIndicator state={state} />);
			const badge = screen.getByText(/\d+%/);
			expect(badge.style.backgroundColor).toBe('white');
		});

		it('renders badge with rounded corners', () => {
			const state = createAutoRunState();
			const { container } = render(<AutoRunIndicator state={state} />);
			const badge = screen.getByText(/\d+%/);
			expect(badge.style.borderRadius).toBe('16px');
		});

		it('renders badge with correct padding', () => {
			const state = createAutoRunState();
			const { container } = render(<AutoRunIndicator state={state} />);
			const badge = screen.getByText(/\d+%/);
			expect(badge.style.padding).toBe('6px 12px');
		});

		it('renders badge with bold font', () => {
			const state = createAutoRunState();
			const { container } = render(<AutoRunIndicator state={state} />);
			const badge = screen.getByText(/\d+%/);
			expect(badge.style.fontWeight).toBe('700');
		});
	});

	describe('default export', () => {
		it('exports AutoRunIndicator as default', async () => {
			const module = await import('../../../web/mobile/AutoRunIndicator');
			expect(module.default).toBe(module.AutoRunIndicator);
		});
	});

	describe('edge cases', () => {
		it('handles completedTasks greater than totalTasks', () => {
			const state = createAutoRunState({ totalTasks: 5, completedTasks: 10 });
			render(<AutoRunIndicator state={state} />);
			// Should show 200%
			expect(screen.getByText('200%')).toBeInTheDocument();
		});

		it('handles negative currentTaskIndex gracefully', () => {
			const state = createAutoRunState({ currentTaskIndex: -1, totalTasks: 5 });
			render(<AutoRunIndicator state={state} />);
			// currentTask = -1 + 1 = 0
			expect(screen.getByText(/Task 0 of 5/)).toBeInTheDocument();
		});

		it('handles very large numbers', () => {
			const state = createAutoRunState({
				totalTasks: 1000000,
				completedTasks: 500000,
				currentTaskIndex: 499999,
			});
			render(<AutoRunIndicator state={state} />);
			expect(screen.getByText('50%')).toBeInTheDocument();
			expect(screen.getByText(/Task 500000 of 1000000/)).toBeInTheDocument();
		});

		it('handles fractional completedTasks (rounds percentage)', () => {
			// In case the values are somehow not integers
			const state = createAutoRunState({ totalTasks: 7, completedTasks: 2 });
			render(<AutoRunIndicator state={state} />);
			// 2/7 = 28.57... rounds to 29
			expect(screen.getByText('29%')).toBeInTheDocument();
		});

		it('handles state with only isRunning true and zeros', () => {
			const state: AutoRunState = {
				isRunning: true,
				totalTasks: 0,
				completedTasks: 0,
				currentTaskIndex: 0,
				isStopping: false,
			};
			render(<AutoRunIndicator state={state} />);
			expect(screen.getByText('AutoRun Active')).toBeInTheDocument();
			expect(screen.getByText('0%')).toBeInTheDocument();
			expect(screen.getByText(/Task 1 of 0/)).toBeInTheDocument();
		});
	});

	describe('integration scenarios', () => {
		it('renders complete running state correctly', () => {
			const state = createAutoRunState({
				isRunning: true,
				totalTasks: 10,
				completedTasks: 3,
				currentTaskIndex: 3,
				isStopping: false,
			});
			const { container } = render(<AutoRunIndicator state={state} sessionName="Build Tasks" />);

			expect(screen.getByText('AutoRun Active')).toBeInTheDocument();
			expect(screen.getByText('30%')).toBeInTheDocument();
			const span = container.querySelector('span');
			expect(span?.textContent).toContain('Build Tasks');
			expect(screen.getByText(/Task 4 of 10/)).toBeInTheDocument();
			expect(screen.getByText(/\(3 done\)/)).toBeInTheDocument();
		});

		it('renders complete stopping state correctly', () => {
			const state = createAutoRunState({
				isRunning: true,
				totalTasks: 8,
				completedTasks: 6,
				currentTaskIndex: 6,
				isStopping: true,
			});
			const { container } = render(<AutoRunIndicator state={state} sessionName="Deploy" />);

			expect(screen.getByText('Stopping...')).toBeInTheDocument();
			expect(screen.getByText('75%')).toBeInTheDocument();
			const span = container.querySelector('span');
			expect(span?.textContent).toContain('Deploy');
			expect(screen.getByText(/Task 7 of 8/)).toBeInTheDocument();
			expect(screen.getByText(/\(6 done\)/)).toBeInTheDocument();
		});

		it('transitions from active to stopping state', () => {
			const activeState = createAutoRunState({ isStopping: false });
			const { rerender } = render(<AutoRunIndicator state={activeState} />);

			expect(screen.getByText('AutoRun Active')).toBeInTheDocument();

			const stoppingState = createAutoRunState({ isStopping: true });
			rerender(<AutoRunIndicator state={stoppingState} />);

			expect(screen.getByText('Stopping...')).toBeInTheDocument();
		});

		it('handles progress updates', () => {
			const initialState = createAutoRunState({
				totalTasks: 10,
				completedTasks: 0,
				currentTaskIndex: 0,
			});
			const { rerender } = render(<AutoRunIndicator state={initialState} />);

			expect(screen.getByText('0%')).toBeInTheDocument();

			const updatedState = createAutoRunState({
				totalTasks: 10,
				completedTasks: 5,
				currentTaskIndex: 5,
			});
			rerender(<AutoRunIndicator state={updatedState} />);

			expect(screen.getByText('50%')).toBeInTheDocument();
			expect(screen.getByText(/\(5 done\)/)).toBeInTheDocument();
		});

		it('hides when isRunning becomes false', () => {
			const runningState = createAutoRunState({ isRunning: true });
			const { rerender, container } = render(<AutoRunIndicator state={runningState} />);

			expect(container.firstChild).not.toBeNull();

			const stoppedState = createAutoRunState({ isRunning: false });
			rerender(<AutoRunIndicator state={stoppedState} />);

			expect(container.firstChild).toBeNull();
		});
	});

	describe('error-paused state', () => {
		it('uses the error background color when paused on error', () => {
			const state = createAutoRunState({ errorPaused: true, errorMessage: 'rate limit hit' });
			const { container } = render(<AutoRunIndicator state={state} />);
			const banner = container.firstChild as HTMLElement;
			expect(banner.style.backgroundColor).toBe('rgb(239, 68, 68)');
		});

		it('shows "Auto Run Paused" instead of "AutoRun Active"', () => {
			const state = createAutoRunState({ errorPaused: true });
			render(<AutoRunIndicator state={state} />);
			expect(screen.getByText('Auto Run Paused')).toBeInTheDocument();
			expect(screen.queryByText('AutoRun Active')).toBeNull();
		});

		it('renders the error message and task description in the recovery box', () => {
			const state = createAutoRunState({
				errorPaused: true,
				errorMessage: 'context window exceeded',
				errorTaskDescription: 'Update README',
			});
			render(<AutoRunIndicator state={state} />);
			expect(screen.getByText('Update README')).toBeInTheDocument();
			expect(screen.getByText('context window exceeded')).toBeInTheDocument();
		});

		it('renders Resume / Skip / Abort buttons when handlers are provided', () => {
			const state = createAutoRunState({ errorPaused: true });
			const onResume = vi.fn();
			const onSkipDocument = vi.fn();
			const onAbort = vi.fn();
			render(
				<AutoRunIndicator
					state={state}
					onResume={onResume}
					onSkipDocument={onSkipDocument}
					onAbort={onAbort}
				/>
			);
			expect(
				screen.getByRole('button', { name: /Resume Auto Run after error/i })
			).toBeInTheDocument();
			expect(screen.getByRole('button', { name: /Skip current document/i })).toBeInTheDocument();
			expect(screen.getByRole('button', { name: /Abort Auto Run/i })).toBeInTheDocument();
		});

		it('hides Resume when errorRecoverable is false', () => {
			const state = createAutoRunState({ errorPaused: true, errorRecoverable: false });
			const onResume = vi.fn();
			const onSkipDocument = vi.fn();
			const onAbort = vi.fn();
			render(
				<AutoRunIndicator
					state={state}
					onResume={onResume}
					onSkipDocument={onSkipDocument}
					onAbort={onAbort}
				/>
			);
			expect(screen.queryByRole('button', { name: /Resume Auto Run after error/i })).toBeNull();
			expect(screen.getByRole('button', { name: /Abort Auto Run/i })).toBeInTheDocument();
		});

		it('does not render the recovery box when no recovery handlers are provided', () => {
			const state = createAutoRunState({ errorPaused: true });
			render(<AutoRunIndicator state={state} />);
			expect(screen.queryByRole('button', { name: /Resume Auto Run after error/i })).toBeNull();
			expect(screen.queryByRole('button', { name: /Abort Auto Run/i })).toBeNull();
		});
	});

	describe('keyboard activation', () => {
		// Review feedback: the banner exposes button semantics (role=button,
		// tabIndex=0) but the original implementation only fired onTap on mouse
		// click — keyboard users couldn't open the Auto Run panel from the
		// banner. These tests pin the Enter / Space / legacy Spacebar bindings
		// and verify they mirror the mouse-click enablement.

		const fireKey = (banner: HTMLElement, key: string) => {
			const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
			banner.dispatchEvent(event);
			return event;
		};

		it('invokes onTap when Enter is pressed on the banner', () => {
			const state = createAutoRunState();
			const onTap = vi.fn();
			const { container } = render(<AutoRunIndicator state={state} onTap={onTap} />);
			const banner = container.firstChild as HTMLElement;
			fireKey(banner, 'Enter');
			expect(onTap).toHaveBeenCalledTimes(1);
		});

		it('invokes onTap when Space is pressed and prevents page scroll', () => {
			const state = createAutoRunState();
			const onTap = vi.fn();
			const { container } = render(<AutoRunIndicator state={state} onTap={onTap} />);
			const banner = container.firstChild as HTMLElement;
			const event = fireKey(banner, ' ');
			expect(onTap).toHaveBeenCalledTimes(1);
			expect(event.defaultPrevented).toBe(true);
		});

		it('also supports the legacy "Spacebar" KeyboardEvent.key value', () => {
			const state = createAutoRunState();
			const onTap = vi.fn();
			const { container } = render(<AutoRunIndicator state={state} onTap={onTap} />);
			const banner = container.firstChild as HTMLElement;
			fireKey(banner, 'Spacebar');
			expect(onTap).toHaveBeenCalledTimes(1);
		});

		it('does not invoke onTap on other keys', () => {
			const state = createAutoRunState();
			const onTap = vi.fn();
			const { container } = render(<AutoRunIndicator state={state} onTap={onTap} />);
			const banner = container.firstChild as HTMLElement;
			fireKey(banner, 'a');
			fireKey(banner, 'ArrowDown');
			expect(onTap).not.toHaveBeenCalled();
		});

		it('does not invoke onTap when errorPaused (mirrors disabled mouse handler)', () => {
			const state = createAutoRunState({ errorPaused: true });
			const onTap = vi.fn();
			const { container } = render(<AutoRunIndicator state={state} onTap={onTap} />);
			const banner = container.firstChild as HTMLElement;
			fireKey(banner, 'Enter');
			fireKey(banner, ' ');
			expect(onTap).not.toHaveBeenCalled();
		});

		it('does not invoke onTap when onTap is not provided', () => {
			// If the banner is purely informational (no onTap), keyboard
			// activation should be a no-op — no handler, no role=button.
			const state = createAutoRunState();
			const { container } = render(<AutoRunIndicator state={state} />);
			const banner = container.firstChild as HTMLElement;
			expect(() => fireKey(banner, 'Enter')).not.toThrow();
		});
	});
});
