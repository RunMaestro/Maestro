/**
 * Pianola Dashboard - the pinned status view in Pianola's workspace.
 *
 * Glanceable board of the other agents: who needs the user, who is working, who
 * recently finished, and a feed of Pianola's recent autonomous decisions. Rows
 * jump to the owning agent on click. Data comes from `usePianolaDashboardData`
 * (live session state + the polled decision log).
 */

import React from 'react';
import {
	AlertCircle,
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
} from 'lucide-react';
import type { Theme } from '../../types';
import { formatRelativeTime } from '../../../shared/formatters';
import {
	usePianolaDashboardData,
	type DashboardAgentRow,
	type DashboardActivityRow,
} from './usePianolaDashboardData';
import { usePianolaSupervisor, type PianolaSupervisorState } from './usePianolaSupervisor';
import type { PianolaSupervisedState } from '../../../main/pianola/pianola-supervisor';

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
	emptyLabel: string;
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
	const { data, refresh } = usePianolaDashboardData();
	const supervisor = usePianolaSupervisor();

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

			<WatchedSection theme={theme} onJumpToAgent={onJumpToAgent} supervisor={supervisor} />

			<Section
				theme={theme}
				icon={<AlertCircle className="w-3.5 h-3.5" style={{ color: theme.colors.warning }} />}
				title="Needs your input"
				count={data.needsInput.length}
				emptyLabel="No agents are waiting on you."
			>
				{data.needsInput.map((row) => (
					<AgentRow
						key={row.key}
						theme={theme}
						row={row}
						accent={theme.colors.warning}
						onJump={onJumpToAgent}
					/>
				))}
			</Section>

			<Section
				theme={theme}
				icon={<Loader2 className="w-3.5 h-3.5" style={{ color: theme.colors.accent }} />}
				title="Working now"
				count={data.working.length}
				emptyLabel="No agents are working right now."
			>
				{data.working.map((row) => (
					<AgentRow
						key={row.key}
						theme={theme}
						row={row}
						accent={theme.colors.accent}
						onJump={onJumpToAgent}
					/>
				))}
			</Section>

			<Section
				theme={theme}
				icon={<CheckCircle2 className="w-3.5 h-3.5" style={{ color: theme.colors.success }} />}
				title="Recently done"
				count={data.recentlyDone.length}
				emptyLabel="Nothing finished recently."
			>
				{data.recentlyDone.map((row) => (
					<AgentRow
						key={row.key}
						theme={theme}
						row={row}
						accent={theme.colors.success}
						onJump={onJumpToAgent}
					/>
				))}
			</Section>

			<Section
				theme={theme}
				icon={<ListChecks className="w-3.5 h-3.5" style={{ color: theme.colors.textDim }} />}
				title="Recent decisions"
				count={data.activity.length}
				emptyLabel="No decisions recorded yet."
			>
				{data.activity.map((row) => (
					<ActivityRow key={row.id} theme={theme} row={row} onJump={onJumpToAgent} />
				))}
			</Section>
		</div>
	);
}
