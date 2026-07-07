/**
 * @file terminalBuffer.ts
 * @description Pure helpers for reading content out of an xterm.js buffer.
 *
 * Kept DOM-free (no `term`, no coordinate math) so the wrapped-line logic can be
 * unit tested in isolation. The minimal interfaces below are structurally
 * satisfied by xterm's `IBuffer` / `IBufferLine`.
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

/**
 * Reconstruct the full logical (unwrapped) line that `absoluteRow` belongs to.
 *
 * A single logical line can span several visual rows when it soft-wraps (a long
 * URL, a wide log line). This walks back to the first row of the group, then
 * concatenates forward across every wrapped continuation, so the caller gets one
 * string regardless of terminal width. Trailing padding on the final row is
 * trimmed; interior rows are kept whole because a wrapped row is full-width.
 */
export function readLogicalLine(buffer: ReadableBuffer, absoluteRow: number): string {
	if (absoluteRow < 0) return '';
	let lineIdx = absoluteRow;
	while (lineIdx > 0 && buffer.getLine(lineIdx)?.isWrapped) lineIdx--;
	let text = buffer.getLine(lineIdx)?.translateToString(false) ?? '';
	for (let next = lineIdx + 1; buffer.getLine(next)?.isWrapped; next++) {
		text += buffer.getLine(next)?.translateToString(false) ?? '';
	}
	return text.trimEnd();
}
