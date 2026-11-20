/**
 * Tests for useForkConversation hook.
 *
 * Locks in the behavior that fork creates a NEW AI TAB within the existing
 * session - it must NOT create a new session. Also covers:
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
}));

// ============================================================================
// Import hook AFTER mocks are registered
// ============================================================================

import { useForkConversation } from '../../../renderer/hooks/agent/useForkConversation';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { prepareMaestroSystemPrompt } from '../../../renderer/utils/spawnHelpers';

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
 * Seed the session store and mount the no-arg fork hook.
 * Mutations go through the store; assert via getState().sessions.
 */
function mountHook(initialSessions: Session[], activeSessionId: string | null) {
	const originalSetSessions = useSessionStore.getState().setSessions;
	const setSessions = vi.fn((updater: Session[] | ((prev: Session[]) => Session[])) => {
		originalSetSessions(updater);
	});
	useSessionStore.setState({
		sessions: initialSessions,
		activeSessionId,
		setSessions: setSessions as typeof originalSetSessions,
	});

	const { result } = renderHook(() => useForkConversation());

	return {
		fork: (logId: string) => act(() => result.current(logId)),
		getSessions: () => useSessionStore.getState().sessions,
		setSessions,
	};
}

// ============================================================================
// Setup
// ============================================================================

beforeEach(() => {
	vi.clearAllMocks();
	// Avoid resetStores here: this file mocks notificationStore without
	// exporting useNotificationStore, which resetStores imports.
	useSessionStore.setState(useSessionStore.getInitialState(), true);

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
	it('forks a pinned provider with its own configuration', async () => {
		const tab = buildSourceTab({
			tabProvider: 'codex',
			customModel: 'tab-codex',
			customEffort: 'high',
		});
		const session = buildSession({
			aiTabs: [tab],
			customPath: '/claude',
			customEnvVars: { CLAUDE: 'yes' },
			providerOverrides: {
				codex: {
					customPath: '/codex',
					customEnvVars: { CODEX: 'yes' },
					customModel: 'codex-model',
					customEffort: 'high',
				},
			},
		});
		const hook = mountHook([session], session.id);
		hook.fork('log-2');
		await waitFor(() => expect(window.maestro.process.spawn).toHaveBeenCalled());
		expect(window.maestro.agents.get).toHaveBeenCalledWith('codex');
		expect(window.maestro.process.spawn).toHaveBeenCalledWith(
			expect.objectContaining({
				toolType: 'codex',
				sessionCustomPath: '/codex',
				sessionCustomEnvVars: { CODEX: 'yes' },
				sessionCustomModel: 'codex-model',
				sessionCustomEffort: 'high',
			})
		);
		const updated = hook.getSessions()[0];
		expect(updated.toolType).toBe('claude-code');
		expect(updated.aiTabs.find((t) => t.id === updated.activeTabId)).toMatchObject({
			tabProvider: 'codex',
			turnProvider: 'codex',
			agentSessionId: null,
		});
	});

	describe('Grok native fork refusal', () => {
		it.each([
			['grok', undefined, 'idle', false],
			['grok', 'claude-code', 'idle', false],
			['claude-code', 'grok', 'idle', false],
			['codex', 'grok', 'busy', false],
			['grok', undefined, 'idle', true],
		] as const)(
			'preserves %s history with owner %s, state %s and pending ID %s',
			(toolType, turnProvider, state, awaitingSessionId) => {
				const binding = {
					version: 1,
					state: 'bound',
					provider: 'grok',
					nativeSessionId: 'shared-native',
					accountRef: 'account-a',
					host: { kind: 'local', identity: 'machine-a' },
					cwd: '/project',
				} as const;
				const sourceTab = buildSourceTab({
					agentSessionId: binding.nativeSessionId,
					nativeSessionBinding: { ...binding, provider: toolType },
					turnProvider,
					state,
					awaitingSessionId,
					providerSessions:
						toolType === 'grok'
							? undefined
							: {
									grok: { agentSessionId: binding.nativeSessionId, nativeSessionBinding: binding },
								},
				});
				const session = buildSession({ toolType, aiTabs: [sourceTab] });
				const others = [
					{ ...binding, accountRef: 'account-b' },
					{ ...binding, host: { kind: 'ssh' as const, identity: 'endpoint-b' } },
				].map((nativeSessionBinding, index) =>
					buildSession({
						id: `other-${index}`,
						toolType: 'grok',
						aiTabs: [
							buildSourceTab({ agentSessionId: binding.nativeSessionId, nativeSessionBinding }),
						],
					})
				);
				const sessions = [session, ...others];
				const snapshot = structuredClone(sessions);
				const { fork, getSessions, setSessions } = mountHook(sessions, session.id);

				fork('log-2');

				expect(getSessions()).toEqual(snapshot);
				expect(setSessions).not.toHaveBeenCalled();
				expect(window.maestro.agents.get).not.toHaveBeenCalled();
				expect(prepareMaestroSystemPrompt).not.toHaveBeenCalled();
				expect(window.maestro.process.spawn).not.toHaveBeenCalled();
				expect(mockCaptureException).not.toHaveBeenCalled();
				expect(mockNotifyToast).toHaveBeenCalledTimes(1);
				const busy = state === 'busy' || awaitingSessionId;
				expect(mockNotifyToast).toHaveBeenCalledWith({
					type: 'warning',
					title: busy ? 'Grok conversation is busy' : 'Grok native fork unavailable',
					message: expect.stringContaining(
						busy ? 'Wait for the current turn' : 'separate context conversation'
					),
					sessionId: session.id,
					tabId: sourceTab.id,
				});
				if (!busy) {
					expect(mockNotifyToast.mock.calls[0][0].message).toContain('Use Grok CLI');
				}
			}
		);

		it('refuses a selected remote account without falling back to a local context fork', () => {
			const session = buildSession({
				toolType: 'grok',
				cwd: '/remote/project',
				customEnvVars: { GROK_HOME: '/remote/account-b' },
				sessionSshRemoteConfig: { enabled: true, remoteId: 'endpoint-b' },
			});
			const { fork, getSessions, setSessions } = mountHook([session], session.id);

			fork('log-1');

			expect(getSessions()[0]).toBe(session);
			expect(setSessions).not.toHaveBeenCalled();
			expect(window.maestro.process.spawn).not.toHaveBeenCalled();
			expect(mockNotifyToast).toHaveBeenCalledWith(
				expect.objectContaining({
					type: 'warning',
					title: 'Grok native fork unavailable',
				})
			);
		});
	});

	describe('reference prompt context fork identity', () => {
		it.each([
			['claude-code', 'u1', 1],
			['claude-code', 'tool-1', 2],
			['codex', 'a1', 3],
		] as const)(
			'copies %s context through %s without resuming native history',
			async (toolType, logId, count) => {
				const logs: LogEntry[] = [
					{ id: 'u1', timestamp: 1, source: 'user', text: 'Selected question' },
					{ id: 'tool-1', timestamp: 2, source: 'tool', text: 'Historical tool evidence' },
					{ id: 'a1', timestamp: 3, source: 'stdout', text: 'Selected answer' },
					{ id: 'u2', timestamp: 4, source: 'user', text: 'Excluded later turn' },
				];
				const sourceTab = buildSourceTab({
					agentSessionId: 'source-native',
					logs,
					saveToHistory: true,
				});
				const session = buildSession({
					toolType,
					aiTabs: [sourceTab],
					cwd: '/remote/project',
					customEnvVars: { SELECTED_ACCOUNT: 'account-b' },
					sessionSshRemoteConfig: { enabled: true, remoteId: 'endpoint-b' },
				});
				const snapshot = structuredClone(sourceTab);
				const { fork, getSessions } = mountHook([session], session.id);

				fork(logId);

				await waitFor(() => expect(window.maestro.process.spawn).toHaveBeenCalledTimes(1));
				const [original, child] = getSessions()[0].aiTabs;
				expect(original).toEqual(snapshot);
				expect(child.agentSessionId).toBeNull();
				expect(child.nativeSessionBinding).toBeUndefined();
				expect(child.providerSessions).toBeUndefined();
				expect(child.awaitingSessionId).toBe(true);
				expect(child.saveToHistory).toBe(true);
				const spawn = vi.mocked(window.maestro.process.spawn).mock.calls[0][0];
				expect(spawn).toMatchObject({
					sessionId: `${session.id}-ai-${child.id}`,
					toolType,
					cwd: session.cwd,
					sessionCustomEnvVars: session.customEnvVars,
					sessionSshRemoteConfig: session.sessionSshRemoteConfig,
					args: ['--flag'],
				});
				expect(spawn.agentSessionId).toBeUndefined();
				expect(spawn.prompt).toContain(`at message ${count} of 4`);
				for (const [index, log] of logs.entries()) {
					if (index < count) expect(spawn.prompt).toContain(log.text);
					else expect(spawn.prompt).not.toContain(log.text);
				}
				expect(spawn.prompt).not.toContain('source-native');
				expect(mockNotifyToast.mock.calls[0][0].title).toBe('Conversation Forked');
				expect(
					[
						child.name,
						...child.logs.map((log) => log.text),
						mockNotifyToast.mock.calls[0][0].message,
					].join(' ')
				).not.toMatch(/native history|native fork|history duplicated/i);
			}
		);
	});

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

		// A fork names the source tab's resolved mode, never none (which
		// plans `standard` whatever the source tab shows).
		it.each([
			['an explicit standard tab', { permissionMode: 'standard' as const }, 'standard'],
			['a tab never set (the pill reads Full Access)', {}, 'full'],
			['a legacy read-only tab', { readOnlyMode: true }, 'readonly'],
		])('spawns and stamps the fork with the mode of %s', async (_label, tabFields, expected) => {
			const sourceTab = buildSourceTab(tabFields);
			const session = buildSession({ aiTabs: [sourceTab], activeTabId: sourceTab.id });
			const { fork, getSessions } = mountHook([session], session.id);

			fork('log-2');

			const newTab = getSessions()[0].aiTabs.find((t) => t.id !== 'source-tab')!;
			expect(newTab.permissionMode).toBe(expected);
			expect(newTab.readOnlyMode).toBe(expected === 'readonly');
			await waitFor(() => {
				expect((window as any).maestro.process.spawn).toHaveBeenCalledTimes(1);
			});
			const spawnArgs = (window as any).maestro.process.spawn.mock.calls[0][0];
			expect(spawnArgs.permissionMode).toBe(expected);
			expect(spawnArgs.readOnlyMode).toBe(expected === 'readonly');
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

			const sourceTab = buildSourceTab({ agentSessionId: 'retained-native' });
			const session = buildSession({ aiTabs: [sourceTab] });
			const sourceBefore = structuredClone(sourceTab);
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
			expect(after.aiTabs[0]).toEqual(sourceBefore);
			expect(newTab.agentSessionId).toBeNull();
			expect(newTab.nativeSessionBinding).toBeUndefined();
			expect(mockNotifyToast.mock.calls[0][0].message).not.toMatch(/native history|native fork/i);
			const errorLog = newTab.logs.find((l: LogEntry) => l.text?.startsWith('Error:'));
			expect(errorLog).toBeDefined();
			expect(errorLog!.source).toBe('system');
			expect(errorLog!.text).toContain('boom');
		});
	});
});
