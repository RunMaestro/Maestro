import { useCallback } from 'react';
import type { MarketplacePlaybook } from '../../../../shared/marketplace-types';
import { logger } from '../../../utils/logger';
import { notifyToast } from '../../../stores/notificationStore';
import { pickDirectory } from '../../../services/pathPicker';
import { normalizeWorktreePath } from '../../../../shared/worktreePaths';

export interface UsePlaybookImportActionsParams {
	selectedPlaybook: MarketplacePlaybook | null;
	targetFolderName: string;
	autoRunFolderPath: string;
	sessionId: string;
	/** The agent's SSH remote (SSH and hosted alike): where the import writes and Browse lists. */
	sshRemoteId?: string;
	importPlaybook: (
		playbook: MarketplacePlaybook,
		targetFolderName: string,
		autoRunFolderPath: string,
		sessionId: string,
		sshRemoteId?: string
	) => Promise<{ success: boolean; error?: string }>;
	onImportComplete: (folderName: string) => void;
	onClose: () => void;
	setTargetFolderName: (folderName: string) => void;
}

export function usePlaybookImportActions({
	selectedPlaybook,
	targetFolderName,
	autoRunFolderPath,
	sessionId,
	sshRemoteId,
	importPlaybook,
	onImportComplete,
	onClose,
	setTargetFolderName,
}: UsePlaybookImportActionsParams) {
	const handleImport = useCallback(async () => {
		if (!selectedPlaybook || !targetFolderName.trim()) return;

		const result = await importPlaybook(
			selectedPlaybook,
			targetFolderName,
			autoRunFolderPath,
			sessionId,
			sshRemoteId
		);

		if (result.success) {
			onImportComplete(targetFolderName);
			onClose();
		} else {
			logger.error('Import failed:', undefined, result.error);
			notifyToast({
				color: 'red',
				title: 'Import failed',
				message: result.error || 'Unknown error',
				dismissible: true,
			});
		}
	}, [
		selectedPlaybook,
		targetFolderName,
		importPlaybook,
		autoRunFolderPath,
		sessionId,
		sshRemoteId,
		onImportComplete,
		onClose,
	]);

	// The import target is a folder NAME inside the Auto Run folder: the import refuses a path
	// (`assertSafeTargetFolderName`). Browse returns a full path, so only a folder directly inside
	// the Auto Run folder counts, and its name is what goes in the field. Anything else would
	// import somewhere the user did not pick, so it is refused here, with the reason.
	const handleBrowseFolder = useCallback(async () => {
		const folder = await pickDirectory({
			sshRemoteId,
			title: 'Select Import Folder',
			startPath: autoRunFolderPath,
		});
		if (!folder) return;
		// A remote path is always POSIX; a local one may use either separator.
		const posix = !!sshRemoteId;
		const picked = normalizeWorktreePath(folder, posix);
		const root = normalizeWorktreePath(autoRunFolderPath, posix);
		const prefix = root.endsWith('/') ? root : `${root}/`;
		const name = root && picked.startsWith(prefix) ? picked.slice(prefix.length) : '';
		if (!name || name.includes('/')) {
			notifyToast({
				color: 'orange',
				title: 'Pick a folder inside the Auto Run folder',
				message:
					'A playbook is imported into a folder directly inside the Auto Run folder. Pick one there, or type a new folder name.',
			});
			return;
		}
		setTargetFolderName(name);
	}, [sshRemoteId, autoRunFolderPath, setTargetFolderName]);

	return { handleImport, handleBrowseFolder };
}
