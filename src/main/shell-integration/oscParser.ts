/**
 * Streaming parser for the OSC sequences emitted by the zsh / bash shell
 * integration scripts (`zsh-integration.ts`, `bash-integration.ts`).
 *
 * Sequences recognized:
 *   - `\x1b]133;A\x07`             prompt-start
 *   - `\x1b]133;B[;cmd=<hex>]\x07` command-start (command text hex-encoded)
 *   - `\x1b]133;C\x07`             command-output (output area starts)
 *   - `\x1b]133;D[;<exit>]\x07`    command-finished (exit code)
 *   - `\x1b]7;file://<host><pwd>\x07` cwd-change
 *
 * The parser is intentionally read-only with respect to the data flow —
 * `parse(chunk)` returns events and never modifies or returns the chunk
 * itself. PtySpawner forwards the original bytes to xterm.js unchanged so the
 * terminal renders correctly; the events fed up the IPC channel are a side
 * channel.
 *
 * Chunk-splitting is the main reason this is a stateful class: PTY data
 * arrives in arbitrary boundaries, so an OSC sequence ('\x1b]133;D;0\x07')
 * can be split across two chunks. We buffer at most the in-flight partial in
 * `residual`. Both ASCII BEL (`\x07`) and the formal String Terminator
 * (`\x1b\\`) are accepted as OSC terminators — the shell scripts only emit
 * BEL today, but accepting ST keeps us compatible with other emitters.
 *
 * Bounded buffer: if a stray `\x1b]` ever arrives without a terminator (e.g.
 * a malformed program writing into the PTY) we cap `residual` at
 * `MAX_OSC_BODY_LEN`. Past that we discard the partial and resume scanning;
 * unbounded buffering would let a single bad byte block all subsequent OSC
 * events for the lifetime of the tab.
 */

export interface OscEvent {
	type: 'prompt-start' | 'command-start' | 'command-output' | 'command-finished' | 'cwd-change';
	/** Decoded command text. Present (possibly empty) for `command-start` when `cmd=` was supplied. */
	command?: string;
	/** Numeric exit code from OSC 133;D. Omitted if the shell didn't include one. */
	exitCode?: number;
	/** Absolute path from OSC 7's `file://` URI, percent-decoded. */
	cwd?: string;
}

const ESC = '\x1b';
const BEL = '\x07';
const OSC_INTRO = '\x1b]'; // ESC ]
// The other accepted terminator is ST (ESC \) — handled inline in findOscTerminator.

/**
 * Cap on the length of a single in-flight OSC body. A real OSC 133;B (command
 * text, hex-encoded → 2 chars per byte) for a typical command is well under
 * 1KB; OSC 7 paths are even smaller. Anything past 16KB is almost certainly
 * stream corruption — drop the partial rather than buffer indefinitely.
 */
const MAX_OSC_BODY_LEN = 16 * 1024;

export class OscStreamParser {
	private residual = '';

	parse(data: string): { events: OscEvent[] } {
		const events: OscEvent[] = [];
		const buf = this.residual + data;
		this.residual = '';

		let pos = 0;
		while (pos < buf.length) {
			const start = buf.indexOf(OSC_INTRO, pos);
			if (start === -1) {
				// No more OSC starts in this buffer. If the very last byte is a
				// lone ESC, it could be the leading half of an OSC intro split
				// across chunks — preserve it for the next call.
				if (buf.length > 0 && buf.charAt(buf.length - 1) === ESC) {
					this.residual = ESC;
				}
				break;
			}

			const bodyStart = start + OSC_INTRO.length;
			const term = findOscTerminator(buf, bodyStart);

			if (term === null) {
				// Tail of the buffer holds an incomplete OSC. Buffer for next
				// call unless it's pathologically large, in which case drop it
				// and skip past the offending intro to avoid permanent stall.
				const tail = buf.slice(start);
				if (tail.length > MAX_OSC_BODY_LEN) {
					pos = bodyStart;
					continue;
				}
				this.residual = tail;
				break;
			}

			const body = buf.slice(bodyStart, term.index);
			const event = parseOscBody(body);
			if (event !== null) events.push(event);
			pos = term.index + term.length;
		}

		return { events };
	}

	/** Discards any in-flight partial sequence. Useful when a process exits. */
	reset(): void {
		this.residual = '';
	}
}

/**
 * Locate the first OSC terminator at or after `from`. Returns the index of
 * the terminator's first byte and its length (1 for BEL, 2 for ST).
 *
 * We deliberately do NOT abort on a stray ESC mid-body: OSC bodies in the
 * wild sometimes contain ESC bytes (other shells, color escapes injected
 * through unusual paths). The tradeoff is that a real ST (`ESC \`) is the
 * only sequence that ends an OSC besides BEL — anything else gets included
 * in the body and the shell scripts we ship never emit either inside an OSC.
 */
function findOscTerminator(buf: string, from: number): { index: number; length: number } | null {
	for (let i = from; i < buf.length; i++) {
		const ch = buf.charAt(i);
		if (ch === BEL) {
			return { index: i, length: 1 };
		}
		if (ch === ESC && i + 1 < buf.length && buf.charAt(i + 1) === '\\') {
			return { index: i, length: 2 };
		}
	}
	return null;
}

function parseOscBody(body: string): OscEvent | null {
	if (body.startsWith('133;')) {
		return parseOsc133(body.slice(4));
	}
	if (body.startsWith('7;')) {
		return parseOsc7(body.slice(2));
	}
	return null;
}

function parseOsc133(rest: string): OscEvent | null {
	// `rest` is everything after `133;`. Split on `;` to peel off the
	// sub-command code and any params. Hex-encoded `cmd=` payload is safe to
	// split since hex is [0-9a-f] only.
	const parts = rest.split(';');
	const sub = parts[0];

	switch (sub) {
		case 'A':
			return { type: 'prompt-start' };
		case 'B': {
			const command = extractCmdParam(parts.slice(1));
			return command !== null ? { type: 'command-start', command } : { type: 'command-start' };
		}
		case 'C':
			return { type: 'command-output' };
		case 'D': {
			const raw = parts[1];
			if (raw === undefined || raw === '') {
				return { type: 'command-finished' };
			}
			const exitCode = Number.parseInt(raw, 10);
			return Number.isNaN(exitCode)
				? { type: 'command-finished' }
				: { type: 'command-finished', exitCode };
		}
		default:
			return null;
	}
}

/**
 * OSC 7 payload is a `file://<host><path>` URI, with the path optionally
 * percent-encoded. Returns the decoded path, or `null` if the URI is
 * malformed (no `file://` prefix or no path component).
 */
function parseOsc7(payload: string): OscEvent | null {
	if (!payload.startsWith('file://')) return null;
	const afterScheme = payload.slice('file://'.length);
	// Path begins at the first `/` — that slash is part of the absolute POSIX
	// path. `file:///foo` (empty host) lands at index 0; `file://host/foo`
	// lands at the `host`/`foo` boundary.
	const pathStart = afterScheme.indexOf('/');
	if (pathStart === -1) return null;
	const encodedPath = afterScheme.slice(pathStart);
	const cwd = safeDecodeURIComponent(encodedPath);
	return { type: 'cwd-change', cwd };
}

function extractCmdParam(params: string[]): string | null {
	for (const p of params) {
		if (p.startsWith('cmd=')) {
			return decodeHex(p.slice(4));
		}
	}
	return null;
}

/**
 * Hex → UTF-8 string. The shell scripts encode command text with `od -An -tx1`
 * (one byte → two lowercase hex chars, no separators), so this is the inverse.
 *
 * Returns the empty string for an empty input (the user pressing Enter on a
 * blank line still emits `cmd=` with no payload). Returns the empty string
 * on malformed hex too — we'd rather record a missing command than crash
 * the parser on garbage from a misbehaving emitter.
 */
function decodeHex(hex: string): string {
	if (hex.length === 0) return '';
	if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) return '';
	const bytes = new Uint8Array(hex.length / 2);
	for (let i = 0; i < hex.length; i += 2) {
		bytes[i / 2] = Number.parseInt(hex.slice(i, i + 2), 16);
	}
	try {
		return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
	} catch {
		return '';
	}
}

function safeDecodeURIComponent(s: string): string {
	try {
		return decodeURIComponent(s);
	} catch {
		// Path contains a literal `%` that isn't part of a valid escape
		// (legal in POSIX paths). Fall back to the raw string rather than
		// dropping the cwd-change event entirely.
		return s;
	}
}
