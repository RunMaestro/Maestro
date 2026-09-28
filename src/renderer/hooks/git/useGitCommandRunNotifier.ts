/**
 * useGitCommandRunNotifier - reports git runs that finish off-screen.
 *
 * Closing the git console leaves the command running (see gitCommandRunStore),
 * so something still has to tell the user how it went. This hook watches every
 * run for its settlement and, when no console is showing that run, toasts the
 * result and drops the transcript. Either way it re-syncs git status, since a
 * completed pull/push moves branch, ahead/behind and file counts.
 *
 * It subscribes imperatively rather than selecting from the store: output
 * chunks mutate `runs` continuously, and a selector would re-render the host on
 * every chunk of a `git push` transfer for no visible gain.
 */

import { useEffect, useRef } from 'react';
import { useGitDetail } from '../../contexts/GitStatusContext';
import { notifyToast } from '../../stores/notificationStore';
import { useGitCommandRunStore, type GitCommandRun } from '../../stores/gitCommandRunStore';
import { getBasename } from '../../../shared/formatters';

function toastForRun(run: GitCommandRun): void {
	const repo = getBasename(run.cwd) || run.cwd;
	const where = run.branch ? `${run.branch} in ${repo}` : repo;
	const verb = run.operation.charAt(0).toUpperCase() + run.operation.slice(1);

	if (run.status === 'success') {
		notifyToast({
			color: 'green',
			title: `${verb} complete`,
			message: `git ${run.operation} finished on ${where}`,
			clickAction: { kind: 'jump-session', sessionId: run.sessionId },
		});
		return;
	}

	if (run.status === 'cancelled') {
		notifyToast({
			color: 'yellow',
			title: `${verb} cancelled`,
			message: `git ${run.operation} was stopped on ${where}`,
			clickAction: { kind: 'jump-session', sessionId: run.sessionId },
		});
		return;
	}

	// A failure the user never saw has to wait for them: no auto-dismiss.
	notifyToast({
		color: 'red',
		title: `${verb} failed`,
		message: run.error || `git ${run.operation} failed on ${where}`,
		dismissible: true,
		clickAction: { kind: 'jump-session', sessionId: run.sessionId },
	});
}

/**
 * @param visibleRunKey Key of the run whose console is on screen, if any. That
 * run's outcome is already visible in the modal footer, so it is not toasted.
 */
export function useGitCommandRunNotifier(visibleRunKey: string | null): void {
	const { refreshGitStatus } = useGitDetail();

	// Read at settlement time, not at subscribe time: the console can open or
	// close between a run starting and finishing.
	const visibleRunKeyRef = useRef(visibleRunKey);
	visibleRunKeyRef.current = visibleRunKey;

	useEffect(() => {
		const handle = () => {
			const { runs, markAnnounced, clearRun } = useGitCommandRunStore.getState();
			for (const run of Object.values(runs)) {
				if (run.status === 'running' || run.announced) continue;
				markAnnounced(run.key);
				void refreshGitStatus();
				if (visibleRunKeyRef.current === run.key) continue;
				toastForRun(run);
				// Nothing is showing this transcript and nothing can reopen it, so
				// holding a settled run would only leak its output buffer.
				clearRun(run.key);
			}
		};

		// Catch a run that settled between the last render and this subscribe.
		handle();
		return useGitCommandRunStore.subscribe(handle);
	}, [refreshGitStatus]);
}
