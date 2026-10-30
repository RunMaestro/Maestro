import { ImapConnectionError, type MailResult } from './mail-errors';
import {
	mailRecord,
	parseMailMessageReference,
	parseMailSearchCriteria,
	parseMailAttachmentReference,
} from './mail-schema';
import {
	parseMailPolicy,
	authorizeMailAccount,
	MAIL_POLICY_KEY,
	type MailRight,
} from './mail-policy';
import { openBrokerMailStream, mailPlatformError, type MailPlatform } from './mail-platform';
import { openMailSession } from './mail-session';
import { consumeMailHeaderDisplay } from './mail-header-projection';
import { consumeMailMimeContent, type MailMimeContent } from './mail-mime-content';

export type MailOperation =
	| 'listAccounts'
	| 'searchHeaders'
	| 'readHeaders'
	| 'readBody'
	| 'listAttachments'
	| 'readAttachment';
export interface MailToolContext {
	readonly callerAgentId: string | null;
	readonly invocationId?: string;
}

export function captureMailReadRequest(operation: MailOperation, args: unknown) {
	if (operation === 'listAccounts') {
		mailRecord(args, []);
		return null;
	}
	if (operation === 'searchHeaders') return parseMailSearchCriteria(args);
	if (!['readHeaders', 'readBody', 'listAttachments', 'readAttachment'].includes(operation))
		throw new ImapConnectionError('MAIL_INVALID');
	const row = mailRecord(args, ['reference'], operation === 'readAttachment' ? ['partId'] : []);
	const reference = parseMailMessageReference(row.reference);
	return operation === 'readAttachment'
		? parseMailAttachmentReference({ ...reference, partId: row.partId })
		: reference;
}

/** Mail domain depth: one verified invocation interface, no ambient credentials,
 * arbitrary endpoint/command, account-policy escape or transferable authority. */
export function createMailService(platform: MailPlatform, isActive: () => boolean) {
	const activeSessions = new Set<Awaited<ReturnType<typeof openMailSession>>>();
	const activeAccounts = new Set<string>();
	let stopped = false;
	const inflight = new Set<Promise<MailResult<unknown>>>();
	async function invoke(
		operation: MailOperation,
		args: unknown,
		context: MailToolContext
	): Promise<MailResult<unknown>> {
		let session: Awaited<ReturnType<typeof openMailSession>> | undefined;
		let reserved: string | undefined;
		let content: MailMimeContent | undefined;
		try {
			const invocationId = context?.invocationId;
			const caller = context?.callerAgentId;
			const request = captureMailReadRequest(operation, args);
			if (
				typeof invocationId !== 'string' ||
				!invocationId ||
				typeof caller !== 'string' ||
				!caller
			)
				throw new ImapConnectionError('MAIL_DENIED');
			const assertInvocation = async () => {
				if (stopped || !isActive()) throw new ImapConnectionError('MAIL_CANCELED');
				const identity = await platform.invocations.inspect(invocationId);
				if (stopped || !isActive()) throw new ImapConnectionError('MAIL_CANCELED');
				if (!identity || identity.active !== true || identity.callerAgentId !== caller)
					throw new ImapConnectionError('MAIL_DENIED');
			};
			await assertInvocation();
			const stored = await platform.records.read(MAIL_POLICY_KEY);
			await assertInvocation();
			if (!stored || !Number.isSafeInteger(stored.revision) || stored.revision < 1)
				throw new ImapConnectionError('MAIL_UNAVAILABLE');
			const policy = parseMailPolicy(stored.value);
			if (operation === 'listAccounts') {
				const accounts = policy.accounts
					.filter(
						(account) => account.enabled && account.agents.some((agent) => agent.agentId === caller)
					)
					.map((account) => ({
						accountId: account.accountId,
						revision: account.revision,
						enabled: account.enabled,
						mailboxes: account.mailboxes,
						credentialStatus: 'unknown',
					}));
				await assertInvocation();
				const current = await platform.records.read(MAIL_POLICY_KEY);
				await assertInvocation();
				if (current?.revision !== stored.revision) throw new ImapConnectionError('MAIL_STALE');
				return { ok: true, value: accounts };
			}
			if (!request) throw new ImapConnectionError('MAIL_INVALID');
			const right: MailRight =
				operation === 'readBody'
					? 'detail'
					: operation === 'listAttachments' || operation === 'readAttachment'
						? 'attachments'
						: 'read';
			const account = authorizeMailAccount(
				policy,
				caller,
				right,
				request.accountId,
				request.accountRevision,
				request.mailbox
			);
			const authorize = async () => {
				await assertInvocation();
				const current = await platform.records.read(MAIL_POLICY_KEY);
				await assertInvocation();
				if (!current || current.revision !== stored.revision)
					throw new ImapConnectionError('MAIL_STALE');
				authorizeMailAccount(
					parseMailPolicy(current.value),
					caller,
					right,
					request.accountId,
					request.accountRevision,
					request.mailbox
				);
			};
			if (activeAccounts.has(account.accountId) || activeAccounts.size >= 4)
				throw new ImapConnectionError('MAIL_LIMIT');
			activeAccounts.add(account.accountId);
			reserved = account.accountId;
			await authorize();
			const stream = await openBrokerMailStream(platform, invocationId, account.endpoint);
			try {
				await authorize();
				session = await openMailSession(stream, authorize);
			} catch (error) {
				await stream.close().catch(() => {});
				throw error;
			}
			activeSessions.add(session);
			await session.execute({
				kind: 'login',
				username: account.username,
				secretRef: account.secretRef,
			});
			const namespace = await session.execute(
				{ kind: 'examine', mailbox: request.mailbox },
				request.uidValidity
			);
			if (namespace.kind !== 'examine') throw new ImapConnectionError('MAIL_PROTOCOL');
			let value: unknown;
			if (operation === 'searchHeaders') {
				if (!('fromUid' in request)) throw new ImapConnectionError('MAIL_INVALID');
				const criteria = request;
				const found = await session.execute(
					{
						kind: 'search',
						fromUid: criteria.fromUid,
						toUid: criteria.toUid,
						...(criteria.text === undefined ? {} : { text: criteria.text }),
					},
					namespace.uidValidity
				);
				if (found.kind !== 'search') throw new ImapConnectionError('MAIL_PROTOCOL');
				const page = found.uids.slice(0, 50);
				value = {
					references: page.map((uid) => ({
						accountId: account.accountId,
						accountRevision: account.revision,
						mailbox: request.mailbox,
						uidValidity: namespace.uidValidity,
						uid,
					})),
					...(found.uids.length > page.length ? { nextFromUid: found.uids[page.length] } : {}),
				};
			} else {
				if (!('uid' in request)) throw new ImapConnectionError('MAIL_INVALID');
				const reference = parseMailMessageReference({
					accountId: request.accountId,
					accountRevision: request.accountRevision,
					mailbox: request.mailbox,
					uidValidity: request.uidValidity,
					uid: request.uid,
				});
				const fetched = await session.execute(
					{
						kind: 'fetch',
						uid: reference.uid,
						content: operation === 'readHeaders' ? 'headers' : 'source',
					},
					reference.uidValidity
				);
				if (fetched.kind !== 'fetch') throw new ImapConnectionError('MAIL_PROTOCOL');
				try {
					if (operation === 'readHeaders')
						value = { reference, ...consumeMailHeaderDisplay(fetched.bytes) };
					else {
						content = consumeMailMimeContent(fetched.bytes);
						if (operation === 'readBody') {
							if (!content.body) throw new ImapConnectionError('MAIL_PROTOCOL');
							value = { reference, ...content.body };
						} else if (operation === 'listAttachments') {
							value = {
								reference,
								attachments: content.attachments.map(({ bytes: _, ...metadata }) => metadata),
							};
						} else {
							if (!('partId' in request) || typeof request.partId !== 'string')
								throw new ImapConnectionError('MAIL_INVALID');
							const partId = request.partId;
							const attachment = content.attachments.find((part) => part.partId === partId);
							if (!attachment) throw new ImapConnectionError('MAIL_INVALID');
							const { bytes, ...metadata } = attachment;
							// One complete decoded attachment per invocation; never combine
							// chunks from separate fetches or leave reusable snapshot handles.
							value = { reference, ...metadata, base64: bytes.toString('base64') };
						}
					}
				} finally {
					fetched.bytes.fill(0);
				}
			}
			await session.close();
			await authorize(); // Teardown and MIME work may race policy revocation.
			return { ok: true, value };
		} catch (error) {
			const safe = mailPlatformError(error);
			return { ok: false, error: { code: safe.code, message: safe.message } };
		} finally {
			content?.attachments.forEach((part) => part.bytes.fill(0));
			if (session) {
				await session.close().catch(() => {});
				activeSessions.delete(session);
			}
			if (reserved) activeAccounts.delete(reserved);
		}
	}
	return {
		invoke(operation: MailOperation, args: unknown, context: MailToolContext) {
			const work = invoke(operation, args, context);
			inflight.add(work);
			void work.finally(() => inflight.delete(work));
			return work;
		},
		async stop() {
			stopped = true;
			await Promise.allSettled([...activeSessions].map((session) => session.close()));
			await Promise.allSettled([...inflight]);
			activeSessions.clear();
		},
	};
}
