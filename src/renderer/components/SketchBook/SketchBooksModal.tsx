/**
 * SketchBooksModal - every Sketch Book on this computer, across every agent,
 * newest first, or one agent's when `agentId` is set (`maestro-cli open
 * sketch-books --agent`). Both open and closed sketches are listed: the sketch store keeps a
 * drawing after its tab closes, so this list is the way back to it once the
 * closed-tab history has moved on.
 *
 * Search narrows by sketch name, owning agent, or id. Each row offers:
 *  - Open: show it in a tab on the agent that owns it (Enter)
 *  - Rename: the sketch's own name; tab labels are the tabs' own (F2)
 *  - Delete: remove it and close its tabs; refused while it is shared
 *
 * Every verb goes through the same `window.maestro.sketch` channels and
 * SketchService as `maestro-cli sketch open|rename|delete`.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BookOpen, ExternalLink, Pencil, Trash2 } from 'lucide-react';
import type { Theme } from '../../types';
import type { SketchRecord } from '../../../shared/sketch/types';
import { formatRelativeTime } from '../../../shared/formatters';
import { MODAL_PRIORITIES } from '../../constants/modalPriorities';
import { useListNavigation } from '../../hooks/keyboard/useListNavigation';
import { useSessionStore } from '../../stores/sessionStore';
import { notifyToast } from '../../stores/notificationStore';
import { ipcErrorMessage } from '../../utils/ipcErrorMessage';
import { FilterInput, MiniBadge, Modal, Spinner } from '../ui';
import { ConfirmModal } from '../ConfirmModal';
import { getTabKindColor, getTabKindIcon } from '../TabBar/tabBarUtils';

export interface SketchBooksModalProps {
	theme: Theme;
	/** List only this agent's sketches. Absent: every agent's. */
	agentId?: string;
	onClose: () => void;
}

/** A sketch as the list shows it: the record and who owns it now. */
export interface SketchBookRow {
	record: SketchRecord;
	/** The owning agent's name, or null when that agent is gone. */
	ownerName: string | null;
	/** A tab on the owning agent points at it right now. */
	hasOpenTab: boolean;
}

/**
 * Newest first, narrowed by `query` against the name, the owner's name and
 * the id (case-insensitive, every word must match somewhere).
 */
export function filterSketchBookRows(rows: SketchBookRow[], query: string): SketchBookRow[] {
	const words = query.toLowerCase().split(/\s+/).filter(Boolean);
	return rows
		.filter((row) => {
			if (words.length === 0) return true;
			const haystack =
				`${row.record.name} ${row.ownerName ?? ''} ${row.record.sketchId}`.toLowerCase();
			return words.every((word) => haystack.includes(word));
		})
		.sort((a, b) => b.record.createdAt - a.record.createdAt);
}

export function SketchBooksModal({ theme, agentId, onClose }: SketchBooksModalProps) {
	const sessions = useSessionStore((state) => state.sessions);
	const scopeName = agentId
		? (sessions.find((session) => session.id === agentId)?.name ?? null)
		: null;
	const [records, setRecords] = useState<SketchRecord[] | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [query, setQuery] = useState('');
	const [renaming, setRenaming] = useState<{ sketchId: string; name: string } | null>(null);
	const [confirmDelete, setConfirmDelete] = useState<SketchRecord | null>(null);
	const filterRef = useRef<HTMLInputElement>(null);

	const reload = useCallback(async () => {
		try {
			// The service filters by owner, the same as `sketch list --agent`.
			setRecords(await window.maestro.sketch.list(agentId ? { ownerAgentId: agentId } : undefined));
			setLoadError(null);
		} catch (error) {
			setLoadError(ipcErrorMessage(error));
		}
	}, [agentId]);

	useEffect(() => {
		void reload();
	}, [reload]);

	const rows = useMemo(() => {
		const byId = new Map(sessions.map((session) => [session.id, session]));
		const all: SketchBookRow[] = (records ?? []).map((record) => {
			const owner = byId.get(record.ownerAgentId);
			return {
				record,
				ownerName: owner?.name ?? null,
				hasOpenTab: Boolean(owner?.sketchTabs?.some((tab) => tab.sketchId === record.sketchId)),
			};
		});
		return filterSketchBookRows(all, query);
	}, [records, sessions, query]);

	const fail = useCallback((error: unknown) => {
		notifyToast({ color: 'red', title: 'Sketch Book', message: ipcErrorMessage(error) });
	}, []);

	const handleOpen = useCallback(
		async (row: SketchBookRow | undefined) => {
			if (!row || row.ownerName === null) return;
			try {
				await window.maestro.sketch.open(row.record.sketchId);
				onClose();
			} catch (error) {
				fail(error);
			}
		},
		[fail, onClose]
	);

	const commitRename = useCallback(async () => {
		if (!renaming) return;
		const current = records?.find((record) => record.sketchId === renaming.sketchId);
		const name = renaming.name.trim();
		setRenaming(null);
		if (!current || !name || name === current.name) return;
		try {
			const updated = await window.maestro.sketch.rename(current.sketchId, name);
			setRecords(
				(prev) =>
					prev?.map((record) => (record.sketchId === updated.sketchId ? updated : record)) ?? prev
			);
		} catch (error) {
			fail(error);
		}
	}, [fail, records, renaming]);

	const handleDelete = useCallback(
		async (record: SketchRecord) => {
			try {
				await window.maestro.sketch.delete(record.sketchId);
				setRecords((prev) => prev?.filter((r) => r.sketchId !== record.sketchId) ?? prev);
			} catch (error) {
				fail(error);
			}
		},
		[fail]
	);

	const { selectedIndex, setSelectedIndex, handleKeyDown } = useListNavigation({
		listLength: rows.length,
		onSelect: (index) => void handleOpen(rows[index]),
		enabled: renaming === null && confirmDelete === null,
	});

	// The query changes the rows under the cursor; start over at the top.
	useEffect(() => setSelectedIndex(0), [query, setSelectedIndex]);

	const startRename = useCallback((record: SketchRecord) => {
		setRenaming({ sketchId: record.sketchId, name: record.name });
	}, []);

	const onListKeyDown = useCallback(
		(e: React.KeyboardEvent) => {
			if (renaming) return;
			const row = rows[selectedIndex];
			if (e.key === 'F2' && row) {
				e.preventDefault();
				startRename(row.record);
				return;
			}
			handleKeyDown(e);
		},
		[handleKeyDown, renaming, rows, selectedIndex, startRename]
	);

	// The layer stack hands Escape to the modal, so peel one thing off at a time:
	// a rename in progress, then the filter, then the modal itself.
	const handleClose = useCallback(() => {
		if (renaming) {
			setRenaming(null);
			filterRef.current?.focus();
		} else if (query) {
			setQuery('');
		} else {
			onClose();
		}
	}, [onClose, query, renaming]);

	const KindIcon = getTabKindIcon('sketch');
	const total = records?.length ?? 0;

	return (
		<>
			<Modal
				theme={theme}
				title="Sketch Books"
				subtitle={agentId ? (scopeName ?? 'Agent removed') : 'All agents'}
				headerIcon={<BookOpen className="w-4 h-4" style={{ color: theme.colors.accent }} />}
				priority={MODAL_PRIORITIES.SKETCH_BOOKS}
				onClose={handleClose}
				width={620}
				resizeKey="sketchBooksModal"
				defaultSize={{ width: 620, height: 520 }}
				minSize={{ width: 420, height: 280 }}
				initialFocusRef={filterRef as React.RefObject<HTMLElement>}
				contentClassName="flex flex-col flex-1 min-h-0 overflow-hidden"
				testId="sketch-books-modal"
			>
				{/* Click-driven list: suppress drag-select, opt names back in per row. */}
				<div className="select-none flex flex-col flex-1 min-h-0" onKeyDown={onListKeyDown}>
					<div className="px-4 pt-3 pb-2">
						<FilterInput
							ref={filterRef}
							theme={theme}
							value={query}
							onChange={setQuery}
							placeholder={
								agentId
									? 'Search sketches by name or id...'
									: 'Search sketches by name, agent, or id...'
							}
							resultLabel={query ? `${rows.length} of ${total}` : undefined}
							ariaLabel="Search Sketch Books"
						/>
					</div>
					<div className="flex-1 min-h-0 overflow-y-auto px-4 pb-4" role="listbox">
						{loadError ? (
							<div className="py-10 text-center text-sm" style={{ color: theme.colors.error }}>
								{loadError}
							</div>
						) : records === null ? (
							<div className="flex justify-center py-10">
								<Spinner color={theme.colors.textDim} />
							</div>
						) : rows.length === 0 ? (
							<div
								className="flex flex-col items-center gap-2 py-10 text-center"
								style={{ color: theme.colors.textDim }}
							>
								<BookOpen className="w-7 h-7 opacity-40" />
								<div className="text-sm">
									{total > 0
										? 'No matches'
										: agentId
											? 'This agent has no sketches'
											: 'No sketches yet'}
								</div>
								{total === 0 && (
									<div className="text-xs max-w-xs">
										New Sketch Book from the command palette or the menu starts one on the active
										agent. Closing its tab keeps the drawing here.
									</div>
								)}
							</div>
						) : (
							<div className="flex flex-col gap-1.5">
								{rows.map((row, index) => {
									const { record } = row;
									const selected = index === selectedIndex;
									const isRenaming = renaming?.sketchId === record.sketchId;
									const ownerGone = row.ownerName === null;
									return (
										<div
											key={record.sketchId}
											role="option"
											aria-selected={selected}
											data-testid="sketch-books-row"
											className="rounded px-3 py-2.5 cursor-pointer"
											style={{
												backgroundColor: selected
													? theme.colors.accentDim
													: theme.colors.bgActivity,
												border: `1px solid ${selected ? theme.colors.accent : theme.colors.border}`,
											}}
											onMouseEnter={() => setSelectedIndex(index)}
											onDoubleClick={() => void handleOpen(row)}
										>
											<div className="flex items-start gap-3">
												<div className="flex-1 min-w-0">
													<div className="flex items-center gap-1.5 min-w-0">
														<KindIcon
															className="w-3.5 h-3.5 shrink-0"
															style={{ color: getTabKindColor('sketch', theme) }}
															aria-hidden
														/>
														{isRenaming ? (
															<input
																autoFocus
																value={renaming.name}
																onChange={(e) => setRenaming({ ...renaming, name: e.target.value })}
																onKeyDown={(e) => {
																	if (e.key === 'Enter') {
																		// Moving focus blurs the input, and the blur commits:
																		// one commit path, so Enter never renames twice.
																		e.preventDefault();
																		filterRef.current?.focus();
																	}
																}}
																onBlur={() => void commitRename()}
																aria-label="Sketch name"
																className="flex-1 min-w-0 text-sm bg-transparent outline-none border-b select-text"
																style={{
																	color: theme.colors.textMain,
																	borderColor: theme.colors.accent,
																}}
															/>
														) : (
															<div
																className="text-sm truncate select-text"
																style={{ color: theme.colors.textMain }}
																title={record.name}
															>
																{record.name}
															</div>
														)}
														{row.hasOpenTab && <MiniBadge label="Open" theme={theme} />}
														{record.share && (
															<MiniBadge
																label="Shared"
																theme={theme}
																color={theme.colors.success}
																title="Shared on RunMaestro.ai"
															/>
														)}
													</div>
													<div
														className="flex items-center gap-1.5 text-xs mt-0.5"
														style={{ color: theme.colors.textDim }}
													>
														{/* One agent's list names its owner in the header, not on every row. */}
														{!agentId && (
															<>
																<span
																	className="truncate"
																	style={{ color: ownerGone ? theme.colors.warning : undefined }}
																>
																	{row.ownerName ?? 'Owner agent removed'}
																</span>
																<span>·</span>
															</>
														)}
														<span className="whitespace-nowrap">
															{formatRelativeTime(record.createdAt)}
														</span>
													</div>
												</div>

												<div className="flex items-center gap-1 shrink-0">
													<button
														type="button"
														onClick={() => void handleOpen(row)}
														disabled={ownerGone}
														title={
															ownerGone
																? 'The agent that owned it is gone, so it has no tab to open in'
																: 'Open in a tab (Enter)'
														}
														className="p-1.5 rounded hover:bg-white/10 transition-colors disabled:opacity-40 disabled:hover:bg-transparent"
														style={{ color: theme.colors.textDim }}
													>
														<ExternalLink className="w-3.5 h-3.5" />
													</button>
													<button
														type="button"
														onClick={() => startRename(record)}
														title="Rename (F2)"
														className="p-1.5 rounded hover:bg-white/10 transition-colors"
														style={{ color: theme.colors.textDim }}
													>
														<Pencil className="w-3.5 h-3.5" />
													</button>
													<button
														type="button"
														onClick={() => setConfirmDelete(record)}
														disabled={record.share !== null}
														title={
															record.share
																? 'Shared: stop sharing it in the Collaborate panel first'
																: 'Delete'
														}
														className="p-1.5 rounded hover:bg-white/10 transition-colors disabled:opacity-40 disabled:hover:bg-transparent"
														style={{ color: theme.colors.textDim }}
													>
														<Trash2 className="w-3.5 h-3.5" />
													</button>
												</div>
											</div>
										</div>
									);
								})}
							</div>
						)}
					</div>
				</div>
			</Modal>

			{confirmDelete && (
				<ConfirmModal
					theme={theme}
					title="Delete Sketch Book"
					message={`Delete "${confirmDelete.name}"? The drawing is removed from this computer and its open tab closes. This cannot be undone.`}
					confirmLabel="Delete"
					onConfirm={() => void handleDelete(confirmDelete)}
					onClose={() => {
						setConfirmDelete(null);
						filterRef.current?.focus();
					}}
				/>
			)}
		</>
	);
}
