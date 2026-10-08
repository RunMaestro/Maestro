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
 * never has a listening port at all. The exception is a hold
 * ({@link holdCueWebhookListener}): while an engine drains, a registration
 * that unregisters stays behind as a stand-in that authenticates as before
 * and answers 503 with `Retry-After`, and the socket stays bound until the
 * hold is released.
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
import { claimWebhookDelivery, isWebhookDeliveryClaimed } from './cue-db';

/** Default port for the Cue webhook listener. Override with `MAESTRO_CUE_WEBHOOK_PORT`. */
export const DEFAULT_CUE_WEBHOOK_PORT = 17997;

/** Reject bodies larger than this outright - a webhook payload that big is a
 *  misconfiguration, and buffering it would let an unauthenticated caller
 *  balloon main-process memory before we ever check the secret. */
const MAX_BODY_BYTES = 1024 * 1024;

/** After a 413, how much more of an oversized body we will read and throw away
 *  so the answer reaches the sender (closing a socket with unread input makes
 *  TCP reset it, which can discard the 413 in flight). Past this, or past
 *  {@link OVERSIZE_DRAIN_MS}, the connection is simply dropped. */
const OVERSIZE_DRAIN_BYTES = 8 * MAX_BODY_BYTES;
const OVERSIZE_DRAIN_MS = 5_000;

/** Raw body retained on the event payload. Payloads are persisted with the run,
 *  so the full megabyte is not worth keeping once filters have run. */
const MAX_STORED_RAW_BODY = 64 * 1024;

/** `Retry-After` on a 503: how soon a sender should try again while Cue is
 *  off or stopping. Short, since a restart is usually quick. */
export const WEBHOOK_RETRY_AFTER_SECONDS = 30;

/**
 * Thrown by a subscriber that cannot take a delivery because Cue is not
 * running (switched off, or stopping). Answered 503 with `Retry-After`, and
 * nothing is recorded, so the retry is handled once Cue runs. A delivery
 * Maestro will not act on is never acknowledged.
 */
export class CueWebhookUnavailableError extends Error {
	constructor(message = 'Cue is not running') {
		super(message);
		this.name = 'CueWebhookUnavailableError';
	}
}

/** Bind hosts that keep the listener on the local machine. Anything else gets
 *  a warning at startup, since it exposes an agent trigger to the network. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

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
	/**
	 * Stable identity of the subscriber (its subscription id). Redelivery
	 * dedupe is kept per subscriber, so a retry reaches only the ones that
	 * failed the first time.
	 */
	id: string;
	/** Path segment under `/cue/`. Already normalized by the caller. */
	path: string;
	/** Shared secret this registration authenticates with. */
	secret: string;
	/** When set, authenticate by HMAC-SHA256 over the raw body using this
	 *  header instead of expecting the secret to be presented directly. */
	signatureHeader?: string;
	/**
	 * Called once per authenticated delivery. The delivery is ACKNOWLEDGED
	 * (answered 2xx) only once this returns or its promise resolves, so it must
	 * not settle before the event has reached the run manager (or was
	 * deliberately dropped). Throwing or rejecting answers 5xx (503 for a
	 * {@link CueWebhookUnavailableError}) and records nothing, so the sender
	 * may retry. `accepted()` records the delivery id as
	 * handled; call it in the same step that hands the event on, so a drain
	 * waiting on the source covers it. It is also called on success if the
	 * subscriber did not.
	 */
	onDelivery: (delivery: CueWebhookDelivery, accepted: () => void) => void | Promise<void>;
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
/** Open holds; see {@link holdCueWebhookListener}. */
let holds = 0;
/** Stand-ins for registrations released while held (see `registerCueWebhook`). */
const standIns = new Set<CueWebhookRegistration>();

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
 *
 * The HMAC is taken over the received *bytes*, not a decoded string. Senders
 * sign the wire bytes, and round-tripping a non-UTF-8 body through
 * `toString('utf8')` substitutes U+FFFD for invalid sequences - re-encoding
 * that would produce a different digest and reject a legitimately signed
 * delivery.
 */
function authenticates(
	reg: CueWebhookRegistration,
	headers: http.IncomingHttpHeaders,
	rawBody: Buffer
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

/**
 * Vendor delivery id, falling back to a locally generated one. `fromSender`
 * says which: only an id the sender chose can come back on a redelivery, so
 * only that kind is worth remembering.
 */
function resolveDeliveryId(headers: http.IncomingHttpHeaders): { id: string; fromSender: boolean } {
	const candidates = ['x-github-delivery', 'x-request-id', 'x-maestro-delivery'];
	for (const key of candidates) {
		const value = headers[key];
		if (typeof value === 'string' && value.length > 0) return { id: value, fromSender: true };
	}
	return { id: crypto.randomUUID(), fromSender: false };
}

/** The dedupe key of one subscriber on one path. */
function claimScope(path: string, reg: CueWebhookRegistration): string {
	return `${path}#${reg.id}`;
}

/**
 * Deliveries being handled right now, by dedupe key. A copy of one that
 * arrives meanwhile waits for it instead of firing a second time; the record
 * in `cue_webhook_deliveries` is written only once the first copy was taken.
 * Process memory on purpose: a crash empties it, and since nothing was
 * recorded and nothing was acknowledged, the sender's retry is handled anew.
 */
const inFlightDeliveries = new Map<string, Promise<void>>();

/** True when this subscriber already took this delivery. A failing database
 *  must not drop deliveries, so an error counts as not taken and is reported. */
function wasDeliveryTaken(scope: string, deliveryId: string): boolean {
	try {
		return isWebhookDeliveryClaimed(scope, deliveryId);
	} catch (err) {
		void captureException(err, { operation: 'cueWebhookClaimDelivery' });
		return false;
	}
}

/** Record that this subscriber took this delivery. */
function recordDeliveryTaken(scope: string, deliveryId: string): void {
	try {
		claimWebhookDelivery(scope, deliveryId);
	} catch (err) {
		void captureException(err, { operation: 'cueWebhookClaimDelivery' });
	}
}

type DeliveryResult = 'accepted' | 'duplicate' | 'unavailable' | 'failed';

/**
 * Hand one delivery to one subscriber. With a sender-chosen id it is deduped:
 * a copy already taken is a duplicate, and a copy arriving while the first is
 * still being handled waits for it and then decides again.
 */
async function deliverTo(
	reg: CueWebhookRegistration,
	path: string,
	delivery: CueWebhookDelivery,
	dedupe: boolean
): Promise<DeliveryResult> {
	const scope = claimScope(path, reg);
	const key = `${scope}\u0000${delivery.deliveryId}`;
	if (dedupe) {
		for (;;) {
			const pending = inFlightDeliveries.get(key);
			if (!pending) break;
			await pending;
		}
		if (wasDeliveryTaken(scope, delivery.deliveryId)) return 'duplicate';
	}

	let finished!: () => void;
	if (dedupe) {
		inFlightDeliveries.set(
			key,
			new Promise<void>((resolve) => {
				finished = resolve;
			})
		);
	}
	let recorded = false;
	const accepted = () => {
		if (recorded || !dedupe) return;
		recorded = true;
		recordDeliveryTaken(scope, delivery.deliveryId);
	};
	try {
		const pending = reg.onDelivery(delivery, accepted);
		if (pending) await pending;
		accepted();
		return 'accepted';
	} catch (err) {
		if (err instanceof CueWebhookUnavailableError) {
			reg.onLog(
				'warn',
				`[CUE] webhook delivery ${delivery.deliveryId} to "/cue/${path}" not taken (${err.message}) - answered 503 so the sender retries`
			);
			return 'unavailable';
		}
		reg.onLog(
			'error',
			`[CUE] webhook delivery ${delivery.deliveryId} to "/cue/${path}" failed: ${err instanceof Error ? err.message : String(err)}`
		);
		void captureException(err, { operation: 'cueWebhookDelivery', path });
		return 'failed';
	} finally {
		if (dedupe) {
			inFlightDeliveries.delete(key);
			finished();
		}
	}
}

function respond(
	res: http.ServerResponse,
	status: number,
	body: Record<string, unknown>,
	options: { closeConnection?: boolean; retryAfterSeconds?: number } = {}
): void {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		'content-type': 'application/json',
		'content-length': Buffer.byteLength(payload),
		...(options.closeConnection ? { connection: 'close' } : {}),
		...(options.retryAfterSeconds !== undefined
			? { 'retry-after': String(options.retryAfterSeconds) }
			: {}),
	});
	res.end(payload);
}

/**
 * Outcome of reading a request body. A size overrun and a broken connection
 * are distinct failures - collapsing them would answer a dropped connection
 * with "413 Payload too large" and send the operator hunting a size limit that
 * was never hit.
 */
type ReadBodyResult =
	| { kind: 'ok'; body: Buffer }
	| { kind: 'too-large' }
	| { kind: 'stream-error' };

/** Read the request body, aborting once it exceeds {@link MAX_BODY_BYTES}. */
function readBody(req: http.IncomingMessage): Promise<ReadBodyResult> {
	return new Promise((resolve) => {
		const chunks: Buffer[] = [];
		let size = 0;
		let settled = false;

		const settle = (result: ReadBodyResult): void => {
			if (settled) return;
			settled = true;
			resolve(result);
		};

		req.on('data', (chunk: Buffer) => {
			size += chunk.length;
			if (settled) {
				// Draining the remainder of an oversized body (see OVERSIZE_DRAIN_BYTES).
				if (size > OVERSIZE_DRAIN_BYTES) req.destroy();
				return;
			}
			if (size > MAX_BODY_BYTES) {
				// Stop buffering but do NOT destroy yet: tearing the socket down
				// here kills it before the 413 is written, and the sender sees a
				// reset connection instead of the documented answer. The rest is
				// drained (bounded) and the caller answers 413.
				settle({ kind: 'too-large' });
				return;
			}
			chunks.push(chunk);
		});
		req.on('end', () => settle({ kind: 'ok', body: Buffer.concat(chunks) }));
		req.on('error', () => settle({ kind: 'stream-error' }));
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
	// A malformed percent-escape (`/cue/%`) makes decodeURIComponent throw. That
	// is a bad request, not a server fault - treat it as an unknown path rather
	// than letting it surface as a 500 and a Sentry report.
	let decoded: string;
	try {
		decoded = decodeURIComponent(match[1]);
	} catch {
		respond(res, 404, { error: 'Unknown webhook path' });
		return;
	}
	const path = normalizeWebhookPath(decoded);

	const targets = [...registrations].filter((reg) => reg.path === path);
	if (targets.length === 0) {
		respond(res, 404, { error: 'Unknown webhook path' });
		return;
	}

	const read = await readBody(req);
	if (read.kind === 'too-large') {
		// Answer, then let the bounded drain in readBody finish the upload so
		// the 413 is not lost to a reset; drop the connection if it drags on.
		respond(res, 413, { error: 'Payload too large' }, { closeConnection: true });
		const drainTimer = setTimeout(() => req.destroy(), OVERSIZE_DRAIN_MS);
		drainTimer.unref?.();
		req.once('end', () => clearTimeout(drainTimer));
		req.once('close', () => clearTimeout(drainTimer));
		return;
	}
	if (read.kind === 'stream-error') {
		respond(res, 400, { error: 'Could not read request body' });
		return;
	}
	const rawBody = read.body;

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

	// Decode to text only now that the signature has been checked against the
	// original bytes. Truncation is applied on the byte buffer so a body that
	// straddles the cap can't be cut mid-codepoint.
	const decodedBody = rawBody.toString('utf8');

	// Parse once and share the result: JSON.parse on a megabyte per matching
	// subscription is wasted work, and every consumer wants the same object.
	let parsed: unknown = null;
	try {
		parsed = decodedBody.length > 0 ? JSON.parse(decodedBody) : null;
	} catch {
		// Non-JSON bodies (form posts, plain text) are legitimate - the raw body
		// still reaches the prompt via {{CUE_WEBHOOK_BODY}}.
		parsed = null;
	}

	const event = resolveVendorEvent(req.headers);
	const { id: deliveryId, fromSender } = resolveDeliveryId(req.headers);

	const receivedAt = new Date().toISOString();
	const truncatedRaw =
		rawBody.length > MAX_STORED_RAW_BODY
			? rawBody.subarray(0, MAX_STORED_RAW_BODY).toString('utf8')
			: decodedBody;

	// ACKNOWLEDGED means answered 2xx, and a 2xx is sent only after every
	// subscriber has taken the delivery: its event reached the run manager
	// (running or queued, durable either way) or was deliberately dropped
	// (filter, SusFactor). Until then nothing is recorded, so a crash leaves
	// no 2xx and no record, and the sender's retry is handled anew.
	//
	// A redelivery (same sender-chosen id within 24 hours) reaches only the
	// subscribers that have not taken it; when none are left it is
	// acknowledged with a 2xx so the sender stops retrying, and fires nothing.
	const results = await Promise.all(
		authenticated.map((reg) =>
			deliverTo(
				reg,
				path,
				{
					path,
					event,
					deliveryId,
					receivedAt,
					headers: sanitizeHeaders(req.headers, reg.signatureHeader),
					body: parsed,
					rawBody: truncatedRaw,
				},
				fromSender
			)
		)
	);
	authenticated.forEach((reg, i) => {
		if (results[i] === 'duplicate') {
			reg.onLog(
				'info',
				`[CUE] webhook delivery ${deliveryId} to "/cue/${path}" was already handled - ignoring the redelivery`
			);
		}
	});
	const accepted = results.filter((r) => r === 'accepted').length;
	const failed = results.filter((r) => r === 'failed' || r === 'unavailable').length;
	if (failed > 0) {
		// A non-2xx so the sender retries; the retry skips who already has it.
		// When the only reason is that Cue is not running, say so: 503 with a
		// Retry-After. Any other failure is a 500.
		const unavailable = results.every((r) => r !== 'failed');
		respond(
			res,
			unavailable ? 503 : 500,
			{ accepted, failed },
			unavailable ? { retryAfterSeconds: WEBHOOK_RETRY_AFTER_SECONDS } : {}
		);
		return;
	}
	if (accepted === 0) {
		respond(res, 200, { accepted: 0, duplicate: true });
		return;
	}
	respond(res, 202, { accepted });
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
		// Binding past loopback puts an agent trigger on the network. It's a
		// supported choice, but a silent one is a footgun - say so once, at the
		// moment it takes effect.
		if (!LOOPBACK_HOSTS.has(host)) {
			onLog(
				'warn',
				`[CUE] webhook listener is bound to ${host}, not loopback - any host that can reach this port may trigger agents (secrets still required). Prefer 127.0.0.1 behind a tunnel or reverse proxy.`
			);
		}
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
		if (holds > 0 && server) {
			// Same path and secret, so a delivery still authenticates, but it is
			// never taken: the 503 path answers it and nothing is recorded.
			const standIn: CueWebhookRegistration = {
				...reg,
				onDelivery: () => {
					throw new CueWebhookUnavailableError('Cue is stopping');
				},
			};
			registrations.add(standIn);
			standIns.add(standIn);
			return;
		}
		stopServerIfIdle();
	};
}

/**
 * Keep the listener bound while an engine drains. A drain disarms every
 * trigger source first, which would otherwise close the socket and leave a
 * sender with a refused connection (a 502 behind a proxy) for the rest of
 * the drain. Held, each released registration answers 503 with
 * `Retry-After` instead, until the returned release function is called; it
 * drops the stand-ins and closes the socket if nothing else is registered.
 * The release is idempotent.
 */
export function holdCueWebhookListener(): () => void {
	holds += 1;
	let released = false;
	return () => {
		if (released) return;
		released = true;
		holds -= 1;
		if (holds > 0) return;
		for (const standIn of standIns) registrations.delete(standIn);
		standIns.clear();
		stopServerIfIdle();
	};
}

/** Test-only: drop all registrations and close the socket. */
export function resetCueWebhookServerForTests(): void {
	registrations.clear();
	standIns.clear();
	holds = 0;
	inFlightDeliveries.clear();
	bindFailed = false;
	boundPort = null;
	if (server) {
		server.close();
		server = null;
	}
}
