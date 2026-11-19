/**
 * The completion modal's actions: what Copy, Save to project, a clicked file
 * path, and opening the `playbook-report` surface do.
 *
 * The queue itself is `playbookCompletionStore`; the report's words come from
 * the shared renderer (`renderPlaybookReportMarkdown`), so the copied text,
 * the saved file, and the file under `.maestro-reports/` are the same
 * document.
 */

import { isAbsolutePath, joinPath } from '../../shared/formatters';
import {
	renderPlaybookReportMarkdown,
	type PlaybookRunReport,
} from '../../shared/playbookRunReport';
import { notifyToast } from '../stores/notificationStore';
import { useModalStore } from '../stores/modalStore';
import {
	usePlaybookCompletionStore,
	type PlaybookCompletion,
} from '../stores/playbookCompletionStore';
import { selectActiveSession, selectSessionById, useSessionStore } from '../stores/sessionStore';
import { safeClipboardWrite } from '../utils/clipboard';
import { flashCopiedToClipboard } from '../utils/flashCopiedToClipboard';
import { ipcErrorMessage } from '../utils/ipcErrorMessage';
import { getSessionSshRemoteId } from '../utils/sessionHelpers';
import { loadLatestPlaybookRunReport, savePlaybookReportToProject } from './playbookRunReport';

/** Put the rendered report on the clipboard. Returns whether it got there. */
export async function copyPlaybookReport(report: PlaybookRunReport): Promise<boolean> {
	const copied = await safeClipboardWrite(renderPlaybookReportMarkdown(report));
	if (copied) {
		flashCopiedToClipboard(report.playbookName, 'Report Copied to Clipboard');
	} else {
		notifyToast({
			color: 'red',
			title: 'Copy failed',
			message: 'The report could not be copied to the clipboard.',
		});
	}
	return copied;
}

/**
 * "Save to project": write the report into the agent's working directory
 * (SSH-aware) and say where in a toast that opens the file on click. Returns
 * the path, or null when the agent is gone or the write failed.
 */
export async function savePlaybookCompletionToProject(
	completion: PlaybookCompletion
): Promise<string | null> {
	const session = selectSessionById(completion.sessionId)(useSessionStore.getState());
	if (!session) {
		notifyToast({
			color: 'red',
			title: 'Report not saved',
			message: 'The agent that ran this playbook no longer exists.',
		});
		return null;
	}
	try {
		const path = await savePlaybookReportToProject(
			completion.report,
			session.cwd,
			getSessionSshRemoteId(session)
		);
		notifyToast({
			color: 'green',
			title: 'Report saved',
			message: path,
			sessionId: session.id,
			clickAction: { kind: 'open-file', sessionId: session.id, path },
		});
		return path;
	} catch (error) {
		notifyToast({ color: 'red', title: 'Report not saved', message: ipcErrorMessage(error) });
		return null;
	}
}

/**
 * The folder a report's relative paths resolve against: the run's own cwd
 * (the worktree when it used one), else the agent's.
 */
export function playbookCompletionCwd(completion: PlaybookCompletion): string | undefined {
	if (completion.report.cwd) return completion.report.cwd;
	return selectSessionById(completion.sessionId)(useSessionStore.getState())?.cwd;
}

/**
 * A file path clicked in the report: open it in the agent's File Preview,
 * through the same path the CLI and toast clicks use. The report is
 * dismissed first, since the file opens beneath it; it stays in History and
 * `.maestro-reports/`.
 */
export function openPlaybookCompletionFile(completion: PlaybookCompletion, path: string): void {
	const cwd = playbookCompletionCwd(completion);
	const filePath = isAbsolutePath(path) || !cwd ? path : joinPath(cwd, path);
	usePlaybookCompletionStore.getState().dismissCurrent();
	window.dispatchEvent(
		new CustomEvent('maestro:openFileTab', {
			detail: { sessionId: completion.sessionId, filePath },
		})
	);
}

/**
 * "Open report" on a History entry: show the report a playbook run's summary
 * entry carries in the completion modal. It joins the queue like any other
 * report, so one already on screen is never replaced. `sessionId` is the
 * agent the run belonged to; without one, Save to project is unavailable.
 */
export function openPlaybookReportFromHistory(
	sessionId: string | undefined,
	report: PlaybookRunReport
): void {
	usePlaybookCompletionStore.getState().enqueue(sessionId ?? '', report);
}

/**
 * The `playbook-report` surface (`maestro-cli open playbook-report`, the
 * command palette): show the waiting reports, or, with none waiting, the
 * active agent's most recent saved one. Says so in a toast when there is
 * nothing to show.
 */
export async function openPlaybookReport(): Promise<boolean> {
	const store = usePlaybookCompletionStore.getState();
	if (store.queue.length > 0) {
		useModalStore.getState().openModal('playbookReport');
		return true;
	}
	const session = selectActiveSession(useSessionStore.getState());
	const nothing = (message: string) => {
		notifyToast({ color: 'yellow', title: 'No playbook report', message });
		return false;
	};
	if (!session) return nothing('Select an agent first: reports belong to the agent that ran them.');
	if (!session.autoRunFolderPath) return nothing(`${session.name} has no Auto Run folder.`);
	try {
		const report = await loadLatestPlaybookRunReport(
			session.autoRunFolderPath,
			getSessionSshRemoteId(session)
		);
		if (!report) return nothing(`${session.name} has not finished a playbook run yet.`);
		usePlaybookCompletionStore.getState().enqueue(session.id, report);
		return true;
	} catch (error) {
		notifyToast({
			color: 'red',
			title: 'Report not opened',
			message: ipcErrorMessage(error),
		});
		return false;
	}
}
