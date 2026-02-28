/**
 * Tests for AppOverlays.tsx (Tier 1A self-sourcing)
 *
 * Verifies that AppOverlays reads overlay data from modalStore
 * and settings from settingsStore instead of receiving them as props.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AppOverlays } from '../../../renderer/components/AppOverlays';
import { useModalStore } from '../../../renderer/stores/modalStore';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';
import type { Theme, Shortcut } from '../../../renderer/types';

// Mock the three overlay sub-components
vi.mock('../../../renderer/components/StandingOvationOverlay', () => ({
	StandingOvationOverlay: (props: Record<string, unknown>) => (
		<div
			data-testid="standing-ovation-overlay"
			data-badge={(props.badge as any)?.id}
			data-disable-confetti={String(props.disableConfetti)}
		>
			StandingOvationOverlay
		</div>
	),
}));

vi.mock('../../../renderer/components/FirstRunCelebration', () => ({
	FirstRunCelebration: (props: Record<string, unknown>) => (
		<div
			data-testid="first-run-celebration"
			data-elapsed={props.elapsedTimeMs}
			data-disable-confetti={String(props.disableConfetti)}
		>
			FirstRunCelebration
		</div>
	),
}));

vi.mock('../../../renderer/components/KeyboardMasteryCelebration', () => ({
	KeyboardMasteryCelebration: (props: Record<string, unknown>) => (
		<div
			data-testid="keyboard-mastery-celebration"
			data-level={props.level}
			data-disable-confetti={String(props.disableConfetti)}
			data-has-shortcuts={String(
				!!props.shortcuts && Object.keys(props.shortcuts as object).length > 0
			)}
		>
			KeyboardMasteryCelebration
		</div>
	),
}));

const mockTheme: Theme = {
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
		accentText: '#ff79c6',
		accentForeground: '#ffffff',
		success: '#50fa7b',
		warning: '#ffb86c',
		error: '#ff5555',
	},
};

const mockShortcuts: Record<string, Shortcut> = {
	'new-session': { id: 'new-session', label: 'New Session', keys: ['Meta', 'n'] },
};

const defaultProps = {
	theme: mockTheme,
	cumulativeTimeMs: 0,
	onCloseStandingOvation: vi.fn(),
	onOpenLeaderboardRegistration: vi.fn(),
	isLeaderboardRegistered: false,
	onCloseFirstRun: vi.fn(),
	onCloseKeyboardMastery: vi.fn(),
};

describe('AppOverlays (Tier 1A self-sourcing)', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		// Reset stores to clean state
		useModalStore.setState({ modals: new Map() });
		useSettingsStore.setState({
			shortcuts: mockShortcuts,
			disableConfetti: false,
		});
	});

	it('renders nothing when no overlay data is set in modalStore', () => {
		const { container } = render(<AppOverlays {...defaultProps} />);
		expect(container.textContent).toBe('');
	});

	it('renders FirstRunCelebration when firstRunCelebration modal data is set', () => {
		const { openModal } = useModalStore.getState();
		openModal('firstRunCelebration', {
			elapsedTimeMs: 12345,
			completedTasks: 3,
			totalTasks: 5,
		});

		render(<AppOverlays {...defaultProps} />);

		const el = screen.getByTestId('first-run-celebration');
		expect(el).toBeInTheDocument();
		expect(el).toHaveAttribute('data-elapsed', '12345');
	});

	it('renders KeyboardMasteryCelebration when keyboardMastery modal data has a level', () => {
		const { openModal } = useModalStore.getState();
		openModal('keyboardMastery', { level: 3 });

		render(<AppOverlays {...defaultProps} />);

		const el = screen.getByTestId('keyboard-mastery-celebration');
		expect(el).toBeInTheDocument();
		expect(el).toHaveAttribute('data-level', '3');
	});

	it('renders StandingOvationOverlay when standingOvation modal data is set', () => {
		const { openModal } = useModalStore.getState();
		openModal('standingOvation', {
			badge: { id: 'speed-demon', name: 'Speed Demon', description: 'Fast!', emoji: '⚡' },
			isNewRecord: true,
			recordTimeMs: 5000,
		});

		render(<AppOverlays {...defaultProps} />);

		const el = screen.getByTestId('standing-ovation-overlay');
		expect(el).toBeInTheDocument();
		expect(el).toHaveAttribute('data-badge', 'speed-demon');
	});

	it('reads disableConfetti from settingsStore and passes to overlays', () => {
		useSettingsStore.setState({ disableConfetti: true });

		const { openModal } = useModalStore.getState();
		openModal('firstRunCelebration', {
			elapsedTimeMs: 1000,
			completedTasks: 1,
			totalTasks: 1,
		});

		render(<AppOverlays {...defaultProps} />);

		const el = screen.getByTestId('first-run-celebration');
		expect(el).toHaveAttribute('data-disable-confetti', 'true');
	});

	it('reads shortcuts from settingsStore and passes to KeyboardMasteryCelebration', () => {
		const { openModal } = useModalStore.getState();
		openModal('keyboardMastery', { level: 2 });

		render(<AppOverlays {...defaultProps} />);

		const el = screen.getByTestId('keyboard-mastery-celebration');
		expect(el).toBeInTheDocument();
		expect(el).toHaveAttribute('data-has-shortcuts', 'true');
	});

	it('renders multiple overlays simultaneously when multiple modal data is set', () => {
		const { openModal } = useModalStore.getState();
		openModal('firstRunCelebration', {
			elapsedTimeMs: 1000,
			completedTasks: 1,
			totalTasks: 1,
		});
		openModal('standingOvation', {
			badge: { id: 'first-run', name: 'First Run', description: 'Complete!', emoji: '🎉' },
			isNewRecord: false,
		});

		render(<AppOverlays {...defaultProps} />);

		expect(screen.getByTestId('first-run-celebration')).toBeInTheDocument();
		expect(screen.getByTestId('standing-ovation-overlay')).toBeInTheDocument();
	});

	it('does not render KeyboardMasteryCelebration when keyboardMastery has no level', () => {
		const { openModal } = useModalStore.getState();
		openModal('keyboardMastery', {}); // No level set

		render(<AppOverlays {...defaultProps} />);

		expect(screen.queryByTestId('keyboard-mastery-celebration')).not.toBeInTheDocument();
	});
});
