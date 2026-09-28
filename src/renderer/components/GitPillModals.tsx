/**
 * GitPillModals - host for the modals launched from the header git pill menu.
 *
 * Mounted once from AppStandaloneModals. It subscribes to just its two modal
 * IDs (rather than joining the broad useModalActions bundle) so unrelated modal
 * traffic doesn't re-render it, and it keeps the pill's launch path free of
 * prop drilling through MainPanel.
 */

import { memo } from 'react';
import { GitCommandRunnerModal } from './GitCommandRunnerModal';
import { BranchSwitcherModal } from './BranchSwitcherModal';
import { useModalStore, selectModalData, selectModalOpen } from '../stores/modalStore';
import { useGitCommandRunNotifier } from '../hooks/git/useGitCommandRunNotifier';
import { gitRunKey } from '../stores/gitCommandRunStore';
import type { Theme } from '../types';

export interface GitPillModalsProps {
	theme: Theme;
}

export const GitPillModals = memo(function GitPillModals({ theme }: GitPillModalsProps) {
	const runnerOpen = useModalStore(selectModalOpen('gitCommandRunner'));
	const runnerData = useModalStore(selectModalData('gitCommandRunner'));
	const switcherOpen = useModalStore(selectModalOpen('branchSwitcher'));
	const switcherData = useModalStore(selectModalData('branchSwitcher'));
	const closeModal = useModalStore((s) => s.closeModal);

	// Runs finish whether or not their console is open, so something outside the
	// modal has to report them. Passing the visible run's key keeps it from
	// toasting a result the user is already looking at.
	useGitCommandRunNotifier(runnerOpen && runnerData ? gitRunKey(runnerData) : null);

	return (
		<>
			{runnerOpen && runnerData && (
				<GitCommandRunnerModal
					theme={theme}
					// Remount per operation+repo. Within one key the console attaches
					// to whatever run gitCommandRunStore already has, so a reopened
					// push shows its transcript rather than starting a second push.
					key={gitRunKey(runnerData)}
					data={runnerData}
					onClose={() => closeModal('gitCommandRunner')}
				/>
			)}

			{switcherOpen && switcherData && (
				<BranchSwitcherModal
					theme={theme}
					data={switcherData}
					onClose={() => closeModal('branchSwitcher')}
				/>
			)}
		</>
	);
});

export default GitPillModals;
