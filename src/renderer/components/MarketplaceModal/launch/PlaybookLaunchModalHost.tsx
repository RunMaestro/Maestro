/**
 * PlaybookLaunchModalHost - mounts the Playbook Launch dialog from the modal store.
 *
 * The Exchange's Launch button opens the dialog with `openPlaybookLaunch(playbook)`; the host
 * draws it and decides what the two ways out do. Cancel closes only the dialog, so the person is
 * back on the playbook's detail view. A launch that started closes the dialog AND the Exchange
 * (the person's next look is the agent running the playbook) and raises a toast that names the
 * agent and goes to it when clicked.
 *
 * It self-subscribes, like the other hosts mounted in `AppStandaloneModals`, so that component
 * carries no launch props. It draws nothing until a playbook is set.
 */

import { useCallback } from 'react';
import { notifyLaunchStarted } from '../../../services/playbookLaunch';
import { getModalActions, selectModalData, useModalStore } from '../../../stores/modalStore';
import type { Theme } from '../../../types';
import { PlaybookLaunchModal, type StartedLaunch } from './PlaybookLaunchModal';

export interface PlaybookLaunchModalHostProps {
	theme: Theme;
}

export function PlaybookLaunchModalHost({ theme }: PlaybookLaunchModalHostProps) {
	const playbook = useModalStore(selectModalData('playbookLaunch'))?.playbook;

	const handleClose = useCallback(() => getModalActions().closePlaybookLaunch(), []);

	const title = playbook?.title;
	const handleLaunched = useCallback(
		(started: StartedLaunch) => {
			const { closePlaybookLaunch, setMarketplaceModalOpen } = getModalActions();
			closePlaybookLaunch();
			setMarketplaceModalOpen(false);
			if (title !== undefined) notifyLaunchStarted(title, started);
		},
		[title]
	);

	if (!playbook) return null;
	return (
		<PlaybookLaunchModal
			theme={theme}
			playbook={playbook}
			onClose={handleClose}
			onLaunched={handleLaunched}
		/>
	);
}
