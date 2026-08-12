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

	return (
		<>
			{runnerOpen && runnerData && (
				<GitCommandRunnerModal
					theme={theme}
					// Remount per operation so a second Pull starts a fresh console.
					key={`${runnerData.operation}:${runnerData.cwd}`}
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
