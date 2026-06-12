import { useCallback } from 'react';
import type { MarketplacePlaybook } from '../../../../shared/marketplace-types';
import { logger } from '../../../utils/logger';
import { notifyToast } from '../../../stores/notificationStore';

export interface UsePlaybookImportActionsParams {
	selectedPlaybook: MarketplacePlaybook | null;
	targetFolderName: string;
	autoRunFolderPath: string;
	sessionId: string;
	sshRemoteId?: string;
	isRemoteSession: boolean;
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
	isRemoteSession,
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

	const handleBrowseFolder = useCallback(async () => {
		if (isRemoteSession) return;
		const folder = await window.maestro.dialog.selectFolder();
		if (folder) {
			setTargetFolderName(folder);
		}
	}, [isRemoteSession, setTargetFolderName]);

	return { handleImport, handleBrowseFolder };
}
