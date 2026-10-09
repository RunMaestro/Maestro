import type { BrowserWindow } from 'electron';
import type { CadenzaHudWindowDeps } from '../app-lifecycle';
import type { getSettingsStore, getSessionsStore } from '../stores';

export interface CadenzaBridgeDependencies {
	getMainWindow: () => BrowserWindow | null;
	sessionsStore: ReturnType<typeof getSessionsStore>;
	settingsStore: ReturnType<typeof getSettingsStore>;
	cadenzaHudDeps: CadenzaHudWindowDeps;
}

export interface CadenzaIpcDependencies {
	getMainWindow: () => BrowserWindow | null;
	settingsStore: ReturnType<typeof getSettingsStore>;
}
