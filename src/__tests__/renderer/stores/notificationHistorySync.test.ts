import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import type {
	NotificationHistoryChange,
	NotificationHistorySnapshot,
} from '../../../shared/notificationHistory';

const host = vi.hoisted(() => ({
	data: { records: [] as unknown[], legacyMigrationComplete: false },
	handlers: new Map<string, (...args: unknown[]) => Promise<NotificationHistorySnapshot>>(),
	listeners: new Set<(snapshot: NotificationHistorySnapshot) => void>(),
	set: vi.fn(),
}));
vi.mock('electron', () => ({
	app: { getPath: () => '/isolated-notification-test' },
	BrowserWindow: { getAllWindows: () => [] },
	ipcMain: {
		handle: (
			channel: string,
			handler: (...args: unknown[]) => Promise<NotificationHistorySnapshot>
		) => host.handlers.set(channel, handler),
	},
}));
vi.mock('electron-store', () => ({
	default: class {
		get(key: keyof typeof host.data) {
			return host.data[key];
		}
		set(data: Partial<typeof host.data>) {
			host.set(data);
			Object.assign(host.data, data);
		}
	},
}));
vi.mock('../../../main/utils/safe-send', () => ({
	createSafeSend: () => (_channel: string, snapshot: NotificationHistorySnapshot) => {
		for (const listener of host.listeners) listener(snapshot);
	},
}));
vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../main/utils/sentry', () => ({ captureException: vi.fn() }));

import { registerNotificationHistoryHandlers } from '../../../main/ipc/handlers/notification-history';
let firstWindow: typeof import('../../../renderer/stores/notificationStore');
let sessionStore: typeof import('../../../renderer/stores/sessionStore');
import { createMockSession } from '../../helpers/mockSession';
import { createMockAITab } from '../../helpers/mockTab';
import { installLocalStorageMock } from '../../helpers/mockLocalStorage';

let cleanup: (() => void)[] = [];
beforeEach(async () => {
	vi.resetModules();
	firstWindow = await import('../../../renderer/stores/notificationStore');
	sessionStore = await import('../../../renderer/stores/sessionStore');
	sessionStore.useSessionStore.setState(sessionStore.useSessionStore.getInitialState(), true);
	host.data.records = [];
	host.data.legacyMigrationComplete = false;
	host.listeners.clear();
	host.set.mockReset();
	registerNotificationHistoryHandlers();
	installLocalStorageMock();
	Object.assign(window.maestro.notification, {
		changeHistory: (change: NotificationHistoryChange) =>
			host.handlers.get('notification:changeHistory')!({}, change),
		onHistoryChanged: (listener: (snapshot: NotificationHistorySnapshot) => void) => {
			host.listeners.add(listener);
			return () => host.listeners.delete(listener);
		},
	});
	firstWindow.useNotificationStore.setState({
		history: [],
		toasts: [],
		historyPersistenceFailed: false,
	});
	firstWindow.useNotificationStore.getState().setOsNotifications(false);
	firstWindow.useNotificationStore.getState().setHistoryEnabled(true);
	cleanup.push(firstWindow.startNotificationHistorySync());
	await firstWindow.flushNotificationHistoryWrites();
});
afterEach(async () => {
	await firstWindow.flushNotificationHistoryWrites();
	sessionStore.useSessionStore.setState(sessionStore.useSessionStore.getInitialState(), true);
	for (const dispose of cleanup) dispose();
	cleanup = [];
	delete (window.maestro.notification as Partial<typeof window.maestro.notification>).changeHistory;
	delete (window.maestro.notification as Partial<typeof window.maestro.notification>)
		.onHistoryChanged;
});

describe('authoritative notification history across windows', () => {
	it('dismisses more visible sticky toasts than the history limit without blocking later writes', async () => {
		for (let index = 0; index < 201; index++) {
			firstWindow.notifyToast({ title: `Sticky ${index}`, message: '', duration: 0 });
		}
		await firstWindow.flushNotificationHistoryWrites();
		expect(firstWindow.useNotificationStore.getState().toasts).toHaveLength(201);
		expect(host.data.records).toHaveLength(200);
		firstWindow.useNotificationStore.getState().clearToasts();
		await firstWindow.flushNotificationHistoryWrites();
		expect(firstWindow.useNotificationStore.getState().historyPersistenceFailed).toBe(false);
		expect(host.data.records.every((record) => (record as { read: boolean }).read)).toBe(true);
		firstWindow.notifyToast({ title: 'Next completion', message: '', historyOnly: true });
		await firstWindow.flushNotificationHistoryWrites();
		expect(host.data.records).toContainEqual(expect.objectContaining({ title: 'Next completion' }));
	});

	it('retains simultaneous completions, read state and clear without stale resurrection', async () => {
		vi.resetModules();
		const secondWindow = await import('../../../renderer/stores/notificationStore');
		secondWindow.useNotificationStore.getState().setHistoryEnabled(true);
		cleanup.push(secondWindow.startNotificationHistorySync());
		await secondWindow.flushNotificationHistoryWrites();
		firstWindow.notifyToast({ title: 'Window A', message: '', historyOnly: true });
		secondWindow.notifyToast({ title: 'Window B', message: '', historyOnly: true });
		await Promise.all([
			firstWindow.flushNotificationHistoryWrites(),
			secondWindow.flushNotificationHistoryWrites(),
		]);
		expect(host.data.records.map((n) => (n as { title: string }).title).sort()).toEqual([
			'Window A',
			'Window B',
		]);
		expect(firstWindow.useNotificationStore.getState().history).toHaveLength(2);
		expect(secondWindow.useNotificationStore.getState().history).toHaveLength(2);
		firstWindow.useNotificationStore.getState().markAllNotificationsRead();
		await firstWindow.flushNotificationHistoryWrites();
		expect(secondWindow.useNotificationStore.getState().history.every((n) => n.read)).toBe(true);
		secondWindow.useNotificationStore.getState().clearNotificationHistory();
		await secondWindow.flushNotificationHistoryWrites();
		expect(firstWindow.useNotificationStore.getState().history).toEqual([]);
		await host.handlers.get('notification:changeHistory')!(
			{},
			{
				action: 'migrate',
				records: [
					{
						id: 'old',
						title: 'Stale legacy',
						message: '',
						timestamp: 1,
						color: 'theme',
						type: 'info',
						read: false,
					},
				],
			}
		);
		expect(host.data.records).toEqual([]);
	});

	it('reprojects the latest read state after an older append acknowledgement arrives', async () => {
		let releaseAck!: () => void;
		let sent!: () => void;
		const sentPromise = new Promise<void>((resolve) => {
			sent = resolve;
		});
		const ackGate = new Promise<void>((resolve) => {
			releaseAck = resolve;
		});
		window.maestro.notification.changeHistory = async (change) => {
			const snapshot = await host.handlers.get('notification:changeHistory')!({}, change);
			if (change.action === 'append') {
				sent();
				await ackGate;
			}
			return snapshot;
		};
		const id = firstWindow.notifyToast({ title: 'Delayed ack', message: '', historyOnly: true });
		await sentPromise;
		await host.handlers.get('notification:changeHistory')!({}, { action: 'read', ids: [id] });
		// The still-pending local append overlays unread until its acknowledgement retires.
		expect(firstWindow.useNotificationStore.getState().history[0].read).toBe(false);
		releaseAck();
		await firstWindow.flushNotificationHistoryWrites();
		expect(firstWindow.useNotificationStore.getState().history[0].read).toBe(true);
	});

	it('keeps later peer notifications unread while mark-all waits behind an earlier write', async () => {
		let releaseAck!: () => void;
		let sent!: () => void;
		const sentPromise = new Promise<void>((resolve) => {
			sent = resolve;
		});
		const ackGate = new Promise<void>((resolve) => {
			releaseAck = resolve;
		});
		window.maestro.notification.changeHistory = async (change) => {
			const snapshot = await host.handlers.get('notification:changeHistory')!({}, change);
			if (change.action === 'append') {
				sent();
				await ackGate;
			}
			return snapshot;
		};
		const id = firstWindow.notifyToast({ title: 'Waiting write', message: '', historyOnly: true });
		await sentPromise;
		firstWindow.useNotificationStore.getState().markAllNotificationsRead();
		const record = firstWindow.useNotificationStore.getState().history.find((n) => n.id === id)!;
		await host.handlers.get('notification:changeHistory')!(
			{},
			{
				action: 'append',
				record: { ...record, id: 'later-peer', title: 'Later peer completion', read: false },
			}
		);
		releaseAck();
		await firstWindow.flushNotificationHistoryWrites();
		expect(host.data.records).toContainEqual(expect.objectContaining({ id, read: true }));
		expect(host.data.records).toContainEqual(
			expect.objectContaining({ id: 'later-peer', read: false })
		);
		expect(
			firstWindow.useNotificationStore.getState().history.find((n) => n.id === 'later-peer')?.read
		).toBe(false);
	});

	it('retains failed writes in the inbox and retries them with the next mutation', async () => {
		host.set.mockImplementationOnce(() => {
			throw new Error('Disk full');
		});
		firstWindow.notifyToast({ title: 'Unsaved', message: '', historyOnly: true });
		await firstWindow.flushNotificationHistoryWrites();
		expect(firstWindow.useNotificationStore.getState().historyPersistenceFailed).toBe(true);
		expect(firstWindow.useNotificationStore.getState().history[0].title).toBe('Unsaved');
		expect(host.data.records).toEqual([]);
		firstWindow.useNotificationStore.getState().markAllNotificationsRead();
		await firstWindow.flushNotificationHistoryWrites();
		expect(firstWindow.useNotificationStore.getState().historyPersistenceFailed).toBe(false);
		expect(host.data.records).toMatchObject([{ title: 'Unsaved', read: true }]);
	});

	it('snapshots known source names for internal notifications without explicit labels', async () => {
		sessionStore.useSessionStore.setState({
			sessions: [
				createMockSession({
					id: 'source-agent',
					name: 'Source Agent',
					aiTabs: [createMockAITab({ id: 'source-tab', name: 'Source Tab' })],
				}),
			],
		});
		firstWindow.notifyToast({
			title: 'Task failed',
			message: 'Failure',
			sessionId: 'source-agent',
			tabId: 'source-tab',
			historyOnly: true,
		});
		await firstWindow.flushNotificationHistoryWrites();
		expect(host.data.records).toMatchObject([{ project: 'Source Agent', tabName: 'Source Tab' }]);
	});

	it('rejects malformed IPC records without altering the history', async () => {
		expect(
			await host.handlers.get('notification:changeHistory')!(
				{},
				{ action: 'append', record: { id: 'bad' } }
			)
		).toMatchObject({ success: false });
		expect(host.data.records).toEqual([]);
	});
});
