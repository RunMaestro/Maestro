/** Renderer -> real preload -> web shim -> bridge dispatcher, with an in-memory wire. */
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LocalModelTaskId } from '../../shared/local-models/tasks';
import type { LocalModelTaskReadiness } from '../../shared/local-models/task-readiness';

const host = vi.hoisted(() => ({
	handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
}));

vi.mock('electron', async () => ({
	ipcMain: { _invokeHandlers: host.handlers },
	ipcRenderer: (await import('../../web-desktop/electron-shim')).ipcRenderer,
}));
vi.mock('../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../main/utils/sentry', () => ({ captureException: vi.fn() }));

// Reuse the historical rendererBridge fixture's wire, without its History store setup.
class LoopbackWebSocket extends EventTarget {
	static readonly OPEN = 1;
	static instance: LoopbackWebSocket;
	readyState = 1;
	frames: { channel?: string; args?: unknown[] }[] = [];
	constructor(_url: string) {
		super();
		LoopbackWebSocket.instance = this;
	}
	send(data: string) {
		const frame = JSON.parse(data);
		this.frames.push(frame);
		if (frame.type === 'bridge.invoke') {
			void handleBridgeInvoke(client, frame, (_client, response) => this.receive(response));
		} else if (frame.type === 'ping') {
			this.receive({ type: 'pong' });
		}
	}
	receive(frame: unknown) {
		this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(frame) }));
	}
	close() {
		this.readyState = 3;
		this.dispatchEvent(new CloseEvent('close', { code: 1008 }));
	}
}
const originalConfig = window.__MAESTRO_CONFIG__;
vi.stubGlobal('WebSocket', LoopbackWebSocket);
window.__MAESTRO_CONFIG__ = { securityToken: 'test-token' } as typeof window.__MAESTRO_CONFIG__;

const { handleBridgeInvoke } = await import('../../main/web-server/handlers/bridgeHandlers');
const { createLocalModelsApi } = await import('../../main/preload/localModels');
const { useLocalModelTaskReadiness } =
	await import('../../renderer/hooks/localModels/useLocalModelTaskReadiness');

const socket = LoopbackWebSocket.instance;
const client = {
	id: 'web-readiness-test',
	socket: socket as unknown as WebSocket,
	connectedAt: Date.now(),
};
const originalLocalModels = window.maestro.localModels;

beforeEach(() => {
	host.handlers.clear();
	socket.frames = [];
	document.getElementById('maestro-submission-notice')?.remove();
	window.maestro.localModels = createLocalModelsApi();
	socket.dispatchEvent(new Event('open'));
	socket.receive({ type: 'connected', bridgeEpoch: 'readiness-test', resumed: true });
});

afterEach(() => {
	cleanup();
	window.maestro.localModels = originalLocalModels;
});

afterAll(() => {
	socket.close();
	window.__MAESTRO_CONFIG__ = originalConfig;
	vi.unstubAllGlobals();
});

describe('local model task readiness over the renderer bridge', () => {
	it.each<LocalModelTaskId | undefined>([undefined, 'dictation', 'semantic-search', 'git-drafts'])(
		'sends no readiness frames on mount, revision or manual refresh (task: %s)',
		async (taskId) => {
			const handler = vi.fn(async () => []);
			host.handlers.set('localModels:taskReadiness', handler);
			const { result, rerender } = renderHook(
				({ revision }) => useLocalModelTaskReadiness(revision, taskId),
				{ initialProps: { revision: 'first' } }
			);
			await waitFor(() => expect(result.current.loading).toBe(false));
			rerender({ revision: 'changed-settings' });
			await act(async () => {
				await result.current.refresh();
			});
			expect(
				socket.frames.filter((frame) => frame.channel === 'localModels:taskReadiness')
			).toEqual([]);
			expect(handler).not.toHaveBeenCalled();
			expect(result.current.readiness).toEqual({});
			expect(result.current).toMatchObject({
				loading: false,
				error: 'Local model tasks are only available in the desktop app.',
			});
			expect(document.getElementById('maestro-submission-notice')).toBeNull();
		}
	);

	it('keeps the current explicit readiness read working over the same wire', async () => {
		const readiness: LocalModelTaskReadiness[] = [
			{
				taskId: 'git-drafts',
				label: 'Git drafts',
				needs: 'text-gen',
				assignment: { type: 'off' },
				state: 'off',
				detail: 'This task is switched off.',
			},
		];
		const handler = vi.fn(async () => readiness);
		host.handlers.set('localModels:taskReadiness', handler);
		await expect(window.maestro.localModels.taskReadiness('git-drafts')).resolves.toEqual(
			readiness
		);
		expect(handler).toHaveBeenCalledWith(expect.objectContaining({ type: 'bridge' }), 'git-drafts');
		expect(socket.frames).toContainEqual(
			expect.objectContaining({ channel: 'localModels:taskReadiness', args: ['git-drafts'] })
		);
	});

	it('still denies an explicit private download before the host handler runs', async () => {
		const handler = vi.fn();
		host.handlers.set('localModels:download', handler);
		await expect(window.maestro.localModels.download('whisper-base')).rejects.toThrow(
			'Channel "localModels:download" is not available over the web interface'
		);
		expect(handler).not.toHaveBeenCalled();
		expect(socket.frames).toContainEqual(
			expect.objectContaining({ channel: 'localModels:download', args: ['whisper-base'] })
		);
		expect(document.getElementById('maestro-submission-notice')?.textContent).toContain(
			'Submission rejected for localModels:download'
		);
	});
});
