import { useState, useMemo, useCallback, useEffect, useRef, memo } from 'react';
import {
	ChevronRight,
	ChevronDown,
	Copy,
	Check,
	Filter,
	X,
	ChevronUp,
	List,
	Table2,
} from 'lucide-react';
import type { Theme } from '../types';
import { CollapsibleJsonViewer } from './CollapsibleJsonViewer';
import { parseJq, evaluateJq, JqError } from '../utils/jqFilter';
import type { JqExpr } from '../utils/jqFilter';
import { useDebouncedValue } from '../hooks/utils/useThrottle';
import { safeClipboardWrite } from '../utils/clipboard';

interface JsonlViewerProps {
	content: string;
	theme: Theme;
	searchQuery?: string;
	onMatchCount?: (count: number) => void;
}

interface ParsedLine {
	index: number;
	raw: string;
	data: unknown;
	error: string | null;
}

interface FilteredLine {
	line: ParsedLine;
	results: unknown[] | null;
}

type ViewMode = 'tree' | 'table';
type SortDirection = 'asc' | 'desc';
interface SortState {
	column: string;
	direction: SortDirection;
}

const MAX_DISPLAY_LINES = 500;
const FILTER_DEBOUNCE_MS = 200;
const SCHEMA_SAMPLE_SIZE = 50;
const TABLE_SCHEMA_THRESHOLD = 0.6;

// ── JSONL parsing ────────────────────────────────────────────────────────────

function parseJsonlLines(content: string): ParsedLine[] {
	const lines: ParsedLine[] = [];
	const rawLines = content.split('\n');
	for (let i = 0; i < rawLines.length; i++) {
		const raw = rawLines[i].trim();
		if (raw === '') continue;
		try {
			lines.push({ index: i + 1, raw, data: JSON.parse(raw), error: null });
		} catch (e) {
			lines.push({
				index: i + 1,
				raw,
				data: null,
				error: e instanceof Error ? e.message : 'Invalid JSON',
			});
		}
	}
	return lines;
}

function applyFilter(lines: ParsedLine[], expr: JqExpr | null): FilteredLine[] {
	if (!expr) {
		return lines.map((line) => ({ line, results: null }));
	}
	const out: FilteredLine[] = [];
	for (const line of lines) {
		if (line.error) continue;
		try {
			const results = evaluateJq(expr, line.data);
			if (results.length > 0) {
				out.push({ line, results });
			}
		} catch {
			// Filter evaluation error — skip line
		}
	}
	return out;
}

// ── Schema detection for table view ──────────────────────────────────────────

interface SchemaInfo {
	columns: string[];
	isTabular: boolean;
}

function detectSchema(lines: FilteredLine[]): SchemaInfo {
	const sample = lines.slice(0, SCHEMA_SAMPLE_SIZE);
	const objectLines = sample.filter((fl) => {
		const data = getDisplayData(fl);
		return data !== null && typeof data === 'object' && !Array.isArray(data);
	});

	if (objectLines.length === 0 || objectLines.length / sample.length < TABLE_SCHEMA_THRESHOLD) {
		return { columns: [], isTabular: false };
	}

	const keyCounts = new Map<string, number>();
	for (const fl of objectLines) {
		const data = getDisplayData(fl) as Record<string, unknown>;
		for (const key of Object.keys(data)) {
			keyCounts.set(key, (keyCounts.get(key) || 0) + 1);
		}
	}

	const columns = Array.from(keyCounts.entries())
		.filter(([, count]) => count / objectLines.length >= TABLE_SCHEMA_THRESHOLD)
		.sort((a, b) => b[1] - a[1])
		.map(([key]) => key);

	return { columns, isTabular: columns.length >= 2 };
}

function getDisplayData(fl: FilteredLine): unknown {
	return fl.results !== null
		? fl.results.length === 1
			? fl.results[0]
			: fl.results
		: fl.line.data;
}

// ── Inline value renderer for collapsed one-liners ───────────────────────────

function formatPreview(value: unknown, maxLen: number): string {
	const s = JSON.stringify(value);
	if (s === undefined) return 'undefined';
	if (s.length <= maxLen) return s;
	return s.substring(0, maxLen) + '…';
}

function formatCellValue(value: unknown): string {
	if (value === null || value === undefined) return '';
	if (typeof value === 'string') return value;
	if (typeof value === 'number' || typeof value === 'boolean') return String(value);
	return JSON.stringify(value);
}

function isNumericColumn(lines: FilteredLine[], column: string): boolean {
	let numCount = 0;
	let totalCount = 0;
	const sample = lines.slice(0, 100);
	for (const fl of sample) {
		const data = getDisplayData(fl);
		if (data !== null && typeof data === 'object' && !Array.isArray(data)) {
			const val = (data as Record<string, unknown>)[column];
			if (val !== null && val !== undefined && val !== '') {
				totalCount++;
				if (typeof val === 'number') numCount++;
			}
		}
	}
	return totalCount > 0 && numCount / totalCount > 0.5;
}

// ── Copy button ──────────────────────────────────────────────────────────────

const CopyLineButton = memo(({ value, theme }: { value: unknown; theme: Theme }) => {
	const [copied, setCopied] = useState(false);
	const handleCopy = useCallback(
		async (e: React.MouseEvent) => {
			e.stopPropagation();
			const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
			const ok = await safeClipboardWrite(text);
			if (ok) {
				setCopied(true);
				setTimeout(() => setCopied(false), 1500);
			}
		},
		[value]
	);

	return (
		<button
			onClick={handleCopy}
			className="p-0.5 rounded opacity-0 group-hover/line:opacity-50 hover:!opacity-100 transition-opacity"
			style={{ color: theme.colors.textDim }}
			title="Copy line"
		>
			{copied ? (
				<Check className="w-3.5 h-3.5" style={{ color: theme.colors.success }} />
			) : (
				<Copy className="w-3.5 h-3.5" />
			)}
		</button>
	);
});
CopyLineButton.displayName = 'CopyLineButton';

// ── Single JSONL tree row ────────────────────────────────────────────────────

interface JsonlRowProps {
	filteredLine: FilteredLine;
	theme: Theme;
	isExpanded: boolean;
	onToggle: () => void;
}

const JsonlRow = memo(({ filteredLine, theme, isExpanded, onToggle }: JsonlRowProps) => {
	const { line } = filteredLine;
	const displayData = getDisplayData(filteredLine);
	const isError = line.error !== null;

	return (
		<div style={{ borderBottom: `1px solid ${theme.colors.border}30` }}>
			<div
				className="group/line flex items-center gap-2 px-3 py-1.5 cursor-pointer hover:bg-white/5 transition-colors"
				onClick={onToggle}
			>
				<span
					className="flex-shrink-0 text-right select-none"
					style={{
						color: theme.colors.textDim,
						fontSize: '11px',
						minWidth: '36px',
						fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
					}}
				>
					{line.index}
				</span>
				<span
					className="flex-shrink-0 w-4 h-4 flex items-center justify-center"
					style={{ color: theme.colors.textDim }}
				>
					{isError ? null : isExpanded ? (
						<ChevronDown className="w-3 h-3" />
					) : (
						<ChevronRight className="w-3 h-3" />
					)}
				</span>
				<span
					className="flex-1 truncate"
					style={{
						fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
						fontSize: '12px',
						color: isError ? theme.colors.error : theme.colors.textMain,
					}}
				>
					{isError ? (
						<>
							<span style={{ color: theme.colors.error }}>Parse error: </span>
							<span style={{ color: theme.colors.textDim }}>{line.raw.substring(0, 120)}</span>
						</>
					) : (
						formatPreview(displayData, 200)
					)}
				</span>
				{!isError && <CopyLineButton value={displayData} theme={theme} />}
			</div>
			{isExpanded && !isError && (
				<div className="pl-14 pr-3 pb-2">
					<CollapsibleJsonViewer
						data={displayData}
						theme={theme}
						initialExpandLevel={3}
						maxStringLength={200}
					/>
				</div>
			)}
		</div>
	);
});
JsonlRow.displayName = 'JsonlRow';

// ── Table view ───────────────────────────────────────────────────────────────

interface JsonlTableProps {
	lines: FilteredLine[];
	columns: string[];
	theme: Theme;
	onRowClick: (lineIndex: number) => void;
	expandedLine: number | null;
}

const JsonlTable = memo(({ lines, columns, theme, onRowClick, expandedLine }: JsonlTableProps) => {
	const [sort, setSort] = useState<SortState | null>(null);

	const numericColumns = useMemo(() => {
		const result = new Set<string>();
		for (const col of columns) {
			if (isNumericColumn(lines, col)) result.add(col);
		}
		return result;
	}, [lines, columns]);

	const sortedLines = useMemo(() => {
		if (!sort) return lines;
		return [...lines].sort((a, b) => {
			const aData = getDisplayData(a);
			const bData = getDisplayData(b);
			const aVal =
				aData !== null && typeof aData === 'object' && !Array.isArray(aData)
					? (aData as Record<string, unknown>)[sort.column]
					: null;
			const bVal =
				bData !== null && typeof bData === 'object' && !Array.isArray(bData)
					? (bData as Record<string, unknown>)[sort.column]
					: null;

			if (aVal == null && bVal == null) return 0;
			if (aVal == null) return 1;
			if (bVal == null) return -1;

			if (typeof aVal === 'number' && typeof bVal === 'number') {
				return sort.direction === 'asc' ? aVal - bVal : bVal - aVal;
			}
			const cmp = String(aVal).localeCompare(String(bVal), undefined, { sensitivity: 'base' });
			return sort.direction === 'asc' ? cmp : -cmp;
		});
	}, [lines, sort]);

	const handleHeaderClick = useCallback((column: string) => {
		setSort((prev) => {
			if (prev?.column === column) {
				return prev.direction === 'asc' ? { column, direction: 'desc' } : null;
			}
			return { column, direction: 'asc' };
		});
	}, []);

	return (
		<div style={{ padding: '16px' }}>
			<div
				className="overflow-x-auto rounded"
				style={{ border: `1px solid ${theme.colors.border}` }}
			>
				<table
					className="w-full"
					style={{
						borderCollapse: 'collapse',
						fontSize: '13px',
						fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
					}}
				>
					<thead>
						<tr>
							<th
								style={{
									padding: '8px 12px',
									textAlign: 'right',
									backgroundColor: theme.colors.bgActivity,
									borderBottom: `2px solid ${theme.colors.border}`,
									borderRight: `1px solid ${theme.colors.border}`,
									color: theme.colors.textDim,
									fontWeight: 'normal',
									fontSize: '11px',
									position: 'sticky',
									top: 0,
									userSelect: 'none',
									minWidth: '48px',
									zIndex: 1,
								}}
							>
								#
							</th>
							{columns.map((col, i) => (
								<th
									key={col}
									onClick={() => handleHeaderClick(col)}
									style={{
										padding: '8px 12px',
										textAlign: numericColumns.has(col) ? 'right' : 'left',
										backgroundColor:
											sort?.column === col ? theme.colors.accent + '20' : theme.colors.bgActivity,
										borderBottom: `2px solid ${theme.colors.border}`,
										borderRight:
											i < columns.length - 1 ? `1px solid ${theme.colors.border}` : undefined,
										color: theme.colors.textMain,
										fontWeight: 600,
										cursor: 'pointer',
										position: 'sticky',
										top: 0,
										userSelect: 'none',
										whiteSpace: 'nowrap',
										zIndex: 1,
									}}
								>
									<span className="inline-flex items-center gap-1">
										{col}
										{sort?.column === col &&
											(sort.direction === 'asc' ? (
												<ChevronUp
													className="w-3 h-3 inline-block"
													style={{ color: theme.colors.accent }}
												/>
											) : (
												<ChevronDown
													className="w-3 h-3 inline-block"
													style={{ color: theme.colors.accent }}
												/>
											))}
									</span>
								</th>
							))}
						</tr>
					</thead>
					<tbody>
						{sortedLines.map((fl, rowIdx) => {
							const data = getDisplayData(fl);
							const isObj = data !== null && typeof data === 'object' && !Array.isArray(data);
							const record = isObj ? (data as Record<string, unknown>) : null;
							const isExpanded = expandedLine === fl.line.index;

							return (
								<>
									<tr
										key={fl.line.index}
										onClick={() => onRowClick(fl.line.index)}
										style={{
											backgroundColor:
												rowIdx % 2 === 0 ? 'transparent' : theme.colors.bgActivity + '60',
											cursor: 'pointer',
										}}
										className="hover:brightness-110 transition-[filter] duration-75"
									>
										<td
											style={{
												padding: '6px 12px',
												textAlign: 'right',
												borderRight: `1px solid ${theme.colors.border}`,
												color: theme.colors.textDim,
												fontSize: '11px',
												userSelect: 'none',
											}}
										>
											<span className="inline-flex items-center gap-1">
												<span
													className="w-3 h-3 flex items-center justify-center"
													style={{ color: theme.colors.textDim }}
												>
													{isExpanded ? (
														<ChevronDown className="w-2.5 h-2.5" />
													) : (
														<ChevronRight className="w-2.5 h-2.5" />
													)}
												</span>
												{fl.line.index}
											</span>
										</td>
										{columns.map((col, colIdx) => {
											const val = record ? record[col] : null;
											const cellText = formatCellValue(val);
											const isNested = val !== null && typeof val === 'object';
											return (
												<td
													key={col}
													style={{
														padding: '6px 12px',
														textAlign: numericColumns.has(col) ? 'right' : 'left',
														borderRight:
															colIdx < columns.length - 1
																? `1px solid ${theme.colors.border}`
																: undefined,
														color: isNested
															? theme.colors.textDim
															: val === null || val === undefined
																? theme.colors.textDim
																: theme.colors.textMain,
														whiteSpace: 'nowrap',
														maxWidth: '400px',
														overflow: 'hidden',
														textOverflow: 'ellipsis',
														fontStyle: isNested ? 'italic' : undefined,
													}}
													title={cellText}
												>
													{cellText || '\u00A0'}
												</td>
											);
										})}
									</tr>
									{isExpanded && (
										<tr key={`${fl.line.index}-detail`}>
											<td
												colSpan={columns.length + 1}
												style={{
													padding: '8px 16px 12px 56px',
													backgroundColor: theme.colors.bgActivity + '30',
												}}
											>
												<CollapsibleJsonViewer
													data={data}
													theme={theme}
													initialExpandLevel={3}
													maxStringLength={200}
												/>
											</td>
										</tr>
									)}
								</>
							);
						})}
					</tbody>
				</table>
			</div>
		</div>
	);
});
JsonlTable.displayName = 'JsonlTable';

// ── Syntax help popover ──────────────────────────────────────────────────────

const SYNTAX_EXAMPLES = [
	{ expr: '.', desc: 'Identity (show full object)' },
	{ expr: '.fieldName', desc: 'Extract a field' },
	{ expr: '.foo.bar', desc: 'Nested field access' },
	{ expr: '.[0]', desc: 'Array index' },
	{ expr: '.[]', desc: 'Iterate all elements' },
	{ expr: 'select(.type == "error")', desc: 'Filter by field value' },
	{ expr: 'select(.msg | contains("fail"))', desc: 'Filter by substring' },
	{ expr: 'select(.status >= 400)', desc: 'Numeric comparison' },
	{ expr: 'select(.a and .b)', desc: 'Boolean AND' },
	{ expr: '.timestamp, .message', desc: 'Multiple fields' },
	{ expr: 'keys', desc: 'Show object keys' },
	{ expr: 'length', desc: 'Object/array/string length' },
	{ expr: 'has("field")', desc: 'Check field existence' },
	{ expr: '.msg | test("err.*")', desc: 'Regex match' },
	{ expr: '.items | sort_by(.name)', desc: 'Sort array by key' },
	{ expr: '.tags | unique', desc: 'Deduplicate array' },
];

function SyntaxHelp({ theme, onInsert }: { theme: Theme; onInsert: (expr: string) => void }) {
	return (
		<div
			className="absolute top-full left-0 right-0 mt-1 rounded-lg shadow-xl overflow-hidden z-50"
			style={{
				backgroundColor: theme.colors.bgSidebar,
				border: `1px solid ${theme.colors.border}`,
			}}
		>
			<div
				className="px-3 py-2 text-xs font-medium"
				style={{ color: theme.colors.textDim, borderBottom: `1px solid ${theme.colors.border}` }}
			>
				jq Filter Syntax
			</div>
			<div className="max-h-64 overflow-y-auto scrollbar-thin">
				{SYNTAX_EXAMPLES.map(({ expr, desc }) => (
					<button
						key={expr}
						className="w-full flex items-center gap-3 px-3 py-1.5 text-left hover:bg-white/5 transition-colors"
						onClick={() => onInsert(expr)}
					>
						<code
							className="flex-shrink-0 px-1.5 py-0.5 rounded text-xs"
							style={{
								backgroundColor: theme.colors.accent + '20',
								color: theme.colors.accent,
								fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
							}}
						>
							{expr}
						</code>
						<span className="text-xs truncate" style={{ color: theme.colors.textDim }}>
							{desc}
						</span>
					</button>
				))}
			</div>
		</div>
	);
}

// ── View mode toggle ─────────────────────────────────────────────────────────

function ViewModeToggle({
	mode,
	onToggle,
	isTabular,
	theme,
}: {
	mode: ViewMode;
	onToggle: (m: ViewMode) => void;
	isTabular: boolean;
	theme: Theme;
}) {
	return (
		<div
			className="flex items-center rounded-md overflow-hidden"
			style={{ border: `1px solid ${theme.colors.border}` }}
		>
			<button
				onClick={() => onToggle('tree')}
				className="flex items-center gap-1 px-2 py-1 text-xs transition-colors"
				style={{
					backgroundColor: mode === 'tree' ? theme.colors.accent + '20' : 'transparent',
					color: mode === 'tree' ? theme.colors.accent : theme.colors.textDim,
					borderRight: `1px solid ${theme.colors.border}`,
				}}
				title="Tree view"
			>
				<List className="w-3 h-3" />
				Tree
			</button>
			<button
				onClick={() => onToggle('table')}
				className="flex items-center gap-1 px-2 py-1 text-xs transition-colors"
				style={{
					backgroundColor: mode === 'table' ? theme.colors.accent + '20' : 'transparent',
					color: mode === 'table' ? theme.colors.accent : theme.colors.textDim,
					opacity: isTabular ? 1 : 0.4,
				}}
				title={isTabular ? 'Table view' : 'Table view (rows lack shared structure)'}
				disabled={!isTabular}
			>
				<Table2 className="w-3 h-3" />
				Table
			</button>
		</div>
	);
}

// ── Main component ───────────────────────────────────────────────────────────

export function JsonlViewer({ content, theme, searchQuery, onMatchCount }: JsonlViewerProps) {
	const [filterText, setFilterText] = useState('');
	const [expandedLines, setExpandedLines] = useState<Set<number>>(new Set());
	const [expandedTableLine, setExpandedTableLine] = useState<number | null>(null);
	const [showHelp, setShowHelp] = useState(false);
	const [viewModeOverride, setViewModeOverride] = useState<ViewMode | null>(null);
	const filterInputRef = useRef<HTMLInputElement>(null);
	const helpRef = useRef<HTMLDivElement>(null);

	const debouncedFilter = useDebouncedValue(filterText, FILTER_DEBOUNCE_MS);

	// Parse all lines
	const allLines = useMemo(() => parseJsonlLines(content), [content]);
	const parseErrors = useMemo(() => allLines.filter((l) => l.error !== null).length, [allLines]);

	// Parse and apply filter
	const { filteredLines, filterError } = useMemo(() => {
		const trimmed = debouncedFilter.trim();
		if (!trimmed) {
			return { filteredLines: applyFilter(allLines, null), filterError: null };
		}
		try {
			const expr = parseJq(trimmed);
			return { filteredLines: applyFilter(allLines, expr), filterError: null };
		} catch (e) {
			return {
				filteredLines: applyFilter(allLines, null),
				filterError: e instanceof JqError ? e.message : String(e),
			};
		}
	}, [allLines, debouncedFilter]);

	// Text search within filtered results
	const textSearchFiltered = useMemo(() => {
		const q = searchQuery?.trim().toLowerCase();
		if (!q) return filteredLines;
		return filteredLines.filter((fl) => {
			const raw = fl.line.raw.toLowerCase();
			if (raw.includes(q)) return true;
			if (fl.results) {
				return JSON.stringify(fl.results).toLowerCase().includes(q);
			}
			return false;
		});
	}, [filteredLines, searchQuery]);

	// Schema detection for table view
	const schema = useMemo(() => detectSchema(textSearchFiltered), [textSearchFiltered]);

	// Default to table when rows have shared structure
	const viewMode = viewModeOverride ?? (schema.isTabular ? 'table' : 'tree');

	const isTruncated = textSearchFiltered.length > MAX_DISPLAY_LINES;
	const displayLines = isTruncated
		? textSearchFiltered.slice(0, MAX_DISPLAY_LINES)
		: textSearchFiltered;

	// Report match count
	useEffect(() => {
		onMatchCount?.(searchQuery?.trim() ? textSearchFiltered.length : 0);
	}, [textSearchFiltered.length, searchQuery, onMatchCount]);

	// Close help on outside click
	useEffect(() => {
		if (!showHelp) return;
		const handler = (e: MouseEvent) => {
			if (helpRef.current && !helpRef.current.contains(e.target as Node)) {
				setShowHelp(false);
			}
		};
		document.addEventListener('mousedown', handler);
		return () => document.removeEventListener('mousedown', handler);
	}, [showHelp]);

	const toggleLine = useCallback((lineIndex: number) => {
		setExpandedLines((prev) => {
			const next = new Set(prev);
			if (next.has(lineIndex)) {
				next.delete(lineIndex);
			} else {
				next.add(lineIndex);
			}
			return next;
		});
	}, []);

	const toggleTableRow = useCallback((lineIndex: number) => {
		setExpandedTableLine((prev) => (prev === lineIndex ? null : lineIndex));
	}, []);

	const expandAll = useCallback(() => {
		setExpandedLines(
			new Set(displayLines.filter((fl) => !fl.line.error).map((fl) => fl.line.index))
		);
	}, [displayLines]);

	const collapseAll = useCallback(() => {
		setExpandedLines(new Set());
		setExpandedTableLine(null);
	}, []);

	const handleInsertSyntax = useCallback((expr: string) => {
		setFilterText(expr);
		setShowHelp(false);
		filterInputRef.current?.focus();
	}, []);

	const handleFilterKeyDown = useCallback(
		(e: React.KeyboardEvent) => {
			if (e.key === 'Escape') {
				if (filterText) {
					setFilterText('');
				} else {
					(e.target as HTMLInputElement).blur();
				}
				e.stopPropagation();
			}
		},
		[filterText]
	);

	return (
		<div className="flex flex-col h-full">
			{/* Filter bar */}
			<div className="flex-shrink-0 px-4 pt-3 pb-2" ref={helpRef}>
				<div className="relative">
					<div
						className="flex items-center gap-2 rounded-lg px-3 py-2"
						style={{
							backgroundColor: theme.colors.bgActivity,
							border: `1px solid ${filterError ? theme.colors.error + '80' : filterText ? theme.colors.accent + '60' : theme.colors.border}`,
						}}
					>
						<Filter
							className="w-3.5 h-3.5 flex-shrink-0"
							style={{ color: filterText ? theme.colors.accent : theme.colors.textDim }}
						/>
						<input
							ref={filterInputRef}
							type="text"
							value={filterText}
							onChange={(e) => setFilterText(e.target.value)}
							onKeyDown={handleFilterKeyDown}
							onFocus={() => !filterText && setShowHelp(true)}
							placeholder='jq filter — .field, select(.x == "y"), keys, contains("...")'
							className="flex-1 bg-transparent outline-none text-xs"
							style={{
								color: theme.colors.textMain,
								fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
							}}
							spellCheck={false}
						/>
						{filterText && (
							<button
								onClick={() => {
									setFilterText('');
									filterInputRef.current?.focus();
								}}
								className="p-0.5 rounded hover:bg-white/10 transition-colors"
								style={{ color: theme.colors.textDim }}
							>
								<X className="w-3.5 h-3.5" />
							</button>
						)}
						<button
							onClick={() => setShowHelp((p) => !p)}
							className="px-1.5 py-0.5 rounded text-xs hover:bg-white/10 transition-colors"
							style={{ color: theme.colors.textDim }}
							title="Show syntax help"
						>
							?
						</button>
					</div>
					{filterError && (
						<div className="mt-1 px-2 py-1 rounded text-xs" style={{ color: theme.colors.error }}>
							{filterError}
						</div>
					)}
					{showHelp && <SyntaxHelp theme={theme} onInsert={handleInsertSyntax} />}
				</div>
			</div>

			{/* Toolbar */}
			<div
				className="flex-shrink-0 flex items-center gap-3 px-4 py-1.5"
				style={{ borderBottom: `1px solid ${theme.colors.border}` }}
			>
				<span className="text-xs" style={{ color: theme.colors.textDim }}>
					{debouncedFilter.trim()
						? `${textSearchFiltered.length.toLocaleString()} of ${allLines.length.toLocaleString()} lines`
						: `${allLines.length.toLocaleString()} lines`}
					{parseErrors > 0 && (
						<span style={{ color: theme.colors.warning }}>
							{' '}
							({parseErrors} parse error{parseErrors !== 1 ? 's' : ''})
						</span>
					)}
					{viewMode === 'table' && schema.columns.length > 0 && (
						<span> × {schema.columns.length} columns</span>
					)}
				</span>
				<div className="flex-1" />

				{/* View mode toggle */}
				<ViewModeToggle
					mode={viewMode}
					onToggle={setViewModeOverride}
					isTabular={schema.isTabular}
					theme={theme}
				/>

				{/* Expand/Collapse (tree mode only) */}
				{viewMode === 'tree' && (
					<>
						<button
							onClick={expandAll}
							className="flex items-center gap-1 px-2 py-0.5 rounded text-xs hover:bg-white/10 transition-colors"
							style={{ color: theme.colors.textDim }}
							title="Expand all"
						>
							<ChevronDown className="w-3 h-3" />
							Expand
						</button>
						<button
							onClick={collapseAll}
							className="flex items-center gap-1 px-2 py-0.5 rounded text-xs hover:bg-white/10 transition-colors"
							style={{ color: theme.colors.textDim }}
							title="Collapse all"
						>
							<ChevronUp className="w-3 h-3" />
							Collapse
						</button>
					</>
				)}
			</div>

			{/* Truncation warning */}
			{isTruncated && (
				<div
					className="flex-shrink-0 px-4 py-2 flex items-center gap-2 text-sm"
					style={{
						backgroundColor: theme.colors.warning + '20',
						border: `1px solid ${theme.colors.warning}40`,
						color: theme.colors.warning,
					}}
				>
					Showing {MAX_DISPLAY_LINES.toLocaleString()} of{' '}
					{textSearchFiltered.length.toLocaleString()}
					{debouncedFilter.trim() ? ' matching' : ''} lines
				</div>
			)}

			{/* Content area */}
			<div className="flex-1 overflow-auto scrollbar-thin">
				{displayLines.length === 0 ? (
					<div
						className="flex items-center justify-center h-32 text-sm"
						style={{ color: theme.colors.textDim }}
					>
						{debouncedFilter.trim() ? 'No lines match filter' : 'Empty JSONL file'}
					</div>
				) : viewMode === 'table' ? (
					<JsonlTable
						lines={displayLines}
						columns={schema.columns}
						theme={theme}
						onRowClick={toggleTableRow}
						expandedLine={expandedTableLine}
					/>
				) : (
					displayLines.map((fl) => (
						<JsonlRow
							key={fl.line.index}
							filteredLine={fl}
							theme={theme}
							isExpanded={expandedLines.has(fl.line.index)}
							onToggle={() => toggleLine(fl.line.index)}
						/>
					))
				)}
			</div>
		</div>
	);
}
