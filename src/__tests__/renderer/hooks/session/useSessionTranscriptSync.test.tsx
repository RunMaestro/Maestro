import * as permissionRegistry from '../../../../main/permission-relay/registry';
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
import { useAgentThinkingListener } from '../../../../renderer/hooks/agent/internal/useAgentThinkingListener';
import { OmpOutputParser } from '../../../../main/parsers/omp-output-parser';

let web = false;
vi.mock('../../../../renderer/utils/runtimeContext', () => ({ isWebDesktop: () => web }));
const ready = async () => {};
let receive: (patch: SessionTranscriptPatch<LogEntry>) => void;
let data: (sessionId: string, data: string) => void;
let stderr: (sessionId: string, data: string) => void;
let thinking: (sessionId: string, data: string) => void;
let tool: Parameters<NonNullable<typeof window.maestro.process.onToolExecution>>[0];
let user: Parameters<typeof window.maestro.process.onUserInput>[0];
let request: (payload: {
	sessionId: string;
	tabId: string;
	requestId: string;
	metadataOnly?: boolean;
}) => void;
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
			onThinkingChunk: (handler) => {
				thinking = handler;
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
	it('keeps two mirrors on the exact host OMP thinking, stdout, stderr, tool and user rows without generating their own output IDs', async () => {
		const tab = createMockAITab({ id: 'tab', logs: [], showThinking: 'sticky' });
		const session = createMockSession({
			id: 'session',
			toolType: 'omp',
			aiTabs: [tab],
			activeTabId: 'tab',
		});
		useSessionStore.setState({ sessions: [session] });
		const mount = () =>
			renderHook(() => {
				const batched = useBatchedSessionUpdates();
				useSessionTranscriptSync(ready);
				useAgentDataListener({
					batchedUpdater: batched,
					activeHiddenToolRef: { current: new Map() },
				});
				useAgentThinkingListener();
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
			const parser = new OmpOutputParser();
			const reasoning = parser.parseJsonLine(
				JSON.stringify({
					type: 'message_update',
					assistantMessageEvent: { type: 'thinking_delta', delta: 'Checking the remote project.' },
				})
			);
			expect(reasoning?.isReasoning).toBe(true);
			thinking('session-ai-tab', reasoning!.text!);
			await vi.waitFor(() =>
				expect(
					useSessionStore
						.getState()
						.sessions[0].aiTabs[0].logs.some((row) => row.source === 'thinking')
				).toBe(true)
			);
			const output = parser.parseJsonLine(
				JSON.stringify({
					type: 'message_update',
					assistantMessageEvent: { type: 'text_delta', delta: 'same text' },
				})
			);
			data('session-ai-tab', output!.text!);
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
			'thinking',
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
				thinking('session-ai-tab', 'Checking the remote project.');
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

	it('returns live runtime inventory without copying transcript rows for metadata-only bootstrap reads', async () => {
		const browserTabs: BrowserTab[] = [
			{
				id: 'browser',
				url: 'https://example.test',
				title: 'Host browser',
				createdAt: 1,
				canGoBack: false,
				canGoForward: false,
				isLoading: false,
			},
		];
		const terminalTabs: TerminalTab[] = [
			{
				id: 'terminal',
				name: null,
				shellType: 'sh',
				pid: 0,
				ptyInitialized: false,
				cwd: '/host',
				createdAt: 1,
				state: 'idle',
			},
		];
		const shellLogs: LogEntry[] = Array.from({ length: 1000 }, (_, i) => ({
			id: 'shell-' + i,
			timestamp: i,
			source: 'stdout',
			text: 'Host terminal output',
		}));
		const session = createMockSession({ id: 'session', shellLogs, browserTabs, terminalTabs });
		useSessionStore.setState({ sessions: [session], activeSessionId: 'session' });
		const owner = renderHook(() => useSessionTranscriptSync(ready));
		await act(async () => {
			request({ sessionId: 'session', tabId: '', requestId: 'inventory', metadataOnly: true });
		});
		const snapshot = published.find((patch) => patch.snapshot)!;
		expect(snapshot.upserts).toEqual([]);
		expect(snapshot.removedIds).toEqual([]);
		expect(snapshot.orderIds).toEqual([]);
		expect(snapshot.runtime?.browserTabs).toEqual(browserTabs);
		expect(snapshot.runtime?.terminalTabs).toEqual(terminalTabs);
		expect(useSessionStore.getState().sessions[0].shellLogs).toEqual(shellLogs);
		owner.unmount();
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

describe('real permission relay runtime producer', () => {
	it('projects a real pending request into host runtime until the last decision resolves', async () => {
		const first = permissionRegistry.registerSpawn({ sessionId: 'agent-ai-tab-1', tabId: 'tab-1' });
		const second = permissionRegistry.registerSpawn({
			sessionId: 'agent-ai-tab-2',
			tabId: 'tab-2',
		});
		window.maestro.process.getPendingPermissions = vi.fn(async () =>
			permissionRegistry.getPendingPermissionSnapshot()
		);
		window.maestro.process.onPendingPermissionsChanged = (handler) =>
			permissionRegistry.subscribePendingPermissions(handler);
		useSessionStore.setState({
			sessions: [
				createMockSession({
					id: 'agent',
					state: 'busy',
					aiTabs: [
						createMockAITab({ id: 'tab-1', state: 'busy' }),
						createMockAITab({ id: 'tab-2', state: 'busy' }),
					],
				}),
			],
		});
		const view = renderHook(() => useSessionTranscriptSync(ready));
		try {
			await act(async () => {
				void permissionRegistry.createPending('real-first', first.token);
			});
			expect(useSessionStore.getState().sessions[0].state).toBe('waiting_input');
			expect(published.some((patch) => patch.runtime?.state === 'waiting_input')).toBe(true);
			act(() => useSessionStore.getState().updateSession('agent', { state: 'busy' }));
			expect(useSessionStore.getState().sessions[0].state).toBe('waiting_input');
			expect(published.filter((patch) => patch.field === 'shellLogs').at(-1)?.runtime?.state).toBe(
				'waiting_input'
			);

			await act(async () => {
				void permissionRegistry.createPending('real-second', second.token);
			});
			await act(async () => {
				permissionRegistry.resolvePending('real-first', { behavior: 'allow' });
			});
			expect(useSessionStore.getState().sessions[0].state).toBe('waiting_input');
			await act(async () => {
				permissionRegistry.resolvePending('real-second', { behavior: 'deny', message: 'No' });
			});
			expect(useSessionStore.getState().sessions[0].state).toBe('busy');
		} finally {
			view.unmount();
			first.cleanup();
			second.cleanup();
			delete (window.maestro.process as any).getPendingPermissions;
			delete (window.maestro.process as any).onPendingPermissionsChanged;
		}
	});
	it('ignores an initial registry snapshot that arrives after a newer request', async () => {
		const spawn = permissionRegistry.registerSpawn({ sessionId: 'agent-ai-tab-1', tabId: 'tab-1' });
		const before = permissionRegistry.getPendingPermissionSnapshot();
		let finish!: (snapshot: typeof before) => void;
		window.maestro.process.getPendingPermissions = vi.fn(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				})
		);
		window.maestro.process.onPendingPermissionsChanged =
			permissionRegistry.subscribePendingPermissions;
		useSessionStore.setState({
			sessions: [
				createMockSession({
					id: 'agent',
					state: 'busy',
					aiTabs: [createMockAITab({ id: 'tab-1', state: 'busy' })],
				}),
			],
		});
		const view = renderHook(() => useSessionTranscriptSync(ready));
		try {
			await act(async () => {
				void permissionRegistry.createPending('registry-race', spawn.token);
			});
			expect(useSessionStore.getState().sessions[0].state).toBe('waiting_input');
			await act(async () => finish(before));
			expect(useSessionStore.getState().sessions[0].state).toBe('waiting_input');
		} finally {
			view.unmount();
			spawn.cleanup();
			delete (window.maestro.process as any).getPendingPermissions;
			delete (window.maestro.process as any).onPendingPermissionsChanged;
		}
	});
});
