/**
 * Where the TUI's log goes.
 *
 * Ink owns stdout and stderr while the UI is up, so anything the library logs
 * has to go to a file: `<userData>/logs/maestro-tui.log`. The logger itself is the
 * library's (`createFileLogger`), shared with `maestro-cli host`.
 */

import * as path from 'path';
export { createFileLogger } from '../shared/maestro-lib';

export const TUI_LOG_FILE_NAME = 'maestro-tui.log';

export function tuiLogFilePath(userDataDir: string): string {
	return path.join(userDataDir, 'logs', TUI_LOG_FILE_NAME);
}
