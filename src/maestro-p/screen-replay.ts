// Replays a captured TUI byte stream onto a character grid and returns the
// screen as a terminal would show it.
//
// Why this exists
// ---------------
// Claude paints `/usage` in the alternate screen with a diffing renderer. A
// repaint rewrites only the cells that changed and jumps the cursor over the
// rest (`ESC[17C ESC[2B`), so text that stays on screen is absent from the
// later bytes. Stripping ANSI from such a stream keeps only what each paint
// happened to write: a live capture read the second weekly header as a bare
// "Fable)" because "Current week (" was left standing from the prior frame,
// and its percentage bar lost the same way. Replaying the cursor moves puts
// every cell back where the terminal drew it.
//
// Scope
// -----
// The subset claude's renderer emits: printable text, CR/LF/BS/TAB, cursor
// movement and positioning, erase in line/display, save/restore cursor, and
// the alternate screen. Styling (SGR), mode switches, and OSC/DCS strings are
// consumed and ignored. There is no wrapping or scrolling: the renderer places
// every row itself inside its fixed-size screen, so an unbounded grid yields
// the same picture without the caller having to know the PTY size. Wide
// (double-width) glyphs count as one cell; the renderer re-positions with
// absolute column moves after them, which keeps later text aligned anyway.

const ALT_SCREEN_MODES = new Set([47, 1047, 1049]);

// Sticky so the parser can match in place without slicing the stream.
const CSI_RE = /\x1b\[([?>=<]?)([0-9;:]*)[ -/]*([@-~])/y;

/** True when the capture switched into the alternate screen at any point. */
export function capturedAlternateScreen(raw: string): boolean {
	return /\x1b\[\?(?:47|1047|1049)h/.test(raw);
}

/**
 * Replay `raw` and return the visible screen, one row per line with trailing
 * blanks trimmed. When the stream entered the alternate screen and later left
 * it, the LAST alternate screen is returned: that is where a full-screen TUI
 * drew its panel, and quitting the TUI must not erase the reading.
 */
export function replayTerminalScreen(raw: string): string {
	let grid: string[][] = [];
	let mainGrid: string[][] | null = null;
	let lastAltGrid: string[][] | null = null;
	let row = 0;
	let col = 0;
	let saved = { row: 0, col: 0 };

	const line = (r: number): string[] => {
		while (grid.length <= r) grid.push([]);
		return grid[r];
	};

	let i = 0;
	while (i < raw.length) {
		const ch = raw[i];

		if (ch === '\x1b') {
			const next = raw[i + 1];
			if (next === '[') {
				CSI_RE.lastIndex = i;
				const m = CSI_RE.exec(raw);
				if (!m) {
					i += 2;
					continue;
				}
				i = CSI_RE.lastIndex;
				const [, prefix, rawParams, final] = m;
				const params = rawParams.split(/[;:]/).map((p) => (p === '' ? 0 : parseInt(p, 10)));
				const n = Math.max(1, params[0] || 1);

				if (prefix === '?') {
					if ((final === 'h' || final === 'l') && params.some((p) => ALT_SCREEN_MODES.has(p))) {
						if (final === 'h' && mainGrid === null) {
							mainGrid = grid;
							grid = [];
						} else if (final === 'l' && mainGrid !== null) {
							lastAltGrid = grid;
							grid = mainGrid;
							mainGrid = null;
						}
					}
					continue;
				}
				if (prefix !== '') continue;

				switch (final) {
					case 'A':
						row = Math.max(0, row - n);
						break;
					case 'B':
					case 'e':
						row += n;
						break;
					case 'C':
					case 'a':
						col += n;
						break;
					case 'D':
						col = Math.max(0, col - n);
						break;
					case 'E':
						row += n;
						col = 0;
						break;
					case 'F':
						row = Math.max(0, row - n);
						col = 0;
						break;
					case 'G':
					case '`':
						col = n - 1;
						break;
					case 'd':
						row = n - 1;
						break;
					case 'H':
					case 'f':
						row = Math.max(1, params[0] || 1) - 1;
						col = Math.max(1, params[1] || 1) - 1;
						break;
					case 'K': {
						const cells = line(row);
						if (params[0] === 1) {
							for (let k = 0; k <= col; k++) cells[k] = ' ';
						} else if (params[0] === 2) {
							cells.length = 0;
						} else if (cells.length > col) {
							cells.length = col;
						}
						break;
					}
					case 'J':
						if (params[0] === 1) {
							for (let r = 0; r < row; r++) line(r).length = 0;
							const cells = line(row);
							for (let k = 0; k <= col; k++) cells[k] = ' ';
						} else if (params[0] === 2 || params[0] === 3) {
							grid.length = 0;
						} else {
							const cells = line(row);
							if (cells.length > col) cells.length = col;
							if (grid.length > row + 1) grid.length = row + 1;
						}
						break;
					case 'X': {
						const cells = line(row);
						for (let k = col; k < col + n; k++) cells[k] = ' ';
						break;
					}
					case 's':
						saved = { row, col };
						break;
					case 'u':
						({ row, col } = saved);
						break;
					// SGR, device queries, scroll regions, and the rest carry no text.
				}
				continue;
			}

			if (next === ']' || next === 'P' || next === '_' || next === '^') {
				// OSC / DCS / APC / PM string: runs to BEL or ST (ESC \).
				let end = i + 2;
				while (
					end < raw.length &&
					raw[end] !== '\x07' &&
					!(raw[end] === '\x1b' && raw[end + 1] === '\\')
				) {
					end++;
				}
				i = raw[end] === '\x07' ? end + 1 : end + 2;
				continue;
			}
			if (next === '7') {
				saved = { row, col };
			} else if (next === '8') {
				({ row, col } = saved);
			} else if (next === 'M') {
				row = Math.max(0, row - 1);
			} else if (next === 'D') {
				row++;
			} else if (next === 'E') {
				row++;
				col = 0;
			} else if (next === 'c') {
				grid.length = 0;
				row = 0;
				col = 0;
			} else if (next === '(' || next === ')' || next === '*' || next === '+') {
				i++; // charset designation carries one extra byte
			}
			i += 2;
			continue;
		}

		if (ch === '\r') {
			col = 0;
		} else if (ch === '\n') {
			row++;
			col = 0;
		} else if (ch === '\b') {
			col = Math.max(0, col - 1);
		} else if (ch === '\t') {
			col = (Math.floor(col / 8) + 1) * 8;
		} else if (ch >= ' ') {
			const glyph = String.fromCodePoint(raw.codePointAt(i) as number);
			line(row)[col] = glyph;
			col++;
			i += glyph.length;
			continue;
		}
		i++;
	}

	const screen = mainGrid !== null ? grid : (lastAltGrid ?? grid);
	return screen
		.map((cells) =>
			Array.from(cells, (cell) => cell ?? ' ')
				.join('')
				.trimEnd()
		)
		.join('\n')
		.replace(/\n+$/, '');
}
