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

import { useCallback, useMemo, useState } from 'react';
import { CheckCircle2, ChevronRight, StopCircle, AlertTriangle, XCircle } from 'lucide-react';
import {
	playbookReportFooterParts,
	playbookReportSections,
	playbookRunReportStatusLabel,
	type PlaybookRunReportStatus,
} from '../../../shared/playbookRunReport';
import { MODAL_PRIORITIES } from '../../constants/modalPriorities';
import {
	copyPlaybookReport,
	openPlaybookCompletionFile,
	savePlaybookCompletionToProject,
} from '../../services/playbookCompletion';
import { selectModalOpen, useModalStore } from '../../stores/modalStore';
import {
	selectCurrentPlaybookCompletion,
	selectPlaybookCompletionCount,
	usePlaybookCompletionStore,
	type PlaybookCompletion,
} from '../../stores/playbookCompletionStore';
import { selectSessionById, useSessionStore } from '../../stores/sessionStore';
import type { Theme } from '../../types';
import { safeClipboardWrite } from '../../utils/clipboard';
import { getSessionSshRemoteId } from '../../utils/sessionHelpers';
import { MarkdownRenderer } from '../MarkdownRenderer';
import { MiniBadge } from '../ui/MiniBadge';
import { Modal, MODAL_BUTTON_BASE_CLASS, MODAL_BUTTON_SECONDARY_CLASS } from '../ui/Modal';

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

function statusColor(theme: Theme, status: PlaybookRunReportStatus): string {
	switch (status) {
		case 'completed':
			return theme.colors.success;
		case 'partial':
			return theme.colors.warning;
		case 'failed':
			return theme.colors.error;
		case 'stopped':
			return theme.colors.textDim;
	}
}

function StatusIcon({ status, color }: { status: PlaybookRunReportStatus; color: string }) {
	const props = { className: 'w-4 h-4', style: { color }, 'aria-hidden': true } as const;
	switch (status) {
		case 'completed':
			return <CheckCircle2 {...props} />;
		case 'partial':
			return <AlertTriangle {...props} />;
		case 'failed':
			return <XCircle {...props} />;
		case 'stopped':
			return <StopCircle {...props} />;
	}
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
	const [saving, setSaving] = useState(false);

	const sections = useMemo(() => playbookReportSections(report), [report]);
	const footerLine = useMemo(() => playbookReportFooterParts(report).join(' · '), [report]);
	const cwd = report.cwd ?? agentCwd;
	// The agent's file tree indexes the agent's cwd; a worktree run's paths are
	// relative to the worktree, so they resolve by path alone.
	const fileTree = cwd && cwd === agentCwd ? agentFileTree : undefined;
	const color = statusColor(theme, report.status);

	// What the run did, read first: a failure's card above the narrative.
	const body = [
		sections.whatDidNotHappen,
		sections.whatWasDone,
		sections.howToUse,
		sections.nextSteps,
	]
		.filter(Boolean)
		.join('\n\n');
	const details = [sections.filesChanged, sections.configuration].filter(Boolean).join('\n\n');

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

	const markdownProps = {
		theme,
		onCopy: (text: string) => void safeClipboardWrite(text),
		fileTree,
		cwd,
		projectRoot: cwd,
		sshRemoteId,
		onFileClick: handleFileClick,
	};

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

	const footer = (
		<>
			{report.status !== 'completed' && (
				<button
					type="button"
					disabled
					title="Not available yet"
					className={`${MODAL_BUTTON_SECONDARY_CLASS} mr-auto disabled:opacity-50 disabled:cursor-not-allowed`}
					style={{ borderColor: theme.colors.border, color: theme.colors.textDim }}
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

	return (
		<Modal
			theme={theme}
			title={report.playbookName}
			subtitle={subtitle}
			headerIcon={<StatusIcon status={report.status} color={color} />}
			priority={MODAL_PRIORITIES.PLAYBOOK_COMPLETION}
			onClose={dismissCurrent}
			width={720}
			resizeKey="modal-playbook-completion"
			defaultSize={{ width: 720, height: 640 }}
			minSize={{ width: 480, height: 360 }}
			footer={footer}
			testId="playbook-completion-modal"
			contentClassName="flex-1 min-h-0 overflow-y-auto px-6 py-4 select-none"
		>
			<div className="select-text" data-testid="playbook-completion-body">
				<p className="text-xs mb-3" style={{ color: theme.colors.textDim }}>
					{footerLine}
				</p>
				<MarkdownRenderer content={body} {...markdownProps} />
			</div>
			{details && (
				<details className="mt-4 group" data-testid="playbook-completion-details">
					<summary
						className="flex items-center gap-1 cursor-pointer text-sm list-none"
						style={{ color: theme.colors.textDim }}
					>
						<ChevronRight
							className="w-3.5 h-3.5 transition-transform group-open:rotate-90"
							aria-hidden="true"
						/>
						Details
					</summary>
					<div className="mt-2 select-text">
						<MarkdownRenderer content={details} {...markdownProps} />
					</div>
				</details>
			)}
		</Modal>
	);
}
