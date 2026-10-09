/**
 * Terminal key sequences shared between the touch key bar (TerminalTouchBar) and
 * the terminal input path (XTerminal). Keeping the escape sequences and the
 * sticky-Ctrl control-code mapping in one place means the on-screen key bar and
 * the physical/virtual keyboard emit byte-for-byte identical input to the PTY.
 *
 * These are the raw bytes a PTY expects, matching what xterm.js would send for
 * the corresponding physical key. Do not re-derive escape sequences elsewhere;
 * import from here.
 */

/**
 * Escape sequences for the non-printable keys exposed on the touch key bar.
 * Arrows use the standard "cursor key" application-agnostic sequences (CSI A/B/C/D)
 * so interactive programs (vim, less, shells with readline) receive them exactly
 * as a hardware arrow key would produce.
 */
export const TERMINAL_KEY_SEQUENCES = {
	/** Escape */
	esc: '\x1b',
	/** Tab */
	tab: '\t',
	/** Enter / carriage return */
	enter: '\r',
	/** Cursor up (CSI A) */
	up: '\x1b[A',
	/** Cursor down (CSI B) */
	down: '\x1b[B',
	/** Cursor left (CSI D) */
	left: '\x1b[D',
	/** Cursor right (CSI C) */
	right: '\x1b[C',
} as const;

export type TerminalKeyName = keyof typeof TERMINAL_KEY_SEQUENCES;

/**
 * Convert a single printable character to the byte it produces when Ctrl is held,
 * used by the touch key bar's sticky-Ctrl toggle. Mirrors a real terminal:
 *
 *   - Letters a-z / A-Z         → \x01-\x1a   (Ctrl-A .. Ctrl-Z)
 *   - `@ [ \\ ] ^ _`            → \x00-\x1f   (Ctrl-@ .. Ctrl-_)
 *   - `?`                       → \x7f        (Ctrl-? = DEL)
 *   - space                     → \x00        (Ctrl-Space = NUL)
 *
 * Any input that is not a single mappable character is returned unchanged, so
 * multi-byte input (paste, IME composition) and already-encoded sequences pass
 * through untouched.
 */
export function toControlChar(input: string): string {
	if (input.length !== 1) return input;

	if (input === '?') return '\x7f';
	if (input === ' ') return '\x00';

	// Uppercase folds a-z onto A-Z so both cases map to the same control code.
	const code = input.toUpperCase().charCodeAt(0);

	// `@`(64) through `_`(95) - this covers A-Z plus the classic control symbols.
	if (code >= 64 && code <= 95) {
		return String.fromCharCode(code & 0x1f);
	}

	return input;
}
