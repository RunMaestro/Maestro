/**
 * Preload API for MaestroRun (`window.maestro.maestroRun`).
 *
 * Mirrors the `maestroRun:*` channels in `src/main/ipc/handlers/maestroRun.ts`.
 */

import { ipcRenderer } from 'electron';
import type { MaestroRunStatus } from '../../shared/maestro-run/status';

export function createMaestroRunApi() {
	return {
		/** The last known status. Never touches the machine. */
		status: (): Promise<MaestroRunStatus> => ipcRenderer.invoke('maestroRun:status'),
		/** Re-inspect the launcher; `checkLatest` also asks GitHub for the newest release. */
		refresh: (options?: { checkLatest?: boolean }): Promise<MaestroRunStatus> =>
			ipcRenderer.invoke('maestroRun:refresh', options),
		/** Install the newest supported release, or update the installed copy. */
		install: (): Promise<MaestroRunStatus> => ipcRenderer.invoke('maestroRun:install'),
		/** Open the Full Disk Access list and watch for the grant. */
		requestAccess: (options?: { reveal?: boolean }): Promise<MaestroRunStatus> =>
			ipcRenderer.invoke('maestroRun:requestAccess', options),
		/** The launcher path while MaestroRun is ready, else null. Gates the system prompt. */
		readyPath: (): Promise<string | null> => ipcRenderer.invoke('maestroRun:readyPath'),
		/** Fires on every status change (install progress, the grant landing). */
		onStatusChanged: (handler: (status: MaestroRunStatus) => void): (() => void) => {
			const wrapped = (_event: Electron.IpcRendererEvent, status: MaestroRunStatus) =>
				handler(status);
			ipcRenderer.on('maestroRun:statusChanged', wrapped);
			return () => {
				ipcRenderer.removeListener('maestroRun:statusChanged', wrapped);
			};
		},
	};
}

export type MaestroRunApi = ReturnType<typeof createMaestroRunApi>;
