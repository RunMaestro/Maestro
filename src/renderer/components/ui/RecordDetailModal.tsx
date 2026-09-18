/**
 * RecordDetailModal - vertical ("record") view of a single row of tabular data.
 *
 * A table lays a row out horizontally, which hides long or multi-line cells
 * behind an ellipsis. This flips one row into a two-column field/value table:
 * one field per line, values wrapped and rendered with their newlines intact.
 *
 * Shared by every tabular preview (CSV/TSV via CsvRowDetailModal, parquet via
 * the ParquetViewer) so they cannot drift on keyboard model, copy affordance,
 * or filtering. Callers hand it a flat field list, which is the only shape all
 * of them agree on: a CSV row is positional strings, a parquet row is typed
 * values that have already been formatted for display.
 *
 * Includes a field/value filter and prev/next navigation through the rows the
 * table is currently displaying (i.e. after its own sort and filter).
 *
 * Keyboard model: Left/Right step between rows, Up/Down (plus PageUp/PageDown
 * and Home/End) scroll the field list, and `/` jumps to the filter. Focus
 * starts on the field list rather than the filter input so every one of those
 * works on open without a click - inside a text input the arrows have to stay
 * caret movement, so parking focus there would swallow the whole scheme.
 */

import { useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Copy, Search, X } from 'lucide-react';
import type { Theme } from '../../types';
import { Modal } from './Modal';
import { GhostIconButton } from './GhostIconButton';
import { highlightMatches } from '../../utils/highlightMatches';
import { safeClipboardWrite } from '../../utils/clipboard';
import { flashCopiedToClipboard } from '../../utils/flashCopiedToClipboard';

const KEY_HINTS: { keys: string[]; label: string }[] = [
	{ keys: ['←', '→'], label: 'Row' },
	{ keys: ['↑', '↓'], label: 'Scroll' },
	{ keys: ['/'], label: 'Filter' },
	{ keys: ['Esc'], label: 'Close' },
];

/** One field/value pair of the record being inspected. */
export interface RecordDetailField {
	/** Field name, already resolved (never blank - callers fall back). */
	key: string;
	/** Display text. Multi-line values keep their newlines. */
	value: string;
}

interface RecordDetailModalProps {
	/** The record, in display order. */
	fields: RecordDetailField[];
	/** 0-based position of this record within the displayed rows */
	index: number;
	/** How many rows the table is currently displaying */
	total: number;
	/** Move to another displayed row (already clamped by the caller) */
	onNavigate: (nextIndex: number) => void;
	onClose: () => void;
	theme: Theme;
	/** Layer-stack priority. Callers pass their own MODAL_PRIORITIES entry. */
	priority: number;
	/** Key the dragged size is remembered under, per calling surface. */
	resizeKey: string;
	/**
	 * Prefix for this surface's test ids: `<prefix>-modal`, `<prefix>-search`,
	 * `<prefix>-fields`. Each caller keeps its own so a test can target the
	 * surface it opened rather than "whichever record modal is up".
	 */
	testIdPrefix: string;
}

export function RecordDetailModal({
	fields,
	index,
	total,
	onNavigate,
	onClose,
	theme,
	priority,
	resizeKey,
	testIdPrefix,
}: RecordDetailModalProps) {
	const [filter, setFilter] = useState('');
	const searchRef = useRef<HTMLInputElement>(null);
	const scrollRef = useRef<HTMLDivElement>(null);
	const query = filter.trim().slice(0, 200);

	const visibleFields = useMemo(() => {
		if (!query) return fields;
		const lower = query.toLowerCase();
		return fields.filter(
			(f) => f.key.toLowerCase().includes(lower) || f.value.toLowerCase().includes(lower)
		);
	}, [fields, query]);

	const canPrev = index > 0;
	const canNext = index < total - 1;

	const copyValue = async (value: string) => {
		if (await safeClipboardWrite(value)) flashCopiedToClipboard(value);
	};

	const customHeader = (
		<div
			className="p-4 border-b flex items-center justify-between gap-3 shrink-0"
			style={{ borderColor: theme.colors.border }}
		>
			<h2 className="text-sm font-bold truncate" style={{ color: theme.colors.textMain }}>
				Row {index + 1}
				<span style={{ color: theme.colors.textDim }}> of {total.toLocaleString()}</span>
			</h2>
			<div className="flex items-center gap-1 shrink-0">
				<GhostIconButton
					onClick={() => canPrev && onNavigate(index - 1)}
					disabled={!canPrev}
					title="Previous row (Left arrow)"
					ariaLabel="Previous row"
					color={theme.colors.textDim}
				>
					<ChevronLeft className="w-4 h-4" />
				</GhostIconButton>
				<GhostIconButton
					onClick={() => canNext && onNavigate(index + 1)}
					disabled={!canNext}
					title="Next row (Right arrow)"
					ariaLabel="Next row"
					color={theme.colors.textDim}
				>
					<ChevronRight className="w-4 h-4" />
				</GhostIconButton>
				<GhostIconButton onClick={onClose} ariaLabel="Close modal" color={theme.colors.textDim}>
					<X className="w-4 h-4" />
				</GhostIconButton>
			</div>
		</div>
	);

	/** Scroll the field list without moving focus off it. */
	const scrollBy = (delta: number) => {
		scrollRef.current?.scrollBy({ top: delta });
	};

	const SCROLL_LINE_PX = 48;

	const handleKeyDown = (e: React.KeyboardEvent) => {
		// Inside the filter input the arrows belong to the caret, so only Enter
		// is intercepted there, to hand focus back to the list. Escape is left
		// alone: the layer stack listens on window in the CAPTURE phase, so it
		// has already closed the modal by the time this bubble-phase handler
		// runs - "Escape clears the filter first" is not implementable here, and
		// Escape closing every modal outright is the app-wide contract anyway.
		if (e.target === searchRef.current) {
			if (e.key === 'Enter') {
				e.preventDefault();
				scrollRef.current?.focus();
			}
			return;
		}

		// Modified arrows belong to the OS/browser (word jumps, history nav).
		if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;

		switch (e.key) {
			case 'ArrowLeft':
				if (!canPrev) return;
				e.preventDefault();
				onNavigate(index - 1);
				break;
			case 'ArrowRight':
				if (!canNext) return;
				e.preventDefault();
				onNavigate(index + 1);
				break;
			case 'ArrowUp':
				e.preventDefault();
				scrollBy(-SCROLL_LINE_PX);
				break;
			case 'ArrowDown':
				e.preventDefault();
				scrollBy(SCROLL_LINE_PX);
				break;
			case 'PageUp':
				e.preventDefault();
				scrollBy(-(scrollRef.current?.clientHeight ?? 0) * 0.9);
				break;
			case 'PageDown':
				e.preventDefault();
				scrollBy((scrollRef.current?.clientHeight ?? 0) * 0.9);
				break;
			case 'Home':
				e.preventDefault();
				scrollRef.current?.scrollTo({ top: 0 });
				break;
			case 'End':
				e.preventDefault();
				scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
				break;
			case '/':
				// Jump to the filter without typing the slash into it.
				e.preventDefault();
				searchRef.current?.focus();
				break;
			default:
				break;
		}
	};

	return (
		<Modal
			theme={theme}
			title={`Row ${index + 1} of ${total}`}
			priority={priority}
			onClose={onClose}
			customHeader={customHeader}
			closeOnBackdropClick
			// The table renders inside the Main Panel, whose `isolate` wrapper is a
			// stacking context - without the portal the backdrop dims only the
			// center and the Left/Right panels stay lit on top of it.
			portal
			resizeKey={resizeKey}
			defaultSize={{ width: 900, height: 640 }}
			minSize={{ width: 380, height: 260 }}
			// Focus the field list, not the filter: arrows have to mean navigate
			// and scroll the moment the modal opens, and they can't while a text
			// input owns the caret. `/` moves focus to the filter.
			initialFocusRef={scrollRef}
			contentClassName="flex flex-col flex-1 min-h-0"
			testId={`${testIdPrefix}-modal`}
		>
			<div className="flex flex-col flex-1 min-h-0" onKeyDown={handleKeyDown}>
				{/* Filter */}
				<div
					className="px-4 py-3 border-b shrink-0 flex items-center gap-2"
					style={{ borderColor: theme.colors.border }}
				>
					<Search className="w-4 h-4 shrink-0" style={{ color: theme.colors.textDim }} />
					<input
						ref={searchRef}
						type="text"
						value={filter}
						onChange={(e) => setFilter(e.target.value)}
						placeholder="Filter fields and values..."
						className="flex-1 bg-transparent outline-none text-sm min-w-0"
						style={{ color: theme.colors.textMain }}
						data-testid={`${testIdPrefix}-search`}
					/>
					{query && (
						<span className="text-xs shrink-0" style={{ color: theme.colors.textDim }}>
							{visibleFields.length} of {fields.length}
						</span>
					)}
					{filter && (
						<GhostIconButton
							onClick={() => setFilter('')}
							ariaLabel="Clear filter"
							color={theme.colors.textDim}
						>
							<X className="w-3 h-3" />
						</GhostIconButton>
					)}
				</div>

				{/* Field / value pairs. tabIndex makes this the keyboard target so
				    Up/Down scroll it and Left/Right reach the handler above. */}
				<div
					ref={scrollRef}
					tabIndex={-1}
					className="flex-1 min-h-0 overflow-y-auto select-text outline-none"
					data-testid={`${testIdPrefix}-fields`}
				>
					{visibleFields.length === 0 ? (
						<div className="p-6 text-sm text-center" style={{ color: theme.colors.textDim }}>
							No fields match "{query}"
						</div>
					) : (
						<table className="w-full" style={{ borderCollapse: 'collapse', fontSize: '0.8125rem' }}>
							<tbody>
								{visibleFields.map((field, i) => (
									<tr
										key={`${field.key}-${i}`}
										className="group"
										style={{
											backgroundColor: i % 2 === 0 ? 'transparent' : theme.colors.bgActivity + '60',
										}}
									>
										<td
											style={{
												padding: '8px 12px',
												verticalAlign: 'top',
												width: '30%',
												minWidth: '120px',
												borderRight: `1px solid ${theme.colors.border}`,
												borderBottom: `1px solid ${theme.colors.border}40`,
												color: theme.colors.textDim,
												fontWeight: 600,
												wordBreak: 'break-word',
											}}
										>
											{highlightMatches(field.key, query, theme.colors.accent)}
										</td>
										<td
											style={{
												padding: '8px 12px',
												verticalAlign: 'top',
												borderBottom: `1px solid ${theme.colors.border}40`,
												color: field.value ? theme.colors.textMain : theme.colors.textDim,
												fontFamily:
													'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
												whiteSpace: 'pre-wrap',
												overflowWrap: 'anywhere',
											}}
										>
											<div className="flex items-start gap-2">
												<div className="flex-1 min-w-0">
													{field.value ? (
														highlightMatches(field.value, query, theme.colors.accent)
													) : (
														<span style={{ opacity: 0.5 }}>empty</span>
													)}
												</div>
												{field.value && (
													<GhostIconButton
														onClick={() => copyValue(field.value)}
														title="Copy value"
														ariaLabel={`Copy ${field.key}`}
														color={theme.colors.textDim}
														className="opacity-0 group-hover:opacity-100 shrink-0"
													>
														<Copy className="w-3 h-3" />
													</GhostIconButton>
												)}
											</div>
										</td>
									</tr>
								))}
							</tbody>
						</table>
					)}
				</div>

				{/* Keyboard legend */}
				<div
					className="px-4 py-2 border-t shrink-0 flex items-center gap-4"
					style={{ borderColor: theme.colors.border }}
				>
					{KEY_HINTS.map(({ keys, label }) => (
						<span
							key={label}
							className="text-xs flex items-center gap-1"
							style={{ color: theme.colors.textDim }}
						>
							{keys.map((key) => (
								<kbd
									key={key}
									className="px-1.5 py-0.5 rounded text-xs"
									style={{ backgroundColor: theme.colors.border }}
								>
									{key}
								</kbd>
							))}
							{label}
						</span>
					))}
				</div>
			</div>
		</Modal>
	);
}
