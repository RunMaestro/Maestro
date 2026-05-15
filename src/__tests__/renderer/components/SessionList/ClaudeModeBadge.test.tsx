/**
 * Tests for ClaudeModeBadge
 *
 * Verifies:
 *  - All five display rules render the right icon + tooltip
 *  - Account short-name derivation, including `.claude` → `default` fallback
 *  - Click cycles via useClaudeInteractiveMode (auto → force-interactive)
 *  - readOnly suppresses cycling and disables the button
 *  - Non-Claude tabs render nothing
 *  - Sessions without `claudeInteractive` render nothing
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, fireEvent, screen, cleanup } from '@testing-library/react';
import {
	ClaudeModeBadge,
	deriveAccountShortName,
} from '../../../../renderer/components/SessionList/ClaudeModeBadge';
import { useSessionStore } from '../../../../renderer/stores/sessionStore';
import { useClaudeUsageStore } from '../../../../renderer/stores/claudeUsageStore';
import { createMockSession } from '../../../helpers/mockSession';
import type { Session } from '../../../../renderer/types';

const setClaudeInteractiveModeMock = vi.fn();
const killMock = vi.fn();
const getClaudeUsageSnapshotsMock = vi.fn();

beforeEach(() => {
	setClaudeInteractiveModeMock.mockReset().mockResolvedValue(true);
	killMock.mockReset().mockResolvedValue(true);
	getClaudeUsageSnapshotsMock.mockReset().mockResolvedValue({});

	(global as any).window = (global as any).window ?? {};
	(window as any).maestro = {
		agents: {
			setClaudeInteractiveMode: setClaudeInteractiveModeMock,
			getClaudeUsageSnapshots: getClaudeUsageSnapshotsMock,
		},
		process: { kill: killMock },
		logger: { log: vi.fn() },
	};

	useSessionStore.setState({ sessions: [], activeSessionId: '' } as any);
	useClaudeUsageStore.getState().__resetForTests();
	cleanup();
});

const seedSession = (overrides: Partial<Session> = {}) => {
	const session = createMockSession({
		id: 'sess-1',
		toolType: 'claude-code',
		...overrides,
	});
	useSessionStore.setState({ sessions: [session], activeSessionId: session.id } as any);
	return session;
};

describe('deriveAccountShortName', () => {
	it('returns "default" when the key is undefined', () => {
		expect(deriveAccountShortName(undefined)).toBe('default');
	});

	it('returns "default" for the bare ".claude" basename', () => {
		expect(deriveAccountShortName('/Users/me/.claude')).toBe('default');
	});

	it('strips the ".claude-" prefix on suffixed accounts', () => {
		expect(deriveAccountShortName('/Users/me/.claude-gmail')).toBe('gmail');
		expect(deriveAccountShortName('/Users/me/.claude-work')).toBe('work');
	});

	it('returns the verbatim basename when no .claude prefix is present', () => {
		expect(deriveAccountShortName('/opt/custom-config')).toBe('custom-config');
	});

	it('handles trailing slashes', () => {
		expect(deriveAccountShortName('/Users/me/.claude-gmail/')).toBe('gmail');
	});
});

describe('ClaudeModeBadge — display rules', () => {
	it('renders nothing for a non-Claude tab', () => {
		seedSession({
			toolType: 'codex',
			claudeInteractive: { mode: 'interactive', modeReason: 'auto' },
		} as any);

		const { container } = render(<ClaudeModeBadge sessionId="sess-1" />);
		expect(container).toBeEmptyDOMElement();
	});

	it('renders nothing when the session has no claudeInteractive block', () => {
		seedSession({});

		const { container } = render(<ClaudeModeBadge sessionId="sess-1" />);
		expect(container).toBeEmptyDOMElement();
	});

	it('mode=interactive, reason=auto → Interactive (using Max plan quota for {account})', () => {
		seedSession({
			claudeInteractive: {
				mode: 'interactive',
				modeReason: 'auto',
				lastUsageSnapshotKey: '/Users/me/.claude-gmail',
			},
		});

		render(<ClaudeModeBadge sessionId="sess-1" />);
		expect(screen.getByTestId('claude-mode-badge').title).toBe(
			'Interactive (using Max plan quota for gmail)'
		);
	});

	it('mode=interactive, reason=auto with .claude → uses "default" account name', () => {
		seedSession({
			claudeInteractive: {
				mode: 'interactive',
				modeReason: 'auto',
				lastUsageSnapshotKey: '/Users/me/.claude',
			},
		});

		render(<ClaudeModeBadge sessionId="sess-1" />);
		expect(screen.getByTestId('claude-mode-badge').title).toBe(
			'Interactive (using Max plan quota for default)'
		);
	});

	it('mode=interactive, reason=user → manually pinned tooltip', () => {
		seedSession({
			claudeInteractive: { mode: 'interactive', modeReason: 'user' },
		});

		render(<ClaudeModeBadge sessionId="sess-1" />);
		expect(screen.getByTestId('claude-mode-badge').title).toBe('Interactive (manually pinned)');
	});

	it('mode=api, reason=auto → billed per token tooltip', () => {
		seedSession({
			claudeInteractive: { mode: 'api', modeReason: 'auto' },
		});

		render(<ClaudeModeBadge sessionId="sess-1" />);
		expect(screen.getByTestId('claude-mode-badge').title).toBe('API mode (billed per token)');
	});

	it('mode=api, reason=user → API manually pinned tooltip', () => {
		seedSession({
			claudeInteractive: { mode: 'api', modeReason: 'user' },
		});

		render(<ClaudeModeBadge sessionId="sess-1" />);
		expect(screen.getByTestId('claude-mode-badge').title).toBe('API mode (manually pinned)');
	});

	it('mode=api, reason=limit with snapshot → tooltip includes reset countdown', () => {
		seedSession({
			claudeInteractive: {
				mode: 'api',
				modeReason: 'limit',
				lastUsageSnapshotKey: '/Users/me/.claude',
			},
		});
		useClaudeUsageStore.getState().setSnapshots({
			'/Users/me/.claude': {
				sampledAt: new Date().toISOString(),
				configDirKey: '/Users/me/.claude',
				session: {
					percent: 100,
					resetsAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
				},
				weekAllModels: {
					percent: 50,
					resetsAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
				},
				weekSonnetOnly: {
					percent: 25,
					resetsAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
				},
			},
		});

		render(<ClaudeModeBadge sessionId="sess-1" />);
		expect(screen.getByTestId('claude-mode-badge').title).toMatch(
			/Auto-fell back to API \(Max plan quota hit, resets [^)]+\)/
		);
	});

	it('mode=api, reason=limit without snapshot → tooltip omits reset countdown', () => {
		seedSession({
			claudeInteractive: { mode: 'api', modeReason: 'limit' },
		});

		render(<ClaudeModeBadge sessionId="sess-1" />);
		expect(screen.getByTestId('claude-mode-badge').title).toBe(
			'Auto-fell back to API (Max plan quota hit)'
		);
	});
});

describe('ClaudeModeBadge — interaction', () => {
	it('cycles the mode on click via window.maestro.agents.setClaudeInteractiveMode', async () => {
		seedSession({
			claudeInteractive: { mode: 'interactive', modeReason: 'auto' },
		});

		render(<ClaudeModeBadge sessionId="sess-1" />);
		fireEvent.click(screen.getByTestId('claude-mode-badge'));

		// Wait a microtask so the async cycle() can fire
		await Promise.resolve();
		expect(setClaudeInteractiveModeMock).toHaveBeenCalledWith('sess-1', 'interactive', 'user');
	});

	it('readOnly suppresses the click cycle', async () => {
		seedSession({
			claudeInteractive: { mode: 'interactive', modeReason: 'auto' },
		});

		render(<ClaudeModeBadge sessionId="sess-1" readOnly />);
		const button = screen.getByTestId('claude-mode-badge') as HTMLButtonElement;
		expect(button.disabled).toBe(true);
		fireEvent.click(button);

		await Promise.resolve();
		expect(setClaudeInteractiveModeMock).not.toHaveBeenCalled();
	});
});
