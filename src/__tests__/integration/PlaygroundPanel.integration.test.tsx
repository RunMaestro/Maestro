import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import confetti from 'canvas-confetti';

import { PlaygroundPanel } from '../../renderer/components/PlaygroundPanel';
import { LayerStackProvider } from '../../renderer/contexts/LayerStackContext';
import type { AutoRunStats, Theme, ThemeMode } from '../../renderer/types';

vi.mock('canvas-confetti', () => ({
	default: vi.fn(),
}));

vi.mock('../../renderer/components/AchievementCard', () => ({
	AchievementCard: ({ autoRunStats }: { autoRunStats: AutoRunStats }) => (
		<div data-testid="achievement-card" data-stats={JSON.stringify(autoRunStats)}>
			Achievement Card
		</div>
	),
}));

vi.mock('../../renderer/components/StandingOvationOverlay', () => ({
	StandingOvationOverlay: ({
		badge,
		isNewRecord,
		onClose,
	}: {
		badge: { level: number; name: string };
		isNewRecord: boolean;
		onClose: () => void;
	}) => (
		<div data-testid="standing-ovation" data-level={badge.level} data-record={isNewRecord}>
			Standing Ovation
			<button onClick={onClose}>Close Ovation</button>
		</div>
	),
}));

vi.mock('../../renderer/components/KeyboardMasteryCelebration', () => ({
	KeyboardMasteryCelebration: ({ level, onClose }: { level: number; onClose: () => void }) => (
		<div data-testid="keyboard-mastery" data-level={level}>
			Keyboard Mastery
			<button onClick={onClose}>Close Mastery</button>
		</div>
	),
}));

const theme: Theme = {
	id: 'dracula',
	name: 'Dracula',
	mode: 'dark',
	colors: {
		bgMain: '#282a36',
		bgSidebar: '#21222c',
		bgActivity: '#343746',
		border: '#44475a',
		textMain: '#f8f8f2',
		textDim: '#6272a4',
		accent: '#bd93f9',
		accentDim: '#bd93f920',
		accentText: '#f8f8f2',
		accentForeground: '#282a36',
		success: '#50fa7b',
		warning: '#ffb86c',
		error: '#ff5555',
	},
};

function renderPanel(options: { themeMode?: ThemeMode; onClose?: () => void } = {}) {
	const onClose = options.onClose ?? vi.fn();
	const view = render(
		<LayerStackProvider>
			<PlaygroundPanel theme={theme} themeMode={options.themeMode ?? 'dark'} onClose={onClose} />
		</LayerStackProvider>
	);
	return { ...view, onClose };
}

function slider(labelText: string): HTMLInputElement {
	const match = screen.getAllByRole('slider').find((candidate) => {
		const label = candidate.closest('div')?.querySelector('label');
		return label?.textContent?.includes(labelText);
	});
	expect(match).toBeDefined();
	return match as HTMLInputElement;
}

describe('PlaygroundPanel integration', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		Object.assign(navigator, {
			clipboard: {
				writeText: vi.fn().mockResolvedValue(undefined),
			},
		});
	});

	afterEach(() => {
		cleanup();
		vi.clearAllTimers();
		vi.useRealTimers();
		document.querySelectorAll('style[data-baton-playground]').forEach((node) => node.remove());
	});

	it('renders in the real layer stack, switches tabs, and closes from chrome or Escape', async () => {
		const { onClose } = renderPanel();

		const dialog = screen.getByRole('dialog', { name: 'Developer Playground' });
		expect(dialog).toHaveAttribute('aria-modal', 'true');
		expect(screen.getByText('Achievements')).toBeInTheDocument();

		fireEvent.keyDown(window, { key: '[' });
		fireEvent.keyDown(window, { key: 'x', metaKey: true, shiftKey: true });
		fireEvent.keyDown(window, { key: '[', metaKey: true, shiftKey: true });
		expect(screen.getByText('Baton')).toBeInTheDocument();
		fireEvent.keyDown(window, { key: ']', metaKey: true, shiftKey: true });
		expect(screen.getByText('Achievements')).toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: 'Confetti' }));
		expect(screen.getByRole('button', { name: /Fire Confetti!/ })).toBeInTheDocument();

		fireEvent.keyDown(window, { key: '[', metaKey: true, shiftKey: true });
		expect(screen.getByText('Achievements')).toBeInTheDocument();

		fireEvent.keyDown(window, { key: ']', metaKey: true, shiftKey: true });
		fireEvent.keyDown(window, { key: ']', metaKey: true, shiftKey: true });
		expect(screen.getByText('Baton')).toBeInTheDocument();
		fireEvent.keyDown(window, { key: '}', metaKey: true, shiftKey: true });
		expect(screen.getByText('Achievements')).toBeInTheDocument();

		fireEvent.keyDown(document, { key: 'Escape' });
		await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
	});

	it('drives achievement stats, standing ovation, keyboard mastery, and reset state', async () => {
		renderPanel({ themeMode: 'light' });

		fireEvent.click(screen.getByRole('button', { name: 'Lv 1' }));
		await waitFor(() => {
			const stats = JSON.parse(screen.getByTestId('achievement-card').dataset.stats ?? '{}');
			expect(stats.cumulativeTimeMs).toBeGreaterThan(0);
			expect(stats.badgeHistory.length).toBeGreaterThan(0);
		});
		fireEvent.click(screen.getByRole('button', { name: 'None' }));

		fireEvent.change(slider('Cumulative Time'), { target: { value: '100' } });
		expect(screen.getByText(/Cumulative Time: \d+d/)).toBeInTheDocument();
		fireEvent.change(slider('Cumulative Time'), { target: { value: '25' } });
		fireEvent.change(slider('Cumulative Time'), { target: { value: '0' } });
		expect(screen.getByText('Cumulative Time: 0s')).toBeInTheDocument();
		fireEvent.change(slider('Longest Run'), { target: { value: '50' } });
		expect(screen.getByText(/Longest Run: \d+h/)).toBeInTheDocument();
		fireEvent.change(slider('Total Runs'), { target: { value: '77' } });
		expect(screen.getByText('Total Runs: 77')).toBeInTheDocument();
		expect(screen.getByTestId('achievement-card')).toHaveAttribute('data-stats');

		fireEvent.click(screen.getByLabelText('Show as New Record'));
		const ovationSelect = screen
			.getByText('Standing Ovation Test')
			.closest('div')!
			.querySelector('select')!;
		fireEvent.change(ovationSelect, { target: { value: '999' } });
		fireEvent.click(screen.getByRole('button', { name: /Trigger Standing Ovation/ }));
		expect(screen.queryByTestId('standing-ovation')).not.toBeInTheDocument();
		fireEvent.change(ovationSelect, { target: { value: '2' } });
		fireEvent.click(screen.getByRole('button', { name: /Trigger Standing Ovation/ }));
		expect(screen.getByTestId('standing-ovation')).toHaveAttribute('data-level', '2');
		expect(screen.getByTestId('standing-ovation')).toHaveAttribute('data-record', 'true');
		fireEvent.click(screen.getByRole('button', { name: 'Close Ovation' }));
		expect(screen.queryByTestId('standing-ovation')).not.toBeInTheDocument();

		const masterySelect = screen
			.getByText('Mastery Level to Show')
			.closest('div')!
			.querySelector('select')!;
		fireEvent.change(masterySelect, { target: { value: '3' } });
		fireEvent.click(screen.getByRole('button', { name: /Trigger Keyboard Mastery Celebration/ }));
		expect(screen.getByTestId('keyboard-mastery')).toHaveAttribute('data-level', '3');
		fireEvent.click(screen.getByRole('button', { name: 'Close Mastery' }));

		fireEvent.click(screen.getByRole('button', { name: /Reset All Mock Data/ }));
		await waitFor(() => {
			const stats = JSON.parse(screen.getByTestId('achievement-card').dataset.stats ?? '{}');
			expect(stats.cumulativeTimeMs).toBe(0);
			expect(stats.totalRuns).toBe(0);
		});
	});

	it('configures confetti origins, physics, shapes, colors, firing, and clipboard export', async () => {
		renderPanel();
		fireEvent.click(screen.getByRole('button', { name: 'Confetti' }));

		fireEvent.click(screen.getByTitle('Top Left'));
		expect(screen.getByText('2 origins selected')).toBeInTheDocument();
		fireEvent.click(screen.getByTitle('Bottom Center'));
		fireEvent.click(screen.getByTitle('Top Left'));
		expect(screen.getByText('Select at least one origin')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: /Fire Confetti!/ })).toBeDisabled();

		fireEvent.click(screen.getByTitle('Middle Right'));
		fireEvent.change(slider('Particle Count'), { target: { value: '150' } });
		fireEvent.change(slider('Angle'), { target: { value: '60' } });
		fireEvent.change(slider('Spread'), { target: { value: '80' } });
		fireEvent.change(slider('Start Velocity'), { target: { value: '70' } });
		fireEvent.change(slider('Gravity'), { target: { value: '1.8' } });
		fireEvent.change(slider('Decay'), { target: { value: '0.75' } });
		fireEvent.change(slider('Drift'), { target: { value: '1.5' } });
		fireEvent.change(slider('Scalar'), { target: { value: '2.2' } });
		fireEvent.change(slider('Ticks'), { target: { value: '350' } });
		fireEvent.click(screen.getByLabelText('Flat (disable 3D wobble)'));
		fireEvent.click(screen.getByRole('button', { name: /square/ }));
		fireEvent.click(screen.getByRole('button', { name: /circle/ }));
		fireEvent.click(screen.getByRole('button', { name: /star/ }));
		fireEvent.change(document.querySelector('input[type="color"]')!, {
			target: { value: '#123456' },
		});
		fireEvent.click(screen.getByRole('button', { name: 'Remove color 1' }));
		fireEvent.click(screen.getByRole('button', { name: '+' }));
		fireEvent.click(screen.getByRole('button', { name: /Fire Confetti!/ }));

		expect(confetti).toHaveBeenCalledWith(
			expect.objectContaining({
				particleCount: 150,
				angle: 60,
				spread: 80,
				startVelocity: 70,
				gravity: 1.8,
				decay: 0.75,
				drift: 1.5,
				scalar: 2.2,
				ticks: 350,
				flat: true,
				shapes: expect.arrayContaining(['star']),
				origin: { x: 1, y: 0.5 },
			})
		);

		fireEvent.click(screen.getByTitle('Top Center'));
		vi.useFakeTimers();
		await act(async () => {
			fireEvent.click(screen.getByRole('button', { name: /Copy Settings/ }));
			await Promise.resolve();
		});
		expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
			expect.stringContaining('Multiple origins')
		);
		expect(screen.getByText('Copied!')).toBeInTheDocument();
		await act(async () => {
			await vi.advanceTimersByTimeAsync(2100);
		});
		expect(screen.getByRole('button', { name: /Copy Settings/ })).toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: /Reset to Defaults/ }));
		expect(screen.getByText('1 origin selected')).toBeInTheDocument();
		await act(async () => {
			fireEvent.click(screen.getByRole('button', { name: /Copy Settings/ }));
			await Promise.resolve();
		});
		expect(navigator.clipboard.writeText).toHaveBeenLastCalledWith(
			expect.stringContaining('origin: { x: 0.5, y: 1 }')
		);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(2100);
		});

		vi.mocked(navigator.clipboard.writeText).mockRejectedValueOnce(new Error('clipboard denied'));
		await act(async () => {
			fireEvent.click(screen.getByRole('button', { name: /Copy Settings/ }));
			await Promise.resolve();
		});
		expect(screen.queryByText('Copied!')).not.toBeInTheDocument();
	});

	it('updates baton animation CSS, toggles preview, resets defaults, and copies CSS', async () => {
		renderPanel();
		fireEvent.click(screen.getByRole('button', { name: 'Baton' }));

		expect(document.querySelector('style[data-baton-playground]')?.textContent).toContain(
			'playground-wand-sparkle'
		);

		fireEvent.change(slider('Duration'), { target: { value: '6' } });
		fireEvent.change(slider('Fade-out start'), { target: { value: '20' } });
		fireEvent.change(slider('Fade-in start'), { target: { value: '80' } });
		fireEvent.change(slider('Translate amount'), { target: { value: '2.4' } });
		fireEvent.change(slider('Stagger offset'), { target: { value: '1.25' } });
		fireEvent.click(screen.getByRole('button', { name: 'linear' }));

		const styleText = document.querySelector('style[data-baton-playground]')?.textContent ?? '';
		expect(styleText).toContain('playground-wand-sparkle 6s linear infinite');
		expect(styleText).toContain('20%');
		expect(styleText).toContain('80%');
		expect(styleText).toContain('translate(2.4px, -2.4px)');
		expect(styleText).toContain('animation-delay: 1.25s');

		fireEvent.click(screen.getByRole('button', { name: 'Active' }));
		expect(screen.getByText('Animation paused')).toBeInTheDocument();

		fireEvent.click(screen.getAllByRole('button', { name: /Reset to Defaults/ }).at(-1)!);
		expect(screen.getByText('3.0s')).toBeInTheDocument();
		expect(screen.getByText('Animation active')).toBeInTheDocument();

		vi.useFakeTimers();
		await act(async () => {
			fireEvent.click(screen.getByRole('button', { name: /Copy CSS Settings/ }));
			await Promise.resolve();
		});
		expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
			expect.stringContaining('@keyframes wand-sparkle')
		);
		expect(screen.getByText('Copied CSS!')).toBeInTheDocument();
		await act(async () => {
			await vi.advanceTimersByTimeAsync(2100);
		});
		expect(screen.getByRole('button', { name: /Copy CSS Settings/ })).toBeInTheDocument();

		vi.mocked(navigator.clipboard.writeText).mockRejectedValueOnce(new Error('clipboard denied'));
		await act(async () => {
			fireEvent.click(screen.getByRole('button', { name: /Copy CSS Settings/ }));
			await Promise.resolve();
		});
		expect(screen.queryByText('Copied CSS!')).not.toBeInTheDocument();
	});
});
