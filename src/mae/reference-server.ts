// Reference implementation of the Maestro bridge / session-ingest host, used in
// dev and tests. It wraps the shared `bridge-core` with a node:http transport
// and in-memory handlers, and records what it received so tests can assert
// behavior. The real desktop host (src/main/mae) wraps the SAME core with
// real-service handlers, so this stays the literal spec.

import * as http from 'node:http';
import { randomUUID } from 'node:crypto';
import {
	type BridgeHandlers,
	type CueEntry,
	type HttpResult,
	type PlaybookEntry,
	type SessionListEntry,
	createBridgeCore,
} from './bridge-core';
import {
	BridgeErrorCode,
	type NotifyParams,
	type SessionEndParams,
	type SessionEventParams,
	type SessionRegisterParams,
	err,
} from './protocol';

export interface ReferenceStore {
	sessions: Map<string, SessionRegisterParams>;
	events: SessionEventParams[];
	ended: Map<string, SessionEndParams>;
	notifications: NotifyParams[];
	seedSessions: SessionListEntry[];
	seedPlaybooks: PlaybookEntry[];
	seedCues: CueEntry[];
}

export interface ReferenceServerOptions {
	secret?: string;
	seedSessions?: SessionListEntry[];
	seedPlaybooks?: PlaybookEntry[];
	seedCues?: CueEntry[];
}

export interface ReferenceServer {
	url: string;
	secret: string;
	store: ReferenceStore;
	close(): Promise<void>;
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
	}
	const raw = Buffer.concat(chunks).toString('utf8');
	if (raw.trim() === '') return undefined;
	try {
		return JSON.parse(raw);
	} catch {
		return undefined;
	}
}

function send(res: http.ServerResponse, result: HttpResult): void {
	res.writeHead(result.status, { 'content-type': 'application/json' });
	res.end(JSON.stringify(result.body));
}

export async function startReferenceServer(
	options: ReferenceServerOptions = {}
): Promise<ReferenceServer> {
	const secret = options.secret ?? randomUUID();
	const store: ReferenceStore = {
		sessions: new Map(),
		events: [],
		ended: new Map(),
		notifications: [],
		seedSessions: options.seedSessions ?? [],
		seedPlaybooks: options.seedPlaybooks ?? [],
		seedCues: options.seedCues ?? [],
	};

	const handlers: BridgeHandlers = {
		listSessions: async () => store.seedSessions,
		listPlaybooks: async () => store.seedPlaybooks,
		observeCues: async () => store.seedCues,
		toast: async (params) => {
			store.notifications.push(params);
		},
		registerSession: async (params) => {
			store.sessions.set(params.ompSessionId, params);
		},
		recordEvent: async (params) => {
			store.events.push(params);
		},
		endSession: async (params) => {
			store.ended.set(params.ompSessionId, params);
		},
	};

	const core = createBridgeCore({ secret, handlers });

	const server = http.createServer((req, res) => {
		void (async () => {
			const url = req.url ?? '';
			const method = req.method ?? 'GET';
			if (method === 'POST' && url === '/v1/sessions/issue') {
				send(res, core.issue(await readBody(req)));
				return;
			}
			if (method === 'POST' && url === '/v1/bridge') {
				send(res, await core.handle(req.headers.authorization, await readBody(req)));
				return;
			}
			send(res, { status: 404, body: err(BridgeErrorCode.UnknownVerb, 'not found') });
		})();
	});

	const { promise: listening, resolve: onListening } = Promise.withResolvers<void>();
	server.listen(0, '127.0.0.1', () => onListening());
	await listening;
	const address = server.address();
	const port = typeof address === 'object' && address !== null ? address.port : 0;
	return {
		url: `http://127.0.0.1:${port}`,
		secret,
		store,
		close: () => {
			const { promise, resolve } = Promise.withResolvers<void>();
			server.close(() => resolve());
			return promise;
		},
	};
}
