/**
 * Preload API for the pm:initRepo IPC channel (#445).
 *
 * Exposes window.maestro.pmInit.initRepo() for local PM state bootstrap
 * without touching ipcRenderer directly.
 */

import { ipcRenderer } from 'electron';
import type { PmInitInput, PmInitResult } from '../ipc/handlers/pm-init';

export function createPmInitApi() {
	return {
		/**
		 * Idempotently initialize the local Maestro Board / Work Graph PM surface.
		 * Returns { created, existing, errors }.
		 */
		initRepo: (input: PmInitInput = {}): Promise<PmInitResult> =>
			ipcRenderer.invoke('pm:initRepo', input),
	};
}

export type PmInitApi = ReturnType<typeof createPmInitApi>;
