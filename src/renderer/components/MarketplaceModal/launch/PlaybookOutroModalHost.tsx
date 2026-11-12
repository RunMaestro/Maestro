/**
 * PlaybookOutroModalHost - mounts the Playbook outro from the modal store.
 *
 * A launched run ends, main records it and cleans up, and `announceLaunchEnd()` (or the click on
 * its toast, `openLaunchOutro()`) opens the outro with `openPlaybookOutro(launch)`. The host draws
 * it and closes it. Every way out of the dialog (Close, the X, Escape, and the buttons that move
 * on to a file or to the launch dialog) ends in `onClose`, which closes the store entry.
 *
 * It self-subscribes, like the other hosts mounted in `AppStandaloneModals`, so that component
 * carries no launch props beyond the app's open-file path. It draws nothing until a launch is set.
 */

import { useCallback } from 'react';
import { getModalActions, selectModalData, useModalStore } from '../../../stores/modalStore';
import type { Theme } from '../../../types';
import { PlaybookOutroModal } from './PlaybookOutroModal';

export interface PlaybookOutroModalHostProps {
	theme: Theme;
	/**
	 * Open a file in a preview tab on the active agent: the app's own open-file path, so media goes
	 * to the floating player and a file the OS owns asks first.
	 */
	onOpenFile: (path: string) => void;
}

export function PlaybookOutroModalHost({ theme, onOpenFile }: PlaybookOutroModalHostProps) {
	const launch = useModalStore(selectModalData('playbookOutro'))?.launch;

	const handleClose = useCallback(() => getModalActions().closePlaybookOutro(), []);

	if (!launch) return null;
	// Keyed by the launch, so an outro opened over another (a click on a toast) starts clean.
	return (
		<PlaybookOutroModal
			key={launch.launchId}
			theme={theme}
			launch={launch}
			onClose={handleClose}
			onOpenFile={onOpenFile}
		/>
	);
}
