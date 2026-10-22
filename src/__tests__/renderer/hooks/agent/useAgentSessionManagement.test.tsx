import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
	useAgentSessionManagement,
	isSynopsisRequest,
} from '../../../../renderer/hooks/agent/useAgentSessionManagement';
import type { UseAgentSessionManagementDeps } from '../../../../renderer/hooks/agent/useAgentSessionManagement';
import { useSessionStore } from '../../../../renderer/stores/sessionStore';
import { createMockAITab } from '../../../helpers/mockTab';
import { createMockSession } from '../../../helpers/mockSession';
import { prepareSessionForPersistence } from '../../../../renderer/hooks/utils/useDebouncedPersistence';
import type { Session } from '../../../../renderer/types';

const historyAdd = vi.fn().mockResolvedValue(true);

beforeEach(() => {
	vi.clearAllMocks();
	useSessionStore.setState({
		sessions: [],
		groups: [],
		activeSessionId: '',
		initialLoadComplete: false,
		removedWorktreePaths: new Set(),
	} as never);
	(window as any).maestro = {
		...((window as any).maestro || {}),
		history: { add: historyAdd },
	};
});

function seedActiveSession(session: Session | null) {
	if (session) {
		useSessionStore.setState({ sessions: [session], activeSessionId: session.id } as never);
	} else {
		useSessionStore.setState({ sessions: [], activeSessionId: null } as never);
	}
}

function makeDeps(_activeSession?: Session | null): UseAgentSessionManagementDeps {
	return {
		setSessions: vi.fn(),
		setActiveAgentSessionId: vi.fn(),
		setAgentSessionsOpen: vi.fn(),
		rightPanelRef: { current: null },
		defaultSaveToHistory: false,
		defaultShowThinking: 'off',
		showFlash: vi.fn(),
	};
}

/** Pull the entry object passed to the most recent `history.add` call. */
function lastAddedEntry(): Record<string, unknown> {
	const call = historyAdd.mock.calls.at(-1);
	return (call?.[0] ?? {}) as Record<string, unknown>;
}

describe('useAgentSessionManagement - history token source capture', () => {
	it('preserves an explicit background owner without borrowing the active tab', async () => {
		seedActiveSession(createMockSession({ toolType: 'claude-code' }));
		const { result } = renderHook(() => useAgentSessionManagement(makeDeps()));
		await act(async () => {
			await result.current.addHistoryEntry({
				type: 'USER',
				summary: 'background',
				agentSessionId: 'untracked-native',
				provider: 'codex',
			});
		});
		expect(lastAddedEntry().provider).toBe('codex');
		expect(lastAddedEntry().tokenSource).toBeUndefined();
	});

	it('keeps a closed tab turn owner when recording History', async () => {
		const tab = createMockAITab({
			id: 'closed',
			tabProvider: 'claude-code',
			turnProvider: 'codex',
		});
		const session = createMockSession({
			toolType: 'claude-code',
			aiTabs: [],
			closedTabHistory: [{ tab, index: 0, closedAt: 1 }],
		});
		seedActiveSession(session);
		const { result } = renderHook(() => useAgentSessionManagement(makeDeps()));
		await act(async () => {
			await result.current.addHistoryEntry({ type: 'USER', summary: 'closed turn', tabId: tab.id });
		});
		expect(lastAddedEntry().tokenSource).toBeUndefined();
		expect(lastAddedEntry().provider).toBe('codex');
	});

	it.each(['codex', 'claude-code'] as const)(
		'uses the captured %s turn owner after selection changes',
		async (provider) => {
			const tab = createMockAITab({
				id: 'owner',
				tabProvider: provider === 'codex' ? 'claude-code' : 'codex',
				turnProvider: provider,
			});
			const session = createMockSession({
				toolType: 'claude-code',
				aiTabs: [tab],
				activeTabId: tab.id,
			});
			seedActiveSession(session);
			const { result } = renderHook(() => useAgentSessionManagement(makeDeps()));
			await act(async () => {
				await result.current.addHistoryEntry({
					type: 'USER',
					summary: 'finished turn',
					tabId: tab.id,
				});
			});
			expect(lastAddedEntry().tokenSource).toBe(provider === 'claude-code' ? 'api' : undefined);
			expect(lastAddedEntry().provider).toBe(provider);
		}
	);

	it('stamps tokenSource/tokenSourceReason from a Claude Code session in TUI mode', async () => {
		const activeSession = createMockSession({
			id: 'sess-tui',
			toolType: 'claude-code',
			claudeInteractive: { mode: 'interactive', modeReason: 'auto' },
		} as Partial<Session>);

		seedActiveSession(activeSession);
		const { result } = renderHook(() => useAgentSessionManagement(makeDeps(activeSession)));
		await act(async () => {
			await result.current.addHistoryEntry({ type: 'USER', summary: 'a turn' });
		});

		expect(historyAdd).toHaveBeenCalledTimes(1);
		const entry = lastAddedEntry();
		expect(entry.tokenSource).toBe('interactive');
		expect(entry.tokenSourceReason).toBe('auto');
	});

	it('defaults a Claude session with no claudeInteractive to API (the default `claude --print` path)', async () => {
		const activeSession = createMockSession({
			id: 'sess-no-mode',
			toolType: 'claude-code',
			claudeInteractive: undefined,
		} as Partial<Session>);

		seedActiveSession(activeSession);
		const { result } = renderHook(() => useAgentSessionManagement(makeDeps(activeSession)));
		await act(async () => {
			await result.current.addHistoryEntry({ type: 'USER', summary: 'a turn' });
		});

		const entry = lastAddedEntry();
		// Absent claudeInteractive means the adaptive/maestro-p machinery never
		// engaged, so the turn ran plain `claude --print` (API). Every Claude turn
		// gets a token-source pill; only the reason is omitted when unknown.
		expect(entry.tokenSource).toBe('api');
		expect(entry).not.toHaveProperty('tokenSourceReason');
	});

	it('omits tokenSource for non-Claude sessions even if claudeInteractive is set', async () => {
		const activeSession = createMockSession({
			id: 'sess-codex',
			toolType: 'codex',
			claudeInteractive: { mode: 'interactive', modeReason: 'auto' },
		} as Partial<Session>);

		seedActiveSession(activeSession);
		const { result } = renderHook(() => useAgentSessionManagement(makeDeps(activeSession)));
		await act(async () => {
			await result.current.addHistoryEntry({ type: 'USER', summary: 'a turn' });
		});

		const entry = lastAddedEntry();
		expect(entry).not.toHaveProperty('tokenSource');
	});

	it('passes through an explicit tokenSource override from the caller', async () => {
		const activeSession = createMockSession({
			id: 'sess-override',
			toolType: 'claude-code',
			claudeInteractive: { mode: 'interactive', modeReason: 'auto' },
		} as Partial<Session>);

		seedActiveSession(activeSession);
		const { result } = renderHook(() => useAgentSessionManagement(makeDeps(activeSession)));
		await act(async () => {
			await result.current.addHistoryEntry({
				type: 'AUTO',
				summary: 'a background turn',
				tokenSource: 'api',
				tokenSourceReason: 'limit',
			});
		});

		const entry = lastAddedEntry();
		expect(entry.tokenSource).toBe('api');
		expect(entry.tokenSourceReason).toBe('limit');
	});
});

describe('isSynopsisRequest', () => {
	it('matches the current "Provide a brief synopsis" wording', () => {
		expect(
			isSynopsisRequest({
				type: 'user',
				content:
					'Provide a brief synopsis of what you just accomplished in this task using this exact format:',
			})
		).toBe(true);
	});

	it('matches the older "Give a brief synopsis" wording', () => {
		expect(
			isSynopsisRequest({
				type: 'user',
				content: 'Give a brief synopsis of what you just accomplished, in exactly this format:',
			})
		).toBe(true);
	});

	it('matches on role when type is absent', () => {
		expect(
			isSynopsisRequest({
				role: 'user',
				content: 'Provide a brief synopsis of what you just accomplished here',
			})
		).toBe(true);
	});

	it('does not match an assistant message that quotes the phrase', () => {
		expect(
			isSynopsisRequest({
				type: 'assistant',
				content: 'You asked me to provide a brief synopsis of what you just accomplished.',
			})
		).toBe(false);
	});

	it('does not match a user message that only mentions the phrase mid-sentence', () => {
		expect(
			isSynopsisRequest({
				type: 'user',
				content:
					'Earlier you gave a brief synopsis of what you just accomplished - can you expand?',
			})
		).toBe(false);
	});

	it('does not match unrelated user messages', () => {
		expect(isSynopsisRequest({ type: 'user', content: 'fix the layout bug' })).toBe(false);
	});
});

// A closed session's name survives only in the records that captured it (a
// history entry, a starred session's label). Resume has to accept that name, and
// has to reject the id label an unnamed tab records for itself.
describe('useAgentSessionManagement - naming a resumed session', () => {
	const AGENT_SESSION_ID = '8535e0e3-90ca-43c7-98ae-c42a09cf23ad';

	beforeEach(() => {
		(window as any).maestro = {
			...((window as any).maestro || {}),
			agentSessions: {
				read: vi.fn().mockResolvedValue({
					messages: [{ type: 'user', content: 'hello' }],
				}),
			},
			claude: { getSessionOrigins: vi.fn().mockResolvedValue({}) },
		};
	});

	/** Run the functional session updater and return the resulting tabs. */
	async function resumeWith(sessionName?: string) {
		const activeSession = createMockSession({
			id: 'sess-resume',
			toolType: 'claude-code',
			projectRoot: '/test/project',
			aiTabs: [],
			unifiedTabOrder: [],
		});
		seedActiveSession(activeSession);
		const deps = makeDeps(activeSession);
		const { result } = renderHook(() => useAgentSessionManagement(deps));

		await act(async () => {
			await result.current.handleResumeSession(
				AGENT_SESSION_ID,
				undefined,
				sessionName,
				undefined,
				undefined,
				'/test/project'
			);
		});

		const updater = (deps.setSessions as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0];
		expect(typeof updater).toBe('function');
		return (updater as (prev: Session[]) => Session[])([activeSession])[0].aiTabs;
	}

	it('focuses an already-loaded Relay conversation when Quick Resume supplies an empty message array and the transcript host is offline', async () => {
		const tab = createMockAITab({
			id: 'loaded',
			agentSessionId: AGENT_SESSION_ID,
			logs: [{ id: 'log', timestamp: 1, source: 'user', text: 'hello' }],
		});
		const session = createMockSession({
			id: 'target',
			projectRoot: '/project',
			toolType: 'claude-code',
			aiTabs: [tab],
			activeTabId: 'another',
		});
		seedActiveSession(session);
		vi.mocked(window.maestro.agentSessions.read).mockRejectedValue(new Error('offline'));
		vi.mocked(window.maestro.claude.getSessionOrigins).mockResolvedValue({
			[AGENT_SESSION_ID]: { origin: 'relay' },
		});
		const deps = makeDeps(session);
		deps.setSessions = useSessionStore.getState().setSessions;
		const { result } = renderHook(() => useAgentSessionManagement(deps));
		await act(async () => {
			expect(await result.current.handleResumeSession(AGENT_SESSION_ID, [])).toBe(true);
		});
		expect(window.maestro.agentSessions.read).not.toHaveBeenCalled();
		expect(useSessionStore.getState().sessions[0]).toMatchObject({
			activeTabId: 'loaded',
			aiTabs: [expect.objectContaining({ origin: 'relay' })],
		});
	});

	it('enriches a loaded tab with origin while preserving its current metadata over old History snapshots', async () => {
		const currentUsage = {
			inputTokens: 500,
			outputTokens: 300,
			cacheReadInputTokens: 0,
			cacheCreationInputTokens: 0,
			totalCostUsd: 1,
		};
		const tab = createMockAITab({
			id: 'loaded',
			agentSessionId: AGENT_SESSION_ID,
			name: 'Current name',
			usageStats: currentUsage,
			state: 'busy',
			inputValue: 'draft',
			logs: [{ id: 'log', timestamp: 1, source: 'user', text: 'hello' }],
		});
		const session = createMockSession({
			id: 'target',
			projectRoot: '/project',
			toolType: 'claude-code',
			aiTabs: [tab],
			activeTabId: 'another',
		});
		seedActiveSession(session);
		vi.mocked(window.maestro.claude.getSessionOrigins).mockResolvedValue({
			[AGENT_SESSION_ID]: { origin: 'relay' },
		});
		const deps = makeDeps(session);
		deps.setSessions = useSessionStore.getState().setSessions;
		const { result } = renderHook(() => useAgentSessionManagement(deps));
		await act(async () => {
			expect(
				await result.current.handleResumeSession(AGENT_SESSION_ID, [], 'Old history name', false, {
					...currentUsage,
					inputTokens: 1,
				})
			).toBe(true);
		});
		expect(useSessionStore.getState().sessions[0].aiTabs[0]).toEqual({
			...tab,
			origin: 'relay',
			tabProvider: 'claude-code',
		});
	});

	it('keeps Relay provenance on the tab through a persisted reload', async () => {
		vi.mocked(window.maestro.claude.getSessionOrigins).mockResolvedValue({
			[AGENT_SESSION_ID]: { origin: 'relay' },
		});
		const tabs = await resumeWith('Relay conversation');
		expect(tabs[0].origin).toBe('relay');
		const persisted = prepareSessionForPersistence(createMockSession({ aiTabs: tabs }));
		expect(JSON.parse(JSON.stringify(persisted)).aiTabs[0]).toMatchObject({
			origin: 'relay',
			state: 'idle',
		});
	});

	it('names the restored tab from the caller-supplied session name', async () => {
		const tabs = await resumeWith('PP Farm Meta Data');

		expect(tabs).toHaveLength(1);
		expect(tabs[0].agentSessionId).toBe(AGENT_SESSION_ID);
		expect(tabs[0].name).toBe('PP Farm Meta Data');
	});

	it('leaves the tab unnamed when the recorded name is just the id label', async () => {
		// A history entry for a tab that never got named records "8535E0E3".
		// Restoring that as a real name renders identically but permanently opts
		// the tab out of auto-naming.
		const tabs = await resumeWith('8535E0E3');

		expect(tabs[0].name).toBeNull();
	});

	it('leaves the tab unnamed when nothing supplies a name', async () => {
		const tabs = await resumeWith(undefined);

		expect(tabs[0].name).toBeNull();
	});
});

describe('useAgentSessionManagement - translated History ownership', () => {
	it('reads a pending History conversation and pins its original provider', async () => {
		const session = createMockSession({
			id: 'pending-agent',
			toolType: 'codex',
			projectRoot: '/test/project',
			aiTabs: [],
			providerTranslationTabInventory: [
				{
					id: 'history:old-claude',
					agentSessionId: null,
					providerSessions: { 'claude-code': { agentSessionId: 'old-claude' } },
				},
			],
		});
		window.maestro.agentSessions.read = vi
			.fn()
			.mockResolvedValue({ messages: [{ type: 'user', content: 'kept history' }] });
		window.maestro.claude.getSessionOrigins = vi.fn().mockResolvedValue({});
		seedActiveSession(session);
		const deps = makeDeps(session);
		const { result } = renderHook(() => useAgentSessionManagement(deps));
		await act(async () => {
			expect(await result.current.handleResumeSession('old-claude')).toBe(true);
		});
		expect(window.maestro.agentSessions.read).toHaveBeenCalledWith(
			'claude-code',
			'/test/project',
			'old-claude',
			expect.any(Object),
			undefined
		);
		const updater = vi.mocked(deps.setSessions).mock.calls.at(-1)![0] as (
			sessions: Session[]
		) => Session[];
		const resumed = updater([session])[0];
		expect(resumed.aiTabs[0]).toMatchObject({
			agentSessionId: 'old-claude',
			tabProvider: 'claude-code',
			providerSessions: { codex: { agentSessionId: null } },
		});
		// A second click reuses the pinned native tab.
		expect(updater([resumed])[0].aiTabs).toHaveLength(1);
	});
	it('refuses a History entry without a destination native mapping before creating a tab', async () => {
		const session = createMockSession({
			id: 'translated-agent',
			toolType: 'codex',
			providerTranslationHistoryMappings: [
				{ tabId: 'history:unmapped', sourceSessionId: 'unmapped', destinationSessionId: null },
			],
		});
		seedActiveSession(session);
		const deps = makeDeps(session);
		const { result } = renderHook(() => useAgentSessionManagement(deps));
		let resumed: boolean | undefined;
		await act(async () => {
			resumed = await result.current.handleResumeSession('unmapped');
		});
		expect(resumed).toBe(false);
		expect(deps.showFlash).toHaveBeenCalledWith(expect.stringContaining('no native mapping'));
		expect(deps.setSessions).not.toHaveBeenCalled();
	});
});
