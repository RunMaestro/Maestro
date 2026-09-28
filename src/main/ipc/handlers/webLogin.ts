/**
 * Web Login account management IPC.
 *
 * These six channels are the ONLY way an account is created, renamed, reset,
 * disabled or deleted. They are DESKTOP-ONLY by construction: the web-desktop
 * bridge refuses every `webLogin:*` channel (`BRIDGE_DENIED_CHANNELS`), so a
 * logged-in browser can never mint itself another account, hand itself a new
 * password, or remove the account it is signed in as. The desktop is the
 * administrator and there is no second administrator.
 *
 * Every verb is a thin pass-through to `WebUserStore`, which owns the
 * validation and throws with a user-facing message. `withIpcErrorLogging`
 * re-throws rather than swallowing, so the renderer's inline error text is the
 * store's own sentence and a genuine fault still reaches Sentry.
 */

import { ipcMain } from 'electron';
import { withIpcErrorLogging } from '../../utils/ipcHandler';
import { getWebUserStore } from '../../web-server/auth/web-user-store';
import type { WebUserPublic } from '../../../shared/webLogin';

const LOG_CONTEXT = '[WebLogin]';

function handlerOpts(operation: string) {
	return { context: LOG_CONTEXT, operation };
}

/** Register the `webLogin:*` account-management channels. */
export function registerWebLoginHandlers(): void {
	ipcMain.handle(
		'webLogin:listUsers',
		withIpcErrorLogging(handlerOpts('listUsers'), async (): Promise<WebUserPublic[]> => {
			return getWebUserStore().listUsers();
		})
	);

	ipcMain.handle(
		'webLogin:createUser',
		withIpcErrorLogging(
			handlerOpts('createUser'),
			async (input: {
				username: string;
				password: string;
				displayName?: string;
			}): Promise<WebUserPublic> => {
				return getWebUserStore().createUser(input);
			}
		)
	);

	ipcMain.handle(
		'webLogin:setPassword',
		withIpcErrorLogging(
			handlerOpts('setPassword'),
			async (id: string, password: string): Promise<void> => {
				await getWebUserStore().setPassword(id, password);
			}
		)
	);

	ipcMain.handle(
		'webLogin:setDisplayName',
		withIpcErrorLogging(
			handlerOpts('setDisplayName'),
			async (id: string, displayName: string): Promise<WebUserPublic> => {
				return getWebUserStore().setDisplayName(id, displayName);
			}
		)
	);

	ipcMain.handle(
		'webLogin:setDisabled',
		withIpcErrorLogging(
			handlerOpts('setDisabled'),
			async (id: string, disabled: boolean): Promise<WebUserPublic> => {
				return getWebUserStore().setDisabled(id, disabled);
			}
		)
	);

	ipcMain.handle(
		'webLogin:deleteUser',
		withIpcErrorLogging(handlerOpts('deleteUser'), async (id: string): Promise<void> => {
			await getWebUserStore().deleteUser(id);
		})
	);
}
