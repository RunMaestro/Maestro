/**
 * Tests for ClaudeModeBadge.
 *
 * Covers the five display rules from MAESTRO-P-03 task 2:
 *   1. interactive/auto  → green TUI icon, no lock
 *   2. interactive/user  → green TUI icon, lock shown
 *   3. api/auto          → blue cloud icon, no lock
 *   4. api/user          → blue cloud icon, lock shown
 *   5. api/limit         → orange warning icon, tooltip includes reset
 *
 * Plus:
 *   - Account-short-name derivation from `lastUsageSnapshotKey`
 *   - Click cycles the mode (interacts with the existing IPC seam)
 *   - Hidden for non-Claude sessions and when claudeInteractive is absent
 *   - readOnly disables click cycling
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

import { ClaudeModeBadge } from '../../../../renderer/components/SessionList/ClaudeModeBadge';
import { useSessionStore } from '../../../../renderer/stores/sessionStore';
import { useClaudeUsageStore } from '../../../../renderer/stores/claudeUsageStore';
import type { Session, Theme } from '../../../../renderer/types';

const setClaudeInteractiveMode = vi.fn().mockResolvedValue(true);
const kill = vi.fn().mockResolvedValue(true);

const mockTheme = {
	name: 'test',
	colors: {
		bgMain: '#1a1a2e',
		bgSidebar: '#16213e',
		bgInput: '#0f3460',
		textMain: '#e0e0e0',
		textDim: '#888888',
		accent: '#4a90e2',
		border: '#333333',
		error: '#ff4444',
		success: '#00cc66',
		warning: '#ffaa00',
	},
} as unknown as Theme;

function makeClaudeSession(overrides: Partial<Session> & { id: string }): Session {
	return {
		name: overrides.id,
		toolType: 'claude-code',
		state: 'idle',
		cwd: '/tmp',
		fullPath: '/tmp',
		projectRoot: '/tmp',
		isGitRepo: false,
		aiLogs: [],
		shellLogs: [],
		workLog: [],
		contextUsage: 0,
		inputMode: 'ai',
		aiPid: 0,
		terminalPid: 0,
		port: 0,
		isLive: false,
		changedFiles: [],
		fileTree: [],
		fileExplorerExpanded: [],
		fileExplorerScrollPos: 0,
		fileTreeAutoRefreshInterval: 180,
		shellCwd: '/tmp',
		aiCommandHistory: [],
		shellCommandHistory: [],
		executionQueue: [],
		activeTimeMs: 0,
		aiTabs: [{ id: 'tab-1', name: 'main', state: 'idle', logs: [], readOnlyMode: false } as any],
		activeTabId: 'tab-1',
		closedTabHistory: [],
		filePreviewTabs: [],
		activeFileTabId: null,
		unifiedTabOrder: [],
		unifiedClosedTabHistory: [],
		autoRunFolderPath: '/tmp',
		...overrides,
	} as Session;
}

beforeEach(() => {
	vi.clearAllMocks();
	setClaudeInteractiveMode.mockResolvedValue(true);
	kill.mockResolvedValue(true);
	const maestro = (window as any).maestro;
	maestro.agents.setClaudeInteractiveMode = setClaudeInteractiveMode;
	maestro.process.kill = kill;
	useSessionStore.setState({
		sessions: [],
		groups: [],
		activeSessionId: '',
		cyclePosition: -1,
	} as any);
	useClaudeUsageStore.setState({
		snapshots: {},
		loaded: true,
		loading: false,
		error: null,
	} as any);
});

afterEach(() => {
	cleanup();
});

describe('ClaudeModeBadge', () => {
	it('renders nothing when the session is not a Claude Code session', () => {
		useSessionStore.setState({
			sessions: [{ ...makeClaudeSession({ id: 's' }), toolType: 'codex' } as Session],
		} as any);
		const { container } = render(<ClaudeModeBadge sessionId="s" theme={mockTheme} />);
		expect(container.firstChild).toBeNull();
	});

	it('renders nothing when claudeInteractive is undefined', () => {
		useSessionStore.setState({
			sessions: [makeClaudeSession({ id: 's' })],
		} as any);
		const { container } = render(<ClaudeModeBadge sessionId="s" theme={mockTheme} />);
		expect(container.firstChild).toBeNull();
	});

	it('shows green TUI icon for interactive/auto and references the account short name', () => {
		useSessionStore.setState({
			sessions: [
				makeClaudeSession({
					id: 's',
					claudeInteractive: {
						mode: 'interactive',
						modeReason: 'auto',
						lastUsageSnapshotKey: '/Users/me/.claude-gmail',
					},
				}),
			],
		} as any);
		render(<ClaudeModeBadge sessionId="s" theme={mockTheme} />);
		const badge = screen.getByTestId('claude-mode-badge-s');
		expect(badge.getAttribute('data-claude-mode')).toBe('interactive');
		expect(badge.getAttribute('data-claude-mode-reason')).toBe('auto');
		expect(badge.getAttribute('title')).toBe('Interactive (using Max plan quota for gmail)');
		// Terminal icon present, no lock
		expect(badge.querySelector('[data-testid="terminal-icon"]')).toBeTruthy();
		expect(badge.querySelector('[data-testid="lock-icon"]')).toBeNull();
	});

	it('falls back to "default" account name when the snapshot key is missing', () => {
		useSessionStore.setState({
			sessions: [
				makeClaudeSession({
					id: 's',
					claudeInteractive: { mode: 'interactive', modeReason: 'auto' },
				}),
			],
		} as any);
		render(<ClaudeModeBadge sessionId="s" theme={mockTheme} />);
		expect(screen.getByTestId('claude-mode-badge-s').getAttribute('title')).toBe(
			'Interactive (using Max plan quota for default)'
		);
	});

	it('shows TUI + lock for interactive/user (manually pinned)', () => {
		useSessionStore.setState({
			sessions: [
				makeClaudeSession({
					id: 's',
					claudeInteractive: { mode: 'interactive', modeReason: 'user' },
				}),
			],
		} as any);
		render(<ClaudeModeBadge sessionId="s" theme={mockTheme} />);
		const badge = screen.getByTestId('claude-mode-badge-s');
		expect(badge.getAttribute('title')).toBe('Interactive (manually pinned)');
		expect(badge.querySelector('[data-testid="terminal-icon"]')).toBeTruthy();
		expect(badge.querySelector('[data-testid="lock-icon"]')).toBeTruthy();
	});

	it('shows blue cloud for api/auto', () => {
		useSessionStore.setState({
			sessions: [
				makeClaudeSession({
					id: 's',
					claudeInteractive: { mode: 'api', modeReason: 'auto' },
				}),
			],
		} as any);
		render(<ClaudeModeBadge sessionId="s" theme={mockTheme} />);
		const badge = screen.getByTestId('claude-mode-badge-s');
		expect(badge.getAttribute('title')).toBe('API mode (billed per token)');
		expect(badge.querySelector('[data-testid="cloud-icon"]')).toBeTruthy();
		expect(badge.querySelector('[data-testid="lock-icon"]')).toBeNull();
	});

	it('shows cloud + lock for api/user', () => {
		useSessionStore.setState({
			sessions: [
				makeClaudeSession({
					id: 's',
					claudeInteractive: { mode: 'api', modeReason: 'user' },
				}),
			],
		} as any);
		render(<ClaudeModeBadge sessionId="s" theme={mockTheme} />);
		const badge = screen.getByTestId('claude-mode-badge-s');
		expect(badge.getAttribute('title')).toBe('API mode (manually pinned)');
		expect(badge.querySelector('[data-testid="cloud-icon"]')).toBeTruthy();
		expect(badge.querySelector('[data-testid="lock-icon"]')).toBeTruthy();
	});

	it('shows warning icon with reset hint for api/limit when a snapshot is cached', () => {
		const resetsAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
		useClaudeUsageStore.setState({
			snapshots: {
				'/Users/me/.claude-gmail': {
					sampledAt: new Date().toISOString(),
					configDirKey: '/Users/me/.claude-gmail',
					session: { percent: 99, resetsAt },
					weekAllModels: { percent: 80, resetsAt },
					weekSonnetOnly: { percent: 80, resetsAt },
				},
			},
			loaded: true,
			loading: false,
			error: null,
		} as any);
		useSessionStore.setState({
			sessions: [
				makeClaudeSession({
					id: 's',
					claudeInteractive: {
						mode: 'api',
						modeReason: 'limit',
						lastUsageSnapshotKey: '/Users/me/.claude-gmail',
					},
				}),
			],
		} as any);
		render(<ClaudeModeBadge sessionId="s" theme={mockTheme} />);
		const badge = screen.getByTestId('claude-mode-badge-s');
		// Warning icon used for the limit case
		expect(badge.querySelector('[data-testid="alerttriangle-icon"]')).toBeTruthy();
		// Tooltip mentions auto-fallback and a reset hint
		const title = badge.getAttribute('title') ?? '';
		expect(title).toMatch(/Auto-fell back to API \(Max plan quota hit/);
		expect(title).toMatch(/resets/);
	});

	it('omits the reset hint for api/limit when no snapshot is cached for the account', () => {
		useSessionStore.setState({
			sessions: [
				makeClaudeSession({
					id: 's',
					claudeInteractive: {
						mode: 'api',
						modeReason: 'limit',
						lastUsageSnapshotKey: '/Users/me/.claude-unknown',
					},
				}),
			],
		} as any);
		render(<ClaudeModeBadge sessionId="s" theme={mockTheme} />);
		expect(screen.getByTestId('claude-mode-badge-s').getAttribute('title')).toBe(
			'Auto-fell back to API (Max plan quota hit)'
		);
	});

	it('clicking the badge cycles to force-interactive', async () => {
		useSessionStore.setState({
			sessions: [
				makeClaudeSession({
					id: 's',
					claudeInteractive: { mode: 'api', modeReason: 'auto' },
				}),
			],
		} as any);
		render(<ClaudeModeBadge sessionId="s" theme={mockTheme} />);
		const badge = screen.getByTestId('claude-mode-badge-s');
		fireEvent.click(badge);
		await Promise.resolve();
		expect(setClaudeInteractiveMode).toHaveBeenCalledWith('s', 'interactive', 'user');
	});

	it('readOnly badges do not cycle on click', () => {
		useSessionStore.setState({
			sessions: [
				makeClaudeSession({
					id: 's',
					claudeInteractive: { mode: 'api', modeReason: 'auto' },
				}),
			],
		} as any);
		render(<ClaudeModeBadge sessionId="s" theme={mockTheme} readOnly />);
		const badge = screen.getByTestId('claude-mode-badge-s');
		fireEvent.click(badge);
		expect(setClaudeInteractiveMode).not.toHaveBeenCalled();
	});
});
