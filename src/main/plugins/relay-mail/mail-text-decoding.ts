import { Buffer } from 'node:buffer';
/**
 * Relay-owned Host-private charset/text helpers, not MIME or HTML parsing.
 * Consuming plain text requires a complete already-transfer-decoded owned part.
 */
import { ImapConnectionError } from './mail-errors';

export const MAIL_TEXT_LIMITS = Object.freeze({ plainTextBytes: 256 * 1024 });

function fail(code: 'MAIL_INVALID' | 'MAIL_PROTOCOL' | 'MAIL_LIMIT'): never {
	throw new ImapConnectionError(code);
}

/** No controls/formatting/bidi/surrogates/line separators except plain CRLF/HTAB. */
export function assertMailTextCharacters(value: string, mode: 'display' | 'plain'): void {
	const checked = mode === 'plain' ? value.replace(/\r\n|\t/g, '') : value;
	if (/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(checked)) fail('MAIL_PROTOCOL');
}

/**
 * Non-consuming shared core. Caller retains ownership and must erase every alias.
 * Latin-1 is for RFC 2047 headers only; plain-body consumption excludes it below.
 * Byte bounds precede string allocation. Character policy belongs to each consumer.
 */
export function decodeMailCharsetBytes(
	bytes: Buffer,
	charset: string,
	maxTextBytes: number
): string {
	try {
		if (
			!Buffer.isBuffer(bytes) ||
			typeof charset !== 'string' ||
			!Number.isSafeInteger(maxTextBytes) ||
			maxTextBytes < 1 ||
			maxTextBytes > MAIL_TEXT_LIMITS.plainTextBytes
		)
			fail('MAIL_INVALID');
		if (bytes.length > maxTextBytes) fail('MAIL_LIMIT');
		if (charset.length > 10) fail('MAIL_PROTOCOL');
		for (let i = 0; i < charset.length; i++) {
			if (charset.charCodeAt(i) < 33 || charset.charCodeAt(i) > 126) fail('MAIL_PROTOCOL');
		}
		const kind = charset.toUpperCase();
		if (kind === 'UTF-8') {
			// Keep BOM visible for the consumer's character rejection. Never replace bad UTF-8.
			const text = bytes.toString('utf8');
			const roundtrip = Buffer.from(text, 'utf8');
			try {
				if (
					roundtrip.length !== bytes.length ||
					!roundtrip.every((byte, index) => byte === bytes[index])
				)
					fail('MAIL_PROTOCOL');
				return text;
			} finally {
				roundtrip.fill(0);
			}
		}
		if (kind !== 'US-ASCII' && kind !== 'ISO-8859-1') fail('MAIL_PROTOCOL');
		let size = bytes.length;
		for (const byte of bytes) {
			if (byte > 127) {
				if (kind === 'US-ASCII') fail('MAIL_PROTOCOL');
				if (++size > maxTextBytes) fail('MAIL_LIMIT');
			}
		}
		// True ISO-8859-1, never WHATWG Windows-1252 or Node ASCII high-bit masking.
		return bytes.toString('latin1');
	} catch (error) {
		throw new ImapConnectionError(
			error instanceof ImapConnectionError ? error.code : 'MAIL_PROTOCOL'
		);
	}
}

/**
 * Consume explicit UTF-8/US-ASCII text/plain bytes under a required tighten-only cap.
 * Preserve CRLF, HTAB, spaces and final ordinary lines; no trimming or HTML conversion.
 * Caller must prove media type/disposition and own every input alias. This pure seam
 * confers no detail/attachment rights or publication authority and has no deadline.
 * JavaScript text cannot be zeroized and must be treated as untrusted literal text.
 */
export function consumeMailPlainText(
	bytes: unknown,
	charset: unknown,
	maxTextBytes: number
): string {
	try {
		if (!Buffer.isBuffer(bytes) || typeof charset !== 'string') fail('MAIL_INVALID');
		if (!/^(?:UTF-8|US-ASCII)$/i.test(charset)) fail('MAIL_PROTOCOL');
		const text = decodeMailCharsetBytes(bytes, charset, maxTextBytes);
		assertMailTextCharacters(text, 'plain');
		return text;
	} catch (error) {
		throw new ImapConnectionError(
			error instanceof ImapConnectionError ? error.code : 'MAIL_PROTOCOL'
		);
	} finally {
		if (Buffer.isBuffer(bytes)) bytes.fill(0);
	}
}
