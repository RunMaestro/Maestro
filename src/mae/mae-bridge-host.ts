// The Maestro bridge / session-ingest host: a loopback-only (127.0.0.1) HTTP
// server the desktop app runs so external `omp`/`mae` sessions can be tracked
// and can call the Maestro toolset. It wraps the shared `bridge-core` (the
// security model) with a node:http transport and writes/removes the discovery
// file.
//
// App-agnostic on purpose: the caller injects `BridgeHandlers` built from real
// Maestro services (sessions store, CueEngine, Electron Notification, the
// renderer session-push). It binds 127.0.0.1 ONLY - never the LAN - so the
// bootstrap-secret exchange and ingest are not remotely reachable.

import * as http from 'node:http';
import { randomUUID } from 'node:crypto';
import {
	type AuditEntry,
	type BridgeHandlers,
	type HttpResult,
	type RateLimits,
	createBridgeCore,
} from './bridge-core';
import { BridgeErrorCode, err } from './protocol';
import {
	type MaeEnv,
	bridgeDiscoveryPath,
	removeBridgeDiscovery,
	writeBridgeDiscovery,
} from './paths';

export interface BridgeHostOptions {
	handlers: BridgeHandlers;
	/** Env used to resolve the discovery file path. Defaults to process.env. */
	env?: MaeEnv;
	/** Bootstrap secret. Defaults to a random uuid (rotated per app launch). */
	secret?: string;
	/** Bind host. Defaults to 127.0.0.1 (loopback only); do not change in prod. */
	host?: string;
	/** Bind port. Defaults to 0 (ephemeral). */
	port?: number;
	rate?: RateLimits;
	audit?: (entry: AuditEntry) => void;
	/** Write the discovery file on start / remove on close. Default true. */
	writeDiscovery?: boolean;
}

export interface BridgeHost {
	url: string;
	secret: string;
	port: number;
	discoveryPath: string | undefined;
	/** Drop every token bound to a run (e.g. when the omp child exits). */
	revokeRun(runId: string): void;
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

export async function startBridgeHost(options: BridgeHostOptions): Promise<BridgeHost> {
	const env = options.env ?? process.env;
	const host = options.host ?? '127.0.0.1';
	// Loopback-only invariant (W5): never let a caller reintroduce LAN exposure
	// of the bootstrap-secret exchange / ingest by binding a routable address.
	if (host !== '127.0.0.1' && host !== '::1' && host !== 'localhost') {
		throw new Error(`mae bridge host must bind loopback only (got "${host}")`);
	}
	const secret = options.secret ?? randomUUID();
	const core = createBridgeCore({
		secret,
		handlers: options.handlers,
		rate: options.rate,
		audit: options.audit,
	});

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

	const { promise: listening, resolve, reject } = Promise.withResolvers<void>();
	const onStartupError = (error: Error): void => reject(error);
	server.once('error', onStartupError);
	server.listen(options.port ?? 0, host, () => {
		server.removeListener('error', onStartupError);
		server.on('error', () => undefined); // ignore transient post-startup errors
		resolve();
	});
	await listening;

	const address = server.address();
	const port = typeof address === 'object' && address !== null ? address.port : 0;
	const url = `http://${host}:${port}`;

	let discoveryPath: string | undefined;
	if (options.writeDiscovery !== false) {
		discoveryPath = bridgeDiscoveryPath(env);
		try {
			await writeBridgeDiscovery(discoveryPath, { url, secret });
		} catch (error) {
			// Never leak a live loopback server (holding the secret) if discovery
			// write fails: tear it down before surfacing the error.
			const { promise, resolve: done } = Promise.withResolvers<void>();
			server.close(() => done());
			await promise;
			throw error;
		}
	}

	return {
		url,
		secret,
		port,
		discoveryPath,
		revokeRun: (runId: string) => core.revokeRun(runId),
		close: async () => {
			if (discoveryPath) await removeBridgeDiscovery(discoveryPath);
			const { promise, resolve: done } = Promise.withResolvers<void>();
			server.close(() => done());
			return promise;
		},
	};
}
