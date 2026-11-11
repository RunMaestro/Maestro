/**
 * @file terminalBuffer.ts
 * @description Pure helpers for reading content out of an xterm.js buffer.
 *
 * Kept DOM-free (no `term`) so the wrapped-line logic can be unit tested in
 * isolation. The minimal interfaces below are structurally satisfied by xterm's
 * `IBuffer` / `IBufferLine`.
 */

export interface ReadableBufferLine {
	/** Whether this row is a soft-wrapped continuation of the previous one. */
	isWrapped: boolean;
	/** Gets the row as a string. Mirrors xterm's `IBufferLine.translateToString`. */
	translateToString(trimRight?: boolean): string;
}

export interface ReadableBuffer {
	getLine(y: number): ReadableBufferLine | undefined;
}

/** The visual rows of one logical line, untrimmed, starting at `firstRow`. */
export interface LogicalLineRows {
	firstRow: number;
	rows: string[];
}

/**
 * Collect the visual rows of the logical (unwrapped) line that `absoluteRow`
 * belongs to. Walks back to the first row of the wrap group, then forward
 * across every wrapped continuation. `maxRowsEachWay` bounds the walk in both
 * directions from `absoluteRow`, for callers that run on every hover.
 */
export function readLogicalLineRows(
	buffer: ReadableBuffer,
	absoluteRow: number,
	maxRowsEachWay = Infinity
): LogicalLineRows | null {
	if (absoluteRow < 0 || !buffer.getLine(absoluteRow)) return null;
	let firstRow = absoluteRow;
	while (
		firstRow > 0 &&
		absoluteRow - firstRow < maxRowsEachWay &&
		buffer.getLine(firstRow)?.isWrapped
	) {
		firstRow--;
	}
	let lastRow = absoluteRow;
	while (lastRow - absoluteRow < maxRowsEachWay && buffer.getLine(lastRow + 1)?.isWrapped) {
		lastRow++;
	}
	const rows: string[] = [];
	for (let y = firstRow; y <= lastRow; y++) {
		rows.push(buffer.getLine(y)?.translateToString(false) ?? '');
	}
	return { firstRow, rows };
}

/**
 * Reconstruct the full logical (unwrapped) line that `absoluteRow` belongs to.
 *
 * A single logical line can span several visual rows when it soft-wraps (a long
 * URL, a wide log line), so the caller gets one string regardless of terminal
 * width. Trailing padding on the final row is trimmed; interior rows are kept
 * whole because a wrapped row is full-width.
 */
export function readLogicalLine(buffer: ReadableBuffer, absoluteRow: number): string {
	return readLogicalLineRows(buffer, absoluteRow)?.rows.join('').trimEnd() ?? '';
}

/** A 0-based buffer cell position. */
export interface BufferCell {
	row: number;
	col: number;
}

/** A pattern match inside a logical line, with inclusive start and end cells. */
export interface LogicalLineMatch {
	text: string;
	start: BufferCell;
	end: BufferCell;
}

/**
 * Rows a link scan may walk from the hovered row in each direction. A 2,000
 * character URL at 80 columns is 25 rows; this keeps a hover over a huge
 * wrapped blob (minified output) from rescanning the whole thing.
 */
export const MAX_LINK_SCAN_ROWS_EACH_WAY = 100;

/**
 * Find every match of `pattern` in the logical line under `absoluteRow` that
 * covers that row. Matching the whole logical line (not just the row) is what
 * lets a soft-wrapped URL be detected, underlined and clicked as one link.
 * Assumes one string character per cell, as xterm's untrimmed rows give for
 * plain text.
 */
export function findLogicalLineMatches(
	buffer: ReadableBuffer,
	absoluteRow: number,
	pattern: RegExp
): LogicalLineMatch[] {
	const logical = readLogicalLineRows(buffer, absoluteRow, MAX_LINK_SCAN_ROWS_EACH_WAY);
	if (!logical) return [];

	const rowStarts: number[] = [];
	let text = '';
	for (const row of logical.rows) {
		rowStarts.push(text.length);
		text += row;
	}
	const cellAt = (index: number): BufferCell => {
		let r = rowStarts.length - 1;
		while (r > 0 && rowStarts[r] > index) r--;
		return { row: logical.firstRow + r, col: index - rowStarts[r] };
	};

	const matches: LogicalLineMatch[] = [];
	const re = new RegExp(
		pattern.source,
		pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`
	);
	let m: RegExpExecArray | null;
	while ((m = re.exec(text)) !== null) {
		if (m[0].length === 0) {
			re.lastIndex++;
			continue;
		}
		const start = cellAt(m.index);
		const end = cellAt(m.index + m[0].length - 1);
		if (start.row <= absoluteRow && end.row >= absoluteRow) {
			matches.push({ text: m[0], start, end });
		}
	}
	return matches;
}
