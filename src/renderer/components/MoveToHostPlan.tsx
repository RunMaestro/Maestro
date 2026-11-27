/**
 * The Move to Host plan, drawn from the `LiftPlanSummary` the lift returns: where the agent goes,
 * which conversations continue there, and what stays on this machine. The same summary the CLI
 * prints as text (`formatLiftPlan()`); the modal keeps that text one click away (Copy Plan as Text).
 */

import { useState } from 'react';
import {
	ArrowRight,
	ChevronDown,
	ChevronRight,
	KeyRound,
	Laptop,
	ListOrdered,
	MessageSquare,
	ScrollText,
	Server,
} from 'lucide-react';
import type { Theme } from '../types';
import {
	formatHostTabMerge,
	type LiftPlanStay,
	type LiftPlanSummary,
	type LiftPlanTab,
} from '../../shared/maestro-lib/agents/lift-plan';
import { getAgentDisplayName } from '../../shared/agentMetadata';
import { StatCardGrid } from './widgets';

/** Conversations listed before the rest fold behind "+ N more". */
const VISIBLE_TABS = 5;

function plural(count: number, one: string, many = `${one}s`): string {
	return `${count} ${count === 1 ? one : many}`;
}

/** One row of "Stays on this machine": every stay of one kind, counted once. */
export interface LiftStayRow {
	kind: LiftPlanStay['kind'];
	title: string;
	detail: string;
}

/**
 * Fold the plan's stays into one row per kind. Seven hidden consult tabs are one row, not seven
 * identical lines. Secret env vars name their keys: the key is what the person recognizes.
 */
export function groupLiftStays(stays: LiftPlanStay[]): LiftStayRow[] {
	const byKind = new Map<LiftPlanStay['kind'], LiftPlanStay[]>();
	for (const stay of stays) byKind.set(stay.kind, [...(byKind.get(stay.kind) ?? []), stay]);
	const rows: LiftStayRow[] = [];
	for (const [kind, group] of byKind) {
		const reasons = [...new Set(group.map((stay) => stay.reason))].join(' ');
		switch (kind) {
			case 'secret-env':
				rows.push({
					kind,
					title: plural(group.length, 'secret env var'),
					detail: `${group.map((stay) => stay.ref).join(', ')}. Check Send secret env vars too to move them.`,
				});
				break;
			case 'hidden-tab':
				rows.push({
					kind,
					title: plural(group.length, 'hidden consult tab'),
					detail: 'They belong to consults that run on this machine.',
				});
				break;
			case 'auto-run-folder':
				rows.push({ kind, title: 'Auto Run folder', detail: `${group[0].ref}. ${reasons}` });
				break;
			case 'transcript-image':
				rows.push({
					kind,
					title: plural(
						group.reduce((total, stay) => total + (stay.count ?? 1), 0),
						'conversation image'
					),
					detail: reasons,
				});
				break;
			default:
				rows.push({ kind, title: plural(group.length, 'queued message'), detail: reasons });
		}
	}
	return rows;
}

/** Transcript entries across every tab that moves (shown as messages; tool lines count too). */
export function liftTranscriptEntries(summary: LiftPlanSummary): number {
	return summary.tabs.reduce((total, tab) => total + tab.entries, 0);
}

/** The plan in one line, for the folded plan under a failure. */
export function liftPlanOneLine(summary: LiftPlanSummary): string {
	const parts = [
		plural(summary.tabs.length, 'conversation'),
		plural(summary.env.sent.length, 'env var'),
	];
	const stays = groupLiftStays(summary.stays).map((row) => `${row.title} stay`);
	return `${[...parts, ...stays].join(' · ')} → ${summary.remote.name}`;
}

/** The active tab first, then the plan's order. */
function orderTabs(summary: LiftPlanSummary): LiftPlanTab[] {
	const active = summary.tabs.find((tab) => tab.id === summary.activeTabId);
	return active ? [active, ...summary.tabs.filter((tab) => tab !== active)] : summary.tabs;
}

function SectionLabel({ theme, children }: { theme: Theme; children: string }) {
	return (
		<div
			className="text-xs font-semibold uppercase tracking-wider"
			style={{ color: theme.colors.textDim }}
		>
			{children}
		</div>
	);
}

export function MoveToHostPlan({ theme, summary }: { theme: Theme; summary: LiftPlanSummary }) {
	const [conversationsOpen, setConversationsOpen] = useState(true);
	const [showAllTabs, setShowAllTabs] = useState(false);
	const remoteName = summary.remote.name;
	const tabs = orderTabs(summary);
	const shownTabs = showAllTabs ? tabs : tabs.slice(0, VISIBLE_TABS);
	const hiddenTabCount = tabs.length - shownTabs.length;
	const stayRows = groupLiftStays(summary.stays);
	// A lift that replaces the copy an earlier Move Back left says what its tabs become (U4).
	const hostTabMerge = summary.replaces ? formatHostTabMerge(summary.tabMerge) : undefined;
	const meta = [
		getAgentDisplayName(summary.agent.provider),
		summary.model,
		summary.effort ? `effort ${summary.effort}` : undefined,
		summary.env.sessionDir
			? `${summary.env.sessionDir.key}=${summary.env.sessionDir.value}`
			: undefined,
		summary.customArgs ? `args ${summary.customArgs}` : undefined,
		summary.customPath ? `binary ${summary.customPath}` : undefined,
	].filter((part): part is string => Boolean(part));
	const ChevronIcon = conversationsOpen ? ChevronDown : ChevronRight;

	return (
		<div className="space-y-4" data-testid="move-to-host-plan">
			<div
				className="flex items-center gap-3 rounded-lg border px-4 py-3"
				style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgActivity }}
			>
				<div className="flex items-center gap-2 shrink-0">
					<Laptop className="w-5 h-5" style={{ color: theme.colors.textDim }} />
					<div>
						<div className="text-sm font-semibold" style={{ color: theme.colors.textMain }}>
							This machine
						</div>
						<div className="text-xs" style={{ color: theme.colors.textDim }}>
							becomes a pointer
						</div>
					</div>
				</div>
				<div className="flex-1 min-w-0 flex flex-col items-center gap-0.5">
					<span
						className="text-xs font-mono truncate max-w-full select-text"
						style={{ color: theme.colors.accent }}
						title={summary.cwd}
					>
						{summary.cwd}
					</span>
					<div className="flex items-center w-full">
						<div
							className="flex-1 border-t border-dashed"
							style={{ borderColor: theme.colors.accent }}
						/>
						<ArrowRight className="w-4 h-4 -ml-1" style={{ color: theme.colors.accent }} />
					</div>
				</div>
				<div className="flex items-center gap-2 shrink-0">
					<Server className="w-5 h-5" style={{ color: theme.colors.textDim }} />
					<div>
						<div className="text-sm font-semibold" style={{ color: theme.colors.textMain }}>
							{remoteName}
						</div>
						<div className="text-xs" style={{ color: theme.colors.textDim }}>
							keeps running with this machine off
						</div>
					</div>
				</div>
			</div>

			<StatCardGrid
				theme={theme}
				minColumnWidth={120}
				cards={[
					{ label: 'Conversations', value: summary.tabs.length, icon: MessageSquare },
					{ label: 'Messages', value: liftTranscriptEntries(summary), icon: ScrollText },
					{ label: 'Env vars', value: summary.env.sent.length, icon: KeyRound },
					{ label: 'Queued messages', value: summary.queued.length, icon: ListOrdered },
				]}
			/>

			{meta.length > 0 && (
				<div className="text-xs select-text" style={{ color: theme.colors.textDim }}>
					{meta.join(' · ')}
				</div>
			)}
			{summary.env.secretsSent.length > 0 && (
				<div className="text-xs select-text" style={{ color: theme.colors.warning }}>
					Secret env vars that move: {summary.env.secretsSent.join(', ')}
				</div>
			)}
			{hostTabMerge && (
				<div
					className="text-xs select-text"
					style={{ color: theme.colors.textDim }}
					data-testid="move-to-host-tab-merge"
				>
					{hostTabMerge}
				</div>
			)}

			<div className="space-y-1">
				<button
					type="button"
					onClick={() => setConversationsOpen((open) => !open)}
					className="w-full flex items-center gap-2 rounded px-1 py-1 text-left hover:bg-white/5 transition-colors"
					aria-expanded={conversationsOpen}
					data-testid="move-to-host-conversations-toggle"
				>
					<ChevronIcon className="w-3.5 h-3.5 shrink-0" style={{ color: theme.colors.accent }} />
					<span className="text-sm font-semibold" style={{ color: theme.colors.textMain }}>
						{plural(summary.tabs.length, 'conversation')} continue on {remoteName}
					</span>
					<span className="ml-auto text-xs" style={{ color: theme.colors.textDim }}>
						each resumes where it left off
					</span>
				</button>
				{conversationsOpen && (
					<div>
						{shownTabs.map((tab) => {
							const active = tab.id === summary.activeTabId;
							return (
								<div
									key={tab.id}
									className="flex items-center gap-2 rounded px-3 py-1.5 border-b last:border-b-0"
									style={{
										borderColor: theme.colors.border,
										backgroundColor: active ? `${theme.colors.accent}1f` : undefined,
									}}
								>
									<span
										className="text-xs truncate select-text"
										style={{ color: theme.colors.textMain }}
									>
										{tab.name ?? tab.id}
									</span>
									{active && (
										<span
											className="text-2xs px-1.5 rounded-full border shrink-0"
											style={{ borderColor: theme.colors.accent, color: theme.colors.accent }}
										>
											open tab
										</span>
									)}
									<span
										className="ml-auto text-xs shrink-0"
										style={{ color: theme.colors.textDim }}
									>
										{tab.agentSessionId ? plural(tab.entries, 'message') : 'starts fresh'}
									</span>
								</div>
							);
						})}
						{(hiddenTabCount > 0 || showAllTabs) && tabs.length > VISIBLE_TABS && (
							<button
								type="button"
								onClick={() => setShowAllTabs((all) => !all)}
								className="text-xs px-3 py-1.5 hover:underline"
								style={{ color: theme.colors.accent }}
							>
								{showAllTabs ? 'Show fewer' : `+ ${hiddenTabCount} more`}
							</button>
						)}
					</div>
				)}
			</div>

			<div className="space-y-1.5">
				<SectionLabel theme={theme}>Stays on this machine</SectionLabel>
				<div className="text-xs flex gap-2 px-1">
					<span style={{ color: theme.colors.textMain }}>Every tab and transcript</span>
					<span style={{ color: theme.colors.textDim }}>
						read-only here, it points to {remoteName}
					</span>
				</div>
				{stayRows.map((row) => (
					<div key={row.kind} className="text-xs flex gap-2 px-1">
						<span className="shrink-0" style={{ color: theme.colors.textMain }}>
							{row.title}
						</span>
						<span className="select-text" style={{ color: theme.colors.textDim }}>
							{row.detail}
						</span>
					</div>
				))}
			</div>
		</div>
	);
}
