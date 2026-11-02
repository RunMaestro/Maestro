import { Buffer } from 'node:buffer';
/**
 * Relay-owned Host-private display projection of the fixed HEADER.FIELDS literal.
 * Consumes/erases owned bytes. This pure function confers no publication authority.
 * Restricted RFC 5322 folding / RFC 2047 B,Q words; not an address or MIME parser.
 */
import { IMAP_HEADER_FIELDS } from './mail-imap-commands';
import { MAIL_HEADER_FIELD_LIMITS, readMailHeaderFields } from './mail-header-fields';
import { ImapConnectionError } from './mail-errors';
import { decodeMailBase64 } from './mail-transfer-decoding';
import { assertMailTextCharacters, decodeMailCharsetBytes } from './mail-text-decoding';

export const MAIL_HEADER_PROJECTION_LIMITS = Object.freeze({
	...MAIL_HEADER_FIELD_LIMITS,
	encodedWordBytes: 75,
	encodedWords: 128,
	displayBytes: 1024,
});

/** Sender is untrusted display text, never a verified mailbox or identity. */
export interface MailHeaderDisplay {
	readonly subject?: string;
	readonly sender?: string;
}

const allowedFields = new Set(IMAP_HEADER_FIELDS);

function fail(code: 'MAIL_PROTOCOL' | 'MAIL_LIMIT' = 'MAIL_PROTOCOL'): never {
	throw new ImapConnectionError(code);
}

function decodeWord(word: string): string {
	if (word.length > MAIL_HEADER_PROJECTION_LIMITS.encodedWordBytes) fail('MAIL_LIMIT');
	const match = /^=\?(UTF-8|US-ASCII|ISO-8859-1)\?([BQ])\?([!-~]+)\?=$/i.exec(word);
	if (!match || match[3].includes('?')) fail();
	const [, charset, encoding, payload] = match;
	let decoded: Buffer | undefined;
	try {
		if (encoding.toUpperCase() === 'B') {
			decoded = decodeMailBase64(payload, MAIL_HEADER_PROJECTION_LIMITS.encodedWordBytes);
			if (!decoded.length) fail();
		} else {
			decoded = Buffer.alloc(payload.length);
			let count = 0;
			for (let i = 0; i < payload.length; i++) {
				if (payload[i] === '=') {
					const hex = payload.slice(i + 1, i + 3);
					if (!/^[0-9A-F]{2}$/.test(hex)) fail();
					decoded[count++] = Number.parseInt(hex, 16);
					i += 2;
				} else decoded[count++] = payload[i] === '_' ? 32 : payload.charCodeAt(i);
			}
			// Retain ownership of the whole allocation for erasure in finally.
			const view = decoded.slice(0, count);
			return decodeText(view, charset);
		}
		return decodeText(decoded, charset);
	} finally {
		decoded?.fill(0);
	}
}

function decodeText(bytes: Buffer, charset: string): string {
	const text = decodeMailCharsetBytes(bytes, charset, MAIL_HEADER_PROJECTION_LIMITS.displayBytes);
	assertMailTextCharacters(text, 'display');
	return text;
}

/** Words must be separated from ordinary text and each other by SP/HTAB. */
function projectDisplay(value: string): string {
	let output = '';
	let cursor = 0;
	let words = 0;
	let previousWord = false;
	while (cursor < value.length) {
		const start = value.indexOf('=?', cursor);
		if (start < 0) {
			output += value.slice(cursor);
			break;
		}
		const between = value.slice(cursor, start);
		if (start > 0 && !/[ \t]/.test(value[start - 1])) fail();
		const prefix = /^=\?[^? \t]+\?[^? \t]+\?/.exec(
			value.slice(start, start + MAIL_HEADER_PROJECTION_LIMITS.encodedWordBytes)
		);
		if (!prefix) fail();
		// A Q payload can begin with '=HH'; its preceding '?=' is not the terminator.
		const end = value.indexOf('?=', start + prefix[0].length);
		if (end < 0) fail();
		const next = end + 2;
		if (next < value.length && !/[ \t]/.test(value[next])) fail();
		if (++words > MAIL_HEADER_PROJECTION_LIMITS.encodedWords) fail('MAIL_LIMIT');
		// Only whitespace between adjacent encoded words disappears (RFC 2047 6.2).
		if (!previousWord || !/^[ \t]+$/.test(between)) output += between;
		output += decodeWord(value.slice(start, next));
		if (Buffer.byteLength(output, 'utf8') > MAIL_HEADER_PROJECTION_LIMITS.displayBytes)
			fail('MAIL_LIMIT');
		previousWord = true;
		cursor = next;
	}
	assertMailTextCharacters(output.replace(/\t/g, ' '), 'display');
	output = output.replace(/[ \t]+/g, ' ').trim();
	if (Buffer.byteLength(output, 'utf8') > MAIL_HEADER_PROJECTION_LIMITS.displayBytes)
		fail('MAIL_LIMIT');
	return output;
}

/**
 * Complete ASCII header-only block, including its terminating empty CRLF line.
 * Unknown/duplicate fields, body suffixes and unsupported encodings fail closed.
 * Caller must own all buffer aliases; erasure does not zeroize JavaScript strings.
 */
export function consumeMailHeaderDisplay(bytes: unknown): MailHeaderDisplay {
	try {
		if (!Buffer.isBuffer(bytes)) throw new ImapConnectionError('MAIL_INVALID');
		const fields = readMailHeaderFields(bytes, (name) => {
			if (!allowedFields.has(name)) fail();
			return true;
		});
		const result: { subject?: string; sender?: string } = {};
		const subject = fields.get('SUBJECT');
		const sender = fields.get('FROM');
		if (subject !== undefined) result.subject = projectDisplay(subject);
		if (sender !== undefined) result.sender = projectDisplay(sender);
		return Object.freeze(result);
	} catch (error) {
		// Fatal TextDecoder errors and all other exceptions carry no header/native cause.
		throw new ImapConnectionError(
			error instanceof ImapConnectionError ? error.code : 'MAIL_PROTOCOL'
		);
	} finally {
		if (Buffer.isBuffer(bytes)) bytes.fill(0);
	}
}
