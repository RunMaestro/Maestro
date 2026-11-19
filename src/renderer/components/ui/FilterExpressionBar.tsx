/**
 * FilterExpressionBar - the one input that filters a data viewer's rows.
 *
 * Shared by the Parquet viewer and the SQLite table view, which speak the
 * same filter language (src/shared/parquet/filterExpression.ts) through
 * different engines. The bar knows the language's surface (column names,
 * how a name is quoted, where a problem starts) and nothing about the engine:
 * each viewer passes its own examples, footnote, and a readout below the
 * input (Parquet's pushdown statistics) as `children`.
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

import {
	forwardRef,
	useEffect,
	useImperativeHandle,
	useMemo,
	useRef,
	useState,
	type ReactNode,
} from 'react';
import { AlertCircle, Filter, HelpCircle, X } from 'lucide-react';

import { quoteFilterColumnName } from '../../../shared/parquet/filterExpression';
import type { ParquetFilterProblem } from '../../../shared/parquet/types';
import type { Theme } from '../../types';
import { elevatedSurfaceStyle } from '../../utils/elevatedSurface';
import { isImeComposing } from '../../utils/ime';

/** A column the bar can complete, with the type text shown beside it. */
export interface FilterExpressionColumn {
	name: string;
	/** Short type label in the completion list (`INT64`, `TEXT`). */
	detail?: string;
}

/** One row of the syntax popover: clicking it puts `expression` in the box. */
export interface FilterExpressionExample {
	expression: string;
	description: string;
}

/** Imperative handle so a file preview can route Cmd+F here. */
export interface FilterExpressionBarHandle {
	focus: () => void;
}

interface FilterExpressionBarProps {
	value: string;
	onChange: (value: string) => void;
	columns: readonly FilterExpressionColumn[];
	problem?: ParquetFilterProblem;
	/** True while the engine is working, for the busy affordance. */
	busy: boolean;
	/** Word shown while busy (`scanning…`, `filtering…`). */
	busyLabel: string;
	placeholder: string;
	/** Syntax popover rows, in ascending order of sophistication. */
	examples: readonly FilterExpressionExample[];
	/** Engine-specific note under the examples (how comparisons are typed). */
	footnote?: ReactNode;
	/** Readout under the input, shown only while the box holds a valid filter. */
	children?: ReactNode;
	/** Prefix for test ids: `<prefix>-filter-input`, `-filter-error`, `-filter-suggestions`. */
	testIdPrefix: string;
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

export const FilterExpressionBar = forwardRef<FilterExpressionBarHandle, FilterExpressionBarProps>(
	function FilterExpressionBar(
		{
			value,
			onChange,
			columns,
			problem,
			busy,
			busyLabel,
			placeholder,
			examples,
			footnote,
			children,
			testIdPrefix,
			theme,
		},
		ref
	) {
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

		const applySuggestion = (column: FilterExpressionColumn) => {
			if (!fragment) return;
			const inserted = quoteFilterColumnName(column.name);
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
				if (
					event.key === 'Tab' ||
					(event.key === 'Enter' && suggestionIndex >= 0 && !isImeComposing(event))
				) {
					event.preventDefault();
					applySuggestion(suggestions[suggestionIndex]);
					return;
				}
			}
			if (event.key === 'Escape' && value && !isImeComposing(event)) {
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
							placeholder={placeholder}
							spellCheck={false}
							autoComplete="off"
							className="w-full bg-transparent outline-none text-xs"
							style={{
								color: theme.colors.textMain,
								// A filter expression is code, so this stays a code face - but
								// it follows the user's chosen one (the shared `font-mono`
								// variable) rather than a hard-coded stack.
								fontFamily: 'var(--maestro-font-mono, ui-monospace, SFMono-Regular, monospace)',
								textDecoration: problem ? 'underline wavy' : 'none',
								textDecorationColor: problem ? theme.colors.error : undefined,
								textUnderlineOffset: '3px',
							}}
							data-testid={`${testIdPrefix}-filter-input`}
						/>
					</div>
					{busy && (
						<span
							className="text-xs-plus shrink-0 animate-pulse"
							style={{ color: theme.colors.textDim }}
						>
							{busyLabel}
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
						className="px-3 pb-2 flex items-start gap-2 text-xs-plus"
						style={{ color: theme.colors.error }}
						data-testid={`${testIdPrefix}-filter-error`}
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

				{!problem && value.trim().length > 0 && children}

				{/* Column completion */}
				{suggestions.length > 0 && suggestionIndex >= 0 && (
					<div
						className="absolute left-9 top-full z-20 rounded overflow-hidden"
						style={{
							...elevatedSurfaceStyle(theme),
							minWidth: 260,
						}}
						data-testid={`${testIdPrefix}-filter-suggestions`}
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
								{column.detail && (
									<span className="shrink-0 text-2xs" style={{ color: theme.colors.textDim }}>
										{column.detail}
									</span>
								)}
							</button>
						))}
					</div>
				)}

				{showHelp && (
					<div
						className="absolute right-3 top-full z-20 rounded p-3 max-w-md"
						style={{
							...elevatedSurfaceStyle(theme),
						}}
					>
						<div className="text-xs font-semibold mb-2" style={{ color: theme.colors.textMain }}>
							Filter syntax
						</div>
						<div className="flex flex-col gap-1">
							{examples.map(({ expression, description }) => (
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
										className="text-xs-plus shrink-0 font-mono"
										style={{ color: theme.colors.accent, minWidth: 190 }}
									>
										{expression}
									</code>
									<span className="text-xs-plus truncate" style={{ color: theme.colors.textDim }}>
										{description}
									</span>
								</button>
							))}
						</div>
						{footnote && (
							<div className="mt-2 text-2xs leading-snug" style={{ color: theme.colors.textDim }}>
								{footnote}
							</div>
						)}
					</div>
				)}
			</div>
		);
	}
);
