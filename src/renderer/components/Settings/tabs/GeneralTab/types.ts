import type { UseSettingsReturn } from '../../../../hooks/settings/useSettings';
import type { ShellInfo, Theme } from '../../../../types';
import type { MaestroCliStatus } from '../../../../../shared/maestro-cli';

export interface GeneralTabProps {
	theme: Theme;
	isOpen: boolean;
}

export type GeneralTabSettings = UseSettingsReturn;

export interface ShellSettingsState {
	shells: ShellInfo[];
	shellsLoading: boolean;
	shellsLoaded: boolean;
	shellConfigExpanded: boolean;
	setShellConfigExpanded: (expanded: boolean) => void;
	handleShellInteraction: () => void;
	selectShell: (shell: ShellInfo) => void;
}

export interface MaestroCliState {
	status: MaestroCliStatus | null;
	statusError: string | null;
	checking: boolean;
	installing: boolean;
	installMessage: string | null;
	checkStatus: () => Promise<void>;
	installOrUpdate: () => Promise<void>;
}

export interface SyncStorageState {
	defaultStoragePath: string;
	customSyncPath: string | undefined;
	syncRestartRequired: boolean;
	syncMigrating: boolean;
	syncError: string | null;
	syncMigratedCount: number | null;
	chooseSyncFolder: () => Promise<void>;
	resetToDefault: () => Promise<void>;
	openStorageFolder: () => void;
}

export interface ForcedParallelWarningState {
	showWarning: boolean;
	handleToggle: () => void;
	handleConfirm: () => void;
	handleCancel: () => void;
}
