import * as permissionRegistry from '../../../../main/permission-relay/registry';
import { useSessionTranscriptSync } from '../../../../renderer/hooks/session/useSessionTranscriptSync';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserWindow, ipcMain } from 'electron';
import {
	registerPersistenceHandlers,
	type PersistenceHandlerDependencies,
} from '../../../../main/ipc/handlers/persistence';
import { broadcastBridgeEvent } from '../../../../main/web-server/handlers/bridgeHandlers';
import { WindowProvider } from '../../../../renderer/contexts/WindowContext';
import { useSessionRestoration } from '../../../../renderer/hooks/session/useSessionRestoration';
import { useSessionStore } from '../../../../renderer/stores/sessionStore';
import { useGroupChatStore } from '../../../../renderer/stores/groupChatStore';
import { createMockSession } from '../../../helpers/mockSession';
import { createMockAITab } from '../../../helpers/mockTab';
import type { SessionTranscriptPatch } from '../../../../shared/sessionTranscript';
import { WEB_BRIDGE_RECONCILE_EVENT } from '../../../../shared/webClientConfig';

vi.mock('electron', async () => {
	const { join } = await import('node:path');
	const { tmpdir } = await import('node:os');
	return {
		ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
		app: { getPath: vi.fn(() => join(tmpdir(), 'maestro-bootstrap-test')), on: vi.fn() },
		BrowserWindow: { getAllWindows: vi.fn(() => []) },
	};
});
vi.mock('../../../../main/plugins/plugin-media-tools', () => ({
	getMediaToolStatus: vi.fn(),
	resolveMediaRuntime: vi.fn(),
	resolveMediaModelDirectory: vi.fn(),
}));
vi.mock('../../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../../main/web-server/handlers/bridgeHandlers', () => ({
	broadcastBridgeEvent: vi.fn(),
}));
const runtime = vi.hoisted(() => ({ web: true }));
vi.mock('../../../../renderer/utils/runtimeContext', () => ({
	isWebDesktop: () => runtime.web,
	isElectronDesktop: () => !runtime.web,
}));
vi.mock('../../../../renderer/services/git', () => ({
	gitService: { isRepo: vi.fn().mockResolvedValue(false) },
}));

// Exercise the real main IPC handler and browser restoration together. Only the
// Electron transport, stored records, and owning host process are boundaries.
const handlers = new Map<string, (...args: any[]) => any>();
let stored: ReturnType<typeof createMockSession>[];
let hostRuntime: Map<string, Record<string, unknown>>;
let receive: ((patch: SessionTranscriptPatch) => void) | undefined;
let holdReplies: boolean;
let pendingReplies: (() => void)[];
let bootstrapResponses: Awaited<ReturnType<typeof window.maestro.sessions.getBootstrap>>[];

beforeEach(() => {
	vi.clearAllMocks();
	runtime.web = true;
	handlers.clear();
	receive = undefined;
	bootstrapResponses = [];
	holdReplies = false;
	pendingReplies = [];
	document.title = 'Maestro';
	stored = ['selected', 'waiting-a', 'waiting-b'].map((id) =>
		createMockSession({
			id,
			state: 'idle',
			activeTabId: 'tab-1',
			aiTabs: [createMockAITab({ id: 'tab-1', logs: [] })],
		})
	);
	hostRuntime = new Map([
		['selected', { state: 'idle' }],
		['waiting-a', { state: 'waiting_input' }],
		['waiting-b', { state: 'waiting_input' }],
	]);
	vi.mocked(ipcMain.handle).mockImplementation((channel, handler) => {
		handlers.set(channel, handler);
	});
	registerPersistenceHandlers({
		settingsStore: { get: (_key: string, fallback: unknown) => fallback, store: {} },
		sessionsStore: {
			get: (key: string, fallback: unknown) => (key === 'sessions' ? stored : fallback),
		},
		groupsStore: { get: (_key: string, fallback: unknown) => fallback },
		getWebServer: () => null,
	} as unknown as PersistenceHandlerDependencies);
	vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([
		{
			isDestroyed: () => false,
			webContents: {
				id: 1,
				isDestroyed: () => false,
				send: (
					channel: string,
					request: {
						sessionId: string;
						tabId: string;
						requestId: string;
						metadataOnly: boolean;
					}
				) => {
					if (channel !== 'sessions:transcriptRequest') return;
					expect(request.metadataOnly).toBe(true);
					expect(request.tabId).toBe('');
					const runtime = { ...hostRuntime.get(request.sessionId) };
					const publish = () =>
						handlers.get('sessions:publishTranscript')!(
							{ sender: { id: 1 } },
							{
								sessionId: request.sessionId,
								field: 'shellLogs',
								upserts: [],
								removedIds: [],
								orderIds: [],
								snapshot: true,
								runtime,
							},
							request.requestId
						);
					if (holdReplies) pendingReplies.push(publish);
					else publish();
				},
			},
		},
	] as unknown as BrowserWindow[]);
	vi.mocked(broadcastBridgeEvent).mockImplementation((channel, args) => {
		if (channel === 'sessions:transcriptSync') receive?.(args[0] as SessionTranscriptPatch);
	});
	useSessionStore.setState({
		sessions: [],
		activeSessionId: '',
		sessionsLoaded: false,
		initialLoadComplete: false,
		sessionsReadOk: false,
		groupsLoaded: false,
	});
	useGroupChatStore.setState({ groupChats: [] });
	window.maestro.sessions = {
		...window.maestro.sessions,
		getBootstrap: vi.fn(async () => {
			const response = JSON.parse(
				JSON.stringify(await handlers.get('sessions:getBootstrap')!({ type: 'bridge' }))
			);
			bootstrapResponses.push(response);
			return response;
		}),
		getActiveSessionId: vi.fn().mockResolvedValue('selected'),
		setActiveSessionId: vi.fn(),
		onTranscriptSync: (handler) => {
			receive = handler;
			return () => {
				receive = undefined;
			};
		},
		publishTranscript: vi.fn().mockResolvedValue(true),
	};
	window.maestro.groups.getAll = vi.fn().mockResolvedValue([]);
	window.maestro.groupChat = { ...window.maestro.groupChat, list: vi.fn().mockResolvedValue([]) };
	window.maestro.agents.get = vi.fn().mockResolvedValue({ id: 'claude-code' });
	window.maestro.process.getActiveProcesses = vi.fn().mockResolvedValue([
		{ sessionId: 'waiting-a-ai-tab-1', pid: 41, isTerminal: false },
		{ sessionId: 'waiting-b-ai-tab-1', pid: 42, isTerminal: false },
	]);
});

afterEach(cleanup);

describe('browser input-request title through real bootstrap IPC', () => {
	it('counts already-waiting background agents on open and reload without a host event', async () => {
		stored[1].aiTabs[0].logs = [
			{ id: 'deferred-row', timestamp: 1, source: 'user', text: 'background transcript' },
		];
		const view = renderHook(() => useSessionRestoration(), {
			wrapper: ({ children }) => createElement(WindowProvider, { children }),
		});
		await waitFor(() => expect(useSessionStore.getState().sessionsLoaded).toBe(true));
		expect(document.title).toBe('(2) Maestro');
		expect(useSessionStore.getState().activeSessionId).toBe('selected');
		expect(broadcastBridgeEvent).not.toHaveBeenCalled();
		expect(bootstrapResponses).toHaveLength(1);
		const waiting = bootstrapResponses[0].find((session) => session.id === 'waiting-a')!;
		expect(waiting.aiTabs[0].logs).toEqual([]);
		expect(waiting.shellLogs).toEqual([]);
		expect(waiting.agentCommands).toBeUndefined();
		expect(waiting.transcriptSnapshots).toEqual([
			{
				sessionId: 'waiting-a',
				runtime: { state: 'waiting_input' },
				clearRuntimeFields: undefined,
			},
		]);
		expect(
			useSessionStore.getState().sessions.every((session) => !('transcriptSnapshots' in session))
		).toBe(true);
		view.unmount();
		useSessionStore.setState({ sessions: [], sessionsLoaded: false, sessionsReadOk: false });
		renderHook(() => useSessionRestoration(), {
			wrapper: ({ children }) => createElement(WindowProvider, { children }),
		});
		await waitFor(() => expect(useSessionStore.getState().sessionsLoaded).toBe(true));
		expect(document.title).toBe('(2) Maestro');
		expect(broadcastBridgeEvent).not.toHaveBeenCalled();
	});
	it('refreshes answered background requests on reconnect without a host event', async () => {
		renderHook(() => useSessionRestoration(), {
			wrapper: ({ children }) => createElement(WindowProvider, { children }),
		});
		await waitFor(() => expect(document.title).toBe('(2) Maestro'));
		hostRuntime.set('waiting-a', { state: 'busy' });
		hostRuntime.set('waiting-b', { state: 'idle' });
		await act(async () => window.dispatchEvent(new Event(WEB_BRIDGE_RECONCILE_EVENT)));
		await waitFor(() => expect(document.title).toBe('Maestro'));
		expect(useSessionStore.getState().sessions.find((s) => s.id === 'waiting-a')?.state).toBe(
			'busy'
		);
		expect(broadcastBridgeEvent).not.toHaveBeenCalled();

		hostRuntime.set('waiting-a', { state: 'waiting_input' });
		hostRuntime.set('waiting-b', { state: 'waiting_input' });
		await act(async () => window.dispatchEvent(new Event(WEB_BRIDGE_RECONCILE_EVENT)));
		await waitFor(() => expect(document.title).toBe('(2) Maestro'));
		const answer: SessionTranscriptPatch = {
			sessionId: 'waiting-a',
			field: 'shellLogs',
			upserts: [],
			removedIds: [],
			orderIds: [],
			runtime: { state: 'busy' },
		};
		await act(async () => {
			await handlers.get('sessions:publishTranscript')!({ sender: { id: 1 } }, answer);
			await handlers.get('sessions:publishTranscript')!({ sender: { id: 1 } }, answer);
		});
		expect(document.title).toBe('(1) Maestro');
		await act(async () => {
			await handlers.get('sessions:publishTranscript')!(
				{ sender: { id: 1 } },
				{
					...answer,
					sessionId: 'waiting-b',
					runtime: { state: 'idle' },
				}
			);
		});
		expect(document.title).toBe('Maestro');
	});

	it('keeps newer host answers when an older reconnect snapshot finishes later', async () => {
		renderHook(() => useSessionRestoration(), {
			wrapper: ({ children }) => createElement(WindowProvider, { children }),
		});
		await waitFor(() => expect(document.title).toBe('(2) Maestro'));
		holdReplies = true;
		act(() => window.dispatchEvent(new Event(WEB_BRIDGE_RECONCILE_EVENT)));
		await waitFor(() => expect(pendingReplies).toHaveLength(3));
		const answer: SessionTranscriptPatch = {
			sessionId: 'waiting-a',
			field: 'shellLogs',
			upserts: [],
			removedIds: [],
			orderIds: [],
			runtime: { state: 'busy' },
			clearRuntimeFields: ['statusMessage'],
		};
		await act(async () => {
			hostRuntime.set('waiting-a', { state: 'busy' });
			await handlers.get('sessions:publishTranscript')!({ sender: { id: 1 } }, answer);
		});
		expect(document.title).toBe('(1) Maestro');
		await act(async () => {
			for (const reply of pendingReplies) reply();
		});
		await waitFor(() => expect(bootstrapResponses).toHaveLength(2));
		expect(document.title).toBe('(1) Maestro');
		expect(
			useSessionStore.getState().sessions.find((session) => session.id === 'waiting-a')?.state
		).toBe('busy');
	});
	it('carries a real relay request through the native runtime owner and browser bootstrap', async () => {
		runtime.web = false;
		for (const session of stored) hostRuntime.set(session.id, { state: 'idle' });
		useSessionStore.setState({
			sessions: stored.map((session) =>
				session.id === 'waiting-a'
					? {
							...session,
							state: 'busy',
							aiTabs: [createMockAITab({ id: 'tab-1', state: 'busy' })],
						}
					: session
			),
			sessionsLoaded: true,
			initialLoadComplete: true,
		});
		window.maestro.process.getPendingPermissions = vi.fn(async () =>
			permissionRegistry.getPendingPermissionSnapshot()
		);
		window.maestro.process.onPendingPermissionsChanged =
			permissionRegistry.subscribePendingPermissions;
		window.maestro.sessions.publishTranscript = vi.fn(async (patch, requestId) => {
			if (!patch.tabId && patch.runtime) hostRuntime.set(patch.sessionId, patch.runtime);
			return handlers.get('sessions:publishTranscript')!({ sender: { id: 1 } }, patch, requestId);
		});
		const host = renderHook(() => useSessionTranscriptSync(async () => {}));
		const spawn = permissionRegistry.registerSpawn({
			sessionId: 'waiting-a-ai-tab-1',
			tabId: 'tab-1',
		});
		let browser: ReturnType<typeof renderHook> | undefined;
		try {
			await act(async () => {
				void permissionRegistry.createPending('bootstrap-real-request', spawn.token);
			});
			expect(useSessionStore.getState().sessions.find((s) => s.id === 'waiting-a')?.state).toBe(
				'waiting_input'
			);
			expect(hostRuntime.get('waiting-a')?.state).toBe('waiting_input');
			host.unmount();
			runtime.web = true;
			vi.mocked(broadcastBridgeEvent).mockClear();
			useSessionStore.setState({ sessions: [], sessionsLoaded: false, sessionsReadOk: false });
			browser = renderHook(() => useSessionRestoration(), {
				wrapper: ({ children }) => createElement(WindowProvider, { children }),
			});
			await waitFor(() => expect(useSessionStore.getState().sessionsLoaded).toBe(true));
			expect(document.title).toBe('(1) Maestro');
			expect(broadcastBridgeEvent).not.toHaveBeenCalled();
			browser.unmount();
			useSessionStore.setState({ sessions: [], sessionsLoaded: false, sessionsReadOk: false });
			browser = renderHook(() => useSessionRestoration(), {
				wrapper: ({ children }) => createElement(WindowProvider, { children }),
			});
			await waitFor(() => expect(useSessionStore.getState().sessionsLoaded).toBe(true));
			expect(document.title).toBe('(1) Maestro');
			expect(broadcastBridgeEvent).not.toHaveBeenCalled();
		} finally {
			host.unmount();
			browser?.unmount();
			permissionRegistry.resolvePending('bootstrap-real-request', { behavior: 'allow' });
			spawn.cleanup();
			delete (window.maestro.process as any).getPendingPermissions;
			delete (window.maestro.process as any).onPendingPermissionsChanged;
		}
	});
});
