/**
 * Tests for the web/mobile RightPanel component.
 *
 * @file src/web/mobile/RightPanel.tsx
 *
 * Covers the inline (desktop) vs full-screen (mobile) layout fork —
 * specifically that the inline panel reserves bottom padding for the
 * fixed CommandInputBar (PR #895 follow-up: AutoRun toolbar was being
 * buried by the input bar overlay).
 */

import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import React from 'react';
import { RightPanel } from '../../../web/mobile/RightPanel';
import type { AutoRunState } from '../../../web/hooks/useWebSocket';

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

vi.mock('../../../web/mobile/GitStatusPanel', () => ({
	GitStatusPanel: () => <div data-testid="git-status-panel" />,
}));

vi.mock('../../../web/mobile/RightDrawer', () => ({
	FilesTabContent: () => <div data-testid="files-tab" />,
	HistoryTabContent: () => <div data-testid="history-tab" />,
	AutoRunTabContent: () => <div data-testid="autorun-tab" />,
}));

vi.mock('../../../web/hooks/useSwipeGestures', () => ({
	useSwipeGestures: () => ({
		handlers: {},
		offsetX: 0,
		isSwiping: false,
	}),
}));

vi.mock('../../../web/mobile/constants', () => ({
	triggerHaptic: vi.fn(),
	HAPTIC_PATTERNS: { tap: 10, success: [10, 30, 10], error: [50, 50, 50] },
}));

function makeProps(overrides: Partial<React.ComponentProps<typeof RightPanel>> = {}) {
	const autoRunState: AutoRunState = {
		isRunning: false,
		totalTasks: 0,
		completedTasks: 0,
		currentTaskIndex: 0,
		isStopping: false,
	};
	return {
		sessionId: 'session-1',
		activeTab: 'files' as const,
		autoRunState,
		gitStatus: {
			status: null,
			diff: null,
			isLoading: false,
			loadStatus: vi.fn(),
			loadDiff: vi.fn(),
			refresh: vi.fn(),
		} as unknown as React.ComponentProps<typeof RightPanel>['gitStatus'],
		onClose: vi.fn(),
		sendRequest: vi.fn(),
		send: vi.fn(),
		...overrides,
	};
}

describe('RightPanel — inputBarHeight reserve (PR #895 desktop layout fix)', () => {
	it('reserves paddingBottom equal to inputBarHeight on the inline desktop panel', () => {
		const { container } = render(<RightPanel {...makeProps({ inputBarHeight: 96 })} />);
		const panel = container
			.querySelector<HTMLDivElement>('[role="tab"]')
			?.closest('div')?.parentElement;
		expect(panel).toBeTruthy();
		expect(panel?.style.paddingBottom).toBe('96px');
	});

	it('does not set paddingBottom when inputBarHeight is unset', () => {
		const { container } = render(<RightPanel {...makeProps()} />);
		const panel = container
			.querySelector<HTMLDivElement>('[role="tab"]')
			?.closest('div')?.parentElement;
		expect(panel).toBeTruthy();
		expect(panel?.style.paddingBottom).toBe('');
	});

	it('ignores inputBarHeight when in full-screen (mobile) mode — drawer sits above the bar via z-index', () => {
		const { container } = render(
			<RightPanel {...makeProps({ inputBarHeight: 96, isFullScreen: true })} />
		);
		const panel = container
			.querySelector<HTMLDivElement>('[role="tab"]')
			?.closest('div')?.parentElement;
		expect(panel).toBeTruthy();
		// Full-screen panel uses position:fixed top/left/right/bottom — no paddingBottom reserve.
		expect(panel?.style.paddingBottom).toBe('');
		expect(panel?.style.position).toBe('fixed');
	});
});
