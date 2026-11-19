import { useCallback } from 'react';
import {
	describeMarketplaceImportFailures,
	type MarketplaceImportPlaybookResult,
	type MarketplacePlaybook,
} from '../../../../shared/marketplace-types';
import type { PlaybookUpdateStatus } from '../../../../shared/playbookUpdates';
import type { Playbook } from '../../../../shared/types';
import { logger } from '../../../utils/logger';
import { notifyToast } from '../../../stores/notificationStore';
import { checkPlaybookUpdates, updateInstalledPlaybook } from '../../../services/playbookUpdates';

export interface UsePlaybookImportActionsParams {
	selectedPlaybook: MarketplacePlaybook | null;
	targetFolderName: string;
	/**
	 * The copy of the selected playbook the agent already has. Set, Install
	 * becomes Update: the record is updated in its own folder instead of a
	 * second record being written over the same files.
	 */
	installed?: PlaybookUpdateStatus;
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
	) => Promise<MarketplaceImportPlaybookResult>;
	onImportComplete: (folderName: string) => void;
	onClose: () => void;
	/**
	 * Install and Run succeeded: move the modal on to configuring the run,
	 * carrying the full record the import stored.
	 */
	onConfigure: (playbook: Playbook) => void;
	setTargetFolderName: (folderName: string) => void;
}

export function usePlaybookImportActions({
	selectedPlaybook,
	targetFolderName,
	installed,
	autoRunFolderPath,
	sessionId,
	sshRemoteId,
	isRemoteSession,
	importPlaybook,
	onImportComplete,
	onClose,
	onConfigure,
	setTargetFolderName,
}: UsePlaybookImportActionsParams) {
	/**
	 * Install the selected playbook. Returns the import result on success
	 * (after reporting a partial install), or `null` when nothing was done or
	 * the install failed (after reporting the failure).
	 */
	const install = useCallback(async (): Promise<MarketplaceImportPlaybookResult | null> => {
		if (!selectedPlaybook) return null;
		const target = { sessionId, autoRunFolderPath, sshRemoteId };

		if (installed) {
			// The service reports the outcome in a toast and re-checks.
			const updated = await updateInstalledPlaybook(target, selectedPlaybook.id);
			if (!updated.success) return null;
			onImportComplete(installed.targetFolderName);
			return updated;
		}

		if (!targetFolderName.trim()) return null;
		const result = await importPlaybook(
			selectedPlaybook,
			targetFolderName,
			autoRunFolderPath,
			sessionId,
			sshRemoteId
		);

		if (!result.success) {
			logger.error('Import failed:', undefined, result.error);
			notifyToast({
				color: 'red',
				title: 'Install failed',
				message: result.error || 'Unknown error',
				dismissible: true,
			});
			return null;
		}

		const failures = describeMarketplaceImportFailures(result);
		if (failures) {
			notifyToast({
				color: 'yellow',
				title: 'Playbook installed partially',
				message: failures,
				dismissible: true,
			});
		}
		onImportComplete(targetFolderName);
		// The new record shows as installed (Update, not Install) from now on.
		void checkPlaybookUpdates(target, { force: true });
		return result;
	}, [
		selectedPlaybook,
		targetFolderName,
		installed,
		importPlaybook,
		autoRunFolderPath,
		sessionId,
		sshRemoteId,
		onImportComplete,
	]);

	const handleInstallOnly = useCallback(async () => {
		if (await install()) onClose();
	}, [install, onClose]);

	const handleInstallAndRun = useCallback(async () => {
		const result = await install();
		if (!result) return;
		if (result.playbook) {
			onConfigure(result.playbook);
			return;
		}
		// Every import path returns the stored record; without it there is
		// nothing to configure, so say so and leave the installed files be.
		logger.error('Install succeeded without a playbook record');
		notifyToast({
			color: 'red',
			title: 'Cannot configure the run',
			message: 'The playbook installed, but its record did not come back. Open it from Auto Run.',
			dismissible: true,
		});
		onClose();
	}, [install, onConfigure, onClose]);

	const handleBrowseFolder = useCallback(async () => {
		if (isRemoteSession) return;
		const folder = await window.maestro.dialog.selectFolder();
		if (folder) {
			setTargetFolderName(folder);
		}
	}, [isRemoteSession, setTargetFolderName]);

	return { handleInstallOnly, handleInstallAndRun, handleBrowseFolder };
}
