/**
 * usePRCreationNotifier - reports PR creations that finish off-screen.
 *
 * Closing the Create PR form leaves `gh pr create` running (see
 * prCreationStore), so something still has to tell the user how it went. This
 * hook watches every creation for its settlement and reports it once:
 *
 *   - success: hand the details to the host (toast + history entry), close the
 *     form if it is still showing this repo, and drop the run
 *   - failure with the form open: leave it alone. The modal renders the error
 *     inline, where the user can read it and retry
 *   - failure with the form closed: a sticky red toast, and the run is KEPT so
 *     reopening Create Pull Request shows the same error rather than a blank
 *     form that hides why the last attempt died
 *
 * It subscribes imperatively rather than selecting, so the host does not
 * re-render every time an unrelated run changes.
 */

import { useEffect, useRef } from 'react';
import { notifyToast } from '../../stores/notificationStore';
import { usePRCreationStore, type PRCreationRun } from '../../stores/prCreationStore';
import type { PRDetails } from '../../components/CreatePRModal';

/**
 * @param visibleKey Key of the run whose form is on screen, if any.
 * @param onPRCreated Host handler for a PR that was opened (toast + history).
 * @param onCloseModal Closes the form. Called only when it is showing the run
 * that just succeeded.
 */
export function usePRCreationNotifier(
	visibleKey: string | null,
	onPRCreated: (details: PRDetails) => void,
	onCloseModal: () => void
): void {
	// Read at settlement time, not at subscribe time: the form can open or close
	// between a creation starting and finishing.
	const visibleKeyRef = useRef(visibleKey);
	visibleKeyRef.current = visibleKey;
	const onPRCreatedRef = useRef(onPRCreated);
	onPRCreatedRef.current = onPRCreated;
	const onCloseModalRef = useRef(onCloseModal);
	onCloseModalRef.current = onCloseModal;

	useEffect(() => {
		const handle = () => {
			const { runs, markAnnounced, clearRun } = usePRCreationStore.getState();
			for (const run of Object.values(runs)) {
				if (run.status === 'running' || run.announced) continue;
				markAnnounced(run.key);
				const isVisible = visibleKeyRef.current === run.key;

				if (run.status === 'success' && run.prUrl) {
					onPRCreatedRef.current(toDetails(run, run.prUrl));
					if (isVisible) onCloseModalRef.current();
					clearRun(run.key);
					continue;
				}

				if (isVisible) continue;

				// A failure the user never saw has to wait for them: no auto-dismiss.
				notifyToast({
					color: 'red',
					title: 'Pull request failed',
					message: run.error || `Could not open a PR from ${run.sourceBranch}`,
					dismissible: true,
					clickAction: { kind: 'jump-session', sessionId: run.sessionId },
				});
			}
		};

		// Catch a creation that settled between the last render and this subscribe.
		handle();
		return usePRCreationStore.subscribe(handle);
	}, []);
}

function toDetails(run: PRCreationRun, url: string): PRDetails {
	return {
		url,
		title: run.title,
		description: run.description,
		sourceBranch: run.sourceBranch,
		targetBranch: run.targetBranch,
		sessionId: run.sessionId,
	};
}
