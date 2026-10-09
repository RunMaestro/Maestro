import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import type { App } from 'electron';
import type { FSWatcher } from 'chokidar';
import type * as ChokidarModule from 'chokidar';

const state = vi.hoisted(() => ({
	handlers: new Map<string, Function>(),
	watchers: [] as FSWatcher[],
	ready: new WeakSet<FSWatcher>(),
	send: vi.fn(),
}));
vi.mock('electron', () => ({
	ipcMain: { handle: (channel: string, handler: Function) => state.handlers.set(channel, handler) },
}));
vi.mock('chokidar', async (original) => {
	const module = await original<typeof ChokidarModule>();
	return {
		...module,
		default: {
			...module.default,
			watch: (...args: Parameters<typeof module.watch>) => {
				const watcher = module.watch(...args);
				state.watchers.push(watcher);
				watcher.once('ready', () => state.ready.add(watcher));
				return watcher;
			},
		},
	};
});
vi.mock('../../main/utils/logger', () => ({
	logger: { info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));
vi.mock('../../main/process-manager', () => ({ ProcessManager: class {} }));
vi.mock('../../main/utils/safe-send', () => ({ createSafeSend: () => state.send }));
import {
	registerDocumentGraphHandlers,
	releaseDocumentGraphClientWatchers,
} from '../../main/ipc/handlers/documentGraph';

let directory: string;
let app: EventEmitter;
const remote = (clientId: string) => ({ type: 'bridge', clientId });
const invoke = (method: string, event: unknown) =>
	state.handlers.get(`documentGraph:${method}`)!(event, directory);

beforeEach(async () => {
	state.handlers.clear();
	state.watchers.length = 0;
	state.send.mockClear();
	directory = await fs.mkdtemp(path.join(os.tmpdir(), 'maestro-graph-'));
	await fs.writeFile(path.join(directory, 'note.md'), 'initial');
	app = new EventEmitter();
	registerDocumentGraphHandlers({ app: app as unknown as App, getMainWindow: () => null });
});
afterEach(async () => {
	app.emit('before-quit');
	await Promise.all(state.watchers.map((watcher) => watcher.close()));
	await fs.rm(directory, { recursive: true, force: true });
});
async function watch(event: unknown): Promise<void> {
	expect((await invoke('watchFolder', event)).success).toBe(true);
	const watcher = state.watchers[0];
	if (!state.ready.has(watcher))
		await new Promise<void>((resolve) => watcher.once('ready', resolve));
}
async function change(content: string): Promise<void> {
	state.send.mockClear();
	await fs.writeFile(path.join(directory, 'note.md'), content);
	await vi.waitFor(
		() =>
			expect(state.send).toHaveBeenCalledWith('documentGraph:filesChanged', {
				rootPath: directory,
				changes: [{ filePath: path.join(directory, 'note.md'), eventType: 'change' }],
			}),
		{ timeout: 5000 }
	);
}

describe('shared document graph watcher ownership', () => {
	it('keeps delivering real file changes after one client unsubscribes, until the final owner leaves', async () => {
		await watch(remote('a'));
		await watch(remote('b'));
		expect(state.watchers).toHaveLength(1);
		await invoke('unwatchFolder', remote('a'));
		expect(state.watchers[0].closed).toBe(false);
		await change('surviving owner');
		await invoke('unwatchFolder', remote('b'));
		expect(state.watchers[0].closed).toBe(true);
	});
	it('disconnect releases only that client and is idempotent', async () => {
		await watch(remote('a'));
		await watch(remote('b'));
		await releaseDocumentGraphClientWatchers('a');
		await releaseDocumentGraphClientWatchers('a');
		expect(state.watchers[0].closed).toBe(false);
		await change('after disconnect');
		await releaseDocumentGraphClientWatchers('b');
		expect(state.watchers[0].closed).toBe(true);
	});
	it('native renderer destruction does not stop a remote owner and repeated subscribe needs one release', async () => {
		const sender = Object.assign(new EventEmitter(), { id: 7, isDestroyed: () => false });
		await watch({ sender });
		await watch(remote('a'));
		await watch(remote('a'));
		sender.emit('destroyed');
		expect(state.watchers[0].closed).toBe(false);
		await change('native owner gone');
		await invoke('unwatchFolder', remote('a'));
		expect(state.watchers[0].closed).toBe(true);
	});
});
