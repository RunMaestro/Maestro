/**
 * Tests for AppInfoModals component
 *
 * Verifies conditional rendering of 5 info/display modals:
 * - ShortcutsHelpModal (shortcutsHelpOpen)
 * - AboutModal (aboutModalOpen)
 * - UpdateCheckModal (updateCheckModalOpen)
 * - ProcessMonitor (processMonitorOpen) - lazy loaded
 * - UsageDashboardModal (usageDashboardOpen) - lazy loaded
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AppInfoModals } from '../../../renderer/components/AppModals';
import type { Theme } from '../../../renderer/types';

// Mock all child modal components
vi.mock('../../../renderer/components/ShortcutsHelpModal', () => ({
	ShortcutsHelpModal: (props: any) => <div data-testid="shortcuts-help-modal" />,
}));

vi.mock('../../../renderer/components/AboutModal', () => ({
	AboutModal: (props: any) => <div data-testid="about-modal" />,
}));

vi.mock('../../../renderer/components/UpdateCheckModal', () => ({
	UpdateCheckModal: (props: any) => <div data-testid="update-check-modal" />,
}));

vi.mock('../../../renderer/components/ProcessMonitor', () => ({
	ProcessMonitor: (props: any) => <div data-testid="process-monitor" />,
}));

vi.mock('../../../renderer/components/UsageDashboard', () => ({
	UsageDashboardModal: (props: any) => <div data-testid="usage-dashboard" />,
}));

const testTheme: Theme = {
	id: 'test-theme',
	name: 'Test Theme',
	mode: 'dark',
	colors: {
		bgMain: '#1e1e1e',
		bgSidebar: '#252526',
		bgActivity: '#333333',
		textMain: '#d4d4d4',
		textDim: '#808080',
		accent: '#007acc',
		accentForeground: '#ffffff',
		border: '#404040',
		error: '#f14c4c',
		warning: '#cca700',
		success: '#89d185',
	},
};

const defaultProps = {
	theme: testTheme,
	shortcutsHelpOpen: false,
	onCloseShortcutsHelp: vi.fn(),
	shortcuts: {},
	tabShortcuts: {},
	hasNoAgents: false,
	keyboardMasteryStats: {
		totalShortcutsUsed: 0,
		uniqueShortcutsUsed: 0,
		shortcutUsageCounts: {},
		level: 0,
		levelName: 'Novice',
		progress: 0,
	},
	aboutModalOpen: false,
	onCloseAboutModal: vi.fn(),
	autoRunStats: {
		cumulativeTimeMs: 0,
		totalRuns: 0,
		currentBadgeLevel: 0,
		longestRunMs: 0,
		longestRunTimestamp: 0,
	},
	usageStats: null,
	handsOnTimeMs: 0,
	onOpenLeaderboardRegistration: vi.fn(),
	isLeaderboardRegistered: false,
	leaderboardRegistration: null,
	updateCheckModalOpen: false,
	onCloseUpdateCheckModal: vi.fn(),
	processMonitorOpen: false,
	onCloseProcessMonitor: vi.fn(),
	sessions: [],
	groups: [],
	groupChats: [],
	onNavigateToSession: vi.fn(),
	onNavigateToGroupChat: vi.fn(),
	usageDashboardOpen: false,
	onCloseUsageDashboard: vi.fn(),
	defaultStatsTimeRange: undefined,
	colorBlindMode: undefined,
};

describe('AppInfoModals', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('does not render any modals when all booleans are false', () => {
		render(<AppInfoModals {...defaultProps} />);

		expect(screen.queryByTestId('shortcuts-help-modal')).not.toBeInTheDocument();
		expect(screen.queryByTestId('about-modal')).not.toBeInTheDocument();
		expect(screen.queryByTestId('update-check-modal')).not.toBeInTheDocument();
		expect(screen.queryByTestId('process-monitor')).not.toBeInTheDocument();
		expect(screen.queryByTestId('usage-dashboard')).not.toBeInTheDocument();
	});

	it('renders ShortcutsHelpModal when shortcutsHelpOpen is true', () => {
		render(<AppInfoModals {...defaultProps} shortcutsHelpOpen={true} />);

		expect(screen.getByTestId('shortcuts-help-modal')).toBeInTheDocument();
	});

	it('renders AboutModal when aboutModalOpen is true', () => {
		render(<AppInfoModals {...defaultProps} aboutModalOpen={true} />);

		expect(screen.getByTestId('about-modal')).toBeInTheDocument();
	});

	it('renders UpdateCheckModal when updateCheckModalOpen is true', () => {
		render(<AppInfoModals {...defaultProps} updateCheckModalOpen={true} />);

		expect(screen.getByTestId('update-check-modal')).toBeInTheDocument();
	});

	it('renders ProcessMonitor when processMonitorOpen is true', async () => {
		render(<AppInfoModals {...defaultProps} processMonitorOpen={true} />);

		expect(await screen.findByTestId('process-monitor')).toBeInTheDocument();
	});

	it('renders UsageDashboardModal when usageDashboardOpen is true', async () => {
		render(<AppInfoModals {...defaultProps} usageDashboardOpen={true} />);

		expect(await screen.findByTestId('usage-dashboard')).toBeInTheDocument();
	});

	it('renders multiple modals simultaneously', async () => {
		render(
			<AppInfoModals
				{...defaultProps}
				shortcutsHelpOpen={true}
				aboutModalOpen={true}
				processMonitorOpen={true}
			/>
		);

		expect(screen.getByTestId('shortcuts-help-modal')).toBeInTheDocument();
		expect(screen.getByTestId('about-modal')).toBeInTheDocument();
		expect(await screen.findByTestId('process-monitor')).toBeInTheDocument();
	});

	it('does not render closed modals when others are open', () => {
		render(<AppInfoModals {...defaultProps} aboutModalOpen={true} />);

		expect(screen.getByTestId('about-modal')).toBeInTheDocument();
		expect(screen.queryByTestId('shortcuts-help-modal')).not.toBeInTheDocument();
		expect(screen.queryByTestId('update-check-modal')).not.toBeInTheDocument();
		expect(screen.queryByTestId('process-monitor')).not.toBeInTheDocument();
		expect(screen.queryByTestId('usage-dashboard')).not.toBeInTheDocument();
	});
});
