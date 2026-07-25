/**
 * Shared local HTTP listener for `webhook.received` Cue subscriptions.
 *
 * One process-wide listener serves every webhook subscription across every
 * agent, because a port can only be bound once. Subscriptions register a path
 * segment plus their own authentication material; the server fans a delivery
 * out to every registration on that path that authenticates successfully.
 * That keeps two projects on the same machine from reading each other's
 * payloads even though they share a socket.
 *
 * Lifecycle is refcounted: the socket is opened on the first registration and
 * closed once the last one unregisters, so a user with no webhook pipelines
 * never has a listening port at all.
 *
 * Security posture:
 *  - Binds to 127.0.0.1 unless `MAESTRO_CUE_WEBHOOK_HOST` says otherwise. To
 *    take deliveries from the internet, front the loopback port with a tunnel
 *    (ngrok, cloudflared) or reverse proxy rather than exposing it directly.
 *  - Every registration must carry a secret. Requests are authenticated with
 *    a timing-safe comparison, either by presented secret or by HMAC-SHA256
 *    over the raw body (GitHub / GitLab `sha256=<hex>` style).
 *  - Auth material is stripped from the headers that reach the event payload,
 *    so secrets never land in a prompt, the activity log, or the Cue DB.
 */

import * as crypto from 'crypto';
import * as http from 'http';
import { normalizeWebhookPath } from '../../shared/cue';
import type { MainLogLevel } from '../../shared/logger-types';
import { captureException } from '../utils/sentry';

/** Default port for the Cue webhook listener. Override with `MAESTRO_CUE_WEBHOOK_PORT`. */
export const DEFAULT_CUE_WEBHOOK_PORT = 17997;

/** Reject bodies larger than this outright - a webhook payload that big is a
 *  misconfiguration, and buffering it would let an unauthenticated caller
 *  balloon main-process memory before we ever check the secret. */
const MAX_BODY_BYTES = 1024 * 1024;

/** Raw body retained on the event payload. Payloads are persisted with the run,
 *  so the full megabyte is not worth keeping once filters have run. */
const MAX_STORED_RAW_BODY = 64 * 1024;

/** Headers that carry authentication material and must never reach a payload. */
const REDACTED_HEADERS = new Set([
	'authorization',
	'proxy-authorization',
	'cookie',
	'x-maestro-cue-secret',
]);

/** A single accepted webhook delivery, as handed to a trigger source. */
export interface CueWebhookDelivery {
	/** Normalized path segment the delivery arrived on (no leading slash). */
	path: string;
	/** Vendor event name, read from the usual `X-*-Event` headers. Empty when
	 *  the sender does not supply one. */
	event: string;
	/** Vendor delivery id when supplied, otherwise a locally generated UUID. */
	deliveryId: string;
	/** ISO-8601 receipt timestamp. */
	receivedAt: string;
	/** Request headers with auth material redacted. Lowercased keys. */
	headers: Record<string, string>;
	/** Parsed JSON body, or `null` when the body was not valid JSON. */
	body: unknown;
	/** Raw request body, truncated to {@link MAX_STORED_RAW_BODY}. */
	rawBody: string;
}

/** What a `webhook.received` subscription registers with the shared server. */
export interface CueWebhookRegistration {
	/** Path segment under `/cue/`. Already normalized by the caller. */
	path: string;
	/** Shared secret this registration authenticates with. */
	secret: string;
	/** When set, authenticate by HMAC-SHA256 over the raw body using this
	 *  header instead of expecting the secret to be presented directly. */
	signatureHeader?: string;
	/** Called once per authenticated delivery. */
	onDelivery: (delivery: CueWebhookDelivery) => void;
	/** Logger for this registration's owning session. */
	onLog: (level: MainLogLevel, message: string) => void;
}

const registrations = new Set<CueWebhookRegistration>();
let server: http.Server | null = null;
/** Port the socket actually bound to. Differs from the configured port only
 *  when the user asked for `0` (OS-assigned). Null until `listen` succeeds. */
let boundPort: number | null = null;
/** Set once we fail to bind so a broken port doesn't log on every delivery
 *  attempt or retry-storm across session refreshes. */
let bindFailed = false;

/**
 * Configured listener port. Invalid env values fall back to the default.
 * `0` is honored as "let the OS pick a free port", matching the convention
 * `WebServer` already uses; {@link buildCueWebhookUrl} then reports whatever
 * port the socket actually landed on.
 */
export function getCueWebhookPort(): number {
	const raw = process.env.MAESTRO_CUE_WEBHOOK_PORT;
	if (!raw) return DEFAULT_CUE_WEBHOOK_PORT;
	const parsed = Number(raw);
	if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
		return DEFAULT_CUE_WEBHOOK_PORT;
	}
	return parsed;
}

/** Resolved bind host. Loopback unless the user explicitly widens it. */
export function getCueWebhookHost(): string {
	const raw = process.env.MAESTRO_CUE_WEBHOOK_HOST?.trim();
	return raw ? raw : '127.0.0.1';
}

/** Delivery URL for a path, for display in logs and the pipeline editor.
 *  Prefers the port the socket actually bound to, which is the only useful
 *  value when the user configured port `0`. */
export function buildCueWebhookUrl(path: string): string {
	return `http://${getCueWebhookHost()}:${boundPort ?? getCueWebhookPort()}/cue/${path}`;
}

/**
 * Compare two secrets without leaking length or content through timing.
 * `timingSafeEqual` requires equal-length buffers, so both sides are hashed
 * first - that makes every comparison fixed-width regardless of input.
 */
function secureEquals(a: string, b: string): boolean {
	const ha = crypto.createHash('sha256').update(a).digest();
	const hb = crypto.createHash('sha256').update(b).digest();
	return crypto.timingSafeEqual(ha, hb);
}

/**
 * Does this delivery authenticate against `reg`?
 *
 * HMAC mode (registration has `signatureHeader`) compares an HMAC-SHA256 of
 * the raw body, accepting both the bare hex digest and the `sha256=<hex>`
 * prefix GitHub and GitLab send. Otherwise the secret must be presented
 * directly via `X-Maestro-Cue-Secret` or `Authorization: Bearer`.
 */
function authenticates(
	reg: CueWebhookRegistration,
	headers: http.IncomingHttpHeaders,
	rawBody: string
): boolean {
	if (reg.signatureHeader) {
		const presented = headers[reg.signatureHeader.toLowerCase()];
		if (typeof presented !== 'string' || presented.length === 0) return false;
		const digest = crypto.createHmac('sha256', reg.secret).update(rawBody).digest('hex');
		const stripped = presented.startsWith('sha256=')
			? presented.slice('sha256='.length)
			: presented;
		return secureEquals(stripped, digest);
	}

	const direct = headers['x-maestro-cue-secret'];
	if (typeof direct === 'string' && secureEquals(direct, reg.secret)) return true;

	const auth = headers.authorization;
	if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
		return secureEquals(auth.slice('Bearer '.length), reg.secret);
	}

	return false;
}

/** Copy request headers, dropping auth material and this registration's
 *  signature header so nothing sensitive reaches the event payload. */
function sanitizeHeaders(
	headers: http.IncomingHttpHeaders,
	signatureHeader: string | undefined
): Record<string, string> {
	const signature = signatureHeader?.toLowerCase();
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		if (value === undefined) continue;
		if (REDACTED_HEADERS.has(key) || key === signature) continue;
		out[key] = Array.isArray(value) ? value.join(', ') : value;
	}
	return out;
}

/** Vendor event name, best-effort across the common webhook providers. */
function resolveVendorEvent(headers: http.IncomingHttpHeaders): string {
	const candidates = ['x-maestro-event', 'x-github-event', 'x-gitlab-event', 'x-event-key'];
	for (const key of candidates) {
		const value = headers[key];
		if (typeof value === 'string' && value.length > 0) return value;
	}
	return '';
}

/** Vendor delivery id, falling back to a locally generated one. */
function resolveDeliveryId(headers: http.IncomingHttpHeaders): string {
	const candidates = ['x-github-delivery', 'x-request-id', 'x-maestro-delivery'];
	for (const key of candidates) {
		const value = headers[key];
		if (typeof value === 'string' && value.length > 0) return value;
	}
	return crypto.randomUUID();
}

function respond(res: http.ServerResponse, status: number, body: Record<string, unknown>): void {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		'content-type': 'application/json',
		'content-length': Buffer.byteLength(payload),
	});
	res.end(payload);
}

/** Read the request body, aborting once it exceeds {@link MAX_BODY_BYTES}. */
function readBody(req: http.IncomingMessage): Promise<string | null> {
	return new Promise((resolve) => {
		const chunks: Buffer[] = [];
		let size = 0;
		let aborted = false;

		req.on('data', (chunk: Buffer) => {
			if (aborted) return;
			size += chunk.length;
			if (size > MAX_BODY_BYTES) {
				aborted = true;
				resolve(null);
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on('end', () => {
			if (!aborted) resolve(Buffer.concat(chunks).toString('utf8'));
		});
		req.on('error', () => {
			if (!aborted) {
				aborted = true;
				resolve(null);
			}
		});
	});
}

/**
 * Handle one inbound request. Exported for tests so the routing, auth, and
 * fan-out rules can be exercised without binding a real socket.
 */
export async function handleCueWebhookRequest(
	req: http.IncomingMessage,
	res: http.ServerResponse
): Promise<void> {
	if (req.method !== 'POST') {
		respond(res, 405, { error: 'Only POST is accepted' });
		return;
	}

	// `req.url` is path + query; the query string is not part of the route.
	const pathname = (req.url ?? '').split('?')[0];
	const match = /^\/cue\/(.+)$/.exec(pathname);
	if (!match) {
		respond(res, 404, { error: 'Unknown webhook path' });
		return;
	}
	const path = normalizeWebhookPath(decodeURIComponent(match[1]));

	const targets = [...registrations].filter((reg) => reg.path === path);
	if (targets.length === 0) {
		respond(res, 404, { error: 'Unknown webhook path' });
		return;
	}

	const rawBody = await readBody(req);
	if (rawBody === null) {
		respond(res, 413, { error: 'Payload too large' });
		return;
	}

	const authenticated = targets.filter((reg) => authenticates(reg, req.headers, rawBody));
	if (authenticated.length === 0) {
		// Log against every subscription on this path: the operator needs to
		// know which pipeline was targeted by a rejected delivery.
		for (const reg of targets) {
			reg.onLog('warn', `[CUE] webhook delivery to "/cue/${path}" rejected (bad secret)`);
		}
		respond(res, 401, { error: 'Unauthorized' });
		return;
	}

	// Parse once and share the result: JSON.parse on a megabyte per matching
	// subscription is wasted work, and every consumer wants the same object.
	let parsed: unknown = null;
	try {
		parsed = rawBody.length > 0 ? JSON.parse(rawBody) : null;
	} catch {
		// Non-JSON bodies (form posts, plain text) are legitimate - the raw body
		// still reaches the prompt via {{CUE_WEBHOOK_BODY}}.
		parsed = null;
	}

	const event = resolveVendorEvent(req.headers);
	const deliveryId = resolveDeliveryId(req.headers);
	const receivedAt = new Date().toISOString();
	const truncatedRaw =
		rawBody.length > MAX_STORED_RAW_BODY ? rawBody.slice(0, MAX_STORED_RAW_BODY) : rawBody;

	for (const reg of authenticated) {
		reg.onDelivery({
			path,
			event,
			deliveryId,
			receivedAt,
			headers: sanitizeHeaders(req.headers, reg.signatureHeader),
			body: parsed,
			rawBody: truncatedRaw,
		});
	}

	respond(res, 202, { accepted: authenticated.length });
}

/** Open the shared socket if it isn't already listening. */
function ensureServerStarted(onLog: (level: MainLogLevel, message: string) => void): void {
	if (server || bindFailed) return;

	const port = getCueWebhookPort();
	const host = getCueWebhookHost();

	const instance = http.createServer((req, res) => {
		void handleCueWebhookRequest(req, res).catch((err) => {
			// A throw here means a bug in our own handler, not a bad request -
			// answer the caller and report it rather than hanging the socket.
			respond(res, 500, { error: 'Internal error' });
			void captureException(err, { operation: 'cueWebhookRequest' });
		});
	});

	instance.on('error', (err: NodeJS.ErrnoException) => {
		bindFailed = true;
		server = null;
		boundPort = null;
		const detail =
			err.code === 'EADDRINUSE'
				? `port ${port} is already in use - set MAESTRO_CUE_WEBHOOK_PORT to a free port and restart Maestro`
				: err.message;
		onLog('error', `[CUE] webhook listener failed to start: ${detail}`);
	});

	instance.listen(port, host, () => {
		const address = instance.address();
		boundPort = address && typeof address === 'object' ? address.port : port;
		onLog('cue', `[CUE] webhook listener started on http://${host}:${boundPort}/cue/`);
	});

	server = instance;
}

/** Close the shared socket once nothing is registered against it. */
function stopServerIfIdle(): void {
	if (registrations.size > 0 || !server) return;
	const instance = server;
	server = null;
	boundPort = null;
	bindFailed = false;
	instance.close();
}

/**
 * Register a webhook subscription with the shared listener.
 *
 * Returns an unregister function; the trigger source calls it from `stop()`,
 * which also tears the socket down when it removes the last registration.
 */
export function registerCueWebhook(reg: CueWebhookRegistration): () => void {
	registrations.add(reg);
	ensureServerStarted(reg.onLog);

	let released = false;
	return () => {
		if (released) return; // idempotent - trigger source stop() may repeat
		released = true;
		registrations.delete(reg);
		stopServerIfIdle();
	};
}

/** Test-only: drop all registrations and close the socket. */
export function resetCueWebhookServerForTests(): void {
	registrations.clear();
	bindFailed = false;
	boundPort = null;
	if (server) {
		server.close();
		server = null;
	}
}
