/**
 * IPC handlers for terminal scrollback persistence.
 *
 * Surface consumed by XTerminal (save on output, load on mount) and by session
 * restoration (prune snapshots of tabs that no longer exist).
 */

import { ipcMain } from 'electron';
import {
	saveTerminalScrollback,
	loadTerminalScrollback,
	pruneTerminalScrollback,
} from '../../terminal-scrollback-store';
import { withIpcErrorLogging } from '../../utils/ipcHandler';

const LOG_CONTEXT = '[IPC:TerminalScrollback]';

export function registerTerminalScrollbackHandlers(): void {
	ipcMain.handle(
		'terminalScrollback:save',
		withIpcErrorLogging({ context: LOG_CONTEXT, operation: 'save' }, (key: string, data: string) =>
			saveTerminalScrollback(key, data)
		)
	);

	ipcMain.handle(
		'terminalScrollback:load',
		withIpcErrorLogging({ context: LOG_CONTEXT, operation: 'load' }, (key: string) =>
			loadTerminalScrollback(key)
		)
	);

	ipcMain.handle(
		'terminalScrollback:prune',
		withIpcErrorLogging({ context: LOG_CONTEXT, operation: 'prune' }, (keepKeys: string[]) =>
			pruneTerminalScrollback(Array.isArray(keepKeys) ? keepKeys : [])
		)
	);
}
