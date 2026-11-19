/**
 * PlaybookCompletionModal - the report of a finished playbook run: what was
 * done, how to use it, and what to do next.
 *
 * It pops by itself when a playbook run finishes, wherever the user is: the
 * one place stealing focus is the feature (PROPOSAL D20). Runs that finish
 * together queue in `playbookCompletionStore` and show one at a time, oldest
 * first, with "1 of N" in the header; Done (or Escape, or the X) drops the one
 * on screen and the next appears (D21).
 *
 * "Report a problem" (failed and partial runs of an Exchange playbook) swaps
 * the report for a consent step that shows the exact issue it would file
 * (`PlaybookFailureReportStep`); Back or Escape returns to the report.
 *
 * The first live completion of an official Exchange playbook while playbook
 * telemetry is off leads with a one-time consent step instead of the report
 * (`PlaybookTelemetryConsentStep`): the literal `run_completed` event, "Share
 * anonymous usage", and "No thanks". Either answer, Escape, or the X goes on
 * to the report, and the step never returns.
 *
 * Ways in: a finished playbook run, "Open Last Playbook Report" in the command
 * palette, and `maestro-cli open playbook-report` (all but the first through
 * `openPlaybookReport`). Ways out: Done, Escape, and the header X.
 *
 * Every word comes from the shared report renderer (`playbookReportSections`),
 * so the modal, Copy, Save to project, and the copy under
 * `.maestro-reports/` say the same thing.
 *
 * Self-subscribing: mounted once in `AppStandaloneModals`, it renders nothing
 * until the `playbookReport` modal is open with a report waiting.
 */

import { useCallback, useEffect, useState } from 'react';
import type {
	PlaybookFailureIssuePreview,
	PlaybookFailurePreviewPayload,
} from '../../../shared/feedback';
import { playbookRunReportStatusLabel } from '../../../shared/playbookRunReport';
import { MODAL_PRIORITIES } from '../../constants/modalPriorities';
import {
	copyPlaybookReport,
	openPlaybookCompletionFile,
	savePlaybookCompletionToProject,
} from '../../services/playbookCompletion';
import {
	canReportPlaybookFailure,
	loadPlaybookFailurePayload,
	previewPlaybookFailure,
	submitPlaybookFailureReport,
} from '../../services/playbookFailureReport';
import {
	answerPlaybookTelemetryConsent,
	notePlaybookTelemetryConsentShown,
	shouldOfferPlaybookTelemetryConsent,
} from '../../services/playbookTelemetryConsent';
import { selectModalOpen, useModalStore } from '../../stores/modalStore';
import {
	selectCurrentPlaybookCompletion,
	selectPlaybookCompletionCount,
	usePlaybookCompletionStore,
	type PlaybookCompletion,
} from '../../stores/playbookCompletionStore';
import { selectSessionById, useSessionStore } from '../../stores/sessionStore';
import type { Theme } from '../../types';
import { ipcErrorMessage } from '../../utils/ipcErrorMessage';
import { getSessionSshRemoteId } from '../../utils/sessionHelpers';
import { MiniBadge } from '../ui/MiniBadge';
import { Modal, MODAL_BUTTON_BASE_CLASS, MODAL_BUTTON_SECONDARY_CLASS } from '../ui/Modal';
import {
	PlaybookReportBody,
	PlaybookReportStatusIcon,
	playbookReportStatusColor,
} from './PlaybookReportBody';
import { PlaybookFailureReportStep } from './PlaybookFailureReportStep';
import { PlaybookTelemetryConsentStep } from './PlaybookTelemetryConsentStep';

/** The "Report a problem" consent step, while it is open. */
interface FailureReportState {
	payload: PlaybookFailurePreviewPayload | null;
	preview: PlaybookFailureIssuePreview | null;
	error: string | null;
}

export interface PlaybookCompletionModalProps {
	theme: Theme;
}

export function PlaybookCompletionModal({ theme }: PlaybookCompletionModalProps) {
	const isOpen = useModalStore(selectModalOpen('playbookReport'));
	const current = usePlaybookCompletionStore(selectCurrentPlaybookCompletion);
	const count = usePlaybookCompletionStore(selectPlaybookCompletionCount);
	if (!isOpen || !current) return null;
	// Keyed on the entry, so the next report starts with Details folded and no
	// save in flight.
	return (
		<PlaybookCompletionModalBody
			key={current.id}
			theme={theme}
			completion={current}
			count={count}
		/>
	);
}

interface PlaybookCompletionModalBodyProps {
	theme: Theme;
	completion: PlaybookCompletion;
	/** Reports waiting, this one included. */
	count: number;
}

function PlaybookCompletionModalBody({
	theme,
	completion,
	count,
}: PlaybookCompletionModalBodyProps) {
	const { report, sessionId } = completion;
	const dismissCurrent = usePlaybookCompletionStore((s) => s.dismissCurrent);
	const agentCwd = useSessionStore((s) => selectSessionById(sessionId)(s)?.cwd);
	const agentFileTree = useSessionStore((s) => selectSessionById(sessionId)(s)?.fileTree);
	const sshRemoteId = useSessionStore((s) =>
		getSessionSshRemoteId(selectSessionById(sessionId)(s))
	);
	const agentProvider = useSessionStore((s) => selectSessionById(sessionId)(s)?.toolType);
	const [saving, setSaving] = useState(false);
	const [failureReport, setFailureReport] = useState<FailureReportState | null>(null);
	const [includeDebugPackage, setIncludeDebugPackage] = useState(false);
	const [sendingReport, setSendingReport] = useState(false);
	// Decided once per entry: the step is offered only if it was never shown.
	const [telemetryConsentOpen, setTelemetryConsentOpen] = useState(() =>
		shouldOfferPlaybookTelemetryConsent(completion.telemetryEvent)
	);

	useEffect(() => {
		if (telemetryConsentOpen) notePlaybookTelemetryConsentShown();
	}, [telemetryConsentOpen]);

	const answerTelemetryConsent = useCallback((share: boolean) => {
		answerPlaybookTelemetryConsent(share);
		setTelemetryConsentOpen(false);
	}, []);
	const skipTelemetryConsent = useCallback(() => setTelemetryConsentOpen(false), []);

	const cwd = report.cwd ?? agentCwd;
	// The agent's file tree indexes the agent's cwd; a worktree run's paths are
	// relative to the worktree, so they resolve by path alone.
	const fileTree = cwd && cwd === agentCwd ? agentFileTree : undefined;
	const color = playbookReportStatusColor(theme, report.status);

	const handleFileClick = useCallback(
		(path: string) => openPlaybookCompletionFile(completion, path),
		[completion]
	);
	const handleCopy = useCallback(() => void copyPlaybookReport(report), [report]);
	const handleSave = useCallback(async () => {
		setSaving(true);
		try {
			await savePlaybookCompletionToProject(completion);
		} finally {
			setSaving(false);
		}
	}, [completion]);

	const reportable =
		(report.status === 'failed' || report.status === 'partial') && canReportPlaybookFailure(report);

	const openFailureReport = useCallback(async () => {
		setFailureReport({ payload: null, preview: null, error: null });
		try {
			const payload = await loadPlaybookFailurePayload(
				report,
				agentProvider ?? 'unknown',
				sshRemoteId
			);
			if (!payload) {
				setFailureReport({
					payload: null,
					preview: null,
					error: 'This run has no failure to report.',
				});
				return;
			}
			const preview = await previewPlaybookFailure(payload);
			setFailureReport({ payload, preview, error: null });
		} catch (error) {
			setFailureReport({ payload: null, preview: null, error: ipcErrorMessage(error) });
		}
	}, [report, agentProvider, sshRemoteId]);

	const closeFailureReport = useCallback(() => setFailureReport(null), []);

	const sendFailureReport = useCallback(async () => {
		if (!failureReport?.payload) return;
		setSendingReport(true);
		try {
			const result = await submitPlaybookFailureReport(failureReport.payload, {
				includeDebugPackage,
			});
			// Filed, added to an existing issue, or handed to the browser: done here.
			if (result && (result.success || result.browserFallback)) setFailureReport(null);
		} finally {
			setSendingReport(false);
		}
	}, [failureReport, includeDebugPackage]);

	const subtitle = (
		<span className="flex items-center gap-2">
			<MiniBadge
				label={playbookRunReportStatusLabel(report.status)}
				theme={theme}
				color={color}
				testId="playbook-completion-status"
			/>
			{count > 1 && (
				<span data-testid="playbook-completion-position" style={{ color: theme.colors.textDim }}>
					1 of {count}
				</span>
			)}
		</span>
	);

	const reportFooter = (
		<>
			<button
				type="button"
				onClick={closeFailureReport}
				disabled={sendingReport}
				className={`${MODAL_BUTTON_SECONDARY_CLASS} mr-auto disabled:opacity-50 disabled:cursor-not-allowed`}
				style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
				data-testid="playbook-failure-back"
			>
				Back
			</button>
			<button
				type="button"
				onClick={() => void sendFailureReport()}
				disabled={!failureReport?.preview || sendingReport}
				className={`${MODAL_BUTTON_BASE_CLASS} disabled:opacity-50 disabled:cursor-not-allowed`}
				style={{
					backgroundColor: theme.colors.accent,
					color: theme.colors.accentForeground,
				}}
				data-testid="playbook-failure-send"
			>
				{sendingReport ? 'Sending...' : 'Send report'}
			</button>
		</>
	);

	const consentFooter = (
		<>
			<button
				type="button"
				onClick={() => answerTelemetryConsent(false)}
				className={`${MODAL_BUTTON_SECONDARY_CLASS} mr-auto`}
				style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
				data-testid="playbook-telemetry-consent-decline"
			>
				No thanks
			</button>
			<button
				type="button"
				onClick={() => answerTelemetryConsent(true)}
				className={MODAL_BUTTON_BASE_CLASS}
				style={{
					backgroundColor: theme.colors.accent,
					color: theme.colors.accentForeground,
				}}
				data-testid="playbook-telemetry-consent-accept"
			>
				Share anonymous usage
			</button>
		</>
	);

	const footer = (
		<>
			{report.status !== 'completed' && (
				<button
					type="button"
					onClick={() => void openFailureReport()}
					disabled={!reportable}
					title={
						reportable
							? 'File this failure for the playbook author, after you see exactly what is sent'
							: 'Only failed or partial runs of a Playbook Exchange playbook can be reported'
					}
					className={`${MODAL_BUTTON_SECONDARY_CLASS} mr-auto disabled:opacity-50 disabled:cursor-not-allowed`}
					style={{
						borderColor: theme.colors.border,
						color: reportable ? theme.colors.textMain : theme.colors.textDim,
					}}
					data-testid="playbook-completion-report-problem"
				>
					Report a problem
				</button>
			)}
			<button
				type="button"
				onClick={handleCopy}
				className={MODAL_BUTTON_SECONDARY_CLASS}
				style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
				data-testid="playbook-completion-copy"
			>
				Copy report
			</button>
			<button
				type="button"
				onClick={() => void handleSave()}
				disabled={saving || !agentCwd}
				title={agentCwd ? `Save to ${agentCwd}` : 'The agent that ran this playbook is gone'}
				className={`${MODAL_BUTTON_SECONDARY_CLASS} disabled:opacity-50 disabled:cursor-not-allowed`}
				style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
				data-testid="playbook-completion-save"
			>
				Save to project
			</button>
			<button
				type="button"
				onClick={dismissCurrent}
				className={MODAL_BUTTON_BASE_CLASS}
				style={{
					backgroundColor: theme.colors.accent,
					color: theme.colors.accentForeground,
				}}
				data-testid="playbook-completion-done"
			>
				Done
			</button>
		</>
	);

	// The event itself, so the step renders only with a payload to show.
	const showTelemetryConsent = telemetryConsentOpen ? completion.telemetryEvent : undefined;

	return (
		<Modal
			theme={theme}
			title={report.playbookName}
			subtitle={subtitle}
			headerIcon={<PlaybookReportStatusIcon status={report.status} color={color} />}
			priority={MODAL_PRIORITIES.PLAYBOOK_COMPLETION}
			onClose={
				showTelemetryConsent
					? skipTelemetryConsent
					: failureReport
						? closeFailureReport
						: dismissCurrent
			}
			width={720}
			resizeKey="modal-playbook-completion"
			defaultSize={{ width: 720, height: 640 }}
			minSize={{ width: 480, height: 360 }}
			footer={showTelemetryConsent ? consentFooter : failureReport ? reportFooter : footer}
			testId="playbook-completion-modal"
			contentClassName="flex-1 min-h-0 overflow-y-auto px-6 py-4 select-none"
		>
			{showTelemetryConsent ? (
				<PlaybookTelemetryConsentStep theme={theme} event={showTelemetryConsent} />
			) : failureReport ? (
				<PlaybookFailureReportStep
					theme={theme}
					preview={failureReport.preview}
					error={failureReport.error}
					includeDebugPackage={includeDebugPackage}
					onIncludeDebugPackageChange={setIncludeDebugPackage}
				/>
			) : (
				<PlaybookReportBody
					theme={theme}
					report={report}
					fileTree={fileTree}
					cwd={cwd}
					sshRemoteId={sshRemoteId}
					onFileClick={handleFileClick}
				/>
			)}
		</Modal>
	);
}
