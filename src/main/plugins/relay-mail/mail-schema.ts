import { pluginRequest } from '../plugin-authority';
/** Relay coordinates and untrusted-input parsers, extracted from PR17 account config.
 * Parsing never conveys account, caller or publication authority. */
import { ImapConnectionError } from './mail-errors';
import {
	assertImapUid,
	assertImapQuotedString,
	prepareImapCommand,
	IMAP_COMMAND_LIMITS,
} from './mail-imap-commands';
import { MAIL_MIME_STRUCTURE_LIMITS } from './mail-mime-structure';
function invalid(): never {
	throw new ImapConnectionError('MAIL_INVALID');
}
/** Closed data fields only: no inherited fields, accessors, symbols or hidden keys. */
export function mailRecord(
	value: unknown,
	required: readonly string[],
	optional: readonly string[] = []
): Record<string, unknown> {
	try {
		const result = pluginRequest(value, required, optional);
		if (Object.values(Object.getOwnPropertyDescriptors(value)).some((d) => !d.enumerable))
			invalid();
		return result;
	} catch {
		invalid();
	}
}

/** Dense bounded arrays; copy data descriptors without evaluating array getters. */
export function mailList(value: unknown, max: number): unknown[] {
	if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) invalid();
	const length = Object.getOwnPropertyDescriptor(value, 'length')?.value;
	if (!Number.isSafeInteger(length) || length < 0 || length > max) invalid();
	const fields = Object.getOwnPropertyDescriptors(value);
	if (Reflect.ownKeys(fields).length !== length + 1) invalid();
	const result: unknown[] = [];
	for (let index = 0; index < length; index++) {
		const field = fields[String(index)];
		if (!field || !field.enumerable || !Object.prototype.hasOwnProperty.call(field, 'value'))
			invalid();
		result.push(field.value);
	}
	return result;
}

function opaqueId(value: unknown): string {
	if (typeof value !== 'string' || !/^[0-9a-f]{32}$/.test(value)) invalid();
	return value;
}

function revision(value: unknown): number {
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) invalid();
	return value;
}

/** Canonical syntax only; exported aliases confer no account ownership or authority. */
export { opaqueId as parseMailAccountId, revision as parseMailAccountRevision };

/** Exact immutable message coordinates only; parsing confers no read authority. */
export type MailMessageReference = Readonly<{
	accountId: string;
	accountRevision: number;
	mailbox: string;
	uidValidity: string;
	uid: string;
}>;

/** Shared by the private reader and verified completion facade, before any await. */
export function parseMailMessageReference(value: unknown): MailMessageReference {
	const raw = mailRecord(value, ['accountId', 'accountRevision', 'mailbox', 'uidValidity', 'uid']);
	const accountId = opaqueId(raw.accountId);
	const accountRevision = revision(raw.accountRevision);
	assertImapQuotedString(raw.mailbox, IMAP_COMMAND_LIMITS.mailbox);
	assertImapUid(raw.uidValidity);
	assertImapUid(raw.uid);
	return Object.freeze({
		accountId,
		accountRevision,
		mailbox: raw.mailbox,
		uidValidity: raw.uidValidity,
		uid: raw.uid,
	});
}

/** Closed immutable fixed-search criteria only; parsing confers no authority. */
export function parseMailSearchCriteria(value: unknown): Readonly<{
	accountId: string;
	accountRevision: number;
	mailbox: string;
	fromUid: string;
	toUid: string;
	uidValidity?: string;
	text?: string;
}> {
	const raw = mailRecord(
		value,
		['accountId', 'accountRevision', 'mailbox', 'fromUid', 'toUid'],
		['uidValidity', 'text']
	);
	const accountId = opaqueId(raw.accountId);
	const accountRevision = revision(raw.accountRevision);
	assertImapQuotedString(raw.mailbox, IMAP_COMMAND_LIMITS.mailbox);
	assertImapUid(raw.fromUid);
	assertImapUid(raw.toUid);
	if (Object.prototype.hasOwnProperty.call(raw, 'uidValidity')) assertImapUid(raw.uidValidity);
	if (Object.prototype.hasOwnProperty.call(raw, 'text'))
		assertImapQuotedString(raw.text, IMAP_COMMAND_LIMITS.searchText);
	const criteria = Object.freeze({
		accountId,
		accountRevision,
		mailbox: raw.mailbox,
		fromUid: raw.fromUid,
		toUid: raw.toUid,
		...(Object.prototype.hasOwnProperty.call(raw, 'uidValidity')
			? { uidValidity: raw.uidValidity as string }
			: {}),
		...(Object.prototype.hasOwnProperty.call(raw, 'text') ? { text: raw.text as string } : {}),
	});
	// Validate ordered range/fixed grammar before I/O; never write or retain this buffer.
	prepareImapCommand('A1', {
		kind: 'search',
		fromUid: criteria.fromUid,
		toUid: criteria.toUid,
		...(Object.prototype.hasOwnProperty.call(criteria, 'text') ? { text: criteria.text } : {}),
	}).bytes.fill(0);
	return criteria;
}

/** Exact complete-part selection only; numeric paths are never capabilities. */
export function parseMailAttachmentReference(
	value: unknown
): MailMessageReference & Readonly<{ partId: string }> {
	const raw = mailRecord(value, [
		'accountId',
		'accountRevision',
		'mailbox',
		'uidValidity',
		'uid',
		'partId',
	]);
	const { partId, ...coordinates } = raw;
	const reference = parseMailMessageReference(coordinates);
	// Bound before splitting, using the same tree/numeric limits as the actual reader.
	assertImapQuotedString(
		partId,
		MAIL_MIME_STRUCTURE_LIMITS.depth * (String(MAIL_MIME_STRUCTURE_LIMITS.nodes).length + 1) - 1
	);
	const segments = partId.split('.');
	if (segments.length > Math.max(1, MAIL_MIME_STRUCTURE_LIMITS.depth - 1)) invalid();
	for (const segment of segments) {
		assertImapUid(segment);
		if (Number(segment) > MAIL_MIME_STRUCTURE_LIMITS.nodes) invalid();
	}
	return Object.freeze({ ...reference, partId });
}
