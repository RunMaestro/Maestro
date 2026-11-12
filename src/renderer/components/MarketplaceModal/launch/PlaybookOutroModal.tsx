/**
 * PlaybookOutroModal - what a launched playbook did, and what to do next.
 *
 * It opens when a launched Auto Run ends and main has recorded the end and cleaned up. Top to
 * bottom:
 *
 * 1. the title (the playbook author's `outro.title`, else the playbook's) and how the run ended:
 *    completed, or stopped with the task documents kept so the person can resume;
 * 2. the run's numbers: tasks, time and cost;
 * 3. the verdict: the first heading section of the report file the run wrote (`outro.reportFile`),
 *    when there is one;
 * 4. the author's summary and next steps;
 * 5. one Open button per output file, which opens it in a preview tab on the agent that ran the
 *    playbook;
 * 6. what cleanup did with the task documents.
 *
 * The footer has Close and **Run again**, which opens the launch dialog again with the answers the
 * run used.
 *
 * Everything it says comes from the launch RECORD (`buildLaunchOutro()`), which keeps the `launch`
 * block and the answers as they were at launch. The dialog is for reading, so its text can be
 * selected and copied. It is a dialog opened by an event, not a surface the person opens, so it is
 * not in `DESTINATION_MODALS` and has no hotkey or palette entry. The same record stays readable
 * later through `marketplace:getLaunch`.
 */

import {
	AlertTriangle,
	CheckCircle2,
	Clock,
	ExternalLink,
	FileText,
	XCircle,
	type LucideIcon,
} from 'lucide-react';
import { useCallback, useMemo, useRef, useState, type ReactElement } from 'react';
import { isAbsolutePath } from '../../../../shared/formatters';
import type { PlaybookLaunchRecord } from '../../../../shared/marketplace-types';
import { MODAL_PRIORITIES } from '../../../constants/modalPriorities';
import { usePathExistence } from '../../../hooks/utils/usePathExistence';
import { jumpToAgent } from '../../../services/agentNavigation';
import { reopenPlaybookLaunch } from '../../../services/playbookLaunch';
import {
	selectActiveSession,
	selectSessionById,
	useSessionStore,
} from '../../../stores/sessionStore';
import type { Theme } from '../../../types';
import { viewportModalSize } from '../../../utils/modalSizing';
import { HeaderActionButton } from '../../ui/HeaderActionButton';
import { Modal, ModalFooter } from '../../ui/Modal';
import { LaunchMarkdown } from './LaunchMarkdown';
import { buildLaunchOutro, launchBulletList, type LaunchOutroTone } from './launchOutro';
import { useLaunchVerdict } from './useLaunchVerdict';

/**
 * The outro is a body portal at the launch dialog's layer. It opens when a run ends, which can be
 * over the Exchange (z-index 9999) or the launch dialog (10000); it mounts later, so it paints on
 * top of both, and `MODAL_PRIORITIES.MARKETPLACE_OUTRO` makes Escape close it first.
 */
const OUTRO_MODAL_Z_INDEX = 10000;

const NO_AGENT_REASON = 'The agent that ran this playbook no longer exists.';
const NO_FILE_REASON = 'The run did not write this file.';

const TONE_ICON: Record<LaunchOutroTone, LucideIcon> = {
	success: CheckCircle2,
	warning: AlertTriangle,
	error: XCircle,
	dim: Clock,
};

function toneColor(theme: Theme, tone: LaunchOutroTone): string {
	switch (tone) {
		case 'success':
			return theme.colors.success;
		case 'warning':
			return theme.colors.warning;
		case 'error':
			return theme.colors.error;
		case 'dim':
			return theme.colors.textDim;
	}
}

export interface PlaybookOutroModalProps {
	theme: Theme;
	/** The launch that ended, as main broadcast it. */
	launch: PlaybookLaunchRecord;
	/**
	 * Close, the X, Escape, and also what follows Run again and Open, because the next thing the
	 * person looks at is the launch dialog or the file.
	 */
	onClose: () => void;
	/**
	 * Open a file in a preview tab on the active agent. The dialog makes the launch's agent the
	 * active one first. The app's own open-file path sits behind this, so media goes to the
	 * floating player and a file the OS owns asks first.
	 */
	onOpenFile: (path: string) => void;
}

export function PlaybookOutroModal({
	theme,
	launch,
	onClose,
	onOpenFile,
}: PlaybookOutroModalProps) {
	// The agent as it is when the outro opens. Its name fills `{{AGENT_NAME}}` in the author's
	// text, and the outro is a record of one run, so a later rename does not rewrite it.
	const agent = useMemo(
		() => selectSessionById(launch.sessionId)(useSessionStore.getState()),
		[launch.sessionId]
	);
	// A boolean, so the dialog does not draw again for every update to any agent.
	const agentExists = useSessionStore((state) =>
		state.sessions.some((session) => session.id === launch.sessionId)
	);
	const view = useMemo(() => buildLaunchOutro(launch, agent), [launch, agent]);
	const verdict = useLaunchVerdict(view.reportFile, launch.sshRemoteId);
	const pathExists = usePathExistence(launch.sshRemoteId);

	const [reopening, setReopening] = useState(false);
	// Read synchronously: Enter on the footer button fires its key handler and its click.
	const reopeningRef = useRef(false);

	const defaultSize = useMemo(() => viewportModalSize({ width: 0.5, height: 0.8 }), []);

	const handleRunAgain = useCallback(async () => {
		if (reopeningRef.current) return;
		reopeningRef.current = true;
		setReopening(true);
		// A refusal is told to the person by a toast, and the outro stays so they keep what it says.
		if (await reopenPlaybookLaunch(launch)) {
			onClose();
			return;
		}
		reopeningRef.current = false;
		setReopening(false);
	}, [launch, onClose]);

	const handleOpen = useCallback(
		(path: string) => {
			// The app's open-file path acts on the active agent, and the run's files belong to the
			// agent that ran it. The person pressed Open, so taking them there is what they asked for.
			const active = selectActiveSession(useSessionStore.getState());
			if (active?.id !== launch.sessionId && !jumpToAgent(launch.sessionId)) return;
			onClose();
			onOpenFile(path);
		},
		[launch.sessionId, onClose, onOpenFile]
	);

	const StatusIcon = TONE_ICON[view.status.tone];
	const statusColor = toneColor(theme, view.status.tone);

	const openDisabledReason = (path: string): string | null => {
		if (!agentExists) return NO_AGENT_REASON;
		// The existence cache holds absolute paths. A relative path is resolved by the open-file
		// path against the agent's project, so it is not asked about here.
		return isAbsolutePath(path) && pathExists(path) === false ? NO_FILE_REASON : null;
	};

	const renderFile = (file: { label: string; path: string }, index: number): ReactElement => {
		const disabledReason = openDisabledReason(file.path);
		return (
			<li
				key={`${index}:${file.path}`}
				className="flex items-center gap-2 min-w-0"
				data-testid="outro-file"
			>
				<FileText
					className="w-4 h-4 shrink-0"
					style={{ color: theme.colors.textDim }}
					aria-hidden="true"
				/>
				<div className="min-w-0 flex-1">
					<div
						className="text-sm font-bold truncate select-text"
						style={{ color: theme.colors.textMain }}
					>
						{file.label}
					</div>
					<div
						className="text-xs font-mono truncate select-text"
						style={{ color: theme.colors.textDim }}
						title={file.path}
					>
						{file.path}
					</div>
				</div>
				<HeaderActionButton
					theme={theme}
					variant="ghost"
					icon={<ExternalLink />}
					onClick={() => handleOpen(file.path)}
					disabled={disabledReason !== null}
					title={disabledReason ?? `Open ${file.path}`}
					ariaLabel={`Open ${file.label}`}
					testId="outro-file-open"
				>
					Open
				</HeaderActionButton>
			</li>
		);
	};

	return (
		<Modal
			theme={theme}
			title={view.title}
			subtitle={agent?.name}
			priority={MODAL_PRIORITIES.MARKETPLACE_OUTRO}
			onClose={onClose}
			width={600}
			resizeKey="marketplace-outro"
			defaultSize={defaultSize}
			minSize={{ width: 440, height: 320 }}
			maxSize={{ width: 860 }}
			zIndex={OUTRO_MODAL_Z_INDEX}
			portal
			testId="playbook-outro-modal"
			contentClassName="p-5 overflow-y-auto flex-1 min-h-0 select-text"
			footer={
				<ModalFooter
					theme={theme}
					onCancel={onClose}
					onConfirm={() => void handleRunAgain()}
					cancelLabel="Close"
					confirmLabel={reopening ? 'Opening...' : 'Run again'}
					confirmDisabled={reopening}
				/>
			}
		>
			<div className="space-y-5 min-w-0">
				<section className="space-y-2" data-testid="outro-status-section">
					<p
						className="flex items-start gap-2 text-sm font-bold"
						style={{ color: statusColor }}
						data-testid="outro-status"
						data-tone={view.status.tone}
					>
						<StatusIcon className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
						<span>{view.status.text}</span>
					</p>
					{view.stats.length > 0 && (
						<dl className="flex flex-wrap gap-x-8 gap-y-2" data-testid="outro-stats">
							{view.stats.map((stat) => (
								<div key={stat.id} data-testid={`outro-stat-${stat.id}`}>
									<dt className="text-xs" style={{ color: theme.colors.textDim }}>
										{stat.label}
									</dt>
									<dd className="text-sm font-bold" style={{ color: theme.colors.textMain }}>
										{stat.value}
									</dd>
								</div>
							))}
						</dl>
					)}
				</section>

				{verdict.status === 'ready' && (
					<section
						className="rounded border p-3 space-y-1"
						style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgMain }}
						data-testid="outro-verdict"
					>
						<h3
							className="text-sm font-bold"
							style={{ color: theme.colors.textMain }}
							data-testid="outro-verdict-heading"
						>
							{verdict.section.heading}
						</h3>
						<LaunchMarkdown
							theme={theme}
							content={verdict.section.body}
							testId="outro-verdict-body"
						/>
					</section>
				)}

				<LaunchMarkdown theme={theme} content={view.summary} testId="outro-summary" />

				{view.nextSteps.length > 0 && (
					<section className="space-y-1" data-testid="outro-next-steps">
						<h3
							className="text-xs font-bold uppercase opacity-70"
							style={{ color: theme.colors.textMain }}
						>
							What to do next
						</h3>
						<LaunchMarkdown theme={theme} content={launchBulletList(view.nextSteps)} />
					</section>
				)}

				{view.files.length > 0 && (
					<section className="space-y-2" data-testid="outro-files">
						<h3
							className="text-xs font-bold uppercase opacity-70"
							style={{ color: theme.colors.textMain }}
						>
							Files
						</h3>
						<ul className="space-y-2">{view.files.map(renderFile)}</ul>
					</section>
				)}

				{view.cleanup && (
					<p
						className="text-xs"
						style={{ color: toneColor(theme, view.cleanup.tone) }}
						data-testid="outro-cleanup"
						data-tone={view.cleanup.tone}
					>
						{view.cleanup.text}
					</p>
				)}
			</div>
		</Modal>
	);
}
