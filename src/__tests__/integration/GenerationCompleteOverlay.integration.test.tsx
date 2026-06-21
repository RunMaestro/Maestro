import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	GenerationCompleteOverlay,
	startGenerationComplete,
} from '../../renderer/components/InlineWizard/GenerationCompleteOverlay';
import { triggerCelebration } from '../../renderer/utils/confetti';
import type { Theme } from '../../renderer/types';

vi.mock('../../renderer/utils/confetti', () => ({
	triggerCelebration: vi.fn(),
}));

const theme = {
	id: 'test-theme',
	name: 'Test Theme',
	mode: 'dark',
	colors: {
		bgMain: '#101010',
		bgSidebar: '#202020',
		bgActivity: '#303030',
		textMain: '#f5f5f5',
		textDim: '#a0a0a0',
		accent: '#3b82f6',
		accentForeground: '#ffffff',
		border: '#404040',
		error: '#ef4444',
		warning: '#f59e0b',
		success: '#22c55e',
		info: '#38bdf8',
		textInverse: '#000000',
	},
} as Theme;

describe('GenerationCompleteOverlay', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.clearAllTimers();
		vi.useRealTimers();
	});

	it('renders the completed playbook summary with plural task copy and themed actions', () => {
		render(<GenerationCompleteOverlay theme={theme} taskCount={3} onDone={vi.fn()} />);

		expect(screen.getByRole('heading', { name: 'Your Playbook is ready!' })).toBeInTheDocument();
		expect(screen.getByText('3 tasks prepared and ready to run')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Done' })).toHaveStyle({
			backgroundColor: '#3b82f6',
			color: '#ffffff',
		});
	});

	it('uses singular task copy and respects the disabled-confetti preference before completing', () => {
		const onDone = vi.fn();
		render(
			<GenerationCompleteOverlay theme={theme} taskCount={1} onDone={onDone} disableConfetti />
		);

		fireEvent.click(screen.getByRole('button', { name: 'Done' }));

		expect(triggerCelebration).toHaveBeenCalledWith(true);
		expect(screen.getByRole('button', { name: 'Finishing...' })).toBeDisabled();
		expect(screen.getByText('1 task prepared and ready to run')).toBeInTheDocument();
		expect(onDone).not.toHaveBeenCalled();

		act(() => {
			vi.advanceTimersByTime(499);
		});
		expect(onDone).not.toHaveBeenCalled();

		act(() => {
			vi.advanceTimersByTime(1);
		});
		expect(onDone).toHaveBeenCalledTimes(1);
	});

	it('starts completion once and disables the done button while the close delay is pending', () => {
		const onDone = vi.fn();
		render(<GenerationCompleteOverlay theme={theme} taskCount={2} onDone={onDone} />);

		const button = screen.getByRole('button', { name: 'Done' });
		fireEvent.click(button);

		expect(triggerCelebration).toHaveBeenCalledWith(false);
		expect(screen.getByRole('button', { name: 'Finishing...' })).toBeDisabled();
		expect(triggerCelebration).toHaveBeenCalledTimes(1);

		act(() => {
			vi.advanceTimersByTime(500);
		});

		expect(onDone).toHaveBeenCalledTimes(1);
	});

	it('returns false without side effects when completion is already closing', () => {
		const setIsClosing = vi.fn();
		const onDone = vi.fn();

		expect(
			startGenerationComplete({
				isClosing: true,
				setIsClosing,
				disableConfetti: false,
				onDone,
			})
		).toBe(false);

		vi.runAllTimers();

		expect(setIsClosing).not.toHaveBeenCalled();
		expect(triggerCelebration).not.toHaveBeenCalled();
		expect(onDone).not.toHaveBeenCalled();
	});
});
