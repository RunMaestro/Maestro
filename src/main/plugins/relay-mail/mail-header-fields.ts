import { Buffer } from 'node:buffer';
/** Shared bounded ASCII header syntax; no MIME/display interpretation or authority. */
import { IMAP_COMMAND_LIMITS } from './mail-imap-commands';
import { ImapConnectionError } from './mail-errors';

const CRLF = Buffer.from('\r\n', 'ascii');

export const MAIL_HEADER_FIELD_LIMITS = Object.freeze({
	lineBytes: 998,
	lines: 256,
	fieldBytes: 8192,
});

/**
 * Non-consuming complete header-only block, including its final empty CRLF line.
 * Trusted selection callback may reject fields; discarded fields still incur limits.
 * Selected duplicates reject; ordinary discarded repeats (e.g. Received) are valid.
 * Caller owns bytes/aliases and erasure. The returned Map/strings stay Host-private.
 */
export function readMailHeaderFields(
	bytes: Buffer,
	select: (name: string) => boolean
): Map<string, string> {
	if (!Buffer.isBuffer(bytes) || typeof select !== 'function')
		throw new ImapConnectionError('MAIL_INVALID');
	if (bytes.length > IMAP_COMMAND_LIMITS.headerBytes) throw new ImapConnectionError('MAIL_LIMIT');
	const fields = new Map<string, string>();
	let offset = 0;
	let lines = 0;
	let current: string | undefined;
	let selected = false;
	let value = '';
	while (offset < bytes.length) {
		if (++lines > MAIL_HEADER_FIELD_LIMITS.lines) throw new ImapConnectionError('MAIL_LIMIT');
		const end = bytes.indexOf(CRLF, offset);
		if (end < 0) throw new ImapConnectionError('MAIL_PROTOCOL');
		if (end - offset > MAIL_HEADER_FIELD_LIMITS.lineBytes)
			throw new ImapConnectionError('MAIL_LIMIT');
		for (let i = offset; i < end; i++) {
			const byte = bytes[i];
			if (byte !== 9 && (byte < 32 || byte > 126)) throw new ImapConnectionError('MAIL_PROTOCOL');
		}
		const line = bytes.toString('latin1', offset, end);
		offset = end + 2;
		if (!line.length) {
			if (offset !== bytes.length) throw new ImapConnectionError('MAIL_PROTOCOL');
			return fields;
		}
		if (line[0] === ' ' || line[0] === '\t') {
			if (!current) throw new ImapConnectionError('MAIL_PROTOCOL');
			if (value.length + line.length > MAIL_HEADER_FIELD_LIMITS.fieldBytes)
				throw new ImapConnectionError('MAIL_LIMIT');
			value += line; // RFC 5322 unfolding removes only CRLF.
		} else {
			const separator = line.indexOf(':');
			if (separator < 1 || !/^[!-9;-~]+$/.test(line.slice(0, separator)))
				throw new ImapConnectionError('MAIL_PROTOCOL');
			current = line.slice(0, separator).toUpperCase();
			selected = select(current);
			if (selected && fields.has(current)) throw new ImapConnectionError('MAIL_PROTOCOL');
			value = line.slice(separator + 1);
		}
		if (value.length > MAIL_HEADER_FIELD_LIMITS.fieldBytes)
			throw new ImapConnectionError('MAIL_LIMIT');
		if (selected) fields.set(current!, value);
	}
	throw new ImapConnectionError('MAIL_PROTOCOL');
}
