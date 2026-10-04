/**
 * How many terminal columns a string takes. Enough for table alignment: East
 * Asian wide characters and emoji count 2, combining marks and zero-width
 * joiners count 0, everything else 1. Not a full wcwidth.
 */

function codePointWidth(code: number): number {
	if (code === 0 || code < 32 || (code >= 0x7f && code < 0xa0)) return 0;
	// Combining marks, variation selectors, zero-width space/joiners.
	if (
		(code >= 0x0300 && code <= 0x036f) ||
		(code >= 0x200b && code <= 0x200f) ||
		(code >= 0xfe00 && code <= 0xfe0f)
	) {
		return 0;
	}
	if (
		(code >= 0x1100 && code <= 0x115f) ||
		(code >= 0x2e80 && code <= 0xa4cf) ||
		(code >= 0xac00 && code <= 0xd7a3) ||
		(code >= 0xf900 && code <= 0xfaff) ||
		(code >= 0xfe30 && code <= 0xfe6f) ||
		(code >= 0xff00 && code <= 0xff60) ||
		(code >= 0xffe0 && code <= 0xffe6) ||
		(code >= 0x1f300 && code <= 0x1f64f) ||
		(code >= 0x1f900 && code <= 0x1f9ff) ||
		(code >= 0x20000 && code <= 0x3fffd)
	) {
		return 2;
	}
	return 1;
}

export function cellWidth(text: string): number {
	let width = 0;
	for (const char of text) width += codePointWidth(char.codePointAt(0) ?? 0);
	return width;
}

/** The longest prefix of `text` that fits in `columns`. */
export function sliceToWidth(text: string, columns: number): string {
	let width = 0;
	let out = '';
	for (const char of text) {
		const next = codePointWidth(char.codePointAt(0) ?? 0);
		if (width + next > columns) break;
		width += next;
		out += char;
	}
	return out;
}
