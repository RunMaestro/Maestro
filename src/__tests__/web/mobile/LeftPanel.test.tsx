/**
 * Tests for the LeftPanel component (web remote-control side panel).
 *
 * @file src/web/mobile/LeftPanel.tsx
 *
 * Regression coverage for the "Bookmarks" section: bookmarked agents must
 * appear in a dedicated section at the top of the side panel (in addition to
 * their normal group), mirroring the desktop Left Bar. The section is hidden
 * while the unread filter is active.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { LeftPanel } from '../../../web/mobile/LeftPanel';
import type { Session } from '../../../web/hooks/useSessions';

const mockColors = {
	bgMain: '#0b0b0d',
	bgSidebar: '#111113',
	bgActivity: '#1c1c1f',
	border: '#27272a',
	textMain: '#e4e4e7',
	textDim: '#a1a1aa',
	accent: '#6366f1',
	accentForeground: '#ffffff',
	success: '#22c55e',
	warning: '#eab308',
	error: '#ef4444',
};

vi.mock('../../../web/components/ThemeProvider', () => ({
	useThemeColors: () => mockColors,
	useTheme: () => ({
		theme: { id: 'dracula', name: 'Dracula', mode: 'dark', colors: mockColors },
		isLight: false,
		isDark: true,
		isVibe: false,
		isDevicePreference: false,
	}),
	ThemeProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// Partial mock — keep real exports (GESTURE_THRESHOLDS, HAPTIC_PATTERNS, etc.,
// which useSwipeGestures relies on) and only stub the haptics side effect.
vi.mock('../../../web/mobile/constants', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../../web/mobile/constants')>();
	return { ...actual, triggerHaptic: vi.fn() };
});

// Build a minimal Session with just the fields LeftPanel reads.
const createSession = (overrides: Partial<Session> = {}): Session =>
	({
		id: 'session-1',
		name: 'Agent One',
		toolType: 'claude-code',
		state: 'idle',
		inputMode: 'ai',
		cwd: '/Users/test/project',
		aiTabs: [],
		...overrides,
	}) as unknown as Session;

const baseProps = {
	activeSessionId: null,
	onSelectSession: vi.fn(),
	onClose: vi.fn(),
	collapsedGroups: new Set<string>(),
	setCollapsedGroups: vi.fn(),
	showUnreadOnly: false,
	setShowUnreadOnly: vi.fn(),
};

describe('LeftPanel — Bookmarks section', () => {
	it('renders a Bookmarks section when an agent is bookmarked', () => {
		const sessions = [
			createSession({ id: 's1', name: 'Bookmarked Agent', bookmarked: true }),
			createSession({ id: 's2', name: 'Plain Agent' }),
		];

		render(<LeftPanel {...baseProps} sessions={sessions} />);

		expect(screen.getByText('Bookmarks')).toBeInTheDocument();
		// Bookmarked agent appears twice: once under Bookmarks, once Ungrouped.
		expect(screen.getAllByText('Bookmarked Agent')).toHaveLength(2);
		// Non-bookmarked agent appears only in its normal section.
		expect(screen.getAllByText('Plain Agent')).toHaveLength(1);
	});

	it('does not render a Bookmarks section when no agent is bookmarked', () => {
		const sessions = [createSession({ id: 's1', name: 'Plain Agent' })];

		render(<LeftPanel {...baseProps} sessions={sessions} />);

		expect(screen.queryByText('Bookmarks')).not.toBeInTheDocument();
	});

	it('hides the Bookmarks section while the unread filter is active', () => {
		// Bookmarked AND busy, so it passes the unread filter and still renders —
		// but the dedicated Bookmarks section header must be suppressed.
		const sessions = [
			createSession({ id: 's1', name: 'Busy Bookmarked', bookmarked: true, state: 'busy' }),
		];

		render(<LeftPanel {...baseProps} sessions={sessions} showUnreadOnly={true} />);

		expect(screen.queryByText('Bookmarks')).not.toBeInTheDocument();
		// The agent itself still shows (in its normal/ungrouped section).
		expect(screen.getByText('Busy Bookmarked')).toBeInTheDocument();
	});
});
