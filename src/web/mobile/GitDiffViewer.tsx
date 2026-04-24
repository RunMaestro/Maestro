/**
 * GitDiffViewer component for Maestro mobile web interface
 *
 * Displays a parsed unified diff in one of two view modes:
 *   - `unified` — a single column (old and new changes interleaved)
 *   - `split`   — two columns side-by-side (old on the left, new on the right)
 *
 * The user's choice is persisted globally via localStorage. If no preference
 * has been saved, the initial mode is picked by viewport tier: `unified` on
 * phones, `split` on tablet and desktop.
 */

import { useCallback, useMemo, useState } from 'react';
import { useThemeColors } from '../components/ThemeProvider';
import { useBreakpoint } from '../hooks/useBreakpoint';
import { triggerHaptic, HAPTIC_PATTERNS } from './constants';

export interface GitDiffViewerProps {
	diff: string;
	filePath: string;
	onBack: () => void;
}

export type DiffViewMode = 'unified' | 'split';

/**
 * localStorage key for the user's persisted diff view-mode preference.
 * Kept flat (not namespaced into the view-state blob) because this is a
 * long-lived UI preference that shouldn't be subject to the staleness check
 * used by `viewState.ts`.
 */
export const DIFF_VIEW_MODE_STORAGE_KEY = 'maestro-web-diff-view-mode';

interface DiffLine {
	content: string;
	type: 'add' | 'remove' | 'hunk' | 'context';
	oldNum: string;
	newNum: string;
}

type SplitRow =
	| { kind: 'hunk'; content: string }
	| {
			kind: 'pair';
			left: SplitCell;
			right: SplitCell;
	  };

interface SplitCell {
	content: string;
	num: string;
	type: 'context' | 'add' | 'remove' | 'empty';
}

/**
 * Read the saved view-mode preference. Returns `null` when the user hasn't
 * made a choice yet (so the caller can apply a tier-based default).
 */
export function loadDiffViewMode(): DiffViewMode | null {
	try {
		const stored = localStorage.getItem(DIFF_VIEW_MODE_STORAGE_KEY);
		if (stored === 'unified' || stored === 'split') return stored;
	} catch {
		/* localStorage unavailable (e.g. Safari private mode) — fall through */
	}
	return null;
}

function saveDiffViewMode(mode: DiffViewMode): void {
	try {
		localStorage.setItem(DIFF_VIEW_MODE_STORAGE_KEY, mode);
	} catch {
		/* ignore localStorage write errors */
	}
}

/**
 * Parse a unified diff string into typed lines with line numbers.
 */
function parseDiffLines(diff: string): DiffLine[] {
	const rawLines = diff.split('\n');
	const result: DiffLine[] = [];

	let oldLine = 0;
	let newLine = 0;

	for (const line of rawLines) {
		if (line.startsWith('@@')) {
			// Parse hunk header: @@ -oldStart,oldCount +newStart,newCount @@
			const match = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
			if (match) {
				oldLine = parseInt(match[1], 10);
				newLine = parseInt(match[2], 10);
			}
			result.push({ content: line, type: 'hunk', oldNum: '', newNum: '' });
		} else if (line.startsWith('+')) {
			result.push({ content: line, type: 'add', oldNum: '', newNum: String(newLine) });
			newLine++;
		} else if (line.startsWith('-')) {
			result.push({ content: line, type: 'remove', oldNum: String(oldLine), newNum: '' });
			oldLine++;
		} else {
			// Context line (or diff header lines before first hunk)
			const isBeforeFirstHunk = oldLine === 0 && newLine === 0;
			if (isBeforeFirstHunk) {
				result.push({ content: line, type: 'context', oldNum: '', newNum: '' });
			} else {
				result.push({
					content: line,
					type: 'context',
					oldNum: String(oldLine),
					newNum: String(newLine),
				});
				oldLine++;
				newLine++;
			}
		}
	}

	return result;
}

/**
 * Transpose a flat list of diff lines into row-aligned split-view rows.
 *
 * Rules:
 *   - Hunk headers get their own full-width row.
 *   - Context lines appear on both sides, same content, with matched numbers.
 *   - A contiguous run of `-` followed by `+` is paired one-to-one; any
 *     imbalance produces empty cells on the unpaired side.
 */
function buildSplitRows(lines: DiffLine[]): SplitRow[] {
	const rows: SplitRow[] = [];
	let i = 0;

	while (i < lines.length) {
		const line = lines[i];

		if (line.type === 'hunk') {
			rows.push({ kind: 'hunk', content: line.content });
			i++;
			continue;
		}

		if (line.type === 'context') {
			rows.push({
				kind: 'pair',
				left: { content: line.content, num: line.oldNum, type: 'context' },
				right: { content: line.content, num: line.newNum, type: 'context' },
			});
			i++;
			continue;
		}

		// Collect a run of removes then a run of adds, and pair them.
		const removes: DiffLine[] = [];
		while (i < lines.length && lines[i].type === 'remove') {
			removes.push(lines[i]);
			i++;
		}
		const adds: DiffLine[] = [];
		while (i < lines.length && lines[i].type === 'add') {
			adds.push(lines[i]);
			i++;
		}

		const pairCount = Math.max(removes.length, adds.length);
		// If neither removes nor adds matched (defensive — shouldn't happen with
		// the parser above), bail out on this line to avoid an infinite loop.
		if (pairCount === 0) {
			i++;
			continue;
		}

		for (let j = 0; j < pairCount; j++) {
			const r = removes[j];
			const a = adds[j];
			rows.push({
				kind: 'pair',
				left: r
					? { content: r.content, num: r.oldNum, type: 'remove' }
					: { content: '', num: '', type: 'empty' },
				right: a
					? { content: a.content, num: a.newNum, type: 'add' }
					: { content: '', num: '', type: 'empty' },
			});
		}
	}

	return rows;
}

export function GitDiffViewer({ diff, filePath, onBack }: GitDiffViewerProps) {
	const colors = useThemeColors();
	const { isPhone } = useBreakpoint();

	const lines = useMemo(() => parseDiffLines(diff), [diff]);
	const splitRows = useMemo(() => buildSplitRows(lines), [lines]);

	// Initial mode: stored preference wins. Otherwise, phone → unified,
	// tablet/desktop → split. Captured once on mount so width changes after
	// the fact don't override a user-selected mode.
	const [viewMode, setViewMode] = useState<DiffViewMode>(() => {
		const stored = loadDiffViewMode();
		if (stored) return stored;
		return isPhone ? 'unified' : 'split';
	});

	const handleViewModeChange = useCallback((mode: DiffViewMode) => {
		triggerHaptic(HAPTIC_PATTERNS.tap);
		setViewMode(mode);
		saveDiffViewMode(mode);
	}, []);

	// Determine max line number width for gutter sizing (shared across modes).
	const maxNumWidth = useMemo(() => {
		let max = 0;
		for (const line of lines) {
			const oldLen = line.oldNum.length;
			const newLen = line.newNum.length;
			if (oldLen > max) max = oldLen;
			if (newLen > max) max = newLen;
		}
		return Math.max(max, 1);
	}, [lines]);

	const gutterWidth = `${maxNumWidth}ch`;

	function lineBackground(type: DiffLine['type'] | 'empty'): string {
		switch (type) {
			case 'add':
				return `${colors.success}26`;
			case 'remove':
				return `${colors.error}26`;
			case 'hunk':
				return `${colors.accent}1a`;
			case 'empty':
				return `${colors.border}33`;
			default:
				return 'transparent';
		}
	}

	function lineColor(type: DiffLine['type'] | 'empty'): string {
		switch (type) {
			case 'hunk':
				return colors.accent;
			default:
				return colors.textMain;
		}
	}

	const hasDiff = diff.trim() !== '';

	return (
		<div className="flex flex-col h-full bg-bg-main">
			{/* Header */}
			<div className="flex items-center gap-[8px] px-[12px] py-[10px] border-b border-border bg-bg-sidebar flex-shrink-0">
				<button
					onClick={() => {
						triggerHaptic(HAPTIC_PATTERNS.tap);
						onBack();
					}}
					className="w-[36px] h-[36px] flex items-center justify-center rounded-lg border border-border bg-bg-main text-text-main cursor-pointer flex-shrink-0 [touch-action:manipulation] [-webkit-tap-highlight-color:transparent]"
					aria-label="Back"
				>
					<svg
						width="16"
						height="16"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						strokeWidth="2"
						strokeLinecap="round"
						strokeLinejoin="round"
					>
						<polyline points="15 18 9 12 15 6" />
					</svg>
				</button>

				<span className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[13px] font-mono font-semibold text-text-main">
					{filePath}
				</span>

				{/* View-mode segmented control */}
				<div
					role="tablist"
					aria-label="Diff view mode"
					className="flex border border-border rounded-lg overflow-hidden flex-shrink-0"
				>
					{(['unified', 'split'] as const).map((mode, idx) => {
						const isActive = viewMode === mode;
						return (
							<button
								key={mode}
								role="tab"
								aria-selected={isActive}
								onClick={() => handleViewModeChange(mode)}
								className={`px-[10px] py-[6px] min-h-[28px] border-0 text-[12px] capitalize cursor-pointer [touch-action:manipulation] [-webkit-tap-highlight-color:transparent] ${idx === 0 ? '' : 'border-l border-border'} ${isActive ? 'bg-accent text-accent-foreground font-semibold' : 'bg-bg-main text-text-dim font-medium'}`}
							>
								{mode}
							</button>
						);
					})}
				</div>
			</div>

			{/* Diff content */}
			<div className="flex-1 overflow-auto [-webkit-overflow-scrolling:touch]">
				{!hasDiff ? (
					<div className="flex items-center justify-center px-[16px] py-[40px] text-text-dim text-[14px]">
						No diff available
					</div>
				) : viewMode === 'unified' ? (
					<pre
						data-diff-view="unified"
						className="m-0 p-0 font-mono text-[12px] leading-[1.5] whitespace-pre"
					>
						{lines.map((line, i) => (
							<div
								key={i}
								className="flex min-w-fit"
								style={{
									backgroundColor: lineBackground(line.type),
									color: lineColor(line.type),
								}}
							>
								{/* Line number gutter */}
								<span
									className="inline-block text-right px-[4px] text-text-dim select-none flex-shrink-0 border-r border-border opacity-60"
									style={{ width: gutterWidth }}
								>
									{line.oldNum}
								</span>
								<span
									className="inline-block text-right px-[4px] text-text-dim select-none flex-shrink-0 border-r border-border opacity-60"
									style={{ width: gutterWidth }}
								>
									{line.newNum}
								</span>

								{/* Line content */}
								<span className="flex-1 px-[8px]">{line.content}</span>
							</div>
						))}
					</pre>
				) : (
					<pre
						data-diff-view="split"
						className="m-0 p-0 font-mono text-[12px] leading-[1.5] whitespace-pre min-w-fit"
					>
						{splitRows.map((row, i) => {
							if (row.kind === 'hunk') {
								return (
									<div
										key={i}
										className="flex min-w-fit"
										style={{
											backgroundColor: lineBackground('hunk'),
											color: lineColor('hunk'),
										}}
									>
										<span className="flex-1 px-[8px]">{row.content}</span>
									</div>
								);
							}

							return (
								<div key={i} className="flex min-w-fit">
									{/* Left (old) cell */}
									<div
										className="flex flex-[1_1_50%] min-w-[50%] border-r border-border"
										style={{
											backgroundColor: lineBackground(row.left.type),
											color: lineColor(row.left.type === 'empty' ? 'context' : row.left.type),
										}}
									>
										<span
											className="inline-block text-right px-[4px] text-text-dim select-none flex-shrink-0 border-r border-border opacity-60"
											style={{ width: gutterWidth }}
										>
											{row.left.num}
										</span>
										<span className="flex-1 px-[8px]">{row.left.content}</span>
									</div>

									{/* Right (new) cell */}
									<div
										className="flex flex-[1_1_50%] min-w-[50%]"
										style={{
											backgroundColor: lineBackground(row.right.type),
											color: lineColor(row.right.type === 'empty' ? 'context' : row.right.type),
										}}
									>
										<span
											className="inline-block text-right px-[4px] text-text-dim select-none flex-shrink-0 border-r border-border opacity-60"
											style={{ width: gutterWidth }}
										>
											{row.right.num}
										</span>
										<span className="flex-1 px-[8px]">{row.right.content}</span>
									</div>
								</div>
							);
						})}
					</pre>
				)}
			</div>
		</div>
	);
}

export default GitDiffViewer;
