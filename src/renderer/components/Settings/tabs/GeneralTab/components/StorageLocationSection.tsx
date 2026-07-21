import { Check, Cloud, ExternalLink, Folder, FolderSync, RotateCcw, X } from 'lucide-react';
import type { Theme } from '../../../../../types';
import { getOpenInLabel } from '../../../../../utils/platformUtils';
import { SettingsSectionHeading } from '../../../SettingsSectionHeading';
import type { SyncStorageState } from '../types';

interface StorageLocationSectionProps {
	theme: Theme;
	syncStorage: SyncStorageState;
}

export function StorageLocationSection({ theme, syncStorage }: StorageLocationSectionProps) {
	const {
		defaultStoragePath,
		customSyncPath,
		syncRestartRequired,
		syncMigrating,
		syncError,
		syncMigratedCount,
		chooseSyncFolder,
		resetToDefault,
		openStorageFolder,
	} = syncStorage;

	return (
		<div data-setting-id="general-storage">
			<SettingsSectionHeading icon={FolderSync}>Storage Location</SettingsSectionHeading>
			<div
				className="p-3 rounded border space-y-3"
				style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgMain }}
			>
				<div>
					<p className="text-sm font-semibold" style={{ color: theme.colors.textMain }}>
						Settings folder
					</p>
					<p className="text-xs opacity-60 mt-0.5">
						Choose where Maestro stores settings, sessions, and groups (including global environment
						variables, agents, and configurations). Use a synced folder (iCloud Drive, Dropbox,
						OneDrive) to share across devices.
					</p>
					<p className="text-xs opacity-50 mt-1 italic">
						Note: Only run Maestro on one device at a time to avoid sync conflicts.
					</p>
				</div>

				<div>
					<div className="block text-xs opacity-60 mb-1">Default Location</div>
					<div
						className="text-xs p-2 rounded font-mono truncate"
						style={{ backgroundColor: theme.colors.bgActivity }}
						title={defaultStoragePath}
					>
						{defaultStoragePath || 'Loading...'}
					</div>
				</div>

				{customSyncPath && (
					<div>
						<div className="block text-xs opacity-60 mb-1">Current Location (Custom)</div>
						<div
							className="text-xs p-2 rounded font-mono truncate flex items-center gap-2"
							style={{
								backgroundColor: theme.colors.accent + '15',
								border: `1px solid ${theme.colors.accent}40`,
							}}
							title={customSyncPath}
						>
							<Cloud className="w-3 h-3 flex-shrink-0" style={{ color: theme.colors.accent }} />
							<span className="truncate">{customSyncPath}</span>
						</div>
					</div>
				)}

				<div className="flex items-center gap-2 flex-wrap">
					<button
						onClick={() => void chooseSyncFolder()}
						disabled={syncMigrating}
						className="flex items-center gap-2 px-3 py-1.5 rounded text-xs font-medium transition-colors disabled:opacity-50"
						style={{
							backgroundColor: theme.colors.accent,
							color: theme.colors.bgMain,
						}}
					>
						<Folder className="w-3 h-3" />
						{syncMigrating
							? 'Migrating...'
							: customSyncPath
								? 'Change Folder...'
								: 'Choose Folder...'}
					</button>

					{customSyncPath && (
						<button
							onClick={() => void resetToDefault()}
							disabled={syncMigrating}
							className="flex items-center gap-2 px-3 py-1.5 rounded text-xs font-medium transition-colors disabled:opacity-50"
							style={{
								backgroundColor: theme.colors.border,
								color: theme.colors.textMain,
							}}
							title="Reset to default location"
						>
							<RotateCcw className="w-3 h-3" />
							Use Default
						</button>
					)}
				</div>

				{syncMigratedCount !== null && syncMigratedCount > 0 && !syncError && (
					<div
						className="p-2 rounded text-xs flex items-center gap-2"
						style={{
							backgroundColor: theme.colors.success + '20',
							color: theme.colors.success,
						}}
					>
						<Check className="w-3 h-3" />
						Migrated {syncMigratedCount} settings file{syncMigratedCount !== 1 ? 's' : ''}
					</div>
				)}

				{syncError && (
					<div
						className="p-2 rounded text-xs flex items-start gap-2"
						style={{
							backgroundColor: theme.colors.error + '20',
							color: theme.colors.error,
						}}
					>
						<X className="w-3 h-3 flex-shrink-0 mt-0.5" />
						<span>{syncError}</span>
					</div>
				)}

				{syncRestartRequired && !syncError && (
					<div
						className="p-2 rounded text-xs flex items-center gap-2"
						style={{
							backgroundColor: theme.colors.warning + '20',
							color: theme.colors.warning,
						}}
					>
						<RotateCcw className="w-3 h-3" />
						Restart Maestro for changes to take effect
					</div>
				)}

				<div className="flex justify-end">
					<button
						onClick={openStorageFolder}
						disabled={!defaultStoragePath && !customSyncPath}
						className="flex items-center gap-1.5 text-[11px] opacity-60 hover:opacity-100 transition-opacity disabled:opacity-30"
						style={{ color: theme.colors.textMain }}
						title={customSyncPath || defaultStoragePath}
					>
						<ExternalLink className="w-3 h-3" />
						{getOpenInLabel(window.maestro?.platform || 'darwin')}
					</button>
				</div>
			</div>
		</div>
	);
}
