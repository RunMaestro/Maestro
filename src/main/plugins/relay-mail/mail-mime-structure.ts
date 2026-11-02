import { Buffer } from 'node:buffer';
/** Relay-owned strict complete MIME traversal; encoded leaves remain Host-private. */
import { IMAP_COMMAND_LIMITS } from './mail-imap-commands';
import { IMAP_FRAMING_LIMITS } from './mail-imap-framing';
import { ImapConnectionError } from './mail-errors';
import { consumeMailMimeHeaders, type MailMimeHeaderDescriptor } from './mail-mime-headers';

const HEADER_SEPARATOR = Buffer.from('\r\n\r\n', 'ascii');

export const MAIL_MIME_STRUCTURE_LIMITS = Object.freeze({
	sourceBytes: IMAP_FRAMING_LIMITS.literalBytes,
	depth: 16, // Root is depth one; containers AND leaves count.
	nodes: 64,
	leaves: 32,
	headerBytes: 256 * 1024, // Aggregate across root and every part.
	scanBytes: IMAP_FRAMING_LIMITS.literalBytes * 16,
});

/** Shells/arrays are frozen. Buffers are owned mutable bytes, not public DTOs. */
export type MailMimePart =
	| {
			readonly kind: 'leaf';
			readonly headers: MailMimeHeaderDescriptor;
			readonly encodedBytes: Buffer;
	  }
	| {
			readonly kind: 'multipart';
			readonly headers: MailMimeHeaderDescriptor;
			readonly children: readonly MailMimePart[];
	  };

type PartRange =
	| { kind: 'leaf'; headers: MailMimeHeaderDescriptor; start: number; end: number }
	| { kind: 'multipart'; headers: MailMimeHeaderDescriptor; children: PartRange[] };

function fail(code: 'MAIL_PROTOCOL' | 'MAIL_LIMIT' = 'MAIL_PROTOCOL'): never {
	throw new ImapConnectionError(code);
}

/**
 * Consumes one complete owned source (not a partial IMAP section). Every part's
 * syntax is validated before any leaf copy. Root requires MIME-Version: 1.0;
 * child versions remain optional. All Content-Types must be explicitly supported
 * by the existing descriptor, including every alternative (no HTML skipping).
 *
 * Strict subset: no preamble/epilogue, delimiter padding or ancestor-prefix
 * boundaries. Open delimiters need CRLF; final close may end at EOF or CRLF.
 * The CRLF immediately before a delimiter belongs to that delimiter, never the
 * previous part. An empty child body still needs its complete header terminator
 * plus the delimiter's separate CRLF. Encoded leaf contents are not interpreted.
 *
 * Caller owns every source alias and, on success, every returned leaf Buffer;
 * erase all leaves on abandonment/after decoding. Strings cannot be zeroized.
 * Keep original independent right lease/deadline through parsing/cleanup/final
 * checks; reauthorize later publication. This synchronous module supplies no
 * authority, decoded body selection, attachment manifest or content validation.
 */
export function consumeMailMimeSource(bytes: unknown): MailMimePart {
	const allocated: Buffer[] = [];
	try {
		if (!Buffer.isBuffer(bytes)) throw new ImapConnectionError('MAIL_INVALID');
		if (bytes.length > MAIL_MIME_STRUCTURE_LIMITS.sourceBytes) fail('MAIL_LIMIT');
		const source = bytes;
		let nodes = 0;
		let leaves = 0;
		let headerBytes = 0;
		let leafBytes = 0;
		let scanBytes = 0;

		const visit = (start: number, end: number, ancestors: readonly string[]): PartRange => {
			if (++nodes > MAIL_MIME_STRUCTURE_LIMITS.nodes) fail('MAIL_LIMIT');
			if (ancestors.length + 1 > MAIL_MIME_STRUCTURE_LIMITS.depth) fail('MAIL_LIMIT');
			scanBytes += end - start;
			if (scanBytes > MAIL_MIME_STRUCTURE_LIMITS.scanBytes) fail('MAIL_LIMIT');
			// Bound the search itself, not merely the eventual header allocation.
			const window = source.slice(start, Math.min(end, start + IMAP_COMMAND_LIMITS.headerBytes));
			const separator = window.indexOf(HEADER_SEPARATOR);
			if (separator < 0) {
				if (end - start > IMAP_COMMAND_LIMITS.headerBytes) fail('MAIL_LIMIT');
				fail();
			}
			const body = start + separator + 4;
			headerBytes += body - start;
			if (headerBytes > MAIL_MIME_STRUCTURE_LIMITS.headerBytes) fail('MAIL_LIMIT');
			// The consuming descriptor erases only this bounded copy, not source.
			const headers = consumeMailMimeHeaders(Buffer.from(source.slice(start, body)), start === 0);
			if (!headers.mimeType.startsWith('multipart/')) {
				if (++leaves > MAIL_MIME_STRUCTURE_LIMITS.leaves) fail('MAIL_LIMIT');
				leafBytes += end - body;
				if (leafBytes > MAIL_MIME_STRUCTURE_LIMITS.sourceBytes) fail('MAIL_LIMIT');
				return { kind: 'leaf', headers, start: body, end };
			}
			const boundary = headers.boundary;
			if (!boundary) fail();
			if (ancestors.some((parent) => boundary.startsWith(parent) || parent.startsWith(boundary)))
				fail();
			const nextMarker = Buffer.from('\r\n--' + boundary, 'ascii');
			try {
				const marker = nextMarker.slice(2);
				const delimiter = (offset: number): { close: boolean; after: number } => {
					const suffix = offset + marker.length;
					if (suffix > end || !marker.every((byte, index) => byte === source[offset + index]))
						fail();
					const close = suffix + 2 <= end && source[suffix] === 45 && source[suffix + 1] === 45;
					const after = suffix + (close ? 2 : 0);
					if (close && after === end) return { close, after };
					if (after + 2 > end || source[after] !== 13 || source[after + 1] !== 10) fail();
					return { close, after: after + 2 };
				};
				const opening = delimiter(body); // Preamble cannot precede it.
				if (opening.close) fail(); // At least one complete child required.
				const children: PartRange[] = [];
				let partStart = opening.after;
				while (true) {
					// Restrict native searching to this entity's range.
					const relative = source.slice(partStart, end).indexOf(nextMarker);
					if (relative < 0) fail(); // No partial/truncated container success.
					const partEnd = partStart + relative;
					const next = delimiter(partEnd + 2);
					children.push(visit(partStart, partEnd, [...ancestors, boundary]));
					if (next.close) {
						if (next.after !== end) fail(); // No epilogue, even whitespace.
						return { kind: 'multipart', headers, children };
					}
					partStart = next.after;
				}
			} finally {
				nextMarker.fill(0);
			}
		};

		const ranges = visit(0, source.length, []);
		const materialize = (range: PartRange): MailMimePart => {
			if (range.kind === 'multipart')
				return Object.freeze({
					kind: 'multipart',
					headers: range.headers,
					children: Object.freeze(range.children.map(materialize)),
				});
			const encodedBytes = Buffer.alloc(range.end - range.start);
			allocated.push(encodedBytes);
			source.copy(encodedBytes, 0, range.start, range.end);
			return Object.freeze({ kind: 'leaf', headers: range.headers, encodedBytes });
		};
		return materialize(ranges);
	} catch (error) {
		for (const buffer of allocated) buffer.fill(0);
		throw new ImapConnectionError(
			error instanceof ImapConnectionError ? error.code : 'MAIL_PROTOCOL'
		);
	} finally {
		if (Buffer.isBuffer(bytes)) bytes.fill(0);
	}
}
