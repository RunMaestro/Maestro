/**
 * Pianola Dashboard - the pinned status view in Pianola's workspace.
 *
 * Glanceable board of Pianola's portfolio and the other agents: the program
 * strip (with each program loop's state and its Supervise / Pause controls),
 * what needs the user (founder asks first, then escalations, waiting agents,
 * tasks to review, failures), what is working and recently finished (grouped by
 * program), what is verified, who Pianola watches, and a feed of Pianola's
 * recent decisions, where program-loop ticks show as compact loop lines. Agent
 * rows jump to the owning agent on click. Data comes from
 * `usePianolaDashboardData` (live session state, the polled decision log, and
 * the polled portfolio brief).
 */

import React from 'react';
import {
	AlertCircle,
	BadgeCheck,
	Loader2,
	CheckCircle2,
	ListChecks,
	RefreshCw,
	CornerUpRight,
	ShieldQuestion,
	MessageSquareReply,
	EyeOff,
	GitBranch,
	Eye,
	Plus,
	X,
	ChevronDown,
	ChevronRight,
	Repeat,
} from 'lucide-react';
import type { Theme } from '../../types';
import { formatRelativeTime } from '../../../shared/formatters';
import type {
	PianolaAskSeverity,
	PianolaBriefProgram,
} from '../../../shared/pianola/pianola-programs';
import { FormInput } from '../ui/FormInput';
import { MiniBadge } from '../ui/MiniBadge';
import { StatCard } from '../widgets';
import {
	usePianolaDashboardData,
	type DashboardAgentRow,
	type DashboardActivityRow,
	type DashboardLoopActivity,
	type DashboardAskRow,
	type DashboardNeedsRow,
	type DashboardProgramGroup,
	type DashboardResultRow,
} from './usePianolaDashboardData';
import { usePianolaSupervisor, type PianolaSupervisorState } from './usePianolaSupervisor';
import { PianolaScopeControls } from './PianolaScopeControls';
import type { PianolaSupervisedState } from '../../../main/pianola/pianola-supervisor';
import { elevatedSurfaceStyle } from '../../utils/elevatedSurface';
import { ipcErrorMessage } from '../../utils/ipcErrorMessage';
import { updateSessionWith } from '../../stores/sessionStore';
import { focusAiTabInSession } from '../../utils/tabHelpers';
import type {
	PianolaDecisionLifecycle,
	PianolaDecisionRecord,
} from '../../../shared/pianola/storage';

const DECISION_STATUS: Record<PianolaDecisionLifecycle['status'], string> = {
	mira_processing: 'Manager processing',
	waiting_human: 'Waiting for human',
	agent_running: 'Agent continuing',
	blocked: 'Blocked',
	paused: 'Paused',
	done: 'Done',
};

const DECISION_ACTOR: Record<PianolaDecisionLifecycle['nextActor'], string> = {
	manager: 'Manager',
	human: 'Human',
	recipient: 'Agent',
	operator: 'Operator',
	none: 'None',
};

function HumanDecision({
	record,
	refresh,
}: {
	record: PianolaDecisionRecord;
	refresh: () => void;
}): React.ReactElement {
	const [answer, setAnswer] = React.useState('');
	const [pending, setPending] = React.useState(false);
	const [message, setMessage] = React.useState('');
	return (
		<form
			onSubmit={(event) => {
				event.preventDefault();
				if (pending || !answer.trim()) return;
				setPending(true);
				setMessage('');
				void window.maestro.pianola
					.resolveDecision({ decisionId: record.id, answer: answer.trim() })
					.then((result) => {
						if (result.status === 'accepted') {
							setAnswer('');
							setMessage('Answer accepted for delivery; awaiting agent acknowledgment.');
						} else setMessage(`${result.status}: ${result.error}`);
						refresh();
					})
					.catch((error: unknown) => {
						setMessage(ipcErrorMessage(error));
						refresh();
					})
					.finally(() => setPending(false));
			}}
		>
			<label>
				Human answer{' '}
				<textarea
					value={answer}
					maxLength={8000}
					onChange={(event) => setAnswer(event.target.value)}
					className="w-full text-black"
				/>
			</label>
			<button type="submit" disabled={pending || !answer.trim()}>
				Send human answer
			</button>
			{message && <div role="status">{message}</div>}
		</form>
	);
}
interface PianolaDashboardProps {
	theme: Theme;
	onJumpToAgent: (sessionId: string, tabId?: string) => void;
}

interface SectionProps {
	theme: Theme;
	icon: React.ReactNode;
	title: string;
	count: number;
	emptyLabel: React.ReactNode;
	headerAction?: React.ReactNode;
	controlRow?: React.ReactNode;
	collapsed?: boolean;
	children: React.ReactNode;
}

/** A titled, icon-led section with a count, an empty-state line, and an optional
 * right-aligned header action. */
function Section({
	theme,
	icon,
	title,
	count,
	emptyLabel,
	headerAction,
	controlRow,
	collapsed = false,
	children,
}: SectionProps): React.ReactElement {
	return (
		<div>
			<div
				className="flex items-center gap-2 mb-3 text-sm font-semibold"
				style={{ color: theme.colors.textMain }}
			>
				{icon}
				<h3>{title}</h3>
				<span className="text-xs font-normal" style={{ color: theme.colors.textDim }}>
					{count}
				</span>
				{headerAction && <div className="ml-auto">{headerAction}</div>}
			</div>
			{controlRow}
			{count === 0 ? (
				<div className="text-sm px-1 py-4" style={{ color: theme.colors.textDim }}>
					{emptyLabel}
				</div>
			) : collapsed ? null : (
				<div className="flex flex-col gap-2">{children}</div>
			)}
		</div>
	);
}

function DashboardPanel({
	theme,
	accent,
	className = '',
	children,
}: {
	theme: Theme;
	accent?: string;
	className?: string;
	children: React.ReactNode;
}): React.ReactElement {
	return (
		<section
			className={`rounded-xl p-4 ${className}`}
			style={{
				backgroundColor: theme.colors.bgSidebar,
				border: `1px solid ${theme.colors.border}`,
				borderTop: `2px solid ${accent ?? theme.colors.border}`,
			}}
		>
			{children}
		</section>
	);
}

/** A clickable agent row: name, description, and (optional) relative time. */
function AgentRow({
	theme,
	row,
	accent,
	onJump,
}: {
	theme: Theme;
	row: DashboardAgentRow;
	accent: string;
	onJump: (sessionId: string, tabId?: string) => void;
}): React.ReactElement {
	const clickable = !!row.sessionId;
	const children = row.worktreeChildren ?? [];
	return (
		<div className="flex flex-col gap-1">
			<button
				type="button"
				disabled={!clickable}
				onClick={() => {
					if (row.sessionId) {
						if (row.tabId) onJump(row.sessionId, row.tabId);
						else onJump(row.sessionId);
					}
				}}
				className="w-full text-left rounded px-3 py-2 flex items-center gap-3 transition-colors hover:bg-white/5 disabled:cursor-default"
				style={{ backgroundColor: theme.colors.bgSidebar, borderLeft: `2px solid ${accent}` }}
				title={clickable ? `Jump to ${row.agentName}` : row.agentName}
			>
				<span
					className="text-sm font-medium truncate shrink-0 max-w-[40%]"
					style={{ color: theme.colors.textMain }}
				>
					{row.agentName}
				</span>
				<span className="text-sm truncate flex-1" style={{ color: theme.colors.textDim }}>
					{row.description}
				</span>
				{row.timestamp !== undefined && (
					<span className="text-xs shrink-0" style={{ color: theme.colors.textDim }}>
						{formatRelativeTime(row.timestamp)}
					</span>
				)}
			</button>
			{children.length > 0 && (
				<div className="flex flex-col gap-1 pl-4">
					{children.map((child) => (
						<button
							key={child.key}
							type="button"
							disabled={!child.sessionId}
							onClick={() => {
								if (child.sessionId) {
									if (child.tabId) onJump(child.sessionId, child.tabId);
									else onJump(child.sessionId);
								}
							}}
							className="w-full text-left rounded px-3 py-1.5 flex items-center gap-2 transition-colors hover:bg-white/5 disabled:cursor-default"
							style={{ backgroundColor: theme.colors.bgSidebar, borderLeft: `2px solid ${accent}` }}
							title={child.sessionId ? `Jump to ${child.agentName}` : child.agentName}
						>
							<GitBranch className="w-3 h-3 shrink-0" style={{ color: theme.colors.textDim }} />
							<span
								className="text-xs font-medium truncate shrink-0 max-w-[45%]"
								style={{ color: theme.colors.textMain }}
							>
								{child.agentName}
							</span>
							<span className="text-xs truncate flex-1" style={{ color: theme.colors.textDim }}>
								{child.description}
							</span>
						</button>
					))}
				</div>
			)}
		</div>
	);
}

/** Rows split under a small program-title subheader per program; rows outside
 * any program come last with no subheader. */
function ProgramGroups<T>({
	theme,
	groups,
	renderRow,
}: {
	theme: Theme;
	groups: DashboardProgramGroup<T>[];
	renderRow: (row: T) => React.ReactNode;
}): React.ReactElement {
	return (
		<>
			{groups.map((group) => (
				<div key={group.key} className="flex flex-col gap-1.5">
					{group.programTitle && (
						<div
							className="text-xs font-medium px-1 pt-1 truncate"
							style={{ color: theme.colors.textDim }}
						>
							{group.programTitle}
						</div>
					)}
					{group.rows.map(renderRow)}
				</div>
			))}
		</>
	);
}

const groupedCount = <T,>(groups: DashboardProgramGroup<T>[]): number =>
	groups.reduce((n, g) => n + g.rows.length, 0);

/**
 * Run a `window.maestro.pianola` mutation, then `onSettled` (a dashboard
 * refresh). A failure is kept as an inline error message instead of rejecting.
 */
function usePianolaAction(onSettled: () => void): {
	busy: boolean;
	error: string | null;
	settle: (action: () => Promise<unknown>) => Promise<void>;
} {
	const [busy, setBusy] = React.useState(false);
	const [error, setError] = React.useState<string | null>(null);
	const settle = async (action: () => Promise<unknown>): Promise<void> => {
		setBusy(true);
		setError(null);
		try {
			await action();
			onSettled();
		} catch (err) {
			setError(ipcErrorMessage(err));
		} finally {
			setBusy(false);
		}
	};
	return { busy, error, settle };
}

/**
 * One program in the strip: status, active plan, its three live counts, and the
 * program loop's state (supervised or not, the last time it woke the lead and
 * why). Pause/Resume sets the program status; Supervise starts the loop. Both
 * call `window.maestro.pianola` and then refresh the dashboard.
 */
function ProgramCard({
	theme,
	program,
	onChanged,
}: {
	theme: Theme;
	program: PianolaBriefProgram;
	onChanged: () => void;
}): React.ReactElement {
	const { busy, error, settle } = usePianolaAction(onChanged);
	const activePlan = program.activePlanTitle ?? program.activePlanId;
	const active = program.status === 'active';
	const { loop } = program;
	return (
		<div
			className="rounded px-3 py-2 flex flex-col gap-1 min-w-[12rem] flex-1"
			style={{ backgroundColor: theme.colors.bgSidebar }}
			data-testid={`pianola-program-${program.id}`}
		>
			<div className="flex items-center gap-2">
				<span className="text-sm font-medium truncate" style={{ color: theme.colors.textMain }}>
					{program.title}
				</span>
				<MiniBadge
					theme={theme}
					label={active ? 'Active' : 'Paused'}
					color={active ? theme.colors.success : theme.colors.warning}
				/>
				<button
					type="button"
					onClick={() =>
						void settle(() =>
							window.maestro.pianola.setProgramStatus(program.id, active ? 'paused' : 'active')
						)
					}
					disabled={busy}
					className="ml-auto text-xs px-2 py-0.5 rounded hover:bg-white/5 transition-colors shrink-0 disabled:opacity-40 disabled:cursor-default"
					style={{ color: theme.colors.textDim }}
					title={active ? 'Pause this program' : 'Resume this program'}
				>
					{active ? 'Pause' : 'Resume'}
				</button>
			</div>
			<div className="text-xs truncate" style={{ color: theme.colors.textDim }}>
				{activePlan ? `Plan: ${activePlan}` : 'No active plan'}
			</div>
			<div className="text-xs" style={{ color: theme.colors.textDim }}>
				<span style={{ color: program.openAsks > 0 ? theme.colors.warning : undefined }}>
					{program.openAsks} open {program.openAsks === 1 ? 'ask' : 'asks'}
				</span>
				{' · '}
				{program.running} running · {program.verifiedLast7d} verified (7d)
			</div>
			<div
				className="flex items-center gap-2 text-xs"
				style={{ color: theme.colors.textDim }}
				data-testid={`pianola-program-loop-${program.id}`}
			>
				<span
					className="w-2 h-2 rounded-full shrink-0"
					style={{
						backgroundColor: loop.supervised ? theme.colors.success : theme.colors.textDim,
					}}
				/>
				<span className="truncate flex-1">
					{loop.supervised ? 'Supervised' : 'Not supervised'}
					{loop.lastWakeReason && ` · woke lead: ${loop.lastWakeReason.replace(/-/g, ' ')}`}
					{loop.lastWakeAt && ` · ${formatRelativeTime(loop.lastWakeAt)}`}
				</span>
				{!loop.supervised && (
					<button
						type="button"
						onClick={() => void settle(() => window.maestro.pianola.superviseProgram(program.id))}
						disabled={busy}
						className="text-xs px-2 py-0.5 rounded font-medium hover:bg-white/5 transition-colors shrink-0 disabled:opacity-40 disabled:cursor-default"
						style={{ color: theme.colors.accent, border: `1px solid ${theme.colors.border}` }}
						title="Run the program loop: wake the lead only when there is work for it"
					>
						Supervise
					</button>
				)}
			</div>
			{error && (
				<div className="text-xs" style={{ color: theme.colors.error }}>
					{error}
				</div>
			)}
		</div>
	);
}

function severityColor(theme: Theme, severity: PianolaAskSeverity): string {
	switch (severity) {
		case 'critical':
		case 'high':
			return theme.colors.error;
		case 'medium':
			return theme.colors.warning;
		default:
			return theme.colors.textDim;
	}
}

/**
 * An open founder ask: severity, program, title, and the requested action, with
 * inline Resolve (the chosen option plus an optional note) and Dismiss. Both
 * call `window.maestro.pianola` and then refresh the dashboard.
 */
function AskRow({
	theme,
	ask,
	onSettled,
}: {
	theme: Theme;
	ask: DashboardAskRow;
	onSettled: () => void;
}): React.ReactElement {
	const [resolving, setResolving] = React.useState(false);
	const [option, setOption] = React.useState('');
	const [note, setNote] = React.useState('');
	const { busy, error, settle } = usePianolaAction(onSettled);
	const color = severityColor(theme, ask.severity);
	const descriptionId = React.useId();

	const submitResolve = (): void => {
		const chosen = option.trim();
		if (!chosen || busy) return;
		void settle(() => window.maestro.pianola.resolveAsk(ask.id, chosen, note.trim() || undefined));
	};

	return (
		<div
			className="rounded px-3 py-2 flex flex-col gap-1.5"
			style={{ backgroundColor: theme.colors.bgSidebar, borderLeft: `2px solid ${color}` }}
			data-testid={`pianola-ask-${ask.id}`}
		>
			<div className="flex items-center gap-2">
				<MiniBadge theme={theme} label={ask.severity} color={color} />
				{ask.programTitle && (
					<span
						className="text-xs shrink-0 max-w-[30%] truncate"
						style={{ color: theme.colors.textDim }}
					>
						{ask.programTitle}
					</span>
				)}
				<span
					className="text-sm font-medium truncate flex-1"
					style={{ color: theme.colors.textMain }}
				>
					{ask.title}
				</span>
				<span className="text-xs shrink-0" style={{ color: theme.colors.textDim }}>
					{formatRelativeTime(ask.since)}
				</span>
			</div>
			<p
				id={descriptionId}
				className="text-xs whitespace-pre-wrap break-words"
				style={{ color: theme.colors.textMain, overflowWrap: 'anywhere' }}
			>
				{ask.detail}
			</p>
			{ask.requestedAction && (
				<div className="text-xs" style={{ color: theme.colors.textMain }}>
					{ask.requestedAction}
				</div>
			)}
			{resolving ? (
				<div
					className="flex flex-col gap-1.5"
					role="group"
					aria-label={`Resolve ${ask.title}`}
					aria-describedby={descriptionId}
				>
					<FormInput
						theme={theme}
						value={option}
						onChange={setOption}
						onSubmit={submitResolve}
						submitEnabled={option.trim().length > 0 && !busy}
						placeholder="Your decision"
						disabled={busy}
						autoFocus
						testId={`pianola-ask-option-${ask.id}`}
					/>
					<FormInput
						theme={theme}
						value={note}
						onChange={setNote}
						onSubmit={submitResolve}
						submitEnabled={option.trim().length > 0 && !busy}
						placeholder="Note (optional)"
						disabled={busy}
						testId={`pianola-ask-note-${ask.id}`}
					/>
					<div className="flex items-center gap-2">
						<button
							type="button"
							onClick={submitResolve}
							disabled={busy || option.trim().length === 0}
							aria-describedby={descriptionId}
							className="text-xs px-2 py-1 rounded font-medium transition-opacity disabled:opacity-40 disabled:cursor-default"
							style={{ backgroundColor: theme.colors.accent, color: theme.colors.accentForeground }}
						>
							Submit
						</button>
						<button
							type="button"
							onClick={() => setResolving(false)}
							disabled={busy}
							className="text-xs px-2 py-1 rounded hover:bg-white/5 transition-colors"
							style={{ color: theme.colors.textDim }}
						>
							Cancel
						</button>
					</div>
				</div>
			) : (
				<div className="flex items-center gap-2">
					<button
						type="button"
						onClick={() => setResolving(true)}
						disabled={busy}
						aria-describedby={descriptionId}
						className="text-xs px-2 py-1 rounded font-medium hover:bg-white/5 transition-colors"
						style={{ color: theme.colors.accent, border: `1px solid ${theme.colors.border}` }}
					>
						Resolve
					</button>
					<button
						type="button"
						onClick={() => void settle(() => window.maestro.pianola.dismissAsk(ask.id))}
						disabled={busy}
						aria-describedby={descriptionId}
						className="text-xs px-2 py-1 rounded hover:bg-white/5 transition-colors"
						style={{ color: theme.colors.textDim }}
					>
						Dismiss
					</button>
				</div>
			)}
			{error && (
				<div className="text-xs" style={{ color: theme.colors.error }}>
					{error}
				</div>
			)}
		</div>
	);
}

const NEEDS_META: Record<
	DashboardNeedsRow['kind'],
	{ label: string; color: (t: Theme) => string }
> = {
	escalation: { label: 'Escalated', color: (t) => t.colors.warning },
	needs_review: { label: 'Needs review', color: (t) => t.colors.accent },
	failed: { label: 'Failed', color: (t) => t.colors.error },
};

/** An escalation, a task awaiting review, or a failed task from the brief. */
function FailedTaskActions({
	theme,
	row,
	onChanged,
}: {
	theme: Theme;
	row: DashboardNeedsRow & { planId: string; taskId: string };
	onChanged: () => void;
}): React.ReactElement {
	const [revising, setRevising] = React.useState(false);
	const [confirmSkip, setConfirmSkip] = React.useState(false);
	const [revision, setRevision] = React.useState('');
	const { busy, error, settle } = usePianolaAction(onChanged);
	const revise = () => {
		if (!revision.trim() || busy) return;
		void settle(() =>
			window.maestro.pianola.revisePlanTask(row.planId, row.taskId, revision.trim())
		);
	};

	return (
		<div className="flex flex-col gap-2">
			{revising ? (
				<div className="flex flex-col gap-2" role="group" aria-label={`Revise ${row.title}`}>
					<FormInput
						theme={theme}
						value={revision}
						onChange={setRevision}
						onSubmit={revise}
						submitEnabled={revision.trim().length > 0 && !busy}
						placeholder="Revision instructions"
						disabled={busy}
						autoFocus
						testId={`pianola-revision-${row.taskId}`}
					/>
					<div className="flex gap-2">
						<button
							type="button"
							onClick={revise}
							disabled={busy || !revision.trim()}
							className="text-xs px-2 py-1 rounded font-medium disabled:opacity-40"
							style={{ backgroundColor: theme.colors.accent, color: theme.colors.accentForeground }}
						>
							Revise & restart
						</button>
						<button
							type="button"
							onClick={() => setRevising(false)}
							disabled={busy}
							className="text-xs px-2 py-1 rounded hover:bg-white/5"
							style={{ color: theme.colors.textDim }}
						>
							Cancel
						</button>
					</div>
				</div>
			) : confirmSkip ? (
				<div
					className="flex flex-wrap items-center gap-2 text-xs"
					style={{ color: theme.colors.textDim }}
				>
					<span>Skip this task? Dependents remain blocked.</span>
					<button
						type="button"
						onClick={() =>
							void settle(() => window.maestro.pianola.skipPlanTask(row.planId, row.taskId))
						}
						disabled={busy}
						className="px-2 py-1 rounded font-medium hover:bg-white/5"
						style={{ color: theme.colors.error, border: `1px solid ${theme.colors.border}` }}
					>
						Confirm skip
					</button>
					<button
						type="button"
						onClick={() => setConfirmSkip(false)}
						disabled={busy}
						className="px-2 py-1 rounded hover:bg-white/5"
						style={{ color: theme.colors.textDim }}
					>
						Cancel
					</button>
				</div>
			) : (
				<div className="flex flex-wrap gap-2">
					<button
						type="button"
						onClick={() =>
							void settle(() => window.maestro.pianola.revisePlanTask(row.planId, row.taskId))
						}
						disabled={busy}
						className="text-xs px-2 py-1 rounded font-medium hover:bg-white/5 disabled:opacity-40"
						style={{ color: theme.colors.accent, border: `1px solid ${theme.colors.border}` }}
					>
						Restart
					</button>
					<button
						type="button"
						onClick={() => setRevising(true)}
						disabled={busy}
						className="text-xs px-2 py-1 rounded hover:bg-white/5 disabled:opacity-40"
						style={{ color: theme.colors.textDim }}
					>
						Revise
					</button>
					<button
						type="button"
						onClick={() => setConfirmSkip(true)}
						disabled={busy}
						className="text-xs px-2 py-1 rounded hover:bg-white/5 disabled:opacity-40"
						style={{ color: theme.colors.textDim }}
					>
						Skip task
					</button>
				</div>
			)}
			{error && (
				<div className="text-xs" style={{ color: theme.colors.error }}>
					{error}
				</div>
			)}
		</div>
	);
}

/** An escalation, a task awaiting review, or a failed task from the brief. */
function NeedsRow({
	theme,
	row,
	onJump,
	onChanged,
}: {
	theme: Theme;
	row: DashboardNeedsRow;
	onJump?: (sessionId: string) => void;
	onChanged?: () => void;
}): React.ReactElement {
	const meta = NEEDS_META[row.kind];
	const color = meta.color(theme);
	return (
		<div
			className="rounded px-3 py-2 flex flex-col gap-2"
			style={{ backgroundColor: theme.colors.bgSidebar, borderLeft: `2px solid ${color}` }}
			title={row.detail}
		>
			<div className="flex items-center gap-2">
				<MiniBadge theme={theme} label={meta.label} color={color} />
				{row.programTitle && (
					<span
						className="text-xs shrink-0 max-w-[30%] truncate"
						style={{ color: theme.colors.textDim }}
					>
						{row.programTitle}
					</span>
				)}
				{row.kind === 'escalation' && row.sessionId && onJump ? (
					<button
						type="button"
						onClick={() => {
							const sessionId = row.sessionId;
							if (!sessionId) return;
							updateSessionWith(sessionId, (session) => focusAiTabInSession(session, row.tabId));
							onJump(sessionId);
						}}
						className="text-sm truncate flex-1 text-left hover:underline"
						style={{ color: theme.colors.textMain }}
					>
						{row.title}
					</button>
				) : (
					<span className="text-sm truncate flex-1" style={{ color: theme.colors.textMain }}>
						{row.title}
					</span>
				)}
				<span className="text-xs shrink-0" style={{ color: theme.colors.textDim }}>
					{formatRelativeTime(row.since)}
				</span>
			</div>
			{row.kind === 'failed' && row.planId && row.taskId && onChanged && (
				<FailedTaskActions
					theme={theme}
					row={{ ...row, planId: row.planId, taskId: row.taskId }}
					onChanged={onChanged}
				/>
			)}
		</div>
	);
}

/** A verified task: what was done, in which plan, and the check that proved it. */
function ResultRow({ theme, row }: { theme: Theme; row: DashboardResultRow }): React.ReactElement {
	return (
		<div
			className="rounded px-3 py-2 flex items-center gap-2"
			style={{
				backgroundColor: theme.colors.bgSidebar,
				borderLeft: `2px solid ${theme.colors.success}`,
			}}
		>
			<span
				className="text-sm font-medium truncate shrink-0 max-w-[40%]"
				style={{ color: theme.colors.textMain }}
			>
				{row.taskTitle}
			</span>
			<span className="text-sm truncate flex-1" style={{ color: theme.colors.textDim }}>
				{row.planTitle}
			</span>
			<MiniBadge theme={theme} label={row.checkName} color={theme.colors.success} />
			<span className="text-xs shrink-0" style={{ color: theme.colors.textDim }}>
				{formatRelativeTime(row.completedAt)}
			</span>
		</div>
	);
}

const ACTION_META: Record<
	DashboardActivityRow['action'],
	{ label: string; icon: React.ReactNode; color: (t: Theme) => string }
> = {
	auto_answer: {
		label: 'Auto-answered',
		icon: <MessageSquareReply className="w-3.5 h-3.5" />,
		color: (t) => t.colors.success,
	},
	escalate: {
		label: 'Escalated to you',
		icon: <ShieldQuestion className="w-3.5 h-3.5" />,
		color: (t) => t.colors.warning,
	},
	handoff: {
		label: 'Handed to Pianola',
		icon: <CornerUpRight className="w-3.5 h-3.5" />,
		color: (t) => t.colors.accent,
	},
	ignore: {
		label: 'Ignored',
		icon: <EyeOff className="w-3.5 h-3.5" />,
		color: (t) => t.colors.textDim,
	},
};

/** A row in the recent-activity feed. */
function ActivityRow({
	theme,
	row,
	onJump,
}: {
	theme: Theme;
	row: DashboardActivityRow;
	onJump: (sessionId: string) => void;
}): React.ReactElement {
	const meta = ACTION_META[row.action];
	const color = meta.color(theme);
	const clickable = !!row.sessionId;
	return (
		<button
			type="button"
			disabled={!clickable}
			onClick={() => row.sessionId && onJump(row.sessionId)}
			className="w-full text-left rounded px-3 py-1.5 flex items-center gap-2.5 transition-colors hover:bg-white/5 disabled:cursor-default"
			style={{ backgroundColor: theme.colors.bgSidebar }}
			title={clickable ? `Jump to ${row.agentName}` : row.agentName}
		>
			<span className="shrink-0 flex items-center gap-1.5" style={{ color }}>
				{meta.icon}
				<span className="text-xs font-medium">{meta.label}</span>
			</span>
			<span
				className="text-sm font-medium truncate shrink-0 max-w-[28%]"
				style={{ color: theme.colors.textMain }}
			>
				{row.agentName}
			</span>
			<span className="text-sm truncate flex-1" style={{ color: theme.colors.textDim }}>
				{row.topic}
			</span>
			<span className="text-xs shrink-0" style={{ color: theme.colors.textDim }}>
				{formatRelativeTime(row.timestamp)}
			</span>
		</button>
	);
}

/** A program-loop tick in the activity feed: one compact line naming the
 * program and what the loop did. Jumps to the program's lead when it is loaded. */
function LoopActivityRow({
	theme,
	row,
	loop,
	onJump,
}: {
	theme: Theme;
	row: DashboardActivityRow;
	loop: DashboardLoopActivity;
	onJump: (sessionId: string) => void;
}): React.ReactElement {
	const clickable = !!row.sessionId;
	return (
		<button
			type="button"
			disabled={!clickable}
			onClick={() => row.sessionId && onJump(row.sessionId)}
			className="w-full text-left rounded px-3 py-1 flex items-center gap-2 text-xs transition-colors hover:bg-white/5 disabled:cursor-default"
			style={{ backgroundColor: theme.colors.bgSidebar, color: theme.colors.textDim }}
			title={clickable ? `Jump to ${row.agentName}` : `${loop.programTitle} loop`}
			data-testid={`pianola-loop-row-${row.id}`}
		>
			<Repeat className="w-3.5 h-3.5 shrink-0" />
			<span className="font-medium shrink-0 max-w-[28%] truncate">{loop.programTitle}</span>
			<span className="truncate flex-1">{loop.action}</span>
			<span className="shrink-0">{formatRelativeTime(row.timestamp)}</span>
		</button>
	);
}

/** Status-dot color for a watched target's live daemon state. */
function watchStateColor(theme: Theme, state?: PianolaSupervisedState): string {
	switch (state) {
		case 'running':
			return theme.colors.success;
		case 'backing-off':
			return theme.colors.warning;
		case 'failed':
			return theme.colors.error;
		default:
			return theme.colors.textDim;
	}
}

/**
 * "Watched by Pianola": the live watch targets plus a "+ Watch an agent" picker
 * that adds one through the same supervisor path the CLI uses. This is the
 * in-app home for adding agents to Pianola's watch list.
 */
function WatchedSection({
	theme,
	onJumpToAgent,
	supervisor,
}: {
	theme: Theme;
	onJumpToAgent: (sessionId: string) => void;
	supervisor: PianolaSupervisorState;
}): React.ReactElement {
	const {
		watched,
		watchable,
		watch,
		unwatch,
		setEnabled,
		autoWatchNewAgents,
		setAutoWatchNewAgents,
	} = supervisor;
	const [pickerOpen, setPickerOpen] = React.useState(false);
	const [expanded, setExpanded] = React.useState(false);
	const canCollapse = watched.length > 5;
	const collapsed = canCollapse && !expanded;
	const failingCount = watched.filter(
		(row) => row.enabled && (row.state === 'failed' || row.state === 'backing-off')
	).length;

	const addButton = (
		<div className="relative">
			<button
				type="button"
				disabled={watchable.length === 0}
				onClick={() => setPickerOpen((open) => !open)}
				className="flex items-center gap-1 text-xs px-2 py-1 rounded hover:bg-white/5 transition-colors disabled:opacity-40 disabled:cursor-default normal-case"
				style={{ color: theme.colors.textDim }}
				title={watchable.length === 0 ? 'No unwatched agents' : 'Watch an agent with Pianola'}
			>
				<Plus className="w-3.5 h-3.5" />
				Watch an agent
			</button>
			{pickerOpen && watchable.length > 0 && (
				<>
					<button
						type="button"
						aria-hidden
						tabIndex={-1}
						className="fixed inset-0 z-40 cursor-default"
						onClick={() => setPickerOpen(false)}
					/>
					<div
						className="absolute right-0 mt-1 z-50 rounded overflow-y-auto scrollbar-thin whitespace-nowrap normal-case py-1"
						style={{
							minWidth: '12rem',
							maxWidth: '20rem',
							maxHeight: '15rem',
							...elevatedSurfaceStyle(theme),
						}}
					>
						{watchable.map((agent) => (
							<button
								key={agent.agentId}
								type="button"
								onClick={() => {
									setPickerOpen(false);
									void watch(agent.agentId, agent.tabId);
								}}
								className="w-full text-left px-3 py-1.5 text-sm flex items-center gap-2 hover:bg-white/5 transition-colors"
								style={{ color: theme.colors.textMain }}
							>
								<Eye className="w-3.5 h-3.5 shrink-0" style={{ color: theme.colors.textDim }} />
								<span className="truncate">{agent.agentName}</span>
							</button>
						))}
					</div>
				</>
			)}
		</div>
	);

	return (
		<Section
			theme={theme}
			icon={<Eye className="w-3.5 h-3.5" style={{ color: theme.colors.accent }} />}
			title="Watched by Pianola"
			count={watched.length}
			emptyLabel="No agents watched yet. Add one and Pianola babysits its questions."
			collapsed={collapsed}
			headerAction={
				<div className="flex items-center gap-1">
					{collapsed && failingCount > 0 && (
						<span
							className="text-xs normal-case"
							style={{ color: theme.colors.error }}
							role="status"
						>
							{failingCount} failing
						</span>
					)}
					{addButton}
					{canCollapse && (
						<button
							type="button"
							aria-expanded={!collapsed}
							onClick={() => setExpanded((value) => !value)}
							className="flex items-center gap-1 text-xs px-2 py-1 rounded hover:bg-white/5 normal-case"
							style={{ color: theme.colors.textDim }}
						>
							{collapsed ? (
								<ChevronRight className="w-3.5 h-3.5" />
							) : (
								<ChevronDown className="w-3.5 h-3.5" />
							)}
							{collapsed ? 'Show agents' : 'Hide agents'}
						</button>
					)}
				</div>
			}
			controlRow={
				<label
					className="flex items-center gap-2 text-xs mb-2 px-1 cursor-pointer"
					style={{ color: theme.colors.textDim }}
				>
					<input
						type="checkbox"
						checked={autoWatchNewAgents}
						onChange={(event) => void setAutoWatchNewAgents(event.target.checked)}
					/>
					Automatically watch new agents
				</label>
			}
		>
			{watched.slice(0, collapsed ? 5 : undefined).map((row) => (
				<div
					key={row.targetId}
					className="rounded px-3 py-2 flex items-center gap-3"
					style={{
						backgroundColor: theme.colors.bgSidebar,
						borderLeft: `2px solid ${theme.colors.accent}`,
					}}
				>
					<span
						className="w-2 h-2 rounded-full shrink-0"
						style={{ backgroundColor: watchStateColor(theme, row.state) }}
						title={row.enabled ? (row.state ?? 'starting') : 'disabled'}
					/>
					<button
						type="button"
						onClick={() => onJumpToAgent(row.agentId)}
						className="text-sm font-medium truncate flex-1 text-left hover:underline"
						style={{ color: theme.colors.textMain }}
						title={`Jump to ${row.agentName}`}
					>
						{row.agentName}
					</button>
					{row.lastError && (
						<span
							className="text-xs truncate max-w-[30%]"
							style={{ color: theme.colors.error }}
							title={row.lastError}
						>
							{row.lastError}
						</span>
					)}
					<button
						type="button"
						onClick={() => void setEnabled(row.targetId, !row.enabled)}
						className="text-xs px-2 py-0.5 rounded hover:bg-white/5 transition-colors shrink-0"
						style={{ color: theme.colors.textDim }}
						title={row.enabled ? 'Pause watching' : 'Resume watching'}
					>
						{row.enabled ? 'Disable' : 'Enable'}
					</button>
					<button
						type="button"
						onClick={() => void unwatch(row.targetId)}
						className="p-1 rounded hover:bg-white/5 transition-colors shrink-0"
						style={{ color: theme.colors.textDim }}
						title="Stop watching"
					>
						<X className="w-3.5 h-3.5" />
					</button>
				</div>
			))}
		</Section>
	);
}
type SecondaryView = 'programs' | 'outcomes' | 'watched' | 'activity';

export function PianolaDashboard({
	theme,
	onJumpToAgent,
}: PianolaDashboardProps): React.ReactElement {
	const { data, portfolio, decisions, refresh } = usePianolaDashboardData();
	const supervisor = usePianolaSupervisor();
	const lifecycleDecisions = decisions.filter((record) => record.lifecycle);
	const [secondaryView, setSecondaryView] = React.useState<SecondaryView>('programs');
	const needsCount =
		portfolio.asks.length +
		portfolio.escalations.length +
		data.needsInput.length +
		portfolio.needsReview.length +
		portfolio.failed.length;
	const workingCount = groupedCount(portfolio.working);
	const verifiedCount = groupedCount(portfolio.results);
	const supervisedPrograms = portfolio.programs.filter((program) => program.loop.supervised).length;
	const renderAgentRow = (accent: string) => (row: DashboardAgentRow) => (
		<AgentRow key={row.key} theme={theme} row={row} accent={accent} onJump={onJumpToAgent} />
	);
	const secondaryTabs: { id: SecondaryView; label: string; count: number }[] = [
		{ id: 'programs', label: 'Programs', count: portfolio.programs.length },
		{ id: 'outcomes', label: 'Outcomes', count: groupedCount(portfolio.finished) + verifiedCount },
		{ id: 'watched', label: 'Watched', count: supervisor.watched.length },
		{ id: 'activity', label: 'Activity', count: data.activity.length },
	];

	return (
		<div
			className="flex-1 min-h-0 overflow-y-auto scrollbar-thin px-5 py-5"
			style={{ backgroundColor: theme.colors.bgMain }}
		>
			<div className="max-w-[1600px] mx-auto">
				<header className="flex items-start justify-between gap-4 mb-4">
					<div>
						<h2 className="text-xl font-semibold" style={{ color: theme.colors.textMain }}>
							Command center
						</h2>
						<p className="text-sm mt-1" style={{ color: theme.colors.textDim }}>
							{needsCount === 0
								? 'Nothing needs your attention'
								: `${needsCount} ${needsCount === 1 ? 'item needs' : 'items need'} your attention`}
						</p>
					</div>
					<button
						type="button"
						onClick={() => {
							refresh();
							supervisor.refresh();
						}}
						className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-md hover:bg-white/5 transition-colors shrink-0"
						style={{ color: theme.colors.textDim, border: `1px solid ${theme.colors.border}` }}
						title="Refresh dashboard"
					>
						<RefreshCw className="w-3.5 h-3.5" />
						Refresh
					</button>
				</header>

				<PianolaScopeControls theme={theme} supervisor={supervisor} />

				<Section
					theme={theme}
					icon={<ShieldQuestion className="w-3.5 h-3.5" />}
					title="Pianola decisions"
					count={lifecycleDecisions.length}
					emptyLabel="No scope decisions recorded yet."
				>
					{lifecycleDecisions.map((record) => {
						const life = record.lifecycle!;
						return (
							<div
								key={record.id}
								className="rounded px-3 py-2"
								style={{ backgroundColor: theme.colors.bgSidebar }}
							>
								<div className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
									{DECISION_STATUS[life.status]} · {record.classification.topic}
								</div>
								<div className="text-xs" style={{ color: theme.colors.textDim }}>
									{DECISION_ACTOR[life.nextActor]}: {life.nextAction}
								</div>
								{life.status === 'waiting_human' && (
									<div className="text-sm select-text">
										{record.classification.questionText ?? record.classification.topic} ·{' '}
										{record.decision.reason}
									</div>
								)}
								{life.status === 'waiting_human' &&
									life.nextActor === 'human' &&
									!record.dryRun &&
									!life.acknowledgedAt &&
									!(
										life.phase === 'answer' &&
										record.deliveryStatus === 'admitted' &&
										life.delivery !== 'rejected'
									) &&
									!(
										life.phase === 'answer' &&
										life.delivery !== 'not_sent' &&
										life.delivery !== 'rejected'
									) && <HumanDecision record={record} refresh={refresh} />}
							</div>
						);
					})}
				</Section>

				<div className="grid grid-cols-2 xl:grid-cols-4 gap-3 mb-4">
					<StatCard
						theme={theme}
						icon={AlertCircle}
						label="Needs you"
						value={needsCount}
						color={needsCount > 0 ? theme.colors.warning : theme.colors.success}
					/>
					<StatCard
						theme={theme}
						icon={Loader2}
						label="Working now"
						value={workingCount}
						color={theme.colors.accent}
					/>
					<StatCard
						theme={theme}
						icon={BadgeCheck}
						label="Verified results"
						value={verifiedCount}
						color={theme.colors.success}
					/>
					<StatCard
						theme={theme}
						icon={Repeat}
						label="Supervised programs"
						value={supervisedPrograms}
						color={theme.colors.accent}
					/>
				</div>

				<div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1.6fr)_minmax(300px,1fr)] gap-4 items-start">
					<DashboardPanel
						theme={theme}
						accent={needsCount > 0 ? theme.colors.warning : theme.colors.success}
					>
						<Section
							theme={theme}
							icon={
								<AlertCircle
									className="w-4 h-4"
									style={{ color: needsCount > 0 ? theme.colors.warning : theme.colors.success }}
								/>
							}
							title="Needs you"
							count={needsCount}
							emptyLabel="You're clear. No decisions or failures need attention."
						>
							<div className="max-h-[62vh] overflow-y-auto pr-1 flex flex-col gap-2">
								{portfolio.asks.map((ask) => (
									<AskRow key={ask.id} theme={theme} ask={ask} onSettled={refresh} />
								))}
								{portfolio.escalations.map((row) => (
									<NeedsRow key={row.key} theme={theme} row={row} onJump={onJumpToAgent} />
								))}
								{data.needsInput.map(renderAgentRow(theme.colors.warning))}
								{portfolio.needsReview.map((row) => (
									<NeedsRow key={row.key} theme={theme} row={row} />
								))}
								{portfolio.failed.map((row) => (
									<NeedsRow key={row.key} theme={theme} row={row} onChanged={refresh} />
								))}
							</div>
						</Section>
					</DashboardPanel>

					<DashboardPanel theme={theme} accent={theme.colors.accent}>
						<Section
							theme={theme}
							icon={<Loader2 className="w-4 h-4" style={{ color: theme.colors.accent }} />}
							title="Working now"
							count={workingCount}
							emptyLabel="No agents are working right now."
						>
							<div className="max-h-[62vh] overflow-y-auto pr-1">
								<ProgramGroups
									theme={theme}
									groups={portfolio.working}
									renderRow={renderAgentRow(theme.colors.accent)}
								/>
							</div>
						</Section>
					</DashboardPanel>
				</div>

				<div className="mt-5">
					<div
						className="flex flex-wrap gap-1 p-1 rounded-lg w-fit max-w-full"
						role="tablist"
						aria-label="Dashboard workspace"
						style={{
							backgroundColor: theme.colors.bgSidebar,
							border: `1px solid ${theme.colors.border}`,
						}}
					>
						{secondaryTabs.map((tab) => {
							const selected = secondaryView === tab.id;
							return (
								<button
									key={tab.id}
									type="button"
									role="tab"
									aria-selected={selected}
									aria-controls="dashboard-secondary-panel"
									onClick={() => setSecondaryView(tab.id)}
									className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors"
									style={{
										backgroundColor: selected ? theme.colors.bgMain : 'transparent',
										color: selected ? theme.colors.textMain : theme.colors.textDim,
									}}
								>
									{tab.label}
									<span className="opacity-60">{tab.count}</span>
								</button>
							);
						})}
					</div>

					<div id="dashboard-secondary-panel" role="tabpanel" className="mt-3">
						{secondaryView === 'programs' && (
							<DashboardPanel theme={theme}>
								<Section
									theme={theme}
									icon={<ListChecks className="w-4 h-4" style={{ color: theme.colors.textDim }} />}
									title="Programs"
									count={portfolio.programs.length}
									emptyLabel="No programs configured."
								>
									<div className="flex flex-wrap gap-2" data-testid="pianola-program-strip">
										{portfolio.programs.map((program) => (
											<ProgramCard
												key={program.id}
												theme={theme}
												program={program}
												onChanged={refresh}
											/>
										))}
									</div>
								</Section>
							</DashboardPanel>
						)}

						{secondaryView === 'outcomes' && (
							<div className="grid grid-cols-1 2xl:grid-cols-2 gap-4">
								<DashboardPanel theme={theme} accent={theme.colors.success}>
									<Section
										theme={theme}
										icon={
											<CheckCircle2 className="w-4 h-4" style={{ color: theme.colors.success }} />
										}
										title="Recently done"
										count={groupedCount(portfolio.finished)}
										emptyLabel="Nothing finished recently."
									>
										<ProgramGroups
											theme={theme}
											groups={portfolio.finished}
											renderRow={renderAgentRow(theme.colors.success)}
										/>
									</Section>
								</DashboardPanel>
								<DashboardPanel theme={theme} accent={theme.colors.success}>
									<Section
										theme={theme}
										icon={
											<BadgeCheck className="w-4 h-4" style={{ color: theme.colors.success }} />
										}
										title="Verified results"
										count={verifiedCount}
										emptyLabel={
											<>
												<div>Nothing verified yet.</div>
												<div className="text-xs mt-1">
													A task counts once it is done and its independent-validation check passed.
												</div>
											</>
										}
									>
										<ProgramGroups
											theme={theme}
											groups={portfolio.results}
											renderRow={(row) => <ResultRow key={row.key} theme={theme} row={row} />}
										/>
									</Section>
								</DashboardPanel>
							</div>
						)}

						{secondaryView === 'watched' && (
							<DashboardPanel theme={theme}>
								<WatchedSection
									theme={theme}
									onJumpToAgent={onJumpToAgent}
									supervisor={supervisor}
								/>
							</DashboardPanel>
						)}

						{secondaryView === 'activity' && (
							<DashboardPanel theme={theme}>
								<Section
									theme={theme}
									icon={<ListChecks className="w-4 h-4" style={{ color: theme.colors.textDim }} />}
									title="Recent decisions"
									count={data.activity.length}
									emptyLabel="No decisions recorded yet."
								>
									{data.activity.map((row) =>
										row.loop ? (
											<LoopActivityRow
												key={row.id}
												theme={theme}
												row={row}
												loop={row.loop}
												onJump={onJumpToAgent}
											/>
										) : (
											<ActivityRow key={row.id} theme={theme} row={row} onJump={onJumpToAgent} />
										)
									)}
								</Section>
							</DashboardPanel>
						)}
					</div>
				</div>
			</div>
		</div>
	);
}
