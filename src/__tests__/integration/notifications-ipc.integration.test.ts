import { EventEmitter } from 'events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ipcHandlers = vi.hoisted(() => new Map<string, (...args: any[]) => Promise<any>>());
const notificationState = vi.hoisted(() => ({
	supported: true,
	constructThrows: false,
	show: vi.fn(),
}));
const browserState = vi.hoisted(() => ({
	windows: [] as Array<{
		webContents: { send: ReturnType<typeof vi.fn>; isDestroyed?: () => boolean };
	}>,
}));
const spawnState = vi.hoisted(() => ({
	spawn: vi.fn(),
	children: [] as any[],
}));

vi.mock('electron', () => ({
	ipcMain: {
		handle: vi.fn((channel: string, handler: (...args: any[]) => Promise<any>) => {
			ipcHandlers.set(channel, handler);
		}),
	},
	Notification: class MockNotification {
		static isSupported = vi.fn(() => notificationState.supported);
		constructor(public options: { title: string; body: string; silent: boolean }) {
			if (notificationState.constructThrows) {
				throw new Error('notification failed');
			}
		}
		on = vi.fn(() => this);
		show = notificationState.show;
	},
	BrowserWindow: {
		getAllWindows: vi.fn(() => browserState.windows),
	},
}));

vi.mock('child_process', async (importOriginal) => {
	const actual = await importOriginal<typeof import('child_process')>();
	return {
		...actual,
		spawn: (...args: unknown[]) => spawnState.spawn(...args),
		default: {
			...actual,
			spawn: (...args: unknown[]) => spawnState.spawn(...args),
		},
	};
});

vi.mock('../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

vi.mock('../../main/utils/safe-send', () => ({
	isWebContentsAvailable: vi.fn((win: { webContents?: { isDestroyed?: () => boolean } }) => {
		return !!win.webContents && !win.webContents.isDestroyed?.();
	}),
}));

import {
	clearNotificationQueue,
	getActiveNotificationCount,
	getNotificationMaxQueueSize,
	getNotificationQueueLength,
	parseNotificationCommand,
	registerNotificationsHandlers,
	resetNotificationState,
} from '../../main/ipc/handlers/notifications';

function createChild() {
	const child = new EventEmitter() as EventEmitter & {
		stdin: EventEmitter & {
			write: ReturnType<typeof vi.fn>;
			end: ReturnType<typeof vi.fn>;
		};
		stderr: EventEmitter;
		kill: ReturnType<typeof vi.fn>;
	};
	child.stdin = Object.assign(new EventEmitter(), {
		write: vi.fn((_text: string, _encoding: string, callback?: (err?: Error) => void) => {
			callback?.();
		}),
		end: vi.fn(),
	});
	child.stderr = new EventEmitter();
	child.kill = vi.fn();
	spawnState.children.push(child);
	return child;
}

function handler<T = any>(channel: string) {
	const found = ipcHandlers.get(channel);
	if (!found) {
		throw new Error(`Missing handler ${channel}`);
	}
	return found as (_event: unknown, ...args: any[]) => Promise<T>;
}

describe('notifications IPC integration', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		ipcHandlers.clear();
		notificationState.supported = true;
		notificationState.constructThrows = false;
		browserState.windows = [];
		spawnState.children = [];
		spawnState.spawn.mockImplementation(() => createChild());
		resetNotificationState();
		registerNotificationsHandlers();
	});

	it('parses notification commands and shows supported, unsupported, and failed OS notifications', async () => {
		expect(parseNotificationCommand()).toBe('say');
		expect(parseNotificationCommand('  custom | command  ')).toBe('custom | command');

		await expect(handler('notification:show')({}, 'Title', 'Body')).resolves.toEqual({
			success: true,
		});
		expect(notificationState.show).toHaveBeenCalled();

		notificationState.supported = false;
		await expect(handler('notification:show')({}, 'Title', 'Body')).resolves.toEqual({
			success: false,
			error: 'Notifications not supported',
		});

		notificationState.supported = true;
		notificationState.constructThrows = true;
		const failed = await handler('notification:show')({}, 'Title', 'Body');
		expect(failed).toMatchObject({ success: false });
		expect(failed.error).toContain('notification failed');
	});

	it('runs notification commands through stdin, emits completion, and tracks active processes', async () => {
		const send = vi.fn();
		browserState.windows = [
			{ webContents: { send } },
			{ webContents: { send: vi.fn(), isDestroyed: () => true } },
		];
		const speakPromise = handler('notification:speak')({}, 'Hello there', '  say -v Alex  ');

		expect(spawnState.spawn).toHaveBeenCalledWith(
			'say -v Alex',
			[],
			expect.objectContaining({ shell: true, stdio: ['pipe', 'ignore', 'pipe'] })
		);
		expect(getActiveNotificationCount()).toBe(1);
		const child = spawnState.children[0];
		expect(child.stdin.write).toHaveBeenCalledWith('Hello there', 'utf8', expect.any(Function));
		child.stderr.emit('data', Buffer.from('minor warning'));
		child.emit('close', 0, null);

		await expect(speakPromise).resolves.toEqual({ success: true, notificationId: 1 });
		expect(getActiveNotificationCount()).toBe(0);
		expect(send).toHaveBeenCalledWith('notification:commandCompleted', 1);
	});

	it('handles empty text, spawn errors, stdin errors, nonzero closes, and stop requests', async () => {
		await expect(handler('notification:speak')({}, '   ', 'say')).resolves.toEqual({
			success: true,
		});

		const spawnErrorPromise = handler('notification:speak')({}, 'Spawn error', 'say');
		const spawnErrorChild = spawnState.children[0];
		spawnErrorChild.emit('error', new Error('spawn exploded'));
		await expect(spawnErrorPromise).resolves.toEqual({ success: true, notificationId: 1 });
		expect(getActiveNotificationCount()).toBe(0);
		resetNotificationState();
		spawnState.children = [];

		const closeFailurePromise = handler('notification:speak')({}, 'Close failure', 'say');
		const closeFailureChild = spawnState.children[0];
		closeFailureChild.stdin.emit('error', Object.assign(new Error('closed'), { code: 'EPIPE' }));
		closeFailureChild.stdin.emit(
			'error',
			Object.assign(new Error('bad stdin'), { code: 'EINVAL' })
		);
		closeFailureChild.stderr.emit('data', Buffer.from('bad command'));
		closeFailureChild.emit('close', 2, null);
		await expect(closeFailurePromise).resolves.toEqual({ success: true, notificationId: 1 });
		expect(getActiveNotificationCount()).toBe(0);
		resetNotificationState();
		spawnState.children = [];

		const activePromise = handler('notification:speak')({}, 'Stop me', 'say');
		const activeChild = spawnState.children[0];
		await expect(handler('notification:stopSpeak')({}, 1)).resolves.toEqual({ success: true });
		expect(activeChild.kill).toHaveBeenCalledWith('SIGTERM');
		activeChild.emit('close', null, 'SIGTERM');
		await activePromise;

		await expect(handler('notification:stopSpeak')({}, 999)).resolves.toMatchObject({
			success: false,
			error: 'No active notification process with that ID',
		});
		resetNotificationState();
		spawnState.children = [];

		const throwPromise = handler('notification:speak')({}, 'Kill throws', 'say');
		const throwChild = spawnState.children[0];
		throwChild.kill.mockImplementation(() => {
			throw new Error('kill failed');
		});
		await expect(handler('notification:stopSpeak')({}, 1)).resolves.toMatchObject({
			success: false,
			error: 'Error: kill failed',
		});
		throwChild.emit('close', null, 'SIGTERM');
		await throwPromise;
	});

	it('rejects queue overflow while one command is active and lets tests clear queued items', async () => {
		const first = handler('notification:speak')({}, 'First', 'say');
		expect(getNotificationQueueLength()).toBe(0);

		for (let index = 0; index < getNotificationMaxQueueSize(); index++) {
			void handler('notification:speak')({}, `Queued ${index}`, 'say');
		}
		expect(getNotificationQueueLength()).toBe(getNotificationMaxQueueSize());

		await expect(handler('notification:speak')({}, 'Overflow', 'say')).resolves.toMatchObject({
			success: false,
			error: expect.stringContaining('Notification queue is full'),
		});

		clearNotificationQueue();
		expect(getNotificationQueueLength()).toBe(0);
		spawnState.children[0].emit('close', 0, null);
		await first;
	});

	it('returns a startup failure when spawn throws before a child process exists', async () => {
		spawnState.spawn.mockImplementationOnce(() => {
			throw new Error('cannot spawn');
		});

		await expect(handler('notification:speak')({}, 'Broken', 'say')).resolves.toMatchObject({
			success: false,
			error: 'Error: cannot spawn',
		});
		expect(getActiveNotificationCount()).toBe(0);
	});
});
