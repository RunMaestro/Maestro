/**
 * Preload API for the pm:initRepo IPC channel (#445).
 *
 * Exposes window.maestro.pmInit.initRepo() so the renderer can invoke
 * the /PM-init slash command without touching ipcRenderer directly.
 */

import { ipcRenderer } from 'electron';
import type { PmInitInput, PmInitResult } from '../ipc/handlers/pm-init';

export function createPmInitApi() {
	return {
		/**
		 * Idempotently ensure all AI-prefixed Projects v2 custom fields exist.
		 * Returns { created, existing, errors }.
		 */
		initRepo: (input: PmInitInput = {}): Promise<PmInitResult> =>
			ipcRenderer.invoke('pm:initRepo', input),
	};
}

export type PmInitApi = ReturnType<typeof createPmInitApi>;
