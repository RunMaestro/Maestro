import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
	useAgentSessionManagement,
	isSynopsisRequest,
} from '../../../../renderer/hooks/agent/useAgentSessionManagement';
import type {
	ResumeSessionOptions,
	UseAgentSessionManagementDeps,
} from '../../../../renderer/hooks/agent/useAgentSessionManagement';
import { useSessionStore } from '../../../../renderer/stores/sessionStore';
import { createMockAITab } from '../../../helpers/mockTab';
import { createMockSession } from '../../../helpers/mockSession';
import { prepareSessionForPersistence } from '../../../../renderer/hooks/utils/useDebouncedPersistence';
import type { Session } from '../../../../renderer/types';
import type { NativeSessionBinding } from '../../../../shared/maestro-lib/agents/providerSwap';

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
		setSessions: vi.fn(useSessionStore.getState().setSessions),
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

		return useSessionStore.getState().sessions[0].aiTabs;
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
		expect(useSessionStore.getState().sessions[0].aiTabs[0]).toEqual({ ...tab, origin: 'relay' });
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

describe('useAgentSessionManagement - scoped Grok commit races', () => {
	const binding = {
		version: 1,
		state: 'bound',
		provider: 'grok',
		nativeSessionId: 'native',
		accountRef: 'account-a',
		host: { kind: 'local', identity: 'machine-a' },
		cwd: '/test/project',
	} satisfies NativeSessionBinding;
	const retained = createMockAITab({
		id: 'loaded',
		agentSessionId: binding.nativeSessionId,
		nativeSessionBinding: binding,
		logs: [{ id: 'kept', timestamp: 1, source: 'user', text: 'retained' }],
		name: 'Current name',
		inputValue: 'draft',
		usageStats: {
			inputTokens: 10,
			outputTokens: 2,
			cacheReadInputTokens: 3,
			cacheCreationInputTokens: 0,
			totalCostUsd: 1,
			contextWindow: 200000,
		},
	});
	const receipt = {
		messages: [{ type: 'user', content: 'native', timestamp: '2026-10-31', uuid: 'native' }],
		total: 1,
		hasMore: false,
		source: { provider: 'grok', status: 'available' },
		nativeSessionBinding: binding,
	} satisfies Awaited<ReturnType<typeof window.maestro.agentSessions.read>>;

	beforeEach(() => {
		seedActiveSession(
			createMockSession({
				toolType: 'grok',
				aiTabs: [retained],
				activeTabId: 'other',
				contextUsage: 42,
			})
		);
		window.maestro.agentSessions = {
			...window.maestro.agentSessions,
			read: vi.fn().mockResolvedValue(receipt),
		};
	});

	function pendingResume(deps = makeDeps()) {
		let finish!: (value: typeof receipt) => void;
		vi.mocked(window.maestro.agentSessions.read).mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				})
		);
		const { result } = renderHook(() => useAgentSessionManagement(deps));
		const resume = (name?: string, options?: ResumeSessionOptions) =>
			result.current.handleResumeSession(
				'native',
				[],
				name,
				false,
				{ ...retained.usageStats!, inputTokens: 1 },
				undefined,
				{ nativeSessionBinding: binding, ...options }
			);
		return { deps, resume, finish: () => finish(receipt) };
	}

	it.each([
		['selection changed', {}],
		['owner removed', {}],
		['provider', { toolType: 'codex' }],
		['cwd', { cwd: '/changed' }],
		['project root', { projectRoot: '/changed' }],
		['remote cwd', { remoteCwd: '/changed' }],
		['observed SSH', { sshRemoteId: 'remote-b' }],
		['configured SSH', { sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-b' } }],
		['account environment', { customEnvVars: { GROK_HOME: '/other-account' } }],
		['other environment', { customEnvVars: { ROUTE: 'different' } }],
		['executable', { customPath: '/changed/grok' }],
		['arguments', { customArgs: '--other' }],
		['tab removed', { aiTabs: [] }],
		[
			'tab rebound',
			{ aiTabs: [{ ...retained, nativeSessionBinding: { ...binding, accountRef: 'account-b' } }] },
		],
	] satisfies [string, Partial<Session>][])(
		'refuses a pending read after %s changes',
		async (change, patch) => {
			const { resume, finish, deps } = pendingResume();
			const pending = resume();
			if (change === 'owner removed') useSessionStore.setState({ sessions: [] });
			else if (change === 'selection changed')
				useSessionStore.setState({ activeSessionId: 'other' });
			else
				useSessionStore
					.getState()
					.setSessions((sessions) => sessions.map((session) => ({ ...session, ...patch })));
			const before = useSessionStore.getState();
			await act(async () => {
				finish();
				expect(await pending).toBe(false);
			});
			expect(useSessionStore.getState()).toEqual(before);
			expect(deps.setActiveAgentSessionId).not.toHaveBeenCalled();
		}
	);

	it('keeps the newest request and its committed tab when an older read resolves last', async () => {
		useSessionStore
			.getState()
			.setSessions((sessions) => sessions.map((session) => ({ ...session, aiTabs: [] })));
		const { resume, finish, deps } = pendingResume();
		const older = resume('Old');
		await act(async () => {
			expect(await resume('New')).toBe(true);
		});
		const before = useSessionStore.getState().sessions;
		await act(async () => {
			finish();
			expect(await older).toBe(false);
		});
		expect(useSessionStore.getState().sessions).toBe(before);
		expect(before[0].aiTabs).toEqual([
			expect.objectContaining({ name: 'New', nativeSessionBinding: binding }),
		]);
		expect(deps.setActiveAgentSessionId).toHaveBeenCalledExactlyOnceWith('native');
	});

	it('focuses a matching tab added during the read without duplicating or replacing metadata', async () => {
		useSessionStore
			.getState()
			.setSessions((sessions) => sessions.map((session) => ({ ...session, aiTabs: [] })));
		const { resume, finish } = pendingResume();
		const pending = resume('Old name');
		useSessionStore
			.getState()
			.setSessions((sessions) => sessions.map((session) => ({ ...session, aiTabs: [retained] })));
		await act(async () => {
			finish();
			expect(await pending).toBe(true);
		});
		expect(useSessionStore.getState().sessions[0]).toMatchObject({
			activeTabId: 'loaded',
			aiTabs: [retained],
			contextUsage: 42,
		});
		expect(useSessionStore.getState().sessions[0].aiTabs).toHaveLength(1);
	});

	it.each([
		'inert updater',
		'owner disappears at commit',
		'caller rejects updater entry',
		'caller rejects proposed tab',
		'subscriber navigates',
		'subscriber removes owner',
	])('returns false instead of overwriting newer selection: %s', async (failure) => {
		let admitted = true;
		const deps = makeDeps();
		if (failure === 'inert updater') deps.setSessions = vi.fn();
		if (failure === 'owner disappears at commit')
			deps.setSessions = vi.fn((updater) => {
				useSessionStore.setState({ sessions: [] });
				useSessionStore.getState().setSessions(updater);
			});
		if (failure === 'caller rejects updater entry')
			deps.setSessions = vi.fn((updater) => {
				admitted = false;
				useSessionStore.getState().setSessions(updater);
			});
		const unsubscribe = useSessionStore.subscribe((state) => {
			if (
				failure.startsWith('subscriber') &&
				state.sessions[0]?.activeTabId === 'loaded' &&
				state.activeSessionId !== 'other'
			)
				useSessionStore.setState(
					failure === 'subscriber navigates' ? { activeSessionId: 'other' } : { sessions: [] }
				);
		});
		try {
			const { resume, finish } = pendingResume(deps);
			const pending = resume(undefined, {
				canResume: (next) =>
					admitted && (failure !== 'caller rejects proposed tab' || next === undefined),
			});
			await act(async () => {
				finish();
				expect(await pending).toBe(false);
			});
			expect(deps.setActiveAgentSessionId).not.toHaveBeenCalled();
			if (failure === 'subscriber navigates') {
				expect(useSessionStore.getState().activeSessionId).toBe('other');
				expect(useSessionStore.getState().sessions[0].aiTabs).toEqual([retained]);
			} else expect(useSessionStore.getState().sessions[0]?.activeTabId).not.toBe('loaded');
		} finally {
			unsubscribe();
		}
	});

	it.each(['before read', 'after read'])('honors caller admission %s', async (boundary) => {
		const { resume, finish, deps } = pendingResume();
		let admitted = boundary !== 'before read';
		const pending = resume(undefined, { canResume: () => admitted });
		admitted = false;
		await act(async () => {
			if (boundary === 'after read') finish();
			expect(await pending).toBe(false);
		});
		expect(window.maestro.agentSessions.read).toHaveBeenCalledTimes(
			boundary === 'before read' ? 0 : 1
		);
		expect(deps.setSessions).not.toHaveBeenCalled();
		expect(deps.setActiveAgentSessionId).not.toHaveBeenCalled();
	});
});
