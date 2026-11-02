import { Buffer } from 'node:buffer';
/**
 * Host-private IMAP4rev1 response framing. No socket, command or SDK surface.
 * See RFC 3501 sections 4/9 and docs/relay-imap-host-contract-20261006.md.
 * One decoder per bounded operation (including its greeting, if applicable).
 * Frames are untrusted: the session must validate attributes, UIDs and matching
 * tagged completion before accepting ANY result. No MIME interpretation here.
 */

export const IMAP_FRAMING_LIMITS = Object.freeze({
	lineBytes: 64 * 1024, // Including CRLF, outside literal contents.
	literalBytes: 24 * 1024 * 1024,
	totalBytes: 25 * 1024 * 1024, // Literal plus framing overhead, entire operation.
	responses: 256,
	literalsPerResponse: 16,
	depth: 16,
});

/** Bounded RFC 3501 flag atoms; only PERMANENTFLAGS permits the exact \\* marker. */
export function isImapFlagList(value: string, allowPermanentWildcard = false): boolean {
	if (
		value.length > IMAP_FRAMING_LIMITS.lineBytes ||
		!value.startsWith('(') ||
		!value.endsWith(')')
	)
		return false;
	if (value === '()') return true;
	// ATOM-CHAR excludes controls, space, (){, list wildcards, quotes, backslash and ].
	return value
		.slice(1, -1)
		.split(' ')
		.every(
			(flag) =>
				(allowPermanentWildcard && flag === '\\*') ||
				/^\\?[\x21\x23-\x24\x26-\x27\x2b-\x5b\x5e-\x7a\x7c-\x7e]{1,64}$/.test(flag)
		);
}

type FramingLimits = { -readonly [K in keyof typeof IMAP_FRAMING_LIMITS]: number };
type Status = 'OK' | 'NO' | 'BAD' | 'BYE';

export type ImapResponseFrame =
	| { kind: 'status'; tag: string | null; status: Status; text: string }
	| { kind: 'data'; name: string; parts: (string | Buffer)[] };

/** Never attach peer bytes, credentials, a cause, or the failing response. */
export class ImapFramingError extends Error {
	constructor(readonly code: 'MAIL_PROTOCOL' | 'MAIL_LIMIT' | 'MAIL_CANCELED') {
		super(
			code === 'MAIL_LIMIT'
				? 'Mail response limit exceeded.'
				: code === 'MAIL_CANCELED'
					? 'Mail response decoder closed.'
					: 'Invalid mail response framing.'
		);
		this.name = 'ImapFramingError';
	}
}

export class ImapResponseDecoder {
	private readonly limits: FramingLimits;
	private readonly literalCeiling: number;
	private readonly line: Buffer;
	private lineLength = 0;
	private receivedBytes = 0;
	private responses = 0;
	private parts: (string | Buffer)[] = [];
	private literal: Buffer | null = null;
	private literalOffset = 0;
	private literalCount = 0;
	private depth = 0;
	private closed = false;

	/** Caller may tighten limits, never raise them above these hard ceilings. */
	constructor(limits: Partial<FramingLimits> = {}) {
		this.limits = { ...IMAP_FRAMING_LIMITS };
		for (const key of Object.keys(limits) as (keyof FramingLimits)[]) {
			const value = limits[key];
			if (
				!Object.prototype.hasOwnProperty.call(IMAP_FRAMING_LIMITS, key) ||
				!Number.isSafeInteger(value) ||
				value === undefined ||
				value < 1 ||
				value > IMAP_FRAMING_LIMITS[key]
			) {
				throw new ImapFramingError('MAIL_LIMIT');
			}
			this.limits[key] = value;
		}
		this.line = Buffer.alloc(this.limits.lineBytes);
		this.literalCeiling = this.limits.literalBytes;
	}

	/** At a response boundary only; preserve cumulative budgets and constructor caps. */
	setLiteralLimit(bytes: number): void {
		this.assertOpen();
		if (this.lineLength || this.literal || this.parts.length) {
			this.dispose();
			throw new ImapFramingError('MAIL_PROTOCOL');
		}
		if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.literalCeiling) {
			this.dispose();
			throw new ImapFramingError('MAIL_LIMIT');
		}
		this.limits.literalBytes = bytes;
	}

	/** A malformed chunk yields no frames from that chunk and poisons the decoder. */
	push(chunk: Buffer): ImapResponseFrame[] {
		this.assertOpen();
		const frames: ImapResponseFrame[] = [];
		try {
			if (!Buffer.isBuffer(chunk)) throw new ImapFramingError('MAIL_PROTOCOL');
			if (chunk.length > this.limits.totalBytes - this.receivedBytes) {
				throw new ImapFramingError('MAIL_LIMIT');
			}
			this.receivedBytes += chunk.length;
			let offset = 0;
			while (offset < chunk.length) {
				if (this.literal) {
					const count = Math.min(this.literal.length - this.literalOffset, chunk.length - offset);
					chunk.copy(this.literal, this.literalOffset, offset, offset + count);
					this.literalOffset += count;
					offset += count;
					if (this.literalOffset === this.literal.length) {
						this.parts.push(this.literal);
						this.literal = null;
						this.literalOffset = 0;
					}
					continue;
				}
				const byte = chunk[offset++];
				if (this.lineLength >= this.line.length) throw new ImapFramingError('MAIL_LIMIT');
				const followsCr = this.lineLength > 0 && this.line[this.lineLength - 1] === 13;
				if ((followsCr && byte !== 10) || (byte === 10 && !followsCr)) {
					throw new ImapFramingError('MAIL_PROTOCOL');
				}
				if (byte !== 13 && byte !== 10 && (byte < 32 || byte > 126)) {
					throw new ImapFramingError('MAIL_PROTOCOL');
				}
				this.line[this.lineLength++] = byte;
				if (byte === 10) {
					const text = this.line.toString('ascii', 0, this.lineLength - 2);
					this.line.fill(0, 0, this.lineLength);
					this.lineLength = 0;
					const frame = this.consumeLine(text, this.receivedBytes - chunk.length + offset);
					if (frame) {
						frames.push(frame);
						if (++this.responses > this.limits.responses) throw new ImapFramingError('MAIL_LIMIT');
					}
				}
			}
			return frames;
		} catch (error) {
			for (const frame of frames) {
				if (frame.kind === 'data') this.eraseLiterals(frame.parts);
			}
			this.dispose();
			throw error instanceof ImapFramingError ? error : new ImapFramingError('MAIL_PROTOCOL');
		}
	}

	/** EOF is framing success only at a response boundary, not command success. */
	finish(): void {
		this.assertOpen();
		const truncated = this.lineLength !== 0 || this.literal !== null || this.parts.length !== 0;
		this.dispose();
		if (truncated) throw new ImapFramingError('MAIL_PROTOCOL');
	}

	/** Cancellation/failure permanently closes and releases owned pending bytes. */
	dispose(): void {
		this.closed = true;
		this.line.fill(0);
		this.literal?.fill(0);
		this.literal = null;
		this.eraseLiterals(this.parts);
		this.parts = [];
		this.lineLength = this.literalOffset = this.literalCount = this.depth = 0;
	}

	private assertOpen(): void {
		if (this.closed) throw new ImapFramingError('MAIL_CANCELED');
	}

	private eraseLiterals(parts: (string | Buffer)[]): void {
		for (const part of parts) if (Buffer.isBuffer(part)) part.fill(0);
	}

	private consumeLine(text: string, consumedBytes: number): ImapResponseFrame | null {
		if (this.parts.length === 0) {
			// Status text is opaque: braces/quotes/parentheses here are NOT literals.
			const status = /^(\*|[A-Za-z0-9]{1,32}) (OK|NO|BAD|BYE) (.+)$/i.exec(text);
			if (status) {
				if (status[1] !== '*' && status[2].toUpperCase() === 'BYE') {
					throw new ImapFramingError('MAIL_PROTOCOL');
				}
				return {
					kind: 'status',
					tag: status[1] === '*' ? null : status[1],
					status: status[2].toUpperCase() as Status,
					text: status[3],
				};
			}
			const count = /^\* ([0-9]{1,10}) (EXISTS|RECENT)$/i.exec(text);
			if (count && Number(count[1]) <= 0xffffffff) {
				return { kind: 'data', name: count[2].toUpperCase(), parts: [text] };
			}
			if (/^\* SEARCH(?: [1-9][0-9]{0,9})*$/i.test(text)) {
				if (
					text
						.split(' ')
						.slice(2)
						.some((uid) => Number(uid) > 0xffffffff)
				) {
					throw new ImapFramingError('MAIL_PROTOCOL');
				}
				return { kind: 'data', name: 'SEARCH', parts: [text] };
			}
			if (/^\* CAPABILITY [\x21-\x7e ]{1,4096}$/i.test(text)) {
				// The command layer validates these bounded opaque tokens only during LOGIN.
				return { kind: 'data', name: 'CAPABILITY', parts: [text] };
			}
			if (/^\* FLAGS /i.test(text) && isImapFlagList(text.slice(8))) {
				return { kind: 'data', name: 'FLAGS', parts: [text] };
			}
			const fetch = /^\* ([1-9][0-9]{0,9}) FETCH \(/i.exec(text);
			if (!fetch || Number(fetch[1]) > 0xffffffff) {
				// Includes continuation, PREAUTH, extensions and unsolicited EXPUNGE.
				throw new ImapFramingError('MAIL_PROTOCOL');
			}
			text = text.slice(fetch[0].length - 1);
			this.parts.push(fetch[0].slice(0, -1));
		}
		const literalBytes = this.scanFetch(text);
		this.parts.push(text);
		if (literalBytes !== null) {
			if (++this.literalCount > this.limits.literalsPerResponse) {
				throw new ImapFramingError('MAIL_LIMIT');
			}
			if (
				literalBytes > this.limits.literalBytes ||
				literalBytes > this.limits.totalBytes - consumedBytes
			) {
				throw new ImapFramingError('MAIL_LIMIT');
			}
			if (literalBytes === 0) this.parts.push(Buffer.alloc(0));
			else this.literal = Buffer.alloc(literalBytes);
			return null;
		}
		if (this.depth !== 0) throw new ImapFramingError('MAIL_PROTOCOL');
		const parts = this.parts;
		this.parts = [];
		this.literalCount = 0;
		return { kind: 'data', name: 'FETCH', parts };
	}

	/** Structural FETCH grammar only; attribute/section semantics belong to session. */
	private scanFetch(text: string): number | null {
		let quoted = false;
		for (let i = 0; i < text.length; i++) {
			const char = text[i];
			if (quoted) {
				if (char === '\\') {
					if (text[++i] !== '\\' && text[i] !== '"') throw new ImapFramingError('MAIL_PROTOCOL');
				} else if (char === '"') quoted = false;
				continue;
			}
			if (this.depth === 0 && char !== ' ' && !(char === '(' && this.parts.length === 1 && i === 0))
				throw new ImapFramingError('MAIL_PROTOCOL');
			if (char === '"') quoted = true;
			else if (char === '(') {
				if (++this.depth > this.limits.depth) throw new ImapFramingError('MAIL_LIMIT');
			} else if (char === ')') {
				if (--this.depth < 0) throw new ImapFramingError('MAIL_PROTOCOL');
			} else if (char === '{') {
				const marker = /^\{([0-9]{1,10})\}$/.exec(text.slice(i));
				if (!marker || (text[i - 1] !== ' ' && text[i - 1] !== '(')) {
					throw new ImapFramingError('MAIL_PROTOCOL');
				}
				return Number(marker[1]);
			} else if (char === '}' || char === '~') throw new ImapFramingError('MAIL_PROTOCOL');
		}
		if (quoted) throw new ImapFramingError('MAIL_PROTOCOL');
		return null;
	}
}
