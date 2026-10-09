import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSessionTranscriptSync } from '../../../../renderer/hooks/session/useSessionTranscriptSync';
import { useBatchedSessionUpdates } from '../../../../renderer/hooks/session/useBatchedSessionUpdates';
import { useAgentDataListener } from '../../../../renderer/hooks/agent/internal/useAgentDataListener';
import { useAgentStderrListener } from '../../../../renderer/hooks/agent/internal/useAgentStderrListener';
import { useAgentToolExecutionListener } from '../../../../renderer/hooks/agent/internal/useAgentToolExecutionListener';
import { useAgentUserInputListener } from '../../../../renderer/hooks/agent/internal/useAgentUserInputListener';
import { useSessionStore } from '../../../../renderer/stores/sessionStore';
import { createMockSession } from '../../../helpers/mockSession';
import { createMockAITab } from '../../../helpers/mockTab';
import type { LogEntry, TerminalTab } from '../../../../renderer/types';
import type { BrowserTab } from '../../../../shared/browserPage';
import type { SessionTranscriptPatch } from '../../../../shared/sessionTranscript';

let web = false;
vi.mock('../../../../renderer/utils/runtimeContext', () => ({ isWebDesktop: () => web }));
const ready = async () => {};
let receive: (patch: SessionTranscriptPatch<LogEntry>) => void;
let data: (sessionId: string, data: string) => void;
let stderr: (sessionId: string, data: string) => void;
let tool: Parameters<NonNullable<typeof window.maestro.process.onToolExecution>>[0];
let user: Parameters<typeof window.maestro.process.onUserInput>[0];
let request: (payload: { sessionId: string; tabId: string; requestId: string }) => void;
let published: SessionTranscriptPatch<LogEntry>[];

beforeEach(() => {
	web = false;
	published = [];
	useSessionStore.setState({ sessions: [], activeSessionId: '', initialLoadComplete: true });
	window.maestro = {
		...window.maestro,
		sessions: {
			...window.maestro.sessions,
			onTranscriptSync: (handler) => {
				receive = handler;
				return () => {};
			},
			onTranscriptRequest: (handler) => {
				request = handler;
				return () => {};
			},
			publishTranscript: vi.fn(async (patch) => {
				published.push(structuredClone(patch));
				return true;
			}),
		},
		process: {
			...window.maestro.process,
			onData: (handler) => {
				data = handler;
				return () => {};
			},
			onStderr: (handler) => {
				stderr = handler;
				return () => {};
			},
			onToolExecution: (handler) => {
				tool = handler;
				return () => {};
			},
			onUserInput: (handler) => {
				user = handler;
				return () => {};
			},
		},
	};
});

describe('owning host transcript identities', () => {
	it('keeps two mirrors on the exact host stdout, stderr, tool and user rows without generating their own output IDs', async () => {
		const tab = createMockAITab({ id: 'tab', logs: [], showThinking: 'sticky' });
		const session = createMockSession({ id: 'session', aiTabs: [tab], activeTabId: 'tab' });
		useSessionStore.setState({ sessions: [session] });
		const mount = () =>
			renderHook(() => {
				const batched = useBatchedSessionUpdates();
				useSessionTranscriptSync(ready);
				useAgentDataListener({
					batchedUpdater: batched,
					activeHiddenToolRef: { current: new Map() },
				});
				useAgentStderrListener({ batchedUpdater: batched });
				useAgentToolExecutionListener();
				useAgentUserInputListener();
				return batched;
			});
		const host = mount();
		await act(async () => {
			user({
				originId: 'remote-origin',
				sessionId: 'session',
				tabId: 'tab',
				inputMode: 'ai',
				entry: { id: 'user-one', timestamp: 1, source: 'user', text: 'same text' },
			});
			data('session-ai-tab', 'same text');
			host.result.current.flushNow();
			tool('session-ai-tab', { toolName: 'Read', timestamp: 2, state: { status: 'completed' } });
			user({
				originId: 'remote-origin',
				sessionId: 'session',
				tabId: 'tab',
				inputMode: 'ai',
				entry: { id: 'user-two', timestamp: 3, source: 'user', text: 'same text' },
			});
			stderr('session-ai-tab', 'error output');
			host.result.current.flushNow();
			useSessionStore.getState().setSessions((sessions) =>
				sessions.map((row) => ({
					...row,
					aiTabs: row.aiTabs.map((item) => ({
						...item,
						agentSessionId: 'host-session-id',
						awaitingSessionId: false,
					})),
				}))
			);
		});
		const canonical = structuredClone(useSessionStore.getState().sessions[0].aiTabs[0].logs);
		expect(canonical.filter((row) => row.source === 'user').map((row) => row.id)).toEqual([
			'user-one',
			'user-two',
		]);
		expect(canonical.map((row) => row.source)).toEqual([
			'user',
			'stdout',
			'tool',
			'user',
			'stderr',
		]);
		await act(async () => {
			request({ sessionId: 'session', tabId: 'tab', requestId: 'reconnect' });
		});
		const snapshot = [...published]
			.reverse()
			.find((patch) => patch.snapshot && patch.tabId === 'tab')!;
		const frames = published.filter((patch) => !patch.snapshot);
		host.unmount();
		web = true;
		for (let client = 0; client < 2; client++) {
			useSessionStore.setState({ sessions: [structuredClone(session)] });
			const mirror = mount();
			await act(async () => {
				data('session-ai-tab', 'same text');
				stderr('session-ai-tab', 'error output');
				tool('session-ai-tab', { toolName: 'Read', timestamp: 2, state: { status: 'completed' } });
				mirror.result.current.flushNow();
				for (const frame of frames) receive(frame);
			});
			expect(useSessionStore.getState().sessions[0].aiTabs[0].logs).toEqual(canonical);
			expect(useSessionStore.getState().sessions[0].aiTabs[0].agentSessionId).toBe(
				'host-session-id'
			);
			expect(useSessionStore.getState().sessions[0].aiTabs[0].awaitingSessionId).toBe(false);
			await act(async () => {
				receive(snapshot);
				receive(snapshot);
			});
			expect(useSessionStore.getState().sessions[0].aiTabs[0].logs).toEqual(canonical);
			mirror.unmount();
		}
	});

	it('marks only newly received output unread relative to this client and does not re-mark replayed or bootstrap rows', async () => {
		web = true;
		const tab = createMockAITab({ id: 'tab', logs: [], hasUnread: false, isAtBottom: true });
		const session = createMockSession({ id: 'session', aiTabs: [tab], activeTabId: 'tab' });
		const patch: SessionTranscriptPatch<LogEntry> = {
			sessionId: 'session',
			tabId: 'tab',
			field: 'logs',
			upserts: [{ id: 'canonical-output', timestamp: 1, source: 'stdout', text: 'new output' }],
			removedIds: [],
			orderIds: ['canonical-output'],
		};
		useSessionStore.setState({ sessions: [session], activeSessionId: 'another-agent' });
		const mirror = renderHook(() => useSessionTranscriptSync(ready));
		await act(async () => {
			receive(patch);
		});
		expect(useSessionStore.getState().sessions[0].aiTabs[0].hasUnread).toBe(true);
		await act(async () => {
			useSessionStore.getState().setSessions((sessions) =>
				sessions.map((row) => ({
					...row,
					aiTabs: row.aiTabs.map((item) => ({ ...item, hasUnread: false })),
				}))
			);
			receive(patch);
		});
		expect(useSessionStore.getState().sessions[0].aiTabs[0].hasUnread).toBe(false);
		await act(async () => {
			receive({
				...patch,
				snapshot: true,
				upserts: [{ ...patch.upserts[0], text: 'historic rebootstrap output' }],
			});
		});
		expect(useSessionStore.getState().sessions[0].aiTabs[0].hasUnread).toBe(false);
		await act(async () => {
			useSessionStore.setState({
				sessions: [{ ...session, aiTabs: [{ ...tab, hasUnread: true }] }],
				activeSessionId: 'session',
			});
			receive(patch);
		});
		expect(useSessionStore.getState().sessions[0].aiTabs[0].hasUnread).toBe(false);
		mirror.unmount();
	});

	it('reconciles live incognito inventory and PID-zero initialization without copying host focus or terminal drafts', async () => {
		web = true;
		const privateTab: BrowserTab = {
			id: 'private',
			url: 'https://example.test',
			title: 'Private',
			ephemeral: true,
			createdAt: 1,
			canGoBack: false,
			canGoForward: false,
			isLoading: false,
		};
		const terminal: TerminalTab = {
			id: 'terminal',
			name: null,
			shellType: 'sh',
			pid: 0,
			ptyInitialized: false,
			cwd: '/host',
			createdAt: 1,
			state: 'idle',
		};
		const session = createMockSession({
			id: 'session',
			activeBrowserTabId: 'private',
			activeGroupId: 'client-group',
			terminalDraftInput: 'client draft',
			browserTabs: [{ ...privateTab, id: 'closed', title: 'Closed', ephemeral: false }, privateTab],
			terminalTabs: [terminal],
		});
		useSessionStore.setState({ sessions: [session], activeSessionId: 'session' });
		const mirror = renderHook(() => useSessionTranscriptSync(ready));
		await act(async () => {
			receive({
				sessionId: 'session',
				field: 'shellLogs',
				upserts: [],
				removedIds: [],
				orderIds: [],
				snapshot: true,
				runtime: {
					browserTabs: [{ ...privateTab, title: 'Host title', partition: 'temporary-host' }],
					terminalTabs: [
						{ ...terminal, ptyInitialized: true },
						{ ...terminal, id: 'new-terminal', ptyInitialized: true },
					],
				},
			});
		});
		const current = useSessionStore.getState().sessions[0];
		expect(current.browserTabs?.map((row) => row.id)).toEqual(['private']);
		expect(current.browserTabs?.[0]).toMatchObject({
			title: 'Host title',
			ephemeral: true,
			partition: 'temporary-host',
		});
		expect(current.activeBrowserTabId).toBe('private');
		expect(current.activeGroupId).toBe('client-group');
		expect(
			current.terminalTabs?.map((row) => ({
				id: row.id,
				pid: row.pid,
				initialized: row.ptyInitialized,
			}))
		).toEqual([
			{ id: 'terminal', pid: 0, initialized: true },
			{ id: 'new-terminal', pid: 0, initialized: true },
		]);
		expect(current.terminalDraftInput).toBe('client draft');
		mirror.unmount();
	});
});
