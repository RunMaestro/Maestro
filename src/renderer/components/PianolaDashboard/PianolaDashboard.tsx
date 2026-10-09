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
import type { PianolaSupervisedState } from '../../../main/pianola/pianola-supervisor';
import { useSessionStore } from '../../stores/sessionStore';
import { focusAiTabInSession } from '../../utils/tabHelpers';
interface PianolaDashboardProps {
	theme: Theme;
	onJumpToAgent: (sessionId: string) => void;
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
	children,
}: {
	theme: Theme;
	icon: React.ReactNode;
	title: string;
	count: number;
	emptyLabel: React.ReactNode;
	headerAction?: React.ReactNode;
	children: React.ReactNode;
}): React.ReactElement {
	return (
		<div className="mb-5">
			<div
				className="flex items-center gap-2 mb-2 text-xs font-bold uppercase tracking-wider"
				style={{ color: theme.colors.textDim }}
			>
				{icon}
				<span>{title}</span>
				<span className="opacity-60">({count})</span>
				{headerAction && <div className="ml-auto">{headerAction}</div>}
			</div>
			{count === 0 ? (
				<div className="text-sm italic px-3 py-2" style={{ color: theme.colors.textDim }}>
					{emptyLabel}
				</div>
			) : (
				<div className="flex flex-col gap-1.5">{children}</div>
			)}
		</div>
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
	onJump: (sessionId: string) => void;
}): React.ReactElement {
	const clickable = !!row.sessionId;
	const children = row.worktreeChildren ?? [];
	return (
		<div className="flex flex-col gap-1">
			<button
				type="button"
				disabled={!clickable}
				onClick={() => row.sessionId && onJump(row.sessionId)}
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
							onClick={() => child.sessionId && onJump(child.sessionId)}
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
			setError(err instanceof Error ? err.message : String(err));
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
function NeedsRow({
	theme,
	row,
	onJump,
}: {
	theme: Theme;
	row: DashboardNeedsRow;
	onJump?: (sessionId: string) => void;
}): React.ReactElement {
	const meta = NEEDS_META[row.kind];
	const color = meta.color(theme);
	return (
		<div
			className="rounded px-3 py-2 flex items-center gap-2"
			style={{ backgroundColor: theme.colors.bgSidebar, borderLeft: `2px solid ${color}` }}
			title={row.detail}
		>
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
						useSessionStore
							.getState()
							.setSessions((sessions) =>
								sessions.map((session) =>
									session.id === sessionId && session.aiTabs.some((tab) => tab.id === row.tabId)
										? focusAiTabInSession(session, row.tabId)
										: session
								)
							);
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
	const { watched, watchable, watch, unwatch, setEnabled } = supervisor;
	const [pickerOpen, setPickerOpen] = React.useState(false);

	const addButton = (
		<div className="relative">
			<button
				type="button"
				disabled={watchable.length === 0}
				onClick={() => setPickerOpen((o) => !o)}
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
						className="absolute right-0 mt-1 z-50 rounded shadow-lg overflow-y-auto scrollbar-thin whitespace-nowrap normal-case py-1"
						style={{
							minWidth: '12rem',
							maxWidth: '20rem',
							maxHeight: '15rem',
							backgroundColor: theme.colors.bgSidebar,
							border: `1px solid ${theme.colors.border}`,
						}}
					>
						{watchable.map((a) => (
							<button
								key={a.agentId}
								type="button"
								onClick={() => {
									setPickerOpen(false);
									void watch(a.agentId, a.tabId);
								}}
								className="w-full text-left px-3 py-1.5 text-sm flex items-center gap-2 hover:bg-white/5 transition-colors"
								style={{ color: theme.colors.textMain }}
							>
								<Eye className="w-3.5 h-3.5 shrink-0" style={{ color: theme.colors.textDim }} />
								<span className="truncate">{a.agentName}</span>
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
			headerAction={addButton}
		>
			{watched.map((row) => (
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
export function PianolaDashboard({
	theme,
	onJumpToAgent,
}: PianolaDashboardProps): React.ReactElement {
	const { data, portfolio, refresh } = usePianolaDashboardData();
	const supervisor = usePianolaSupervisor();
	const needsCount =
		portfolio.asks.length +
		portfolio.escalations.length +
		data.needsInput.length +
		portfolio.needsReview.length +
		portfolio.failed.length;
	const renderAgentRow = (accent: string) => (row: DashboardAgentRow) => (
		<AgentRow key={row.key} theme={theme} row={row} accent={accent} onJump={onJumpToAgent} />
	);

	return (
		<div
			className="flex-1 min-h-0 overflow-y-auto scrollbar-thin px-4 py-4"
			style={{ backgroundColor: theme.colors.bgMain }}
		>
			<div className="flex items-center justify-between mb-4">
				<h2 className="text-base font-bold" style={{ color: theme.colors.textMain }}>
					Agent Dashboard
				</h2>
				<button
					type="button"
					onClick={() => {
						refresh();
						supervisor.refresh();
					}}
					className="flex items-center gap-1.5 text-xs px-2 py-1 rounded hover:bg-white/5 transition-colors"
					style={{ color: theme.colors.textDim }}
					title="Refresh"
				>
					<RefreshCw className="w-3.5 h-3.5" />
					Refresh
				</button>
			</div>

			{portfolio.programs.length > 0 && (
				<div className="flex flex-wrap gap-2 mb-5" data-testid="pianola-program-strip">
					{portfolio.programs.map((program) => (
						<ProgramCard key={program.id} theme={theme} program={program} onChanged={refresh} />
					))}
				</div>
			)}

			<Section
				theme={theme}
				icon={<AlertCircle className="w-3.5 h-3.5" style={{ color: theme.colors.warning }} />}
				title="Needs your input"
				count={needsCount}
				emptyLabel="No agents are waiting on you."
			>
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
					<NeedsRow key={row.key} theme={theme} row={row} />
				))}
			</Section>

			<Section
				theme={theme}
				icon={<Loader2 className="w-3.5 h-3.5" style={{ color: theme.colors.accent }} />}
				title="Working now"
				count={groupedCount(portfolio.working)}
				emptyLabel="No agents are working right now."
			>
				<ProgramGroups
					theme={theme}
					groups={portfolio.working}
					renderRow={renderAgentRow(theme.colors.accent)}
				/>
			</Section>

			<Section
				theme={theme}
				icon={<CheckCircle2 className="w-3.5 h-3.5" style={{ color: theme.colors.success }} />}
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

			<Section
				theme={theme}
				icon={<BadgeCheck className="w-3.5 h-3.5" style={{ color: theme.colors.success }} />}
				title="Results"
				count={groupedCount(portfolio.results)}
				emptyLabel={
					<>
						<div>Nothing verified yet.</div>
						<div className="not-italic text-xs">
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

			<WatchedSection theme={theme} onJumpToAgent={onJumpToAgent} supervisor={supervisor} />

			<Section
				theme={theme}
				icon={<ListChecks className="w-3.5 h-3.5" style={{ color: theme.colors.textDim }} />}
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
		</div>
	);
}
