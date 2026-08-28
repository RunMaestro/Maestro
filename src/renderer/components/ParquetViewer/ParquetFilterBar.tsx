/**
 * ParquetFilterBar - the one input that filters a parquet file.
 *
 * There is deliberately no mode switch. A bare word is a substring search
 * across every column, and anything with an operator in it is a typed
 * predicate, so the same box serves someone who types `smith` and someone who
 * types `ts >= now-7d and status != archived`. The JSONL viewer's text/jq
 * toggle is the counter-example: it makes the user classify their own query
 * before typing it, and the first thing typed into a fresh box is usually
 * evaluated by the wrong engine.
 *
 * Column completion is offered while the caret sits on an identifier, which is
 * what makes the typed half discoverable without a schema lookup. The parse
 * error, when there is one, names the span it starts at - the input underlines
 * it rather than just printing a message, because "unexpected token" ten
 * characters back is otherwise a scavenger hunt.
 */

import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { AlertCircle, Filter, HelpCircle, X, Zap } from 'lucide-react';

import type {
	ParquetColumnInfo,
	ParquetFilterProblem,
	ParquetScanStats,
} from '../../../shared/parquet/types';
import type { Theme } from '../../types';
import { formatCount, formatSize } from '../../../shared/formatters';
import { quoteColumnName } from './parquetFormat';

/** Examples shown in the help popover, in ascending order of sophistication. */
const SYNTAX_EXAMPLES: { expression: string; description: string }[] = [
	{ expression: 'acme', description: 'any column contains "acme"' },
	{ expression: 'status = active', description: 'exact match' },
	{ expression: 'price > 100 and qty <= 5', description: 'combine with and / or / not' },
	{ expression: 'region in (us, eu)', description: 'set membership' },
	{ expression: 'id between 100 and 200', description: 'inclusive range' },
	{ expression: 'ts >= now-7d', description: 'relative time (s, m, h, d, w)' },
	{ expression: 'ts >= 2024-01-15 10:30', description: 'absolute date or datetime' },
	{ expression: 'name ~ smith', description: 'contains (case-insensitive)' },
	{ expression: 'name ~ /^acme-\\d+$/', description: 'regular expression' },
	{ expression: 'path ^= /var/log', description: 'starts with ( $= ends with )' },
	{ expression: 'notes is null', description: 'null tests' },
	{ expression: '[order id] = 42', description: 'bracket names with spaces' },
];

/** Imperative handle so the file preview can route Cmd+F here. */
export interface ParquetFilterBarHandle {
	focus: () => void;
}

interface ParquetFilterBarProps {
	value: string;
	onChange: (value: string) => void;
	columns: ParquetColumnInfo[];
	problem?: ParquetFilterProblem;
	stats?: ParquetScanStats;
	/** True while a scan is running, for the busy affordance. */
	busy: boolean;
	theme: Theme;
}

/** Identifier fragment the caret is currently sitting inside, if any. */
function identifierAtCaret(value: string, caret: number): { text: string; start: number } | null {
	let start = caret;
	while (start > 0 && /[A-Za-z0-9_.]/.test(value[start - 1])) start--;
	if (start === caret) return null;
	const text = value.slice(start, caret);
	// A pure number is a literal, not a half-typed column name.
	return /^[0-9]+$/.test(text) ? null : { text, start };
}

export const ParquetFilterBar = forwardRef<ParquetFilterBarHandle, ParquetFilterBarProps>(
	function ParquetFilterBar({ value, onChange, columns, problem, stats, busy, theme }, ref) {
		const inputRef = useRef<HTMLInputElement>(null);
		useImperativeHandle(ref, () => ({
			focus: () => {
				inputRef.current?.focus();
				inputRef.current?.select();
			},
		}));
		const [caret, setCaret] = useState(0);
		const [showHelp, setShowHelp] = useState(false);
		const [suggestionIndex, setSuggestionIndex] = useState(0);

		const fragment = useMemo(() => identifierAtCaret(value, caret), [value, caret]);
		const suggestions = useMemo(() => {
			if (!fragment) return [];
			const needle = fragment.text.toLowerCase();
			const matches = columns
				.filter((column) => column.name.toLowerCase().includes(needle))
				.sort((a, b) => {
					// Prefix hits first: typing `cus` should offer `customer_id`
					// before `legacy_customer_ref`.
					const aPrefix = a.name.toLowerCase().startsWith(needle) ? 0 : 1;
					const bPrefix = b.name.toLowerCase().startsWith(needle) ? 0 : 1;
					return aPrefix - bPrefix || a.name.length - b.name.length;
				})
				.slice(0, 8);
			// Nothing to offer when the fragment already names a column exactly.
			return matches.length === 1 && matches[0].name.toLowerCase() === needle ? [] : matches;
		}, [fragment, columns]);

		useEffect(() => {
			setSuggestionIndex(0);
		}, [fragment?.text]);

		const applySuggestion = (column: ParquetColumnInfo) => {
			if (!fragment) return;
			const inserted = quoteColumnName(column.name);
			const next = `${value.slice(0, fragment.start)}${inserted}${value.slice(caret)}`;
			onChange(next);
			// Restore the caret after React re-renders with the new value, so the
			// user keeps typing the operator instead of hunting for the end.
			requestAnimationFrame(() => {
				const position = fragment.start + inserted.length;
				inputRef.current?.setSelectionRange(position, position);
				setCaret(position);
				inputRef.current?.focus();
			});
		};

		const syncCaret = () => setCaret(inputRef.current?.selectionStart ?? 0);

		const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
			if (suggestions.length > 0) {
				if (event.key === 'ArrowDown') {
					event.preventDefault();
					setSuggestionIndex((index) => (index + 1) % suggestions.length);
					return;
				}
				if (event.key === 'ArrowUp') {
					event.preventDefault();
					setSuggestionIndex((index) => (index - 1 + suggestions.length) % suggestions.length);
					return;
				}
				if (event.key === 'Tab' || (event.key === 'Enter' && suggestionIndex >= 0)) {
					event.preventDefault();
					applySuggestion(suggestions[suggestionIndex]);
					return;
				}
			}
			if (event.key === 'Escape' && value) {
				// Only reaches here when nothing above has claimed Escape. Inside a
				// registered modal the layer stack takes it at capture on `window`
				// and closes the surface first, which is the app-wide contract; in a
				// file TAB there is no such layer, so clearing the filter is the
				// useful thing to do with the key.
				event.preventDefault();
				event.stopPropagation();
				onChange('');
			}
		};

		const pruned = stats ? stats.rowGroupsPruned : 0;
		const prunedShare = stats && stats.rowGroupsTotal > 0 ? pruned / stats.rowGroupsTotal : 0;

		return (
			<div
				className="relative shrink-0"
				style={{ borderBottom: `1px solid ${theme.colors.border}` }}
			>
				<div className="flex items-center gap-2 px-3 py-2">
					<Filter
						className="w-4 h-4 shrink-0"
						style={{ color: problem ? theme.colors.error : theme.colors.textDim }}
					/>
					<div className="relative flex-1 min-w-0">
						<input
							ref={inputRef}
							type="text"
							value={value}
							onChange={(event) => {
								onChange(event.target.value);
								setCaret(event.target.selectionStart ?? 0);
							}}
							onKeyDown={handleKeyDown}
							onKeyUp={syncCaret}
							onClick={syncCaret}
							onBlur={() => window.setTimeout(() => setSuggestionIndex(-1), 120)}
							placeholder="Filter rows: try  status = active and price > 100"
							spellCheck={false}
							autoComplete="off"
							className="w-full bg-transparent outline-none text-xs"
							style={{
								color: theme.colors.textMain,
								fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
								textDecoration: problem ? 'underline wavy' : 'none',
								textDecorationColor: problem ? theme.colors.error : undefined,
								textUnderlineOffset: '3px',
							}}
							data-testid="parquet-filter-input"
						/>
					</div>
					{busy && (
						<span
							className="text-[11px] shrink-0 animate-pulse"
							style={{ color: theme.colors.textDim }}
						>
							scanning…
						</span>
					)}
					{value && (
						<button
							type="button"
							onClick={() => onChange('')}
							title="Clear filter"
							aria-label="Clear filter"
							className="shrink-0"
						>
							<X className="w-3.5 h-3.5" style={{ color: theme.colors.textDim }} />
						</button>
					)}
					<button
						type="button"
						onClick={() => setShowHelp((open) => !open)}
						title="Filter syntax"
						aria-label="Filter syntax"
						className="shrink-0"
					>
						<HelpCircle
							className="w-4 h-4"
							style={{ color: showHelp ? theme.colors.accent : theme.colors.textDim }}
						/>
					</button>
				</div>

				{/* Parse / bind error, anchored to the span it came from. */}
				{problem && (
					<div
						className="px-3 pb-2 flex items-start gap-2 text-[11px]"
						style={{ color: theme.colors.error }}
						data-testid="parquet-filter-error"
					>
						<AlertCircle className="w-3.5 h-3.5 shrink-0 mt-px" />
						<span className="min-w-0">
							{problem.message}
							{problem.suggestion && (
								<button
									type="button"
									className="ml-2 underline"
									onClick={() =>
										onChange(
											`${value.slice(0, problem.start)}${problem.suggestion}${value.slice(problem.end)}`
										)
									}
								>
									Use "{problem.suggestion}"
								</button>
							)}
						</span>
					</div>
				)}

				{/* Pushdown readout. The number that explains why a filter over a
			    multi-GB file came back instantly. */}
				{!problem && stats && value.trim().length > 0 && (
					<div
						className="px-3 pb-2 flex items-center gap-3 text-[11px] flex-wrap"
						style={{ color: theme.colors.textDim }}
						data-testid="parquet-pushdown-stats"
					>
						{pruned > 0 && (
							<span className="flex items-center gap-1" style={{ color: theme.colors.success }}>
								<Zap className="w-3 h-3" />
								skipped {formatCount(pruned)} of {formatCount(stats.rowGroupsTotal)} row groups
								{prunedShare > 0 ? ` (${Math.round(prunedShare * 100)}%)` : ''}
							</span>
						)}
						<span>read {formatSize(stats.bytesRead)}</span>
						<span>{formatCount(stats.rowsExamined)} rows examined</span>
						<span title="The predicate was fully expressible as parquet-level pruning, so no row-by-row pass was needed to prove it.">
							{stats.fullyPushedDown ? 'fully pushed down' : 'partial pushdown'}
						</span>
					</div>
				)}

				{/* Column completion */}
				{suggestions.length > 0 && suggestionIndex >= 0 && (
					<div
						className="absolute left-9 top-full z-20 rounded shadow-lg overflow-hidden"
						style={{
							backgroundColor: theme.colors.bgActivity,
							border: `1px solid ${theme.colors.border}`,
							minWidth: 260,
						}}
						data-testid="parquet-filter-suggestions"
					>
						{suggestions.map((column, index) => (
							<button
								key={column.name}
								type="button"
								onMouseDown={(event) => event.preventDefault()}
								onClick={() => applySuggestion(column)}
								className="w-full flex items-center justify-between gap-3 px-3 py-1.5 text-xs text-left"
								style={{
									backgroundColor:
										index === suggestionIndex ? `${theme.colors.accent}25` : 'transparent',
									color: theme.colors.textMain,
								}}
							>
								<span className="truncate font-mono">{column.name}</span>
								<span className="shrink-0 text-[10px]" style={{ color: theme.colors.textDim }}>
									{column.logicalType ?? column.physicalType ?? column.kind}
								</span>
							</button>
						))}
					</div>
				)}

				{showHelp && (
					<div
						className="absolute right-3 top-full z-20 rounded shadow-lg p-3 max-w-md"
						style={{
							backgroundColor: theme.colors.bgActivity,
							border: `1px solid ${theme.colors.border}`,
						}}
					>
						<div className="text-xs font-semibold mb-2" style={{ color: theme.colors.textMain }}>
							Filter syntax
						</div>
						<div className="flex flex-col gap-1">
							{SYNTAX_EXAMPLES.map(({ expression, description }) => (
								<button
									key={expression}
									type="button"
									onClick={() => {
										onChange(expression);
										setShowHelp(false);
										inputRef.current?.focus();
									}}
									className="flex items-baseline gap-3 text-left rounded px-1 py-0.5 hover:brightness-125"
								>
									<code
										className="text-[11px] shrink-0 font-mono"
										style={{ color: theme.colors.accent, minWidth: 190 }}
									>
										{expression}
									</code>
									<span className="text-[11px] truncate" style={{ color: theme.colors.textDim }}>
										{description}
									</span>
								</button>
							))}
						</div>
						<div className="mt-2 text-[10px] leading-snug" style={{ color: theme.colors.textDim }}>
							Terms sitting next to each other are combined with <code>and</code>. Comparisons use
							the column's real type, so <code>ts &gt; now-1h</code> compares instants and{' '}
							<code>price &gt; 9.99</code> compares numbers.
						</div>
					</div>
				)}
			</div>
		);
	}
);
