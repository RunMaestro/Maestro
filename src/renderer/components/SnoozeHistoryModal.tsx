/**
 * SnoozeHistoryModal - the log of snoozes that have ended.
 *
 * One chronological list, newest first, across every agent. Each row answers
 * the questions you actually have looking back: what did I park, what did I
 * tell myself about it, when was it due, and when did it come back.
 *
 * Reached from the "View History" link in the Snoozed Tabs modal.
 */

import { useCallback, useMemo } from 'react';
import { History, StickyNote, RotateCcw, BellRing, X } from 'lucide-react';
import type { Theme, SnoozeHistoryEntry, SnoozeResolution } from '../types';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { Modal } from './ui';
import { useSessionStore } from '../stores/sessionStore';
import { useSnoozeHistoryStore, MAX_SNOOZE_HISTORY } from '../stores/snoozeHistoryStore';
import { formatSnoozeTarget } from '../../shared/snooze';
import { formatRelativeTime } from '../../shared/formatters';

export interface SnoozeHistoryModalProps {
	theme: Theme;
	onClose: () => void;
	/**
	 * Focus an agent (and its tab, when the tab is still open). Omitted `tabId`
	 * means "just switch to the agent".
	 */
	onJumpToTab?: (sessionId: string, tabId?: string) => void;
}

/** Icon and wording per resolution, so the three outcomes read distinctly. */
const RESOLUTION_META: Record<
	SnoozeResolution,
	{ icon: typeof BellRing; label: string; describe: (entry: SnoozeHistoryEntry) => string }
> = {
	woke: {
		icon: BellRing,
		label: 'Came back',
		describe: (entry) => `Came back ${formatRelativeTime(entry.resolvedAt)}`,
	},
	unsnoozed: {
		icon: RotateCcw,
		label: 'Brought back early',
		describe: (entry) => `Brought back early ${formatRelativeTime(entry.resolvedAt)}`,
	},
	dismissed: {
		icon: X,
		label: 'Dismissed',
		describe: (entry) => `Dismissed ${formatRelativeTime(entry.resolvedAt)}`,
	},
};

export function SnoozeHistoryModal({ theme, onClose, onJumpToTab }: SnoozeHistoryModalProps) {
	const entries = useSnoozeHistoryStore((state) => state.entries);
	const sessions = useSessionStore((state) => state.sessions);

	// The store keeps entries newest-first, but sort defensively so the view is
	// chronological regardless of how the log was written or hydrated.
	const ordered = useMemo(
		() => [...entries].sort((a, b) => b.resolvedAt - a.resolvedAt),
		[entries]
	);

	/**
	 * Where a history row can actually take you, resolved against LIVE state.
	 *
	 * A history entry is a snapshot of a past resolution, so its ids go stale:
	 * the agent may have been deleted, the tab closed since it woke, and a
	 * `dismissed` entry never had its tab restored at all. Resolving here (rather
	 * than trusting the stored ids) is what keeps a row from promising a jump it
	 * can't make.
	 *
	 * Returns null when the agent is gone, and a target with no `tabId` when the
	 * agent is still around but that particular tab isn't.
	 */
	const resolveJumpTarget = useCallback(
		(entry: SnoozeHistoryEntry): { sessionName: string; tabId?: string } | null => {
			const session = sessions.find((s) => s.id === entry.sessionId);
			if (!session) return null;
			const tabIsOpen = !!entry.tabId && session.aiTabs?.some((t) => t.id === entry.tabId);
			return { sessionName: session.name, tabId: tabIsOpen ? entry.tabId : undefined };
		},
		[sessions]
	);

	return (
		<Modal
			theme={theme}
			title="Snooze History"
			headerIcon={<History className="w-4 h-4" style={{ color: theme.colors.accent }} />}
			priority={MODAL_PRIORITIES.SNOOZE_HISTORY}
			onClose={onClose}
			width={560}
			maxHeight="70vh"
		>
			{/* Click-driven shell; row content opts back into selection below. */}
			<div className="select-none">
				{ordered.length === 0 ? (
					<div
						className="flex flex-col items-center gap-2 py-10 text-center"
						style={{ color: theme.colors.textDim }}
					>
						<History className="w-7 h-7 opacity-40" />
						<div className="text-sm">No snooze history yet</div>
						<div className="text-xs max-w-xs">
							Once a snoozed tab comes back or you dismiss it, it shows up here with the note you
							left yourself.
						</div>
					</div>
				) : (
					<>
						<div className="flex flex-col gap-1.5">
							{ordered.map((entry) => {
								const meta = RESOLUTION_META[entry.resolution];
								const Icon = meta.icon;
								const dismissed = entry.resolution === 'dismissed';
								const target = onJumpToTab ? resolveJumpTarget(entry) : null;
								// Say up front what the click will do, including when the tab
								// is gone and only the agent is left to open.
								const jumpTitle = !target
									? `${entry.sessionName || 'That agent'} is no longer available`
									: target.tabId
										? `Jump to this tab in ${target.sessionName}`
										: `Open ${target.sessionName} - that tab is no longer open`;

								return (
									<div
										key={entry.id}
										role={target ? 'button' : undefined}
										tabIndex={target ? 0 : undefined}
										title={jumpTitle}
										aria-label={target ? `${entry.label}. ${jumpTitle}` : undefined}
										onClick={
											target ? () => onJumpToTab?.(entry.sessionId, target.tabId) : undefined
										}
										onKeyDown={
											target
												? (e) => {
														if (e.key === 'Enter' || e.key === ' ') {
															e.preventDefault();
															onJumpToTab?.(entry.sessionId, target.tabId);
														}
													}
												: undefined
										}
										className={`rounded px-3 py-2.5 outline-none ${
											target ? 'cursor-pointer hover:bg-white/5 transition-colors' : ''
										}`}
										style={{
											backgroundColor: theme.colors.bgActivity,
											border: `1px solid ${theme.colors.border}`,
										}}
									>
										<div className="flex items-start gap-2.5">
											<Icon
												className="w-3.5 h-3.5 shrink-0 mt-0.5"
												style={{
													color: dismissed ? theme.colors.textDim : theme.colors.accent,
												}}
											/>

											<div className="flex-1 min-w-0 select-text">
												<div
													className="text-sm truncate"
													style={{
														color: theme.colors.textMain,
														// A dismissed tab was given up on; dim it so the list
														// reads at a glance.
														opacity: dismissed ? 0.65 : 1,
													}}
													title={entry.label}
												>
													{entry.label}
												</div>

												<div
													className="flex flex-wrap items-center gap-1.5 text-xs mt-0.5"
													style={{ color: theme.colors.textDim }}
												>
													{entry.sessionName && (
														<>
															<span className="truncate">{entry.sessionName}</span>
															<span>·</span>
														</>
													)}
													<span className="whitespace-nowrap">{meta.describe(entry)}</span>
												</div>

												<div className="text-xs mt-0.5" style={{ color: theme.colors.textDim }}>
													Was due {formatSnoozeTarget(entry.wakeAt)}
												</div>

												{entry.note && (
													<div
														className="flex items-start gap-1.5 text-xs mt-1.5"
														style={{ color: theme.colors.textDim }}
													>
														<StickyNote className="w-3 h-3 shrink-0 mt-0.5" />
														<span className="italic">{entry.note}</span>
													</div>
												)}
											</div>
										</div>
									</div>
								);
							})}
						</div>

						{ordered.length >= MAX_SNOOZE_HISTORY && (
							<div
								className="text-xs-plus text-center mt-3"
								style={{ color: theme.colors.textDim }}
							>
								Showing the most recent {MAX_SNOOZE_HISTORY}. Older entries are dropped as new ones
								arrive.
							</div>
						)}
					</>
				)}
			</div>
		</Modal>
	);
}
