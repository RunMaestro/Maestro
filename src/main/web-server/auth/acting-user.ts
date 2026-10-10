/**
 * Acting user - who a main-process call is running on behalf of.
 *
 * A bridge.invoke from a logged-in browser reaches an `ipcMain` handler with
 * the same shared FAKE_EVENT every other bridge call uses, and most handlers
 * strip the event anyway (`withIpcErrorLogging`), so nothing in a handler's
 * arguments says which account asked. Rather than threading a user through
 * hundreds of handler signatures, the bridge wraps each dispatch in an
 * AsyncLocalStorage context and anything main-side that needs the answer asks
 * {@link getActingUser}. Electron renderer calls run outside any context and
 * read `undefined`, which means "the desktop".
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { WebActingUser } from '../../../shared/webLogin';

const storage = new AsyncLocalStorage<WebActingUser | undefined>();

/** Run `fn` with `user` as the acting user for every await inside it. */
export function runAsActingUser<T>(user: WebActingUser | undefined, fn: () => T): T {
	return storage.run(user, fn);
}

/** The account the current call is acting as, or `undefined` for the desktop. */
export function getActingUser(): WebActingUser | undefined {
	return storage.getStore();
}
