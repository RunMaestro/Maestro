import type { BrowserWindow } from 'electron';
import type { PluginManager } from '../plugins/plugin-manager';
import type { getSettingsStore } from '../stores';
import type { CadenzaPayload } from '../../shared/cadenza-types';

export interface PluginHostViewBridgeDependencies {
	getMainWindow: () => BrowserWindow | null;
	getPluginManager: () => PluginManager | null;
	settingsStore: ReturnType<typeof getSettingsStore>;
	deliverCadenza: (payload: CadenzaPayload) => boolean;
}
