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
} from 'lucide-react';
import type { Theme } from '../../types';
import { formatRelativeTime } from '../../../shared/formatters';
import {
	usePianolaDashboardData,
	type DashboardAgentRow,
	type DashboardActivityRow,
} from './usePianolaDashboardData';

interface PianolaDashboardProps {
	theme: Theme;
	onJumpToAgent: (sessionId: string) => void;
}

/** A titled, icon-led section with a count and an empty-state line. */
function Section({
	theme,
	icon,
	title,
	count,
	emptyLabel,
	children,
}: {
	theme: Theme;
	icon: React.ReactNode;
	title: string;
	count: number;
	emptyLabel: string;
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

export function PianolaDashboard({
	theme,
	onJumpToAgent,
}: PianolaDashboardProps): React.ReactElement {
	const { data, refresh } = usePianolaDashboardData();

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
					onClick={refresh}
					className="flex items-center gap-1.5 text-xs px-2 py-1 rounded hover:bg-white/5 transition-colors"
					style={{ color: theme.colors.textDim }}
					title="Refresh"
				>
					<RefreshCw className="w-3.5 h-3.5" />
					Refresh
				</button>
			</div>

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
