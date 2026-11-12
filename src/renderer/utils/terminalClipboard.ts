/**
 * @file terminalClipboard.ts
 * @description Parse OSC 52, the escape sequence a terminal program uses to put
 * text on the user's clipboard.
 *
 * A program running in a PTY has no clipboard of its own, least of all over
 * SSH, so a TUI that offers "press c to copy" (Claude Code's login screen, tmux
 * copy mode, vim with an OSC 52 provider) emits `ESC ] 52 ; <target> ; <base64>
 * BEL` and trusts the terminal to do the write. xterm.js ignores the sequence
 * unless a handler is registered, which made every one of those copy commands a
 * silent no-op: the app reported "sent 465 chars via OSC 52" and the clipboard
 * never changed.
 *
 * Kept DOM-free so the wire format can be unit tested without a terminal.
 */

/**
 * Largest decoded payload accepted, in bytes. A copy is a URL or a screen of
 * text; a megabyte is generous for that and still bounds what a program can
 * push onto the clipboard in one sequence.
 */
export const OSC52_MAX_TEXT_BYTES = 1_000_000;

export type Osc52Request =
	/** The program asked to put `text` on the clipboard. */
	| { kind: 'write'; text: string }
	/** The program asked to READ the clipboard. Never honored - see below. */
	| { kind: 'query' }
	/** Malformed, empty, or oversized. Nothing to do. */
	| { kind: 'ignore' };

/**
 * Interpret the body of an OSC 52 sequence (everything after `52;`).
 *
 * The body is `<targets>;<payload>`. `targets` names X11 selections (`c`
 * clipboard, `p` primary, ...) and may be empty; every target is treated as the
 * one system clipboard, since that is the only one a user can paste from here.
 * `payload` is base64 text, or `?` to ask for the clipboard's contents.
 *
 * A query is reported so the caller can consume the sequence, but it must not
 * be answered: the reply would be typed into the PTY, handing whatever the user
 * last copied (a password, a token) to any program that asks, including one on
 * a remote host. An empty payload means "clear the clipboard" in the spec and
 * is ignored for a milder version of the same reason - a program should not be
 * able to destroy what the user copied.
 */
export function parseOsc52(data: string): Osc52Request {
	const separator = data.indexOf(';');
	if (separator === -1) return { kind: 'ignore' };

	const payload = data.slice(separator + 1).trim();
	if (payload === '?') return { kind: 'query' };
	if (!payload) return { kind: 'ignore' };
	// Checked against the encoded length so an oversized payload is never decoded.
	if (payload.length > Math.ceil(OSC52_MAX_TEXT_BYTES / 3) * 4) return { kind: 'ignore' };

	let binary: string;
	try {
		binary = atob(payload);
	} catch {
		return { kind: 'ignore' };
	}
	// atob yields one char per BYTE; the bytes are UTF-8, so decode them as such
	// or every non-ASCII character comes out as mojibake.
	const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
	const text = new TextDecoder().decode(bytes);
	return text ? { kind: 'write', text } : { kind: 'ignore' };
}
