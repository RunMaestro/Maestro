/**
 * Tests for useForkConversation hook.
 *
 * Locks in the behavior that fork creates a NEW AI TAB within the existing
 * session — it must NOT create a new session. Also covers:
 * - Tab inserted immediately after the source tab
 * - unifiedTabOrder has the new tab inserted directly after the source (not appended)
 * - Session marked busy, new tab active, source session.id preserved
 * - Agent spawn uses the existing session.id (`${session.id}-ai-${newTabId}`)
 * - Multi-chunk AI response is captured via endIndex extension
 * - Early returns for invalid logId or missing active session
 * - Error path: spawn failure flips tab/session back to idle and appends an error log
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup, waitFor } from '@testing-library/react';
import type { Session, AITab, LogEntry } from '../../../renderer/types';
import { createMockSession } from '../../helpers/mockSession';
import { createMockAITab } from '../../helpers/mockTab';

// ============================================================================
// Mock modules BEFORE importing the hook
// ============================================================================

const mockNotifyToast = vi.fn();
vi.mock('../../../renderer/stores/notificationStore', () => ({
	notifyToast: (...args: unknown[]) => mockNotifyToast(...args),
}));

const mockCaptureException = vi.fn();
vi.mock('../../../renderer/utils/sentry', () => ({
	captureException: (...args: unknown[]) => mockCaptureException(...args),
}));

vi.mock('../../../renderer/utils/spawnHelpers', () => ({
	prepareMaestroSystemPrompt: vi.fn().mockResolvedValue('mock-system-prompt'),
	getStdinFlags: vi.fn().mockReturnValue({
		sendPromptViaStdin: false,
		sendPromptViaStdinRaw: false,
	}),
}));

// ============================================================================
// Import hook AFTER mocks are registered
// ============================================================================

import { useForkConversation } from '../../../renderer/hooks/agent/useForkConversation';

// ============================================================================
// Helpers
// ============================================================================

function buildSourceTab(overrides: Partial<AITab> = {}): AITab {
	return createMockAITab({
		id: 'source-tab',
		name: 'Source',
		logs: [
			{ id: 'log-1', timestamp: 1000, source: 'user', text: 'Hello' },
			{ id: 'log-2', timestamp: 2000, source: 'stdout', text: 'Hi there' },
		],
		...overrides,
	});
}

function buildSession(overrides: Partial<Session> = {}): Session {
	const sourceTab = buildSourceTab();
	return createMockSession({
		id: 'session-A',
		name: 'Agent One',
		toolType: 'claude-code',
		aiTabs: [sourceTab],
		activeTabId: sourceTab.id,
		unifiedTabOrder: [{ type: 'ai', id: sourceTab.id }],
		...overrides,
	});
}

/**
 * Drive the hook against a mutable session array that mirrors how App.tsx
 * wires it up. Returns the current snapshot, the fork handler, and setter.
 */
function mountHook(initialSessions: Session[], activeSessionId: string | null) {
	let sessions = initialSessions;
	const setSessions = vi.fn((updater: (prev: Session[]) => Session[]) => {
		sessions = updater(sessions);
	});

	const { result, rerender } = renderHook(
		({ s, id }: { s: Session[]; id: string | null }) => useForkConversation(s, setSessions, id),
		{ initialProps: { s: sessions, id: activeSessionId } }
	);

	return {
		fork: (logId: string) => act(() => result.current(logId)),
		getSessions: () => sessions,
		setSessions,
		rerender: () => rerender({ s: sessions, id: activeSessionId }),
	};
}

// ============================================================================
// Setup
// ============================================================================

beforeEach(() => {
	vi.clearAllMocks();

	(window as any).maestro = {
		agents: {
			get: vi.fn().mockResolvedValue({
				command: 'claude',
				args: ['--flag'],
				path: '/usr/bin/claude',
				capabilities: { supportsStreamJsonInput: false },
			}),
		},
		process: { spawn: vi.fn().mockResolvedValue(undefined) },
		prompts: { get: vi.fn().mockResolvedValue({ success: true, content: '' }) },
	};
});

afterEach(() => {
	cleanup();
});

// ============================================================================
// Tests
// ============================================================================

describe('useForkConversation', () => {
	describe('session-level invariants', () => {
		it('creates a new tab in the existing session (does NOT create a new session)', () => {
			const session = buildSession();
			const { fork, getSessions } = mountHook([session], session.id);

			fork('log-2');

			const after = getSessions();
			expect(after).toHaveLength(1);
			expect(after[0].id).toBe(session.id);
			expect(after[0].aiTabs).toHaveLength(2);
		});

		it('inserts the new tab immediately after the source tab', () => {
			const firstTab = buildSourceTab({ id: 'tab-first' });
			const sourceTab = buildSourceTab({
				id: 'tab-source',
				logs: [{ id: 'log-s', timestamp: 1, source: 'user', text: 'question' }],
			});
			const tailTab = createMockAITab({ id: 'tab-tail', name: 'Tail' });
			const session = buildSession({
				aiTabs: [firstTab, sourceTab, tailTab],
				activeTabId: sourceTab.id,
				unifiedTabOrder: [
					{ type: 'ai', id: firstTab.id },
					{ type: 'ai', id: sourceTab.id },
					{ type: 'ai', id: tailTab.id },
				],
			});
			const { fork, getSessions } = mountHook([session], session.id);

			fork('log-s');

			const after = getSessions()[0];
			const aiTabs = after.aiTabs;
			expect(aiTabs).toHaveLength(4);
			expect(aiTabs[0].id).toBe(firstTab.id);
			expect(aiTabs[1].id).toBe(sourceTab.id);
			expect(aiTabs[3].id).toBe(tailTab.id);
			const newTab = aiTabs[2];
			expect(newTab.id).not.toBe(sourceTab.id);
			expect(newTab.name).toBe('Forked: Source');
			// unifiedTabOrder must insert the fork directly after the source, not at the end
			expect(after.unifiedTabOrder).toEqual([
				{ type: 'ai', id: firstTab.id },
				{ type: 'ai', id: sourceTab.id },
				{ type: 'ai', id: newTab.id },
				{ type: 'ai', id: tailTab.id },
			]);
		});

		it('marks the new tab busy, makes it active, and appends to unifiedTabOrder', () => {
			const session = buildSession();
			const { fork, getSessions } = mountHook([session], session.id);

			fork('log-2');

			const after = getSessions()[0];
			const newTab = after.aiTabs.find((t) => t.id !== 'source-tab')!;
			expect(newTab.state).toBe('busy');
			expect(newTab.awaitingSessionId).toBe(true);
			expect(after.activeTabId).toBe(newTab.id);
			expect(after.state).toBe('busy');
			expect(after.busySource).toBe('ai');
			expect(after.unifiedTabOrder).toEqual([
				{ type: 'ai', id: 'source-tab' },
				{ type: 'ai', id: newTab.id },
			]);
			expect(after.activeFileTabId).toBeNull();
			expect(after.activeBrowserTabId).toBeNull();
			expect(after.activeTerminalTabId).toBeNull();
			expect(after.inputMode).toBe('ai');
		});

		it('seeds the new tab with a fork-notice system log and user-context log', () => {
			const session = buildSession();
			const { fork, getSessions } = mountHook([session], session.id);

			fork('log-2');

			const newTab = getSessions()[0].aiTabs.find((t) => t.id !== 'source-tab')!;
			expect(newTab.logs).toHaveLength(2);
			expect(newTab.logs[0].source).toBe('system');
			expect(newTab.logs[0].text).toMatch(/^Forked from tab "Source"/);
			expect(newTab.logs[1].source).toBe('user');
			expect(newTab.logs[1].text).toContain('# Forked Conversation');
			expect(newTab.logs[1].text).toContain('User: Hello');
			expect(newTab.logs[1].text).toContain('Assistant: Hi there');
		});
	});

	describe('agent spawn', () => {
		it('spawns the agent with sessionId `${session.id}-ai-${newTabId}`', async () => {
			const session = buildSession();
			const { fork, getSessions } = mountHook([session], session.id);

			fork('log-2');

			const newTab = getSessions()[0].aiTabs.find((t) => t.id !== 'source-tab')!;
			await waitFor(() => {
				expect((window as any).maestro.process.spawn).toHaveBeenCalledTimes(1);
			});
			const spawnArgs = (window as any).maestro.process.spawn.mock.calls[0][0];
			expect(spawnArgs.sessionId).toBe(`${session.id}-ai-${newTab.id}`);
			expect(spawnArgs.toolType).toBe('claude-code');
			expect(spawnArgs.command).toBe('/usr/bin/claude');
			expect(spawnArgs.prompt).toContain('# Forked Conversation');
		});

		it('fires a toast bound to the existing session and the new tab', async () => {
			const session = buildSession();
			const { fork, getSessions } = mountHook([session], session.id);

			fork('log-2');

			const newTab = getSessions()[0].aiTabs.find((t) => t.id !== 'source-tab')!;
			expect(mockNotifyToast).toHaveBeenCalledTimes(1);
			const toast = mockNotifyToast.mock.calls[0][0];
			expect(toast.sessionId).toBe(session.id);
			expect(toast.tabId).toBe(newTab.id);
			expect(toast.title).toBe('Conversation Forked');
		});
	});

	describe('multi-chunk AI response', () => {
		it('extends endIndex forward through consecutive non-user/tool/thinking entries', () => {
			const sourceTab = buildSourceTab({
				id: 'mct',
				logs: [
					{ id: 'u1', timestamp: 1, source: 'user', text: 'Q' },
					{ id: 'a1', timestamp: 2, source: 'stdout', text: 'chunk 1' },
					{ id: 'a2', timestamp: 3, source: 'stdout', text: 'chunk 2' },
					{ id: 'a3', timestamp: 4, source: 'stdout', text: 'chunk 3' },
					{ id: 'u2', timestamp: 5, source: 'user', text: 'next question' },
				],
			});
			const session = buildSession({
				aiTabs: [sourceTab],
				activeTabId: sourceTab.id,
				unifiedTabOrder: [{ type: 'ai', id: sourceTab.id }],
			});
			const { fork, getSessions } = mountHook([session], session.id);

			fork('a1');

			const newTab = getSessions()[0].aiTabs.find((t) => t.id !== sourceTab.id)!;
			const userContext = newTab.logs[1].text!;
			expect(userContext).toContain('Assistant: chunk 1');
			expect(userContext).toContain('Assistant: chunk 2');
			expect(userContext).toContain('Assistant: chunk 3');
			expect(userContext).not.toContain('next question');
		});
	});

	describe('early returns', () => {
		it('no-ops when activeSessionId is null', () => {
			const session = buildSession();
			const { fork, getSessions, setSessions } = mountHook([session], null);

			fork('log-2');

			expect(setSessions).not.toHaveBeenCalled();
			expect(getSessions()[0].aiTabs).toHaveLength(1);
		});

		it('no-ops when logId is not found in the active tab', () => {
			const session = buildSession();
			const { fork, getSessions, setSessions } = mountHook([session], session.id);

			fork('nonexistent-log-id');

			expect(setSessions).not.toHaveBeenCalled();
			expect(getSessions()[0].aiTabs).toHaveLength(1);
			expect((window as any).maestro.process.spawn).not.toHaveBeenCalled();
		});
	});

	describe('error path', () => {
		it('flips tab and session back to idle and appends an error log on spawn failure', async () => {
			(window as any).maestro.process.spawn = vi.fn().mockRejectedValueOnce(new Error('boom'));

			const session = buildSession();
			const { fork, getSessions } = mountHook([session], session.id);

			fork('log-2');

			await waitFor(() => {
				expect(mockCaptureException).toHaveBeenCalledTimes(1);
			});

			const after = getSessions()[0];
			const newTab = after.aiTabs.find((t) => t.id !== 'source-tab')!;
			expect(after.state).toBe('idle');
			expect(after.busySource).toBeUndefined();
			expect(newTab.state).toBe('idle');
			expect(newTab.awaitingSessionId).toBe(false);
			const errorLog = newTab.logs.find((l: LogEntry) => l.text?.startsWith('Error:'));
			expect(errorLog).toBeDefined();
			expect(errorLog!.source).toBe('system');
			expect(errorLog!.text).toContain('boom');
		});
	});
});
