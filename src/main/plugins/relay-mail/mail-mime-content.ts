import { Buffer } from 'node:buffer';
/** Host-owned consuming MIME composition. Results and attachment bytes are Host-private. */
import { ImapConnectionError } from './mail-errors';
import { consumeMailMimeSource, type MailMimePart } from './mail-mime-structure';
import { consumeMailTransferBytes, MAIL_TRANSFER_LIMITS } from './mail-transfer-decoding';
import { consumeMailPlainText, MAIL_TEXT_LIMITS } from './mail-text-decoding';
import type { MailMimeHeaderDescriptor } from './mail-mime-headers';

export const MAIL_MIME_CONTENT_LIMITS = Object.freeze({
	bodyBytes: MAIL_TEXT_LIMITS.plainTextBytes, // Includes every discarded body alternative.
	attachments: 16,
	attachmentBytes: MAIL_TRANSFER_LIMITS.decodedBytes,
	attachmentAggregateBytes: 2 * MAIL_TRANSFER_LIMITS.decodedBytes,
});

export interface MailMimeBodyContent {
	readonly mimeType: 'text/plain';
	readonly text: string;
	readonly sizeBytes: number;
}

/** MIME is sender-declared, not proof of file format or safe executable content. */
export interface MailMimeAttachmentContent {
	readonly partId: string; // Numeric source path, not an account/reference capability.
	readonly filename: string; // Untrusted display label; never a filesystem path.
	readonly mimeType: Exclude<
		MailMimeHeaderDescriptor['mimeType'],
		'multipart/mixed' | 'multipart/alternative'
	>;
	readonly sizeBytes: number;
	readonly bytes: Buffer; // Mutable owned snapshot; never a public DTO/event.
}

export interface MailMimeContent {
	readonly body?: MailMimeBodyContent; // Absent differs from complete empty text.
	readonly attachments: readonly MailMimeAttachmentContent[];
}

function fail(code: 'MAIL_PROTOCOL' | 'MAIL_LIMIT' = 'MAIL_PROTOCOL'): never {
	throw new ImapConnectionError(code);
}

/**
 * Consume complete owned source via the actual bounded structure/transfer/text
 * consumers. Every leaf is decoded, including alternatives that are not selected.
 * Mixed permits at most one body-producing child, never joins independent text.
 * Alternative requires body-only children and chooses the last complete body;
 * unsupported/invalid children cause failure, never fallback or partial success.
 * Named or attachment-marked text and every nontext leaf are attachments.
 *
 * Budgets precede decoded allocations. A full aggregate permits further empty
 * leaves only. Root leaf has private path "1"; multipart children use 1-based
 * paths (1, 2, 1.1, ...), preserving physical order and unique source identity.
 * Fixed absent-name label is "attachment". No MIME sniffing, file repair or HTML.
 *
 * Source and every encoded leaf are erased on every path; temporary body bytes
 * and failed attachment outputs are erased too. Successful attachment buffers
 * belong to the caller, who must erase them on use/abandonment. Frozen shells do
 * not freeze Buffers; aliases and JavaScript strings cannot be recalled/zeroized.
 * Keep original independent grants/lease/deadline through synchronous work and
 * cleanup, and reauthorize publication. No cache, public DTO/chunk, I/O or authority.
 */
export function consumeMailMimeContent(bytes: unknown): MailMimeContent {
	let tree: MailMimePart | undefined;
	const decodedAttachments: Buffer[] = [];
	const attachments: MailMimeAttachmentContent[] = [];
	let bodyBytes = 0;
	let attachmentBytes = 0;
	try {
		tree = consumeMailMimeSource(bytes);
		const visit = (part: MailMimePart, path: string): MailMimeBodyContent | undefined => {
			if (part.kind === 'multipart') {
				let body: MailMimeBodyContent | undefined;
				const alternative = part.headers.mimeType === 'multipart/alternative';
				for (let i = 0; i < part.children.length; i++) {
					const before = attachments.length;
					const child = visit(part.children[i], path ? `${path}.${i + 1}` : `${i + 1}`);
					if (alternative && (!child || attachments.length !== before)) fail();
					if (child !== undefined) {
						if (body !== undefined && !alternative) fail();
						body = child;
					}
				}
				return body;
			}
			const { headers, encodedBytes } = part;
			const mimeType = headers.mimeType;
			if (mimeType === 'multipart/mixed' || mimeType === 'multipart/alternative') fail();
			const isBody =
				mimeType === 'text/plain' &&
				headers.filename === undefined &&
				headers.disposition !== 'attachment';
			if (!isBody && attachments.length >= MAIL_MIME_CONTENT_LIMITS.attachments) fail('MAIL_LIMIT');
			const remaining = isBody
				? MAIL_MIME_CONTENT_LIMITS.bodyBytes - bodyBytes
				: Math.min(
						MAIL_MIME_CONTENT_LIMITS.attachmentBytes,
						MAIL_MIME_CONTENT_LIMITS.attachmentAggregateBytes - attachmentBytes
					);
			// Consumers require positive caps. Only an empty encoding can decode to
			// zero bytes in this strict subset; avoid a one-byte allocation at capacity.
			if (remaining === 0 && encodedBytes.length !== 0) fail('MAIL_LIMIT');
			let decoded: Buffer | undefined;
			try {
				decoded = consumeMailTransferBytes(encodedBytes, headers.transferEncoding, remaining || 1);
				const sizeBytes = decoded.length;
				if (sizeBytes > remaining) fail('MAIL_LIMIT');
				if (isBody) {
					bodyBytes += sizeBytes;
					const text = consumeMailPlainText(decoded, headers.charset, remaining || 1);
					return Object.freeze({ mimeType: 'text/plain', text, sizeBytes });
				}
				attachmentBytes += sizeBytes;
				decodedAttachments.push(decoded);
				attachments.push(
					Object.freeze({
						partId: path || '1',
						filename: headers.filename ?? 'attachment',
						mimeType,
						sizeBytes,
						bytes: decoded,
					})
				);
				decoded = undefined; // Transfer ownership only after the closed record exists.
				return undefined;
			} finally {
				decoded?.fill(0);
			}
		};
		const body = visit(tree, '');
		return Object.freeze({
			...(body === undefined ? {} : { body }),
			attachments: Object.freeze(attachments),
		});
	} catch (error) {
		for (const buffer of decodedAttachments) buffer.fill(0);
		throw new ImapConnectionError(
			error instanceof ImapConnectionError ? error.code : 'MAIL_PROTOCOL'
		);
	} finally {
		const erase = (part: MailMimePart): void => {
			if (part.kind === 'leaf') part.encodedBytes.fill(0);
			else for (const child of part.children) erase(child);
		};
		if (tree) erase(tree);
		if (Buffer.isBuffer(bytes)) bytes.fill(0);
	}
}
