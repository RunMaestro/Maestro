import { createConnection } from 'net';
import { readFile } from 'fs/promises';
import * as path from 'path';
import {
	LITE_CONTROL_DISCOVERY_FILE,
	LITE_CONTROL_PROTOCOL_VERSION,
	LITE_CONTROL_MAX_BYTES,
	resolveLiteDataDirectory,
	isLiteControlEndpoint,
} from '../../shared/lite-control';
import type {
	LiteControlAction,
	LiteControlDiscovery,
	LiteControlReply,
	LiteControlRequest,
} from '../../shared/lite-control';

export interface LiteClientOptions {
	userData?: string;
	confirmed?: boolean;
}

/** One command, one OS-local connection; never retries potentially mutating actions. */
export async function sendLiteCommand(
	action: LiteControlAction,
	payload?: unknown,
	options: LiteClientOptions = {}
): Promise<LiteControlReply> {
	const directory = resolveLiteDataDirectory(options.userData);
	let discovery: LiteControlDiscovery;
	try {
		discovery = JSON.parse(
			await readFile(path.join(directory, LITE_CONTROL_DISCOVERY_FILE), 'utf8')
		) as LiteControlDiscovery;
	} catch (error) {
		throw new Error(
			`Cannot discover running Maestro Lite at ${directory}. Start Maestro --lite with the same user-data directory. ${error instanceof Error ? error.message : String(error)}`
		);
	}
	if (discovery?.protocolVersion !== LITE_CONTROL_PROTOCOL_VERSION)
		throw new Error(
			'Unsupported Lite control protocol. Rebuild/restart Lite and maestro-cli together.'
		);
	if (
		typeof discovery.secret !== 'string' ||
		!/^[a-f0-9]{64}$/.test(discovery.secret) ||
		!isLiteControlEndpoint(discovery.endpoint)
	) {
		throw new Error('Invalid Lite local control discovery. Restart Maestro Lite.');
	}
	const request: LiteControlRequest = {
		protocolVersion: LITE_CONTROL_PROTOCOL_VERSION,
		secret: discovery.secret,
		action,
		payload,
		confirmed: options.confirmed,
	};
	const encoded = JSON.stringify(request) + '\n';
	if (Buffer.byteLength(encoded) > LITE_CONTROL_MAX_BYTES)
		throw new Error('Lite control request is too large.');
	const { promise, resolve, reject } = Promise.withResolvers<LiteControlReply>();
	const socket = createConnection(discovery.endpoint);
	let finished = false;
	let input = '';
	let bytes = 0;
	const finish = (error?: Error, reply?: LiteControlReply): void => {
		if (finished) return;
		finished = true;
		socket.destroy();
		if (error) reject(error);
		else resolve(reply!);
	};
	socket.setTimeout(120_000, () =>
		finish(
			new Error(
				'Lite command timed out. Its outcome may be uncertain; inspect lite status before acting again.'
			)
		)
	);
	socket.setEncoding('utf8');
	socket.on('connect', () => socket.write(encoded));
	socket.on('error', (error) =>
		finish(
			new Error(
				`Cannot reach Maestro Lite at ${directory}: ${error.message}. The command is not retried.`
			)
		)
	);
	socket.on('close', () =>
		finish(
			new Error(
				'Lite closed before acknowledging the command. Its outcome may be uncertain; inspect lite status before acting again.'
			)
		)
	);
	socket.on('data', (chunk: string) => {
		bytes += Buffer.byteLength(chunk);
		if (bytes > LITE_CONTROL_MAX_BYTES) {
			finish(new Error('Lite control response is too large.'));
			return;
		}
		input += chunk;
		if (!input.includes('\n')) return;
		try {
			const reply = JSON.parse(input) as LiteControlReply;
			if (!reply || typeof reply.success !== 'boolean')
				throw new Error('Invalid Lite control response.');
			finish(undefined, reply);
		} catch (error) {
			finish(error instanceof Error ? error : new Error(String(error)));
		}
	});
	return promise;
}
