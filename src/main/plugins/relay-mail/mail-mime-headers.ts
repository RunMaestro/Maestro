import { Buffer } from 'node:buffer';
/** Relay-owned strict MIME header descriptors, not source traversal or content DTOs. */
import { readMailHeaderFields } from './mail-header-fields';
import { ImapConnectionError } from './mail-errors';

export const MAIL_MIME_HEADER_LIMITS = Object.freeze({
	parameters: 3,
	filenameBytes: 128,
	boundaryBytes: 70,
});

const mediaTypes = [
	'text/plain',
	'multipart/mixed',
	'multipart/alternative',
	'application/pdf',
	'image/png',
	'image/jpeg',
	'image/gif',
	'image/webp',
] as const;

export interface MailMimeHeaderDescriptor {
	readonly mimeType: (typeof mediaTypes)[number];
	readonly transferEncoding: '7bit' | '8bit' | 'base64' | 'quoted-printable';
	readonly charset?: 'UTF-8' | 'US-ASCII';
	readonly boundary?: string;
	readonly disposition?: 'inline' | 'attachment';
	readonly filename?: string;
}

const selectedFields = new Set([
	'MIME-VERSION',
	'CONTENT-TYPE',
	'CONTENT-TRANSFER-ENCODING',
	'CONTENT-DISPOSITION',
]);

function fail(code: 'MAIL_PROTOCOL' | 'MAIL_LIMIT' = 'MAIL_PROTOCOL'): never {
	throw new ImapConnectionError(code);
}

function trimWhitespace(value: string): string {
	return value.replace(/^[ \t]+|[ \t]+$/g, '');
}

/** RFC 2045 token excludes tspecials; comments/extended parameters are unsupported. */
function isTokenCharacter(value: string): boolean {
	return /^[!#$%&'*+\-.0-9A-Z^_`a-z{|}~]$/.test(value);
}

/** Linear bounded scanner; quoted pairs allow only escaped quote/backslash. */
function parseParameterized(
	value: string,
	mediaType: boolean
): {
	kind: string;
	parameters: Map<string, string>;
} {
	let cursor = 0;
	const whitespace = () => {
		while (value[cursor] === ' ' || value[cursor] === '\t') cursor++;
	};
	const token = () => {
		const start = cursor;
		while (cursor < value.length && isTokenCharacter(value[cursor])) cursor++;
		if (cursor === start) fail();
		return value.slice(start, cursor);
	};
	whitespace();
	let kind = token();
	if (mediaType) {
		if (value[cursor++] !== '/') fail();
		kind += '/' + token();
	}
	const parameters = new Map<string, string>();
	whitespace();
	while (cursor < value.length) {
		if (value[cursor++] !== ';') fail();
		if (parameters.size >= MAIL_MIME_HEADER_LIMITS.parameters) fail('MAIL_LIMIT');
		whitespace();
		const name = token().toLowerCase();
		if (name.includes('*') || parameters.has(name)) fail();
		whitespace();
		if (value[cursor++] !== '=') fail();
		whitespace();
		let parameter: string;
		if (value[cursor] === '"') {
			cursor++;
			parameter = '';
			while (cursor < value.length && value[cursor] !== '"') {
				let character = value[cursor++];
				if (character === '\\') {
					character = value[cursor++];
					if (character !== '"' && character !== '\\') fail();
				}
				if (!character || character.charCodeAt(0) < 32 || character.charCodeAt(0) > 126) fail();
				parameter += character;
			}
			if (value[cursor++] !== '"' || !parameter.length) fail();
		} else parameter = token();
		parameters.set(name, parameter);
		whitespace();
	}
	return { kind: kind.toLowerCase(), parameters };
}

/** ASCII label only, never a filesystem path or a trusted sender-supplied name. */
function filenameLabel(value: string): string {
	if (value.length > MAIL_MIME_HEADER_LIMITS.filenameBytes) fail('MAIL_LIMIT');
	if (
		!value.length ||
		value !== trimWhitespace(value) ||
		value === '.' ||
		value === '..' ||
		/[\\/:<>"|?*]/.test(value) ||
		value.includes('=?') ||
		value.endsWith('.')
	)
		fail();
	return value;
}

/**
 * Consumes an owned complete ASCII header-only block, not a whole MIME source.
 * Explicit supported Content-Type required. Missing text charset defaults to
 * US-ASCII; missing transfer encoding defaults to 7bit (RFC 2045/2046).
 * MIME-Version is optional for part headers; if present it must be exactly 1.0.
 * Trusted source traversal can require it at the root via requireMimeVersion.
 * No comments, RFC 2231/2047 parameters, HTML, message/* or guessing/recovery.
 * Caller must hold original grants/deadline around parsing and future publication,
 * validate actual part bytes/structure and exclude attachment-marked/named leaves
 * from detail selection. Strings/aliases cannot be zeroized or recalled.
 */
export function consumeMailMimeHeaders(
	bytes: unknown,
	requireMimeVersion: boolean = false
): MailMimeHeaderDescriptor {
	try {
		if (!Buffer.isBuffer(bytes) || typeof requireMimeVersion !== 'boolean')
			throw new ImapConnectionError('MAIL_INVALID');
		const fields = readMailHeaderFields(bytes, (name) => {
			if (selectedFields.has(name)) return true;
			if (name.startsWith('CONTENT-')) fail();
			return false;
		});
		const version = fields.get('MIME-VERSION');
		if (requireMimeVersion && version === undefined) fail();
		if (version !== undefined && trimWhitespace(version) !== '1.0') fail();
		const rawType = fields.get('CONTENT-TYPE');
		if (rawType === undefined) fail();
		const type = parseParameterized(rawType, true);
		const mimeType = mediaTypes.find((candidate) => candidate === type.kind);
		if (!mimeType) fail();
		const multipart = mimeType.startsWith('multipart/');
		for (const name of type.parameters.keys()) {
			if (
				multipart
					? name !== 'boundary'
					: name !== 'name' && !(mimeType === 'text/plain' && name === 'charset')
			)
				fail();
		}
		const rawEncoding = fields.get('CONTENT-TRANSFER-ENCODING');
		const encoding = rawEncoding === undefined ? '7bit' : trimWhitespace(rawEncoding).toLowerCase();
		if (
			encoding !== '7bit' &&
			encoding !== '8bit' &&
			encoding !== 'base64' &&
			encoding !== 'quoted-printable'
		)
			fail();
		if (multipart && encoding !== '7bit' && encoding !== '8bit') fail();
		const result: {
			mimeType: MailMimeHeaderDescriptor['mimeType'];
			transferEncoding: MailMimeHeaderDescriptor['transferEncoding'];
			charset?: MailMimeHeaderDescriptor['charset'];
			boundary?: string;
			disposition?: MailMimeHeaderDescriptor['disposition'];
			filename?: string;
		} = { mimeType, transferEncoding: encoding };
		if (mimeType === 'text/plain') {
			const charset = (type.parameters.get('charset') ?? 'US-ASCII').toUpperCase();
			if (charset !== 'UTF-8' && charset !== 'US-ASCII') fail();
			result.charset = charset;
		}
		if (multipart) {
			const boundary = type.parameters.get('boundary');
			if (boundary && boundary.length > MAIL_MIME_HEADER_LIMITS.boundaryBytes) fail('MAIL_LIMIT');
			if (!boundary || !/^[0-9A-Za-z'()+_,\-./:=? ]*[0-9A-Za-z'()+_,\-./:=?]$/.test(boundary))
				fail();
			result.boundary = boundary;
		}
		const name = type.parameters.get('name');
		if (name !== undefined) result.filename = filenameLabel(name);
		const rawDisposition = fields.get('CONTENT-DISPOSITION');
		if (rawDisposition !== undefined) {
			if (multipart) fail(); // No attached multipart containers in this subset.
			const disposition = parseParameterized(rawDisposition, false);
			if (disposition.kind !== 'inline' && disposition.kind !== 'attachment') fail();
			for (const parameter of disposition.parameters.keys()) {
				if (parameter !== 'filename') fail();
			}
			result.disposition = disposition.kind;
			const filename = disposition.parameters.get('filename');
			if (filename !== undefined) {
				const label = filenameLabel(filename);
				if (result.filename !== undefined && result.filename !== label) fail();
				result.filename = label;
			}
		}
		return Object.freeze(result);
	} catch (error) {
		throw new ImapConnectionError(
			error instanceof ImapConnectionError ? error.code : 'MAIL_PROTOCOL'
		);
	} finally {
		if (Buffer.isBuffer(bytes)) bytes.fill(0);
	}
}
