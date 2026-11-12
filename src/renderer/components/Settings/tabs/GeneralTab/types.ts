import type { UseSettingsReturn } from '../../../../hooks/settings/useSettings';
import type { ShellInfo, Theme } from '../../../../types';

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

/** The install state moved to a shared hook (the Updates and Playbook Launch dialogs read it too). */
export type { MaestroCliState } from '../../../../hooks/utils/useMaestroCliState';

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
