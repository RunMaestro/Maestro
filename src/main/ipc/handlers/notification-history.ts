/** Main owns notification mutations so independent windows cannot overwrite each other. */
import { app, BrowserWindow, ipcMain } from 'electron';
import Store from 'electron-store';
import path from 'path';
import {
	applyNotificationHistoryChange,
	isNotificationHistoryChange,
	parseNotificationHistory,
	type NotificationHistoryRecord,
	type NotificationHistorySnapshot,
} from '../../../shared/notificationHistory';
import { createStoreDeserializer } from '../../stores/corrupt-store-recovery';
import { createSafeSend } from '../../utils/safe-send';
import { createHandler } from '../../utils/ipcHandler';

/** Each IPC turn applies a delta synchronously and persists before broadcasting its revision. */
export function registerNotificationHistoryHandlers(): void {
	const cwd = app.getPath('userData');
	const store = new Store<{
		records: NotificationHistoryRecord[];
		legacyMigrationComplete: boolean;
	}>({
		name: 'maestro-notification-history',
		cwd,
		defaults: { records: [], legacyMigrationComplete: false },
		deserialize: createStoreDeserializer(path.join(cwd, 'maestro-notification-history.json')),
	});
	const broadcast = createSafeSend(() => BrowserWindow.getAllWindows());
	let revision = 0;
	ipcMain.handle(
		'notification:changeHistory',
		createHandler(
			{ context: 'NotificationHistory', operation: 'change', logSuccess: false },
			async (_event: unknown, change: unknown) => {
				if (!isNotificationHistoryChange(change))
					throw new Error('Invalid notification history request');
				const effectiveChange =
					change.action === 'migrate' && store.get('legacyMigrationComplete')
						? { action: 'migrate' as const, records: [] }
						: change;
				const records = applyNotificationHistoryChange(
					parseNotificationHistory(store.get('records')),
					effectiveChange
				);
				store.set({
					records,
					legacyMigrationComplete:
						store.get('legacyMigrationComplete') || change.action === 'migrate',
				});
				const snapshot: NotificationHistorySnapshot = {
					success: true,
					records,
					revision: ++revision,
				};
				broadcast('notification:historyChanged', snapshot);
				return { ...snapshot };
			}
		)
	);
}
