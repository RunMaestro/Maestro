/**
 * PlaybookReportBody - the body of a playbook run report, shared by the
 * completion modal and the History detail view so both show the same
 * sections in the same order.
 *
 * Order: the footer facts line; the "What did not happen" card (partial and
 * failed runs only, above the narrative so a failure is read first); "What
 * was done", "How to use it", and "Next steps"; then a collapsed "Details"
 * disclosure with the files changed and the configuration. Every word comes
 * from `playbookReportSections`, the same split Copy and Save join.
 */

import { useMemo } from 'react';
import { AlertTriangle, CheckCircle2, ChevronRight, StopCircle, XCircle } from 'lucide-react';
import {
	playbookReportFooterParts,
	playbookReportSections,
	playbookRunReportStatusLabel,
	type PlaybookRunReport,
	type PlaybookRunReportStatus,
} from '../../../shared/playbookRunReport';
import type { Theme } from '../../types';
import type { FileNode } from '../../types/fileTree';
import { safeClipboardWrite } from '../../utils/clipboard';
import { MarkdownRenderer } from '../MarkdownRenderer';
import { MiniBadge } from '../ui/MiniBadge';

/** The theme color a report status is drawn in. */
export function playbookReportStatusColor(theme: Theme, status: PlaybookRunReportStatus): string {
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

export function PlaybookReportStatusIcon({
	status,
	color,
}: {
	status: PlaybookRunReportStatus;
	color: string;
}) {
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

export interface PlaybookReportBodyProps {
	theme: Theme;
	report: PlaybookRunReport;
	/**
	 * Draw the status icon and badge above the body. The completion modal
	 * leaves it off: its header already carries them.
	 */
	showStatus?: boolean;
	/** Markdown link resolution: paths in the report are relative to `cwd`. */
	fileTree?: FileNode[];
	cwd?: string;
	projectRoot?: string;
	sshRemoteId?: string;
	onFileClick?: (path: string) => void;
	enableBionifyReadingMode?: boolean;
}

export function PlaybookReportBody({
	theme,
	report,
	showStatus = false,
	fileTree,
	cwd,
	projectRoot,
	sshRemoteId,
	onFileClick,
	enableBionifyReadingMode,
}: PlaybookReportBodyProps) {
	const sections = useMemo(() => playbookReportSections(report), [report]);
	const footerLine = useMemo(() => playbookReportFooterParts(report).join(' · '), [report]);
	const color = playbookReportStatusColor(theme, report.status);

	const body = [sections.whatWasDone, sections.howToUse, sections.nextSteps]
		.filter(Boolean)
		.join('\n\n');
	const details = [sections.filesChanged, sections.configuration].filter(Boolean).join('\n\n');

	const markdownProps = {
		theme,
		onCopy: (text: string) => void safeClipboardWrite(text),
		fileTree,
		cwd,
		projectRoot: projectRoot ?? cwd,
		sshRemoteId,
		onFileClick,
		enableBionifyReadingMode,
	};

	return (
		<div data-testid="playbook-report-body">
			{showStatus && (
				<div className="flex items-center gap-2 mb-2" data-testid="playbook-report-status-row">
					<PlaybookReportStatusIcon status={report.status} color={color} />
					<MiniBadge
						label={playbookRunReportStatusLabel(report.status)}
						theme={theme}
						color={color}
						testId="playbook-report-status"
					/>
				</div>
			)}
			<div className="select-text">
				<p className="text-xs mb-3" style={{ color: theme.colors.textDim }}>
					{footerLine}
				</p>
				{sections.whatDidNotHappen && (
					<div
						className="rounded border px-4 py-3 mb-4"
						style={{ borderColor: `${color}66`, backgroundColor: `${color}12` }}
						data-testid="playbook-report-not-done"
					>
						<MarkdownRenderer content={sections.whatDidNotHappen} {...markdownProps} />
					</div>
				)}
				<div data-testid="playbook-report-main">
					<MarkdownRenderer content={body} {...markdownProps} />
				</div>
			</div>
			{details && (
				<details className="mt-4 group" data-testid="playbook-report-details">
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
		</div>
	);
}
