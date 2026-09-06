/**
 * GroupDetailModal
 *
 * Per-group stats sub-modal opened by clicking a tile on the Usage Dashboard's
 * Groups tab. The group tile answers "what did this client cost"; this answers
 * "and which agents inside it spent it" - a sortable per-agent table of the same
 * measures the group totals were summed from, so a row and the header always
 * reconcile.
 *
 * Every number comes from the aggregation the dashboard already fetched, run
 * through the same `rollUpGroup` the tiles use - once per member for the rows,
 * once over all members for the header. Sharing the reducer is the point: a
 * separate per-agent calculation could disagree with the group total it sits
 * under, and the user would have no way to tell which one was lying.
 *
 * Clicking a row opens the existing per-agent detail modal on top of this one.
 */

import { memo, useMemo, useRef } from 'react';
import type { Session, Theme } from '../../types';
import type { StatsAggregation } from '../../../shared/stats-types';
import type { GroupStatRollup } from '../../../shared/statsGroupRollup';
import { rollUpGroup, totalTokens } from '../../../shared/statsGroupRollup';
import {
	formatCost,
	formatDurationHuman,
	formatNumber,
	formatRelativeTime,
	formatTokensCompact,
} from '../../../shared/formatters';
import { getAgentDisplayName } from '../../../shared/agentMetadata';
import { Modal } from '../ui/Modal';
import { SortableTh } from '../ui/SortableTh';
import { useTableSort } from '../../hooks/ui/useTableSort';
import { useElementWidth } from '../../hooks/ui/useElementWidth';
import { MODAL_PRIORITIES } from '../../constants/modalPriorities';
import { Sparkline } from './Sparkline';
import { Kpi, MetaField, SectionHeading } from './DetailPrimitives';

const EM_DASH = '—';

type MemberSortKey = 'name' | 'queries' | 'duration' | 'tokens' | 'cost' | 'auto' | 'lastActive';

/** One row of the per-agent table. */
interface MemberRow {
	session: Session;
	queries: number;
	duration: number;
	tokens: number;
	costUsd: number;
	pricedQueries: number;
	autoPercent: number | null;
	/** Local-date string of the last day with recorded activity, or null. */
	lastActiveDate: string | null;
}

/**
 * Numeric columns default to descending: "who used the most" is the question a
 * usage table is opened to answer, and an ascending first click buries it.
 */
function defaultDirectionFor(key: MemberSortKey): 'asc' | 'desc' {
	return key === 'name' ? 'asc' : 'desc';
}

/**
 * Explain how much of the group's activity the cost figure actually covers.
 * Mirrors the tile's tooltip so the two surfaces cannot contradict each other.
 */
function coverageNote(pricedQueries: number, queries: number): string {
	if (pricedQueries === 0) {
		return 'No token usage recorded yet. Cost tracking covers turns recorded after the stats database gained token columns.';
	}
	if (pricedQueries >= queries) {
		return `Covers all ${formatNumber(queries)} recorded ${queries === 1 ? 'query' : 'queries'}.`;
	}
	return `Covers ${formatNumber(pricedQueries)} of ${formatNumber(queries)} queries - earlier turns report no usage.`;
}

export interface GroupDetailModalProps {
	/** The clicked group's rollup, including its member sessions. */
	rollup: GroupStatRollup;
	/** Live sessions, used to resolve each member id back to a full Session. */
	sessions: Session[];
	data: StatsAggregation;
	theme: Theme;
	onClose: () => void;
	/** Open the per-agent detail modal for a member. */
	onSelectAgent?: (session: Session) => void;
}

export const GroupDetailModal = memo(function GroupDetailModal({
	rollup,
	sessions,
	data,
	theme,
	onClose,
	onSelectAgent,
}: GroupDetailModalProps) {
	const activityRef = useRef<HTMLDivElement>(null);
	const activityWidth = useElementWidth(activityRef);
	const { sortKey, direction, toggleSort } = useTableSort<MemberSortKey>('queries', {
		defaultDirectionFor,
	});

	const rows = useMemo((): MemberRow[] => {
		const byId = new Map(sessions.map((s) => [s.id, s]));
		return rollup.sessions.map((member) => {
			// One member at a time through the same reducer the group total uses,
			// so a row can never disagree with the header above it.
			const stats = rollUpGroup([member], data);
			const days = stats.byDay.filter((d) => d.count > 0);
			return {
				session: byId.get(member.id) ?? ({ ...member, toolType: member.toolType } as Session),
				queries: stats.queries,
				duration: stats.duration,
				tokens: totalTokens(stats.tokens),
				costUsd: stats.tokens.costUsd,
				pricedQueries: stats.tokens.pricedQueries,
				autoPercent: stats.autoPercent,
				lastActiveDate: days.length > 0 ? days[days.length - 1].date : null,
			};
		});
	}, [rollup.sessions, sessions, data]);

	const sortedRows = useMemo(() => {
		const factor = direction === 'asc' ? 1 : -1;
		// Alphabetical first so equal values keep a stable, scannable order
		// rather than whatever the member array happened to hold.
		const byName = (a: MemberRow, b: MemberRow) =>
			a.session.name.localeCompare(b.session.name, undefined, { sensitivity: 'base' });
		const base = rows.slice().sort(byName);
		if (sortKey === 'name') return direction === 'asc' ? base : base.reverse();

		return base.slice().sort((a, b) => {
			switch (sortKey) {
				case 'queries':
					return (a.queries - b.queries) * factor;
				case 'duration':
					return (a.duration - b.duration) * factor;
				case 'tokens':
					return (a.tokens - b.tokens) * factor;
				case 'cost':
					return (a.costUsd - b.costUsd) * factor;
				case 'auto': {
					// Agents with no recorded queries have no auto share at all.
					// They sink to the bottom in BOTH directions rather than
					// masquerading as 0% and topping an ascending sort.
					if (a.autoPercent === null && b.autoPercent === null) return 0;
					if (a.autoPercent === null) return 1;
					if (b.autoPercent === null) return -1;
					return (a.autoPercent - b.autoPercent) * factor;
				}
				case 'lastActive': {
					if (!a.lastActiveDate && !b.lastActiveDate) return 0;
					if (!a.lastActiveDate) return 1;
					if (!b.lastActiveDate) return -1;
					return a.lastActiveDate.localeCompare(b.lastActiveDate) * factor;
				}
				default:
					return 0;
			}
		});
	}, [rows, sortKey, direction]);

	const sparkline = useMemo(() => rollup.byDay.map((d) => d.count), [rollup.byDay]);
	const groupTokens = totalTokens(rollup.tokens);
	const hasUsage = rollup.tokens.pricedQueries > 0;
	const note = coverageNote(rollup.tokens.pricedQueries, rollup.queries);
	const memberLabel = `${rollup.memberCount} ${rollup.memberCount === 1 ? 'agent' : 'agents'}`;

	const headerCellClass = 'py-2 px-2 border-b';
	const cellStyle = { borderColor: theme.colors.border };

	return (
		<Modal
			theme={theme}
			title={rollup.emoji ? `${rollup.emoji} ${rollup.name}` : rollup.name}
			priority={MODAL_PRIORITIES.USAGE_DASHBOARD_GROUP_DETAIL}
			onClose={onClose}
			width={900}
			maxHeight="85vh"
			resizeKey="modal-usage-group-detail"
			defaultSize={{ width: 900, height: 720 }}
			minSize={{ width: 520, height: 380 }}
			closeOnBackdropClick={true}
			testId="group-detail-modal"
			contentClassName="p-6 overflow-y-auto flex-1 min-h-0"
		>
			<div className="space-y-5">
				<section
					className="rounded-lg p-3 border"
					style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgMain }}
				>
					<div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-xs">
						<MetaField label="Agents" value={memberLabel} theme={theme} />
						{rollup.providers.length > 0 && (
							<MetaField
								label="Providers"
								value={rollup.providers.map((p) => getAgentDisplayName(p)).join(', ')}
								theme={theme}
							/>
						)}
						<MetaField
							label="Active days"
							value={formatNumber(rollup.byDay.filter((d) => d.count > 0).length)}
							theme={theme}
						/>
					</div>
				</section>

				<section className="grid grid-cols-2 sm:grid-cols-5 gap-3">
					<Kpi
						label="Queries"
						value={formatNumber(rollup.queries)}
						theme={theme}
						testId="group-detail-queries"
					/>
					<Kpi
						label="Active time"
						value={rollup.duration > 0 ? formatDurationHuman(rollup.duration) : EM_DASH}
						muted={rollup.duration === 0}
						theme={theme}
						testId="group-detail-duration"
					/>
					<Kpi
						label="Tokens"
						value={hasUsage ? formatTokensCompact(groupTokens) : EM_DASH}
						muted={!hasUsage}
						title={note}
						theme={theme}
						testId="group-detail-tokens"
					/>
					<Kpi
						label="Cost"
						value={hasUsage ? formatCost(rollup.tokens.costUsd) : EM_DASH}
						muted={!hasUsage}
						title={note}
						theme={theme}
						testId="group-detail-cost"
					/>
					<Kpi
						label="Auto"
						value={rollup.autoPercent === null ? EM_DASH : `${rollup.autoPercent}%`}
						muted={rollup.autoPercent === null}
						title="Share of queries started by Auto Run or Cue rather than typed"
						theme={theme}
						testId="group-detail-auto"
					/>
				</section>

				{!hasUsage && (
					<p className="text-xs-plus" style={{ color: theme.colors.textDim }} role="note">
						{note}
					</p>
				)}

				{sparkline.length > 0 && (
					<section>
						<SectionHeading theme={theme}>Daily Activity</SectionHeading>
						<div
							ref={activityRef}
							className="rounded-md p-3 border"
							style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgMain }}
						>
							<Sparkline
								data={sparkline}
								color={theme.colors.accent}
								// 24px of horizontal padding on the measured container.
								// Width is 0 until the observer fires; fall back to the
								// default frame width so the first paint is not empty.
								width={activityWidth > 0 ? Math.max(120, activityWidth - 24) : 840}
								height={64}
							/>
							<div
								className="flex justify-between mt-1 text-2xs"
								style={{ color: theme.colors.textDim }}
							>
								<span>{rollup.byDay[0]?.date ?? ''}</span>
								<span>{rollup.byDay[rollup.byDay.length - 1]?.date ?? ''}</span>
							</div>
						</div>
					</section>
				)}

				<section>
					<SectionHeading theme={theme}>Agents in this group</SectionHeading>
					{sortedRows.length === 0 ? (
						<div
							className="py-6 text-center text-sm rounded-md border"
							style={{
								borderColor: theme.colors.border,
								backgroundColor: theme.colors.bgMain,
								color: theme.colors.textDim,
							}}
							data-testid="group-detail-no-members"
							role="status"
						>
							This group has no agents.
						</div>
					) : (
						<div className="overflow-x-auto">
							<table className="w-full text-xs" data-testid="group-detail-members">
								<thead>
									<tr style={{ color: theme.colors.textDim }}>
										<SortableTh
											columnKey="name"
											label="Agent"
											sortKey={sortKey}
											direction={direction}
											onSort={toggleSort}
											theme={theme}
											className={headerCellClass}
											style={cellStyle}
											testId="group-detail-sort-name"
										/>
										<SortableTh
											columnKey="queries"
											label="Queries"
											align="right"
											sortKey={sortKey}
											direction={direction}
											onSort={toggleSort}
											theme={theme}
											className={headerCellClass}
											style={cellStyle}
											testId="group-detail-sort-queries"
										/>
										<SortableTh
											columnKey="duration"
											label="Time"
											align="right"
											sortKey={sortKey}
											direction={direction}
											onSort={toggleSort}
											theme={theme}
											className={headerCellClass}
											style={cellStyle}
											title="Total agent run time"
											testId="group-detail-sort-duration"
										/>
										<SortableTh
											columnKey="tokens"
											label="Tokens"
											align="right"
											sortKey={sortKey}
											direction={direction}
											onSort={toggleSort}
											theme={theme}
											className={headerCellClass}
											style={cellStyle}
											testId="group-detail-sort-tokens"
										/>
										<SortableTh
											columnKey="cost"
											label="Cost"
											align="right"
											sortKey={sortKey}
											direction={direction}
											onSort={toggleSort}
											theme={theme}
											className={headerCellClass}
											style={cellStyle}
											testId="group-detail-sort-cost"
										/>
										<SortableTh
											columnKey="auto"
											label="Auto %"
											align="right"
											sortKey={sortKey}
											direction={direction}
											onSort={toggleSort}
											theme={theme}
											className={headerCellClass}
											style={cellStyle}
											testId="group-detail-sort-auto"
										/>
										<SortableTh
											columnKey="lastActive"
											label="Last active"
											align="right"
											sortKey={sortKey}
											direction={direction}
											onSort={toggleSort}
											theme={theme}
											className={headerCellClass}
											style={cellStyle}
											testId="group-detail-sort-last-active"
										/>
									</tr>
								</thead>
								<tbody>
									{sortedRows.map((row) => {
										const rowNote = coverageNote(row.pricedQueries, row.queries);
										const rowHasUsage = row.pricedQueries > 0;
										const isClickable = Boolean(onSelectAgent);
										return (
											<tr
												key={row.session.id}
												className={isClickable ? 'cursor-pointer' : undefined}
												onClick={isClickable ? () => onSelectAgent?.(row.session) : undefined}
												data-testid="group-detail-member-row"
												title={
													isClickable ? `View detailed stats for ${row.session.name}` : undefined
												}
											>
												<td
													className="py-2 px-2 border-b max-w-[260px]"
													style={{ ...cellStyle, color: theme.colors.textMain }}
												>
													<span className="block truncate" title={row.session.name}>
														{row.session.name}
													</span>
													{row.session.worktreeBranch && (
														<span
															className="block truncate text-2xs"
															style={{ color: theme.colors.textDim }}
														>
															{row.session.worktreeBranch}
														</span>
													)}
												</td>
												<td
													className="py-2 px-2 border-b text-right tabular-nums"
													style={{ ...cellStyle, color: theme.colors.textMain }}
													data-testid="group-detail-member-queries"
												>
													{formatNumber(row.queries)}
												</td>
												<td
													className="py-2 px-2 border-b text-right tabular-nums"
													style={{
														...cellStyle,
														color: row.duration > 0 ? theme.colors.textMain : theme.colors.textDim,
													}}
												>
													{row.duration > 0 ? formatDurationHuman(row.duration) : EM_DASH}
												</td>
												<td
													className="py-2 px-2 border-b text-right tabular-nums"
													style={{
														...cellStyle,
														color: rowHasUsage ? theme.colors.textMain : theme.colors.textDim,
													}}
													title={rowNote}
												>
													{rowHasUsage ? formatTokensCompact(row.tokens) : EM_DASH}
												</td>
												<td
													className="py-2 px-2 border-b text-right tabular-nums"
													style={{
														...cellStyle,
														color: rowHasUsage ? theme.colors.textMain : theme.colors.textDim,
													}}
													title={rowNote}
													data-testid="group-detail-member-cost"
												>
													{rowHasUsage ? formatCost(row.costUsd) : EM_DASH}
												</td>
												<td
													className="py-2 px-2 border-b text-right tabular-nums"
													style={{
														...cellStyle,
														color:
															row.autoPercent === null
																? theme.colors.textDim
																: theme.colors.textMain,
													}}
												>
													{row.autoPercent === null ? EM_DASH : `${row.autoPercent}%`}
												</td>
												<td
													className="py-2 px-2 border-b text-right"
													style={{ ...cellStyle, color: theme.colors.textDim }}
												>
													{row.lastActiveDate
														? formatRelativeTime(
																new Date(`${row.lastActiveDate}T00:00:00`).getTime()
															)
														: EM_DASH}
												</td>
											</tr>
										);
									})}
								</tbody>
							</table>
						</div>
					)}
				</section>
			</div>
		</Modal>
	);
});

export default GroupDetailModal;
