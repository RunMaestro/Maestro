import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueuedCommand } from '../../web/hooks/useOfflineQueue';
import type { AutoRunState } from '../../web/hooks/useWebSocket';

const mocks = vi.hoisted(() => ({
	colors: {
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
	},
	triggerHaptic: vi.fn(),
}));

vi.mock('../../web/components/ThemeProvider', () => ({
	useTheme: () => ({
		theme: {
			colors: mocks.colors,
		},
	}),
	useThemeColors: () => mocks.colors,
}));

vi.mock('../../web/mobile/constants', () => ({
	HAPTIC_PATTERNS: {
		tap: [10],
	},
	triggerHaptic: mocks.triggerHaptic,
}));

import { PullToRefreshIndicator } from '../../web/components/PullToRefresh';
import { AutoRunIndicator } from '../../web/mobile/AutoRunIndicator';
import { OfflineQueueBanner } from '../../web/mobile/OfflineQueueBanner';

function queuedCommand(overrides: Partial<QueuedCommand> = {}): QueuedCommand {
	return {
		id: 'command-1',
		command: 'npm run test:integration -- --long-command-that-should-be-truncated',
		sessionId: 'session-1',
		timestamp: Date.now() - 60_000,
		inputMode: 'ai',
		attempts: 0,
		...overrides,
	};
}

function autoRunState(overrides: Partial<AutoRunState> = {}): AutoRunState {
	return {
		isRunning: true,
		totalTasks: 10,
		completedTasks: 3,
		currentTaskIndex: 3,
		isStopping: false,
		...overrides,
	};
}

describe('web mobile zero-coverage components integration', () => {
	beforeEach(() => {
		vi.setSystemTime(new Date('2026-05-27T10:00:00Z'));
		mocks.colors.accent = '#6366f1';
		mocks.triggerHaptic.mockClear();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	describe('PullToRefreshIndicator', () => {
		it('renders nothing until pulling or refreshing starts', () => {
			const { container } = render(
				<PullToRefreshIndicator
					pullDistance={0}
					progress={0}
					isRefreshing={false}
					isThresholdReached={false}
				/>
			);

			expect(container.firstChild).toBeNull();
		});

		it('renders pull, release, and refreshing states while converting supported accent formats', () => {
			const { rerender } = render(
				<PullToRefreshIndicator
					pullDistance={30}
					progress={0.4}
					isRefreshing={false}
					isThresholdReached={false}
					style={{ zIndex: 2 }}
				/>
			);

			expect(screen.getByText('Pull to refresh')).toBeInTheDocument();

			mocks.colors.accent = '#abc';
			rerender(
				<PullToRefreshIndicator
					pullDistance={70}
					progress={1}
					isRefreshing={false}
					isThresholdReached={true}
				/>
			);
			expect(screen.getByText('Release to refresh')).toBeInTheDocument();

			mocks.colors.accent = '#abcd';
			rerender(
				<PullToRefreshIndicator
					pullDistance={70}
					progress={1}
					isRefreshing={false}
					isThresholdReached={true}
				/>
			);
			expect(screen.getByText('Release to refresh')).toBeInTheDocument();

			mocks.colors.accent = '#112233ff';
			rerender(
				<PullToRefreshIndicator
					pullDistance={10}
					progress={0.5}
					isRefreshing={true}
					isThresholdReached={false}
				/>
			);
			expect(screen.getByText('Refreshing...')).toBeInTheDocument();

			mocks.colors.accent = 'rgb(10.4, 20.5, 30.6)';
			rerender(
				<PullToRefreshIndicator
					pullDistance={20}
					progress={0.5}
					isRefreshing={false}
					isThresholdReached={false}
				/>
			);
			expect(screen.getByText('Pull to refresh')).toBeInTheDocument();

			mocks.colors.accent = 'rgba(bad)';
			rerender(
				<PullToRefreshIndicator
					pullDistance={20}
					progress={0.5}
					isRefreshing={false}
					isThresholdReached={false}
				/>
			);
			expect(screen.getByText('Pull to refresh')).toBeInTheDocument();

			mocks.colors.accent = 'not-a-color';
			rerender(
				<PullToRefreshIndicator
					pullDistance={20}
					progress={0.5}
					isRefreshing={false}
					isThresholdReached={false}
				/>
			);
			expect(screen.getByText('Pull to refresh')).toBeInTheDocument();
		});
	});

	describe('OfflineQueueBanner', () => {
		it('renders nothing when the queue is empty', () => {
			const { container } = render(
				<OfflineQueueBanner
					queue={[]}
					status="idle"
					onClearQueue={vi.fn()}
					onProcessQueue={vi.fn()}
					onRemoveCommand={vi.fn()}
					isOffline={false}
					isConnected={true}
				/>
			);

			expect(container.firstChild).toBeNull();
		});

		it('shows queued commands, haptic interactions, retry, clear, and removal actions', () => {
			const onClearQueue = vi.fn();
			const onProcessQueue = vi.fn();
			const onRemoveCommand = vi.fn();

			render(
				<OfflineQueueBanner
					queue={[
						queuedCommand(),
						queuedCommand({
							id: 'command-2',
							command: 'echo second',
							inputMode: 'terminal',
							attempts: 2,
							lastError: 'network failed',
						}),
					]}
					status="idle"
					onClearQueue={onClearQueue}
					onProcessQueue={onProcessQueue}
					onRemoveCommand={onRemoveCommand}
					isOffline={false}
					isConnected={true}
				/>
			);

			expect(screen.getByText('2 commands queued')).toBeInTheDocument();
			expect(screen.getByText('Commands ready to send.')).toBeInTheDocument();

			fireEvent.click(screen.getByText('Send Now'));
			expect(onProcessQueue).toHaveBeenCalledTimes(1);

			fireEvent.click(screen.getByText('2 commands queued'));
			expect(screen.getByText(/npm run test:integration/)).toBeInTheDocument();
			expect(screen.getByText('CLI')).toBeInTheDocument();
			expect(screen.getByText(/2 attempts/)).toBeInTheDocument();
			expect(screen.getByText(/network failed/)).toBeInTheDocument();

			fireEvent.click(screen.getAllByLabelText('Remove command')[0]);
			expect(onRemoveCommand).toHaveBeenCalledWith('command-1');

			fireEvent.click(screen.getByText('Clear'));
			expect(onClearQueue).toHaveBeenCalledTimes(1);
			expect(mocks.triggerHaptic).toHaveBeenCalledTimes(4);
		});

		it('handles offline and processing states without retrying or clearing', () => {
			const onClearQueue = vi.fn();
			const { rerender } = render(
				<OfflineQueueBanner
					queue={[queuedCommand()]}
					status="idle"
					onClearQueue={onClearQueue}
					onProcessQueue={vi.fn()}
					onRemoveCommand={vi.fn()}
					isOffline={true}
					isConnected={false}
				/>
			);

			expect(screen.getByText('1 command queued')).toBeInTheDocument();
			expect(screen.getByText('Commands will be sent when you reconnect.')).toBeInTheDocument();
			expect(screen.queryByText('Send Now')).not.toBeInTheDocument();

			rerender(
				<OfflineQueueBanner
					queue={[queuedCommand({ attempts: 1 })]}
					status="processing"
					onClearQueue={onClearQueue}
					onProcessQueue={vi.fn()}
					onRemoveCommand={vi.fn()}
					isOffline={false}
					isConnected={true}
				/>
			);

			expect(screen.getByText('Sending...')).toBeInTheDocument();
			expect(screen.getByText('Sending queued commands...')).toBeInTheDocument();
			fireEvent.click(screen.getByText('1 command queued'));
			expect(screen.getByText(/1 attempt/)).toBeInTheDocument();
			expect(screen.getByLabelText('Remove command')).toBeDisabled();
			fireEvent.click(screen.getByText('Clear'));
			expect(onClearQueue).not.toHaveBeenCalled();
		});
	});

	describe('AutoRunIndicator', () => {
		it('renders only for running AutoRun sessions and calculates progress', () => {
			const { container, rerender } = render(<AutoRunIndicator state={null} />);
			expect(container.firstChild).toBeNull();

			rerender(<AutoRunIndicator state={autoRunState({ isRunning: false })} />);
			expect(container.firstChild).toBeNull();

			rerender(<AutoRunIndicator state={autoRunState()} sessionName="Project Alpha" />);
			expect(screen.getByText('AutoRun Active')).toBeInTheDocument();
			expect(screen.getByText(/Project Alpha -/)).toBeInTheDocument();
			expect(screen.getByText(/Task 4 of 10/)).toBeInTheDocument();
			expect(screen.getByText('30%')).toBeInTheDocument();

			rerender(<AutoRunIndicator state={autoRunState({ totalTasks: 0, completedTasks: 0 })} />);
			expect(screen.getByText('0%')).toBeInTheDocument();

			rerender(<AutoRunIndicator state={autoRunState({ isStopping: true })} />);
			expect(screen.getByText('Stopping...')).toBeInTheDocument();
		});
	});
});
