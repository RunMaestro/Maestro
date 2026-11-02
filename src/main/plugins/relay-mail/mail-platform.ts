import { ImapConnectionError } from './mail-errors';
import type { MailByteStream } from './mail-session';
import { decodeMailBase64 } from './mail-transfer-decoding';

/** Existing brokered JSON transport, narrowed to the read executor needs. */
export interface MailPlatform {
	invocations: { inspect(invocationId: string): Promise<{ callerAgentId: string; active: true }> };
	records: {
		read(key: string): Promise<{ revision: number; value: unknown } | null>;
	};
	net: {
		tlsOpen(input: {
			host: string;
			port: number;
			invocationId: string;
		}): Promise<{ streamId: string }>;
		tlsRead(input: {
			streamId: string;
			invocationId: string;
			maxBytes: number;
		}): Promise<{ base64: string; eof: boolean }>;
		tlsWrite(input: {
			streamId: string;
			invocationId: string;
			parts: ({ base64: string } | { secretRef: string; encoding: 'quoted-ascii' })[];
		}): Promise<{ writtenBytes: number }>;
		tlsClose(input: { streamId: string }): Promise<{ closed: true }>;
	};
}

/** Broker error details never escape as mail errors or logs. */
export function mailPlatformError(error: unknown): ImapConnectionError {
	if (error instanceof ImapConnectionError) return error;
	// The JSON envelope carries errorCode; the sandbox SDK exposes it as Error.code.
	const code =
		error && typeof error === 'object' && 'code' in error
			? error.code
			: error && typeof error === 'object' && 'errorCode' in error
				? error.errorCode
				: null;
	return new ImapConnectionError(
		code === 'PLUGIN_DENIED'
			? 'MAIL_DENIED'
			: code === 'PLUGIN_CANCELED'
				? 'MAIL_CANCELED'
				: code === 'PLUGIN_TIMEOUT'
					? 'MAIL_TIMEOUT'
					: code === 'PLUGIN_LIMIT'
						? 'MAIL_LIMIT'
						: code === 'PLUGIN_INVALID'
							? 'MAIL_INVALID'
							: code === 'PLUGIN_CONFLICT'
								? 'MAIL_STALE'
								: 'MAIL_UNAVAILABLE'
	);
}

async function broker<T>(work: Promise<T>): Promise<T> {
	try {
		return await work;
	} catch (error) {
		throw mailPlatformError(error);
	}
}

export async function openBrokerMailStream(
	platform: MailPlatform,
	invocationId: string,
	endpoint: { host: string; port: number }
): Promise<MailByteStream> {
	const { streamId } = await broker(platform.net.tlsOpen({ ...endpoint, invocationId }));
	if (typeof streamId !== 'string' || !streamId) throw new ImapConnectionError('MAIL_UNAVAILABLE');
	let closed = false;
	return {
		async read() {
			if (closed) throw new ImapConnectionError('MAIL_CANCELED');
			const reply = await broker(
				platform.net.tlsRead({ streamId, invocationId, maxBytes: 64 * 1024 })
			);
			if (
				!reply ||
				typeof reply.eof !== 'boolean' ||
				typeof reply.base64 !== 'string' ||
				reply.base64.length > 4 * Math.ceil((64 * 1024) / 3)
			)
				throw new ImapConnectionError('MAIL_PROTOCOL');
			const bytes = decodeMailBase64(reply.base64, 64 * 1024);
			if (!bytes.length && !reply.eof) {
				bytes.fill(0);
				throw new ImapConnectionError('MAIL_PROTOCOL');
			}
			if (reply.eof && !bytes.length) return null;
			return bytes;
		},
		async write(bytes) {
			if (closed) throw new ImapConnectionError('MAIL_CANCELED');
			await broker(
				platform.net.tlsWrite({
					streamId,
					invocationId,
					parts: [{ base64: bytes.toString('base64') }],
				})
			);
		},
		async writeSecret(prefix, secretRef, suffix) {
			if (closed) throw new ImapConnectionError('MAIL_CANCELED');
			await broker(
				platform.net.tlsWrite({
					streamId,
					invocationId,
					parts: [
						{ base64: prefix.toString('base64') },
						{ secretRef, encoding: 'quoted-ascii' },
						{ base64: suffix.toString('base64') },
					],
				})
			);
		},
		async close() {
			if (closed) return;
			await broker(platform.net.tlsClose({ streamId }));
			closed = true;
		},
	};
}
