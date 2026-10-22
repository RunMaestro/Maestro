/**
 * A desktop a real `maestro-cli` process can reach from an opt-in end-to-end
 * test: a loopback WebSocket server that speaks the CLI bridge's address
 * (`ws://127.0.0.1:<port>/<token>/ws`), writes the discovery file the CLI
 * looks for, and hands every message to the product's own
 * `WebSocketMessageHandler`. So a verb run by a spawned agent goes through the
 * same dispatch and the same service function as it does against the app, and
 * only the transport's host is a stand-in.
 *
 * Messages that need a renderer (a tab, a toast, a dispatch) have no callback
 * here and are answered with the handler's own error. The ones that end in a
 * main-process service (`system_one_*`, `local_models_*`) work.
 *
 * NOT re-exported from `./index`: it opens a socket and writes a file.
 */

import { randomBytes } from 'crypto';
import type { IncomingMessage } from 'http';
import * as path from 'path';
import { WebSocketServer } from 'ws';
import type { WebClientMessage } from '../../main/web-server/handlers/messageHandlers/types';
import {
	deleteCliServerInfo,
	readCliServerInfo,
	writeCliServerInfo,
} from '../../shared/cli-server-discovery';

/** One message a CLI process sent, as far as a test needs to tell them apart. */
export interface CliBridgeMessage {
	type: string;
	/** The agent the CLI said it ran under (`MAESTRO_CALLER_AGENT_ID`). */
	fromSessionId?: string;
	fromTabId?: string;
}

export interface TestCliBridge {
	port: number;
	/** Every message received, in order. */
	messages: CliBridgeMessage[];
	/** Stop the server and remove the discovery file, if it is still this bridge's. */
	close: () => Promise<void>;
}

/**
 * Start the bridge and write its discovery file into `dataDir`.
 *
 * The discovery file's place is read from `MAESTRO_USER_DATA`, and with that
 * unset it is the LIVE app's folder, where writing would cut the user's real
 * CLI off from their running app. So this refuses unless the variable already
 * names `dataDir`.
 */
export async function startCliBridge(dataDir: string): Promise<TestCliBridge> {
	const pinned = process.env.MAESTRO_USER_DATA;
	if (!pinned || path.resolve(pinned) !== path.resolve(dataDir)) {
		throw new Error(
			`startCliBridge writes the CLI discovery file, so MAESTRO_USER_DATA must already name the test's own data folder (${dataDir}).`
		);
	}

	// Loaded here, after the check: the handler pulls in the main process's
	// services, which a caller that is refused never needs.
	const { WebSocketMessageHandler } =
		await import('../../main/web-server/handlers/messageHandlers/WebSocketMessageHandler');
	const token = randomBytes(16).toString('hex');
	const handler = new WebSocketMessageHandler();
	const messages: CliBridgeMessage[] = [];
	const server = new WebSocketServer({
		host: '127.0.0.1',
		port: 0,
		// The token in the path is the bridge's only credential, as in the app.
		verifyClient: ({ req }: { req: IncomingMessage }) => req.url === `/${token}/ws`,
	});
	await new Promise<void>((resolve, reject) => {
		server.once('listening', resolve);
		server.once('error', reject);
	});

	let clients = 0;
	server.on('connection', (socket) => {
		const client = { socket, id: `cli-${++clients}`, connectedAt: Date.now(), cli: true };
		socket.on('message', (data) => {
			let message: WebClientMessage;
			try {
				message = JSON.parse(data.toString()) as WebClientMessage;
			} catch {
				return;
			}
			const from = message as { fromSessionId?: unknown; fromTabId?: unknown };
			messages.push({
				type: message.type,
				...(typeof from.fromSessionId === 'string' ? { fromSessionId: from.fromSessionId } : {}),
				...(typeof from.fromTabId === 'string' ? { fromTabId: from.fromTabId } : {}),
			});
			handler.handleMessage(client, message);
		});
	});

	const address = server.address();
	if (address === null || typeof address === 'string') {
		throw new Error('The test CLI bridge has no port.');
	}
	const port = address.port;
	writeCliServerInfo({ port, token, pid: process.pid, startedAt: Date.now() });

	return {
		port,
		messages,
		close: async () => {
			if (readCliServerInfo()?.token === token) deleteCliServerInfo();
			for (const socket of server.clients) socket.terminate();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}
