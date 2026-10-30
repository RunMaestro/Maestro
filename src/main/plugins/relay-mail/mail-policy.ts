import { serializedJsonByteLength } from '../../../shared/jsonUtils';
import { ImapConnectionError } from './mail-errors';
import { assertImapQuotedString, IMAP_COMMAND_LIMITS } from './mail-imap-commands';
import { mailRecord, mailList, parseMailAccountId, parseMailAccountRevision } from './mail-schema';

export const MAIL_POLICY_KEY = 'mail.policy';
export const MAIL_RIGHTS = ['read', 'detail', 'attachments'] as const;
export type MailRight = (typeof MAIL_RIGHTS)[number];
export interface MailAccount {
	readonly accountId: string;
	readonly revision: number;
	readonly enabled: boolean;
	readonly endpoint: Readonly<{ host: string; port: number }>;
	readonly username: string;
	readonly secretRef: string;
	readonly mailboxes: readonly string[];
	readonly agents: readonly Readonly<{ agentId: string; rights: readonly MailRight[] }>[];
}
export interface MailPolicy {
	readonly version: 1;
	readonly accounts: readonly MailAccount[];
	/** Removed IDs never become new accounts; history exhaustion denies additions. */
	readonly removed: readonly Readonly<{ accountId: string; secretRef: string }>[];
	/** Previously confirmed references retained for native cleanup after rotation. */
	readonly retiredSecrets: readonly Readonly<{ accountId: string; secretRef: string }>[];
}

/** Validate user-confirmed opaque records again inside Relay; no tolerant fallback. */
export function parseMailPolicy(value: unknown): MailPolicy {
	const root = mailRecord(value, ['version', 'accounts', 'removed'], ['retiredSecrets']);
	if (root.version !== 1) throw new ImapConnectionError('MAIL_INVALID');
	const ids = new Set<string>();
	const claim = (id: unknown) => {
		const parsed = parseMailAccountId(id);
		if (ids.has(parsed)) throw new ImapConnectionError('MAIL_INVALID');
		ids.add(parsed);
		return parsed;
	};
	const removed = mailList(root.removed, 1024).map((value) => {
		const row = mailRecord(value, ['accountId', 'secretRef']);
		if (typeof row.secretRef !== 'string' || !/^[\x21-\x7e]{1,256}$/.test(row.secretRef))
			throw new ImapConnectionError('MAIL_INVALID');
		return Object.freeze({ accountId: claim(row.accountId), secretRef: row.secretRef });
	});
	const accounts = mailList(root.accounts, 32).map((value) => {
		const row = mailRecord(value, [
			'accountId',
			'revision',
			'enabled',
			'endpoint',
			'username',
			'secretRef',
			'mailboxes',
			'agents',
		]);
		const endpoint = mailRecord(row.endpoint, ['host', 'port']);
		if (
			typeof endpoint.host !== 'string' ||
			endpoint.host.length > 253 ||
			endpoint.host !== endpoint.host.toLowerCase() ||
			!endpoint.host.includes('.') ||
			!endpoint.host
				.split('.')
				.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ||
			// Match Host/SDK pluginEndpointScope: numeric/hex final labels can be
			// interpreted as IP coordinates; numeric labels elsewhere remain DNS.
			/^(?:[0-9]+|0x[0-9a-f]*)$/.test(endpoint.host.split('.').at(-1)!) ||
			endpoint.host.endsWith('.localhost') ||
			typeof endpoint.port !== 'number' ||
			!Number.isInteger(endpoint.port) ||
			endpoint.port < 1 ||
			endpoint.port > 65535 ||
			typeof row.enabled !== 'boolean' ||
			typeof row.secretRef !== 'string' ||
			!/^[\x21-\x7e]{1,256}$/.test(row.secretRef)
		)
			throw new ImapConnectionError('MAIL_INVALID');
		assertImapQuotedString(row.username, IMAP_COMMAND_LIMITS.username);
		const mailboxes = mailList(row.mailboxes, 32).map((name) => {
			assertImapQuotedString(name, IMAP_COMMAND_LIMITS.mailbox);
			return name;
		});
		if (!mailboxes.length || new Set(mailboxes).size !== mailboxes.length)
			throw new ImapConnectionError('MAIL_INVALID');
		const agentIds = new Set<string>();
		const agents = mailList(row.agents, 128).map((value) => {
			const agent = mailRecord(value, ['agentId', 'rights']);
			if (
				typeof agent.agentId !== 'string' ||
				!/^[\x21-\x7e]{1,128}$/.test(agent.agentId) ||
				/[*,|]/.test(agent.agentId) ||
				agentIds.has(agent.agentId)
			)
				throw new ImapConnectionError('MAIL_INVALID');
			agentIds.add(agent.agentId);
			const rights = mailList(agent.rights, 3).map((right) => {
				if (!MAIL_RIGHTS.includes(right as MailRight))
					throw new ImapConnectionError('MAIL_INVALID');
				return right as MailRight;
			});
			if (!rights.length || new Set(rights).size !== rights.length)
				throw new ImapConnectionError('MAIL_INVALID');
			return Object.freeze({ agentId: agent.agentId, rights: Object.freeze(rights) });
		});
		if (
			(!row.enabled && agents.length) ||
			(row.enabled && ['reconsent-required', 'legacy-preserved'].includes(row.secretRef))
		)
			throw new ImapConnectionError('MAIL_INVALID');
		return Object.freeze({
			accountId: claim(row.accountId),
			revision: parseMailAccountRevision(row.revision),
			enabled: row.enabled,
			endpoint: Object.freeze({ host: endpoint.host, port: endpoint.port }),
			username: row.username,
			secretRef: row.secretRef,
			mailboxes: Object.freeze(mailboxes),
			agents: Object.freeze(agents),
		});
	});
	const retiredSecrets = mailList(root.retiredSecrets ?? [], 64).map((value) => {
		const row = mailRecord(value, ['accountId', 'secretRef']);
		const accountId = parseMailAccountId(row.accountId);
		if (
			!ids.has(accountId) ||
			typeof row.secretRef !== 'string' ||
			!/^[\x21-\x7e]{1,256}$/.test(row.secretRef) ||
			['reconsent-required', 'legacy-preserved'].includes(row.secretRef)
		)
			throw new ImapConnectionError('MAIL_INVALID');
		return Object.freeze({ accountId, secretRef: row.secretRef });
	});
	const refs = new Set<string>();
	for (const row of [...accounts, ...removed, ...retiredSecrets]) {
		if (['reconsent-required', 'legacy-preserved'].includes(row.secretRef)) continue;
		if (refs.has(row.secretRef)) throw new ImapConnectionError('MAIL_INVALID');
		refs.add(row.secretRef);
	}
	const policy = Object.freeze({
		version: 1 as const,
		accounts: Object.freeze(accounts),
		removed: Object.freeze(removed),
		retiredSecrets: Object.freeze(retiredSecrets),
	});
	const bytes = serializedJsonByteLength(policy);
	if (bytes === null || bytes > 64 * 1024) throw new ImapConnectionError('MAIL_LIMIT');
	return policy;
}

/** Reuse the current confirmed Relay account policy, independently of generic Host grants. */
export function authorizeMailAccount(
	policy: MailPolicy,
	agentId: string,
	right: MailRight,
	accountId: string,
	revision: number,
	mailbox: string
): MailAccount {
	const account = policy.accounts.find((account) => account.accountId === accountId);
	if (
		!account ||
		!account.enabled ||
		!account.mailboxes.includes(mailbox) ||
		!account.agents.some((agent) => agent.agentId === agentId && agent.rights.includes(right))
	)
		throw new ImapConnectionError('MAIL_DENIED');
	if (account.revision !== revision) throw new ImapConnectionError('MAIL_STALE');
	return account;
}
