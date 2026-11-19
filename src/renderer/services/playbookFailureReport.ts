/**
 * "Report a problem" on a finished playbook run: find the failure the run
 * can report, show the exact issue it would file, and file it.
 *
 * The issue is built in the main process (the fingerprint hashes with node
 * `crypto`), from the pristine copy of the failing document this service reads
 * through the SSH-aware Auto Run reader. Preview and submit build from the
 * same input, so the body the user agreed to is the body that is sent.
 *
 * Without a usable gh the main process sends nothing and hands back a
 * prefilled GitHub URL instead: this opens it in the system browser, puts any
 * overflow on the clipboard, and says so in a toast.
 */

import type {
	PlaybookFailureIssuePreview,
	PlaybookFailurePreviewPayload,
	PlaybookFailureSubmitResponse,
} from '../../shared/feedback';
import { playbookFailureFromRunReport } from '../../shared/playbookFailureCore';
import type { PlaybookRunReport } from '../../shared/playbookRunReport';
import { notifyToast } from '../stores/notificationStore';
import { safeClipboardWrite } from '../utils/clipboard';
import { ipcErrorMessage } from '../utils/ipcErrorMessage';

/** Whether a finished run has a failure "Report a problem" can file. */
export function canReportPlaybookFailure(report: PlaybookRunReport): boolean {
	return playbookFailureFromRunReport(report, '') !== null;
}

/**
 * The preview input for a run: the failure plus the shipped text of its
 * document. Null when the run has nothing to report. A pristine copy that
 * cannot be read leaves the task line out; it is never read from the working
 * copy, which holds the user's expanded parameter values.
 */
export async function loadPlaybookFailurePayload(
	report: PlaybookRunReport,
	agentProvider: string,
	sshRemoteId?: string
): Promise<PlaybookFailurePreviewPayload | null> {
	const draft = playbookFailureFromRunReport(report, agentProvider);
	if (!draft) return null;
	let pristineSource: string | null = null;
	if (report.autoRunFolderPath) {
		try {
			const result = await window.maestro.autorun.readDoc(
				report.autoRunFolderPath,
				draft.pristineDocumentPath,
				sshRemoteId
			);
			pristineSource = result?.success && result.content ? result.content : null;
		} catch {
			// No pristine copy (an import that kept none, or a moved folder): the
			// issue says the shipped task was not available.
			pristineSource = null;
		}
	}
	return { report: draft.report, pristineSource };
}

/** The issue exactly as it would be filed. */
export function previewPlaybookFailure(
	payload: PlaybookFailurePreviewPayload
): Promise<PlaybookFailureIssuePreview> {
	return window.maestro.feedback.previewPlaybookFailure(payload);
}

/**
 * File the failure and tell the user what happened in a toast. Returns the
 * main process's answer, or null when the call itself failed.
 */
export async function submitPlaybookFailureReport(
	payload: PlaybookFailurePreviewPayload,
	options: { includeDebugPackage: boolean }
): Promise<PlaybookFailureSubmitResponse | null> {
	let result: PlaybookFailureSubmitResponse;
	try {
		result = await window.maestro.feedback.submitPlaybookFailure({
			...payload,
			includeDebugPackage: options.includeDebugPackage,
		});
	} catch (error) {
		notifyToast({ color: 'red', title: 'Report not sent', message: ipcErrorMessage(error) });
		return null;
	}

	if (result.browserFallback) {
		await openBrowserFallback(result);
		return result;
	}
	if (!result.success) {
		notifyToast({
			color: 'red',
			title: 'Report not sent',
			message: result.error ?? 'GitHub did not accept the report.',
		});
		return result;
	}

	const warnings = result.warnings?.length ? ` ${result.warnings.join(' ')}` : '';
	notifyToast({
		color: 'green',
		title: result.deduplicated ? 'Already reported' : 'Problem reported',
		message: result.deduplicated
			? `Someone already reported this failure. Your +1 and version were added to the open issue.${warnings}`
			: `The issue is filed.${warnings}`,
		...(result.issueUrl && { clickAction: { kind: 'open-url' as const, url: result.issueUrl } }),
	});
	return result;
}

/** Open the prefilled new-issue page and put whatever did not fit on the clipboard. */
async function openBrowserFallback(result: PlaybookFailureSubmitResponse): Promise<void> {
	const fallback = result.browserFallback!;
	const copied = fallback.overflow ? await safeClipboardWrite(fallback.overflow) : false;
	window.maestro.shell.openExternal(fallback.url);
	const reason = result.error ? `${result.error} ` : '';
	const overflowNote = fallback.overflow
		? copied
			? ' The report was too long for the link, so the rest is on your clipboard: paste it at the end of the issue.'
			: ' The report was too long for the link, and the rest could not be copied to the clipboard.'
		: '';
	notifyToast({
		color: 'yellow',
		title: 'Finish the report in your browser',
		message: `${reason}A prefilled GitHub issue opened in your browser.${overflowNote}`,
		clickAction: { kind: 'open-url', url: fallback.url },
	});
}
