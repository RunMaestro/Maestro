import { ipcRenderer } from 'electron';
import type { MaestroCliStatus, MaestroCliInstallResult } from '../../shared/maestro-cli';

export interface MaestroCliApi {
	checkStatus: () => Promise<MaestroCliStatus>;
	installOrUpdate: () => Promise<MaestroCliInstallResult>;
}

export function createMaestroCliApi(): MaestroCliApi {
	return {
		checkStatus: () => ipcRenderer.invoke('maestroCli:checkStatus'),
		installOrUpdate: () => ipcRenderer.invoke('maestroCli:installOrUpdate'),
	};
}
