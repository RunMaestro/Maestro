import { Buffer } from 'node:buffer';
import { ImapConnectionError, type MailErrorCode } from './mail-errors';
import { ImapFramingError, ImapResponseDecoder, type ImapResponseFrame } from './mail-imap-framing';
import {
	prepareImapCommand,
	validateImapCommandResult,
	validateImapStatusCode,
	eraseImapFrameLiterals,
	type FixedImapCommand,
	type ImapCommandResult,
} from './mail-imap-commands';

/** Internal adapter: production uses only the consented Host TLS broker.
 * Owned read/write bytes never cross the public mail tool interface. */
export interface MailByteStream {
	read(): Promise<Buffer | null>;
	write(bytes: Buffer): Promise<void>;
	writeSecret(prefix: Buffer, secretRef: string, suffix: Buffer): Promise<void>;
	close(): Promise<void>;
}

type SessionCommand =
	| Exclude<FixedImapCommand, { kind: 'login' }>
	| { kind: 'login'; username: string; secretRef: string };

/** Host-owned read-only protocol policy over the existing TLS and secret broker. */
export async function openMailSession(stream: MailByteStream, authorize: () => Promise<void>) {
	const decoder = new ImapResponseDecoder();
	const admittedAt = Date.now();
	let authenticated = false;
	let namespace: string | undefined;
	let sequence = 0;
	let busy = false;
	let terminal: ImapConnectionError | undefined;
	let closing: Promise<void> | undefined;
	const frames: ImapResponseFrame[] = [];

	function sanitize(error: unknown): ImapConnectionError {
		return new ImapConnectionError(
			error instanceof ImapConnectionError || error instanceof ImapFramingError
				? error.code
				: 'MAIL_UNAVAILABLE'
		);
	}
	function stop(code: MailErrorCode) {
		terminal ??= new ImapConnectionError(code);
		eraseImapFrameLiterals(frames);
		frames.length = 0;
		decoder.dispose();
		closing ??= Promise.resolve().then(() => stream.close());
		// The initiating operation still awaits cleanup and reports fixed errors.
		void closing.catch(() => {});
		return closing;
	}
	async function active() {
		if (terminal) throw terminal;
		if (Date.now() - admittedAt >= (authenticated ? 30_000 : 10_000)) {
			await stop('MAIL_TIMEOUT');
			throw terminal;
		}
		try {
			await authorize();
		} catch {
			await stop('MAIL_DENIED');
			throw terminal;
		}
		if (terminal) throw terminal;
		if (Date.now() - admittedAt >= (authenticated ? 30_000 : 10_000)) {
			await stop('MAIL_TIMEOUT');
			throw terminal;
		}
	}
	async function receive() {
		await active();
		const bytes = await stream.read();
		try {
			await active();
			if (bytes === null) {
				decoder.finish();
				throw new ImapConnectionError('MAIL_UNAVAILABLE');
			}
			if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 64 * 1024)
				throw new ImapConnectionError('MAIL_PROTOCOL');
			const batch = decoder.push(bytes);
			frames.push(...batch);
			return batch;
		} finally {
			bytes?.fill(0);
		}
	}
	try {
		decoder.setLiteralLimit(0);
		while (!frames.length) await receive();
		if (
			frames.length !== 1 ||
			frames[0].kind !== 'status' ||
			frames[0].tag !== null ||
			frames[0].status !== 'OK'
		)
			throw new ImapConnectionError('MAIL_PROTOCOL');
		validateImapStatusCode('greeting', frames[0].text);
		decoder.setLiteralLimit(0); // Also rejects trailing partial records.
		frames.length = 0;
		await active();
	} catch (error) {
		const safe = sanitize(error);
		await stop(safe.code).catch(() => {});
		throw safe;
	}

	return {
		async execute(
			command: SessionCommand,
			expectedUidValidity?: string
		): Promise<ImapCommandResult> {
			if (busy) throw new ImapConnectionError('MAIL_LIMIT');
			busy = true;
			let wire: Buffer | undefined;
			let result: ImapCommandResult | undefined;
			try {
				await active();
				if (++sequence > 64) throw new ImapConnectionError('MAIL_LIMIT');
				if (
					command.kind === 'login' &&
					(typeof command.secretRef !== 'string' ||
						!/^[A-Za-z0-9._-]{1,256}$/.test(command.secretRef))
				)
					throw new ImapConnectionError('MAIL_INVALID');
				// The secret never enters Relay. Use the canonical encoder to validate
				// username/LOGIN syntax, then replace only its empty quoted password.
				const prepared = prepareImapCommand(
					`A${sequence}`,
					command.kind === 'login'
						? { kind: 'login', username: command.username, password: '' }
						: command
				);
				wire = prepared.bytes;
				if ((prepared.kind === 'login') === authenticated)
					throw new ImapConnectionError('MAIL_INVALID');
				if (
					['search', 'fetch', 'metadata'].includes(prepared.kind) &&
					(!namespace || expectedUidValidity !== namespace)
				)
					throw new ImapConnectionError('MAIL_STALE');
				decoder.setLiteralLimit(prepared.literalLimit ?? 0);
				await active();
				try {
					if (command.kind === 'login')
						await stream.writeSecret(wire.slice(0, -4), command.secretRef, wire.slice(-2));
					else await stream.write(wire);
				} finally {
					wire.fill(0);
					wire = undefined;
				}
				await active();
				for (;;) {
					const batch = await receive();
					const tagged = batch.findIndex((frame) => frame.kind === 'status' && frame.tag !== null);
					if (tagged < 0) continue;
					if (tagged !== batch.length - 1) throw new ImapConnectionError('MAIL_PROTOCOL');
					break;
				}
				result = validateImapCommandResult(prepared, frames);
				decoder.setLiteralLimit(prepared.literalLimit ?? 0);
				if (result.kind === 'examine') {
					if (expectedUidValidity !== undefined && result.uidValidity !== expectedUidValidity)
						throw new ImapConnectionError('MAIL_STALE');
					namespace = result.uidValidity;
				}
				await active();
				if (prepared.kind === 'login') authenticated = true;
				frames.length = 0; // Validated FETCH transfers its sole owned literal.
				if (prepared.kind === 'logout') await stop('MAIL_CANCELED');
				return result;
			} catch (error) {
				if (result?.kind === 'fetch') result.bytes.fill(0);
				const safe = sanitize(error);
				await stop(safe.code).catch(() => {});
				throw safe;
			} finally {
				wire?.fill(0);
				busy = false;
			}
		},
		async close() {
			await stop('MAIL_CANCELED');
		},
	};
}
