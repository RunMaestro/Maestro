import { Buffer } from 'node:buffer';
/**
 * Relay-owned Host-private MIME transfer bytes, not a MIME structure/text parser.
 * Restricted RFC 2045 sections 2.7/2.8/6.7/6.8. No publication authority.
 */
import { ImapConnectionError } from './mail-errors';
import { IMAP_FRAMING_LIMITS } from './mail-imap-framing';

export const MAIL_TRANSFER_LIMITS = Object.freeze({
	decodedBytes: 8 * 1024 * 1024,
	encodedLineBytes: 76,
	identityLineBytes: 998,
});

function fail(code: 'MAIL_PROTOCOL' | 'MAIL_LIMIT' = 'MAIL_PROTOCOL'): never {
	throw new ImapConnectionError(code);
}

function assertByteLimit(limit: number): void {
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAIL_TRANSFER_LIMITS.decodedBytes)
		throw new ImapConnectionError('MAIL_INVALID');
}

function base64Value(byte: number): number {
	if (byte >= 65 && byte <= 90) return byte - 65;
	if (byte >= 97 && byte <= 122) return byte - 71;
	if (byte >= 48 && byte <= 57) return byte + 4;
	if (byte === 43) return 62;
	if (byte === 47) return 63;
	return -1;
}

/** Shared with RFC 2047 B words. No whitespace; empty MIME payload is valid. */
export function decodeMailBase64(payload: string, maxDecodedBytes: number): Buffer {
	assertByteLimit(maxDecodedBytes);
	if (typeof payload !== 'string') throw new ImapConnectionError('MAIL_INVALID');
	if (payload.length > 4 * Math.ceil(maxDecodedBytes / 3)) fail('MAIL_LIMIT');
	if (payload.length % 4 !== 0) fail();
	const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0;
	const size = (payload.length / 4) * 3 - padding;
	if (size > maxDecodedBytes) fail('MAIL_LIMIT');
	// Linear validation before allocation: no large recursive regex or permissive decoder.
	for (let i = 0; i < payload.length - padding; i++) {
		if (base64Value(payload.charCodeAt(i)) < 0) fail();
	}
	if (
		padding &&
		(base64Value(payload.charCodeAt(payload.length - padding - 1)) & (padding === 2 ? 15 : 3)) !== 0
	)
		fail();
	let decoded: Buffer | undefined;
	try {
		decoded = Buffer.from(payload, 'base64');
		if (decoded.length !== size) fail();
		return decoded;
	} catch (error) {
		decoded?.fill(0);
		throw new ImapConnectionError(
			error instanceof ImapConnectionError ? error.code : 'MAIL_PROTOCOL'
		);
	}
}

function hexValue(byte: number): number {
	if (byte >= 48 && byte <= 57) return byte - 48;
	if (byte >= 65 && byte <= 70) return byte - 55;
	return -1; // Strict uppercase RFC 2045 hex, unlike header Q's underscore rule.
}

/** Validate/count first; second pass fills the exact allocation. No partial output. */
function scanQuotedPrintable(bytes: Buffer, limit: number, output?: Buffer): number {
	let count = 0;
	let line = 0;
	const emit = (byte: number) => {
		if (count >= limit) fail('MAIL_LIMIT');
		if (output) output[count] = byte;
		count++;
	};
	for (let i = 0; i < bytes.length; i++) {
		const byte = bytes[i];
		if (byte === 13) {
			if (bytes[i + 1] !== 10) fail();
			emit(13);
			emit(10);
			i++;
			line = 0;
			continue;
		}
		if (++line > MAIL_TRANSFER_LIMITS.encodedLineBytes) fail('MAIL_LIMIT');
		if (byte === 61) {
			if (bytes[i + 1] === 13 && bytes[i + 2] === 10) {
				if (i + 3 === bytes.length) fail(); // No terminal dangling soft break.
				i += 2;
				line = 0;
				continue;
			}
			const high = hexValue(bytes[i + 1]);
			const low = hexValue(bytes[i + 2]);
			if (high < 0 || low < 0) fail();
			line += 2;
			if (line > MAIL_TRANSFER_LIMITS.encodedLineBytes) fail('MAIL_LIMIT');
			emit(high * 16 + low);
			i += 2;
		} else {
			if (byte === 9 || byte === 32) {
				if (i + 1 === bytes.length || bytes[i + 1] === 13) fail();
			} else if (byte < 33 || byte > 126) fail();
			emit(byte); // '_' remains literal; this is not an RFC 2047 Q word.
		}
	}
	return count;
}

function base64Payload(bytes: Buffer, limit: number): string {
	let line = 0;
	let count = 0;
	for (let i = 0; i < bytes.length; i++) {
		const byte = bytes[i];
		if (byte === 13) {
			if (bytes[i + 1] !== 10 || !line) fail();
			i++;
			line = 0;
		} else {
			if (base64Value(byte) < 0 && byte !== 61) fail();
			if (++line > MAIL_TRANSFER_LIMITS.encodedLineBytes) fail('MAIL_LIMIT');
			if (++count > 4 * Math.ceil(limit / 3)) fail('MAIL_LIMIT');
		}
	}
	// Only strict bounded ASCII with CRLF survived; Node's ASCII high-bit masking is avoided.
	return bytes.toString('latin1').replace(/\r\n/g, '');
}

function validateIdentity(bytes: Buffer, encoding: '7bit' | '8bit'): void {
	let line = 0;
	for (let i = 0; i < bytes.length; i++) {
		const byte = bytes[i];
		if (byte === 13) {
			if (bytes[i + 1] !== 10) fail();
			i++;
			line = 0;
		} else {
			if (byte === 0 || byte === 10 || (encoding === '7bit' && byte > 127)) fail();
			if (++line > MAIL_TRANSFER_LIMITS.identityLineBytes) fail('MAIL_LIMIT');
		}
	}
}

/**
 * Consume one complete owned part. Required limit only tightens the 8 MiB ceiling.
 * Caller owns all input aliases and successful output, which must be erased after use.
 * Empty parts are valid. Exact case-insensitive encoding tokens only; no header parsing.
 * This synchronous seam cannot enforce caller grants, whole-message aggregate budgets
 * or elapsed deadlines; future integration must check them around decoding/publication.
 * Temporary JavaScript base64 strings cannot be zeroized.
 */
export function consumeMailTransferBytes(
	bytes: unknown,
	encoding: unknown,
	maxDecodedBytes: number
): Buffer {
	let output: Buffer | undefined;
	try {
		if (!Buffer.isBuffer(bytes) || typeof encoding !== 'string')
			throw new ImapConnectionError('MAIL_INVALID');
		assertByteLimit(maxDecodedBytes);
		if (bytes.length > IMAP_FRAMING_LIMITS.literalBytes) fail('MAIL_LIMIT');
		if (encoding.length > 16) fail();
		const kind = encoding.toLowerCase();
		if (kind === 'base64') {
			output = decodeMailBase64(base64Payload(bytes, maxDecodedBytes), maxDecodedBytes);
		} else if (kind === 'quoted-printable') {
			const size = scanQuotedPrintable(bytes, maxDecodedBytes);
			output = Buffer.alloc(size);
			if (scanQuotedPrintable(bytes, maxDecodedBytes, output) !== size) fail();
		} else if (kind === '7bit' || kind === '8bit') {
			if (bytes.length > maxDecodedBytes) fail('MAIL_LIMIT');
			validateIdentity(bytes, kind);
			output = Buffer.from(bytes);
		} else fail(); // No binary, compression, guessing or unknown-encoding fallback.
		return output;
	} catch (error) {
		output?.fill(0);
		throw new ImapConnectionError(
			error instanceof ImapConnectionError ? error.code : 'MAIL_PROTOCOL'
		);
	} finally {
		if (Buffer.isBuffer(bytes)) bytes.fill(0);
	}
}
