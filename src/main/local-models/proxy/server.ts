/**
 * The Maestro token proxy's HTTP server.
 *
 * A request arrives on loopback, its path names the upstream and, when the
 * launch put one there, the agent (`resolveTokenProxyTarget`), and it is
 * forwarded with its headers and body bytes unchanged. The response comes back
 * the same way, streamed chunk by chunk. In `passthrough` mode, which is every
 * request unless an agent chose otherwise, this module changes NOTHING in
 * either direction; it only counts the bytes it carried.
 *
 * `compress` mode is the one exception, and it is narrow: for an agent whose
 * mode is `compress` (`modeFor`), a request that holds a message list is read
 * whole, handed to `compress` (`compress.ts`), and sent with the body that
 * comes back. Everything else about that request, and every other request,
 * stays on the passthrough path. A body that cannot be read (an encoding this
 * module does not know, bytes that are not UTF-8, a body past
 * {@link MAX_COMPRESS_BODY_BYTES}) or a compressor that throws leaves the
 * request exactly as it arrived: compression is an optimization, so its
 * failure never costs the user the turn. The response is never touched.
 *
 * Background routing is the second exception, and the only one that changes
 * where a request GOES. For an agent whose `backgroundRequests` names a target
 * (`backgroundRouteFor`), an Anthropic Messages request is read whole and
 * handed to `planBackgroundRoute` (`background-route.ts`). A request that is
 * unmistakably one of the CLI's side requests is sent to the target instead of
 * the provider: the same path and query, the same body except for the model's
 * name, the client's provider credentials removed, and the target's key added.
 * The target's answer, an error included, is the response. A target that
 * cannot be used is answered by the proxy, by name. In neither case does the
 * request go to the provider as well: that would hide the failure and spend
 * what the user chose to save. Every other request of that agent goes to the
 * provider as it arrived.
 *
 * Built on Node's `http` / `https` rather than `fetch` (and so not on
 * `fetchWithTimeout`) on purpose. `fetch` decodes a compressed response and
 * re-frames the body, which is a different response; it also wants a total
 * timeout, and a model stream runs for minutes. Raw `http` hands over the
 * bytes as they came and leaves the timeout to the two ends that own it: the
 * provider CLI and the provider.
 *
 * What "unchanged" means precisely:
 *
 * - Headers are forwarded from `rawHeaders`, so casing, order and duplicates
 *   survive. Only hop-by-hop headers (RFC 9110 section 7.6.1, plus anything the
 *   `Connection` header lists) are dropped, and `Host` is rewritten to the
 *   upstream's, which TLS virtual hosting requires. `Authorization`,
 *   `x-api-key` and every other credential pass through; the proxy adds none of
 *   its own, so it gives a local caller nothing it could not get by calling the
 *   upstream directly. (A request routed to a background target is the one
 *   that does not go to the upstream, and it carries the target's key instead.)
 * - Bodies are never decoded. A request with `content-encoding: zstd` (Codex
 *   has sent one) is forwarded as the bytes it is, and so is a compressed
 *   response.
 * - An upstream error (a 429, a 529, an auth failure) is a response like any
 *   other and is forwarded whole. Only a failure of the proxy itself (no such
 *   route, upstream unreachable) is answered by the proxy, and that body names
 *   the proxy (`tokenProxyErrorBody`).
 * - A stream the upstream drops mid-response is dropped to the client too. The
 *   proxy never ends a truncated response cleanly.
 */

import * as http from 'http';
import * as https from 'https';
import type { AddressInfo } from 'net';
import { promisify } from 'util';
import * as zlib from 'zlib';
import { estimateTokenCount } from '../../../shared/formatters';
import {
	defaultTokenProxyUpstreams,
	isCompressingTokenProxyMode,
	resolveTokenProxyTarget,
	TOKEN_PROXY_HOST,
	TOKEN_PROXY_NAME,
	tokenProxyErrorBody,
	type TokenProxyErrorCode,
	type TokenProxyRequestKind,
	type TokenProxyRequestMode,
	type TokenProxyUpstreams,
} from '../../../shared/local-models/token-proxy';
import {
	planBackgroundRoute,
	withRequestModel,
	type BackgroundRoutePlan,
	type BackgroundRouteSkip,
} from './background-route';
import type { CompressedBlock, CompressRequestResult, CompressRequestStats } from './compress';

/**
 * The largest request body `compress` mode reads into memory, encoded or
 * decoded. A larger one is forwarded as a stream, unread.
 */
export const MAX_COMPRESS_BODY_BYTES = 64 * 1024 * 1024;

/** Why a `compress` mode request was forwarded without being read. */
export type TokenProxyCompressionSkip =
	/** A `Content-Encoding` this module cannot decode. */
	| 'encoding'
	/** The decoded body is not UTF-8 text. */
	| 'not-text'
	/** The body is past {@link MAX_COMPRESS_BODY_BYTES}. */
	| 'too-large'
	/** Decoding or the compressor threw. */
	| 'failed';

/** What `compress` mode did with one request. */
export interface TokenProxyCompressionLog {
	/** Set when the body went out as it arrived, unread or after a failure. */
	skipped?: TokenProxyCompressionSkip;
	/** The failure, for `skipped: 'failed'`. */
	error?: string;
	/** Whether the body sent differs from the body received. */
	changed: boolean;
	/** How long the request was held to be read and shortened. */
	addedLatencyMs: number;
	/** Tokens (characters / 4) of the body as it arrived and as it was sent. */
	originalTokens?: number;
	sentTokens?: number;
	stats?: CompressRequestStats;
	blocks?: CompressedBlock[];
}

/** Why a request of an agent with a background target went to the provider. */
export type TokenProxyBackgroundSkip =
	/** It is not a background request (`planBackgroundRoute`). */
	| BackgroundRouteSkip
	/** Its body could not be read, so it could not be shown to be one. */
	| TokenProxyCompressionSkip;

/** What background routing did with one request. */
export interface TokenProxyBackgroundLog {
	/**
	 * The target the request was meant for, as `<source id>:<model>`. Set for a
	 * background request whether the target answered or could not be used.
	 * Absent when the request went to the provider, and for a stored target
	 * that names nothing.
	 */
	routedTo?: string;
	/** Why the request went to the provider. */
	skipped?: TokenProxyBackgroundSkip;
	/** The failure, for `skipped: 'failed'`. */
	error?: string;
	/** How long the request was held: to be read, and for the target to be ready. */
	addedLatencyMs: number;
}

/** A background target, ready for one request, or why it cannot be used. */
export type TokenProxyBackgroundTarget =
	| {
			ok: true;
			/** The target's root. The request's own path (`/v1/messages`) follows it. */
			baseUrl: string;
			/** The target's key, sent as a bearer token. Absent for a server with none. */
			key?: string;
			/** The model name sent in place of the provider's small model. */
			model: string;
	  }
	| { ok: false; error: string };

/** Where one agent's background requests go. */
export interface TokenProxyBackgroundRoute {
	/** The agent's provider: its small model is what a background request names. */
	toolType: string;
	/** The target as the log records it. Absent when the stored target names none. */
	routedTo?: string;
	/**
	 * Make the target ready and say where it is. Called only for a request that
	 * IS a background request, so a target is never started for a turn.
	 */
	resolve: () => Promise<TokenProxyBackgroundTarget>;
}

/** How one request ended. */
export type TokenProxyRequestOutcome =
	/** The upstream's response (whatever its status) reached the client whole. */
	| 'completed'
	/**
	 * The client went away before the response finished, and before an event
	 * stream announced the end of its turn (see `streamAnnouncedItsEnd`).
	 */
	| 'client-aborted'
	/**
	 * The upstream could not be reached, or dropped mid-response. The upstream
	 * of a background request is its target, which also ends here when it
	 * cannot be used.
	 */
	| 'upstream-failed'
	/** The request named no route; nothing was forwarded. */
	| 'unknown-route'
	/**
	 * The client asked to switch protocols (a WebSocket). The proxy carries HTTP
	 * only, said so with a 426, and forwarded nothing. Not a failure: the client
	 * is expected to send the same turn over HTTP.
	 */
	| 'upgrade-refused';

/** What the proxy carried for one request. Never a header or a body. */
export interface TokenProxyRequestLog {
	/** The route prefix, or null when the request named none. */
	route: string | null;
	kind: TokenProxyRequestKind;
	/** The agent the base URL named, or null when it named none. */
	agentId: string | null;
	mode: TokenProxyRequestMode;
	/** Epoch ms the request arrived. */
	startedAt: number;
	method: string;
	/** The forwarded path, without the route prefix or the query string. */
	path: string;
	/** The status sent to the client, or 0 when none was. */
	status: number;
	/** Request body bytes received from the client. */
	requestBytes: number;
	/** Request body bytes sent on. Differs only when the body was compressed or routed. */
	sentBytes: number;
	/** Response body bytes received from the upstream and sent to the client. */
	responseBytes: number;
	durationMs: number;
	outcome: TokenProxyRequestOutcome;
	/** The failure, when the proxy itself failed. */
	error?: string;
	/** Present when the request went down the `compress` path. */
	compression?: TokenProxyCompressionLog;
	/**
	 * Present for an Anthropic Messages request of an agent that sends its
	 * background requests somewhere: where this one went, or why it stayed.
	 */
	background?: TokenProxyBackgroundLog;
}

export interface TokenProxyServerOptions {
	/** Route prefix -> upstream base URL. Defaults to the real providers. */
	upstreams?: TokenProxyUpstreams;
	/** Called once per request, when it has ended. */
	onRequest?: (entry: TokenProxyRequestLog) => void;
	/**
	 * How one agent's requests are carried. Asked once per request, so a mode
	 * the user changes applies to the next request. Defaults to `passthrough`.
	 */
	modeFor?: (agentId: string | null) => TokenProxyRequestMode;
	/**
	 * Shortens a request body in `compress` mode (`compressRequestBody`). It
	 * takes and returns text. Without it every request is a passthrough.
	 */
	compress?: (
		kind: TokenProxyRequestKind,
		body: string,
		options: { early: boolean }
	) => Promise<CompressRequestResult>;
	/**
	 * Where one agent's background requests go, or null when they go to the
	 * provider like everything else. Asked once per Anthropic Messages request,
	 * so a target the user changes applies to the next request. Without it no
	 * request is ever routed.
	 */
	backgroundRouteFor?: (agentId: string | null) => TokenProxyBackgroundRoute | null;
}

export interface TokenProxyServer {
	/** Bind loopback on `port` (0 picks a free one). Resolves the bound port. */
	listen(port: number): Promise<number>;
	/** The bound port, or null while not listening. */
	port(): number | null;
	/**
	 * Stop accepting connections and release the port at once. Requests in
	 * flight finish unless `force` is set, which cuts them. Resolves when the
	 * last connection has ended.
	 */
	close(options?: { force?: boolean }): Promise<void>;
}

/** Headers that describe one connection, not the message (RFC 9110 7.6.1). */
const HOP_BY_HOP_HEADERS: ReadonlySet<string> = new Set([
	'connection',
	'keep-alive',
	'proxy-authenticate',
	'proxy-authorization',
	'proxy-connection',
	'te',
	'trailer',
	'transfer-encoding',
	'upgrade',
]);

/**
 * The headers of a message that belong to the next hop, in `rawHeaders` form
 * (`[name, value, name, value, ...]`). Everything is kept as it arrived except
 * hop-by-hop headers, headers the `Connection` header names, and `alsoDrop`.
 */
export function forwardableHeaders(
	rawHeaders: readonly string[],
	alsoDrop: readonly string[] = []
): string[] {
	const drop = new Set<string>(HOP_BY_HOP_HEADERS);
	for (const name of alsoDrop) drop.add(name.toLowerCase());
	for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
		if (rawHeaders[i].toLowerCase() !== 'connection') continue;
		for (const token of rawHeaders[i + 1].split(',')) {
			const name = token.trim().toLowerCase();
			if (name !== '') drop.add(name);
		}
	}
	const kept: string[] = [];
	for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
		if (!drop.has(rawHeaders[i].toLowerCase())) kept.push(rawHeaders[i], rawHeaders[i + 1]);
	}
	return kept;
}

/**
 * The headers that carry the client's credential for the PROVIDER. A request
 * sent to a background target goes without them: a provider's key or login
 * token must never reach a server the provider does not run.
 */
const PROVIDER_CREDENTIAL_HEADERS: readonly string[] = ['authorization', 'x-api-key', 'cookie'];

type BodyDecoder = (input: Buffer, options: zlib.ZlibOptions) => Promise<Buffer>;

/** `Content-Encoding` value -> decoder. Absent: the body is forwarded unread. */
function bodyDecoders(): Record<string, BodyDecoder> {
	const decoders: Record<string, BodyDecoder> = {
		gzip: promisify(zlib.gunzip),
		'x-gzip': promisify(zlib.gunzip),
		deflate: promisify(zlib.inflate),
		br: promisify(zlib.brotliDecompress) as BodyDecoder,
	};
	// Codex has sent zstd. Older Node builds have no decoder for it.
	const zstd = (zlib as unknown as { zstdDecompress?: typeof zlib.gunzip }).zstdDecompress;
	if (typeof zstd === 'function') decoders.zstd = promisify(zstd);
	return decoders;
}

/** The request's `Content-Encoding`, lowercased. Null when it has none. */
function contentEncoding(rawHeaders: readonly string[]): string | null {
	const values: string[] = [];
	for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
		if (rawHeaders[i].toLowerCase() === 'content-encoding') values.push(rawHeaders[i + 1]);
	}
	const encoding = values.join(',').trim().toLowerCase();
	return encoding === '' || encoding === 'identity' ? null : encoding;
}

/**
 * The events that say a streamed turn is over, by provider: the Responses API
 * (`response.completed` and its failed and incomplete siblings), Chat
 * Completions (`[DONE]`), and Anthropic Messages (`message_stop`).
 */
const STREAM_END_MARKERS = [
	'response.completed',
	'response.failed',
	'response.incomplete',
	'data: [DONE]',
	'message_stop',
] as const;

const STREAM_END_MARKER_MAX_LENGTH = Math.max(...STREAM_END_MARKERS.map((marker) => marker.length));

/**
 * Whether an event stream has already told the client its turn is finished.
 *
 * A client is free to hang up once it has that event, without waiting for the
 * upstream to close the connection, and Codex does: on real traffic every one
 * of its turns was recorded `client-aborted` although each had completed. The
 * response then never "finishes" from this side, so the terminal event is the
 * only evidence that the hang-up was the end of a turn and not an abandoned
 * one. The bytes are read, never changed: this only decides one word of the log.
 */
export function streamAnnouncedItsEnd(text: string): boolean {
	return STREAM_END_MARKERS.some((marker) => text.includes(marker));
}

/**
 * The text of a request body, or why it cannot be read. The decode is strict:
 * a body whose bytes are not UTF-8 would not survive the trip back to bytes,
 * so it is not read at all.
 */
async function decodeRequestBody(
	raw: Buffer,
	encoding: string | null
): Promise<{ text: string } | { skipped: TokenProxyCompressionSkip }> {
	let bytes = raw;
	if (encoding !== null) {
		const decode = bodyDecoders()[encoding];
		if (!decode) return { skipped: 'encoding' };
		bytes = await decode(raw, { maxOutputLength: MAX_COMPRESS_BODY_BYTES });
	}
	try {
		return { text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) };
	} catch {
		return { skipped: 'not-text' };
	}
}

function errorText(error: unknown): string {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	const message = error instanceof Error ? error.message : String(error);
	return code && !message.includes(code) ? `${code}: ${message}` : message;
}

/** A request body's text, or why it cannot be read. */
type ReadBody = { text: string } | { skipped: TokenProxyCompressionSkip; error?: string };

type ReadyBackgroundTarget =
	| { ok: true; destination: URL; key?: string; model: string }
	| { ok: false; error: string };

/**
 * Ask a route for its target and turn the answer into an address. Never
 * throws: a resolver that fails, and an address that is not a URL, are both a
 * target that cannot be used.
 */
async function readyBackgroundTarget(
	route: TokenProxyBackgroundRoute
): Promise<ReadyBackgroundTarget> {
	try {
		const target = await route.resolve();
		if (!target.ok) return target;
		return {
			ok: true,
			destination: new URL(target.baseUrl),
			key: target.key,
			model: target.model,
		};
	} catch (error) {
		return {
			ok: false,
			error: `${TOKEN_PROXY_NAME} could not make this agent's Background requests target ready (${errorText(error)}). The request was not sent to the provider.`,
		};
	}
}

export function createTokenProxyServer(options: TokenProxyServerOptions = {}): TokenProxyServer {
	const upstreams = options.upstreams ?? defaultTokenProxyUpstreams();
	// Keep-alive to the upstream, so a turn's requests do not each pay a TLS
	// handshake. Owned here (not the global agent) so closing the proxy closes
	// exactly its own upstream sockets.
	const httpAgent = new http.Agent({ keepAlive: true });
	const httpsAgent = new https.Agent({ keepAlive: true });

	const server = http.createServer((req, res) => handleRequest(req, res));
	// Both agents die with the server: only after the last connection ended, so
	// a graceful close does not cut the upstream half of a request in flight.
	server.on('close', () => {
		httpAgent.destroy();
		httpsAgent.destroy();
	});

	function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
		const startedAt = Date.now();
		const method = req.method ?? 'GET';
		const target = resolveTokenProxyTarget(method, req.url ?? '/', upstreams);
		const agentId = target.ok ? target.agentId : null;
		const entry: TokenProxyRequestLog = {
			route: target.ok ? target.route : null,
			kind: target.ok ? target.kind : 'other',
			agentId,
			mode: target.ok ? (options.modeFor?.(agentId) ?? 'passthrough') : 'passthrough',
			startedAt,
			method,
			path: target.ok ? target.path : (req.url ?? '/').split('?')[0],
			status: 0,
			requestBytes: 0,
			sentBytes: 0,
			responseBytes: 0,
			durationMs: 0,
			outcome: 'completed',
		};
		let failure: { outcome: TokenProxyRequestOutcome; error: string } | null = null;
		let closed = false;
		let upstreamRequest: http.ClientRequest | null = null;
		// Whether the upstream has already said the turn is over on an event
		// stream that the client then hung up on (see `streamAnnouncedItsEnd`).
		let streamEnded = false;
		let streamTail = '';
		// Set when the body sent is not the body received. Otherwise the two
		// counts are the same number.
		let sentBytes: number | null = null;
		// When a background request began waiting for its target, while it waits.
		// A cold model takes seconds to load, and a client that gives up in that
		// time is still logged with how long it was held.
		let waitingForTargetSince: number | null = null;

		// 'close' is the one event every ending reaches: a finished response, a
		// client that went away, and a response this module destroyed.
		res.once('close', () => {
			closed = true;
			entry.durationMs = Date.now() - startedAt;
			entry.sentBytes = sentBytes ?? (upstreamRequest ? entry.requestBytes : 0);
			if (waitingForTargetSince !== null && entry.background) {
				entry.background.addedLatencyMs = Date.now() - waitingForTargetSince;
			}
			if (failure) {
				entry.outcome = failure.outcome;
				entry.error = failure.error;
			} else if (!res.writableFinished && !streamEnded) {
				entry.outcome = 'client-aborted';
				// The client leaving ends the upstream request too, so an
				// abandoned turn stops generating (and billing) at the provider.
				upstreamRequest?.destroy();
			}
			options.onRequest?.(entry);
		});

		/** Answer as the proxy. Only possible while nothing has been sent. */
		const answerAsProxy = (
			status: number,
			code: TokenProxyErrorCode,
			outcome: TokenProxyRequestOutcome,
			message: string
		): void => {
			// Nobody is left to answer, and the request is already accounted for.
			if (failure || closed) return;
			failure = { outcome, error: message };
			if (res.headersSent) {
				// The upstream's status line is already with the client. Cutting
				// the connection is the only honest signal left.
				res.destroy();
				return;
			}
			const body = Buffer.from(tokenProxyErrorBody(code, message), 'utf-8');
			entry.status = status;
			entry.responseBytes = body.length;
			res.writeHead(status, {
				'content-type': 'application/json',
				'content-length': body.length,
			});
			res.end(body);
		};

		if (!target.ok) {
			// Drain what the client is still sending so the 404 is delivered.
			req.resume();
			answerAsProxy(404, 'unknown-route', 'unknown-route', target.error);
			return;
		}

		// A WebSocket handshake. The proxy reads and counts HTTP bodies and has no
		// business inside a socket it would only tunnel, so it answers for itself.
		// Forwarding the request instead (the `Upgrade` header is hop-by-hop and
		// is dropped) reaches the upstream as a plain GET, which it answers 405:
		// Codex took that for a transient failure and retried the handshake nine
		// times, 9.3 of the 12.3 seconds of a measured turn, before it sent the
		// turn over HTTP. 426 is the status that says "not this protocol, here".
		if (req.headers.upgrade) {
			req.resume();
			answerAsProxy(
				426,
				'upgrade-not-supported',
				'upgrade-refused',
				`The ${TOKEN_PROXY_NAME} carries HTTP requests only, not a ${String(req.headers.upgrade)} connection. Send the request over HTTP.`
			);
			return;
		}

		let upstream: URL;
		try {
			upstream = new URL(target.upstream);
		} catch {
			req.resume();
			answerAsProxy(
				502,
				'upstream-unreachable',
				'upstream-failed',
				`${TOKEN_PROXY_NAME} has no usable upstream address for route "/${target.route}".`
			);
			return;
		}

		/** The request's own headers, for a body that goes to the provider as it arrived. */
		const arrivedHeaders = (): string[] => [
			...forwardableHeaders(req.rawHeaders, ['host']),
			'Host',
			upstream.host,
		];

		/**
		 * Open the request to `destination` (the provider's upstream, or a
		 * background target) and wire its response to the client. The headers are
		 * fixed here (Node writes an array of raw headers at once), so a body
		 * whose length changed needs them built first.
		 */
		const forward = (destination: URL, headers: string[]): http.ClientRequest => {
			const secure = destination.protocol === 'https:';
			const upstreamFailed = (error: unknown): void => {
				answerAsProxy(
					502,
					'upstream-unreachable',
					'upstream-failed',
					`${TOKEN_PROXY_NAME} could not complete the request to ${destination.origin} (${errorText(error)}). The request was not sent anywhere else.`
				);
			};
			const outgoing = (secure ? https : http).request({
				protocol: destination.protocol,
				hostname: destination.hostname.replace(/^\[|\]$/g, ''),
				port: destination.port || undefined,
				method,
				// The client's path and query are appended as the text they arrived
				// as. Only the destination's base goes through `URL`.
				path: `${destination.pathname.replace(/\/+$/, '')}${target.path}${target.query}` || '/',
				headers,
				agent: secure ? httpsAgent : httpAgent,
			});
			upstreamRequest = outgoing;

			outgoing.on('error', upstreamFailed);
			outgoing.on('response', (upstreamResponse) => {
				entry.status = upstreamResponse.statusCode ?? 0;
				try {
					res.writeHead(
						upstreamResponse.statusCode ?? 502,
						upstreamResponse.statusMessage || undefined,
						forwardableHeaders(upstreamResponse.rawHeaders)
					);
				} catch (error) {
					upstreamResponse.destroy();
					upstreamFailed(error);
					return;
				}
				// Send the status line now and every chunk as it lands: a server-sent
				// event must not wait for the next one to fill a packet.
				res.flushHeaders();
				res.socket?.setNoDelay(true);
				// An event stream says so in its content type, except where it does
				// not: the ChatGPT backend answers a Codex turn with a stream and no
				// `Content-Type` at all. A message request answered with no type is
				// read for the terminal event too, or every finished Codex turn is
				// recorded as abandoned.
				const contentType = String(upstreamResponse.headers['content-type'] ?? '');
				const eventStream =
					/^text\/event-stream\b/i.test(contentType) ||
					(contentType === '' && target.kind !== 'other');
				upstreamResponse.on('data', (chunk: Buffer) => {
					entry.responseBytes += chunk.length;
					if (eventStream && !streamEnded) {
						// The marker can straddle two chunks, so the end of the last one
						// is kept and read together with this one.
						const text = streamTail + chunk.toString('latin1');
						streamEnded = streamAnnouncedItsEnd(text);
						streamTail = text.slice(-STREAM_END_MARKER_MAX_LENGTH);
					}
				});
				upstreamResponse.on('error', upstreamFailed);
				upstreamResponse.on('close', () => {
					if (!upstreamResponse.complete)
						upstreamFailed(new Error('the upstream closed mid-response'));
				});
				upstreamResponse.pipe(res);
			});
			return outgoing;
		};

		req.on('data', (chunk: Buffer) => {
			entry.requestBytes += chunk.length;
		});
		// A client that drops mid-upload is handled by the response's 'close'
		// above; this only keeps the stream error from going unhandled.
		req.on('error', () => {});

		const compress =
			isCompressingTokenProxyMode(entry.mode) && target.kind !== 'other'
				? options.compress
				: undefined;
		// Asked only for the one kind of request that can be routed.
		const background =
			target.kind === 'anthropic-messages' ? (options.backgroundRouteFor?.(agentId) ?? null) : null;
		if (!compress && !background) {
			req.pipe(forward(upstream, arrivedHeaders()));
			return;
		}

		// The body has to be whole before any of it is sent: shortening it
		// changes its length, and where it goes depends on what it holds.
		const kind = target.kind;
		const received: Buffer[] = [];
		let receivedBytes = 0;

		const readBody = async (raw: Buffer): Promise<ReadBody> => {
			try {
				return await decodeRequestBody(raw, contentEncoding(req.rawHeaders));
			} catch (error) {
				return { skipped: 'failed', error: errorText(error) };
			}
		};

		/**
		 * Send a background request to the agent's target. Resolves true when the
		 * request is spoken for (sent to the target, or failed by name) and false
		 * when it is not a background request, which then goes to the provider.
		 */
		const sendToTarget = async (
			route: TokenProxyBackgroundRoute,
			read: ReadBody,
			heldAt: number
		): Promise<boolean> => {
			const log: TokenProxyBackgroundLog = { addedLatencyMs: 0 };
			entry.background = log;
			const stays = (skipped: TokenProxyBackgroundSkip, error?: string): false => {
				log.skipped = skipped;
				if (error !== undefined) log.error = error;
				log.addedLatencyMs = Date.now() - heldAt;
				return false;
			};
			if ('skipped' in read) return stays(read.skipped, read.error);
			let plan: BackgroundRoutePlan;
			try {
				plan = planBackgroundRoute(read.text, route.toolType);
			} catch (error) {
				// Not shown to be a background request, so it is treated as a turn.
				return stays('failed', errorText(error));
			}
			if (!plan.route) return stays(plan.reason);

			// From here the request belongs to the target. Nothing below sends it
			// to the provider.
			if (route.routedTo !== undefined) log.routedTo = route.routedTo;
			waitingForTargetSince = heldAt;
			const ready = await readyBackgroundTarget(route);
			waitingForTargetSince = null;
			log.addedLatencyMs = Date.now() - heldAt;
			// The client left while the target was made ready: nobody to answer.
			if (closed) return true;
			if (!ready.ok) {
				answerAsProxy(502, 'background-target-unavailable', 'upstream-failed', ready.error);
				return true;
			}
			const body = Buffer.from(withRequestModel(read.text, plan, ready.model), 'utf-8');
			try {
				const outgoing = forward(ready.destination, [
					// The new body goes out as plain UTF-8 with its own length, and
					// without the credentials the client holds for the provider.
					...forwardableHeaders(req.rawHeaders, [
						'host',
						'content-length',
						'content-encoding',
						...PROVIDER_CREDENTIAL_HEADERS,
					]),
					'Content-Length',
					String(body.length),
					...(ready.key ? ['Authorization', `Bearer ${ready.key}`] : []),
					'Host',
					ready.destination.host,
				]);
				sentBytes = body.length;
				outgoing.end(body);
			} catch (error) {
				// A header Node refuses to write (a key with a character no header
				// may hold). The request never left.
				answerAsProxy(
					502,
					'background-target-unavailable',
					'upstream-failed',
					`${TOKEN_PROXY_NAME} could not send the request to this agent's Background requests target (${errorText(error)}). The request was not sent to the provider.`
				);
			}
			return true;
		};

		const readAndSend = async (raw: Buffer): Promise<void> => {
			const heldAt = Date.now();
			const read = await readBody(raw);
			if (background && (await sendToTarget(background, read, heldAt))) return;

			if (!compress) {
				// Read for routing only, and it is a turn: out as it arrived.
				if (!closed) forward(upstream, arrivedHeaders()).end(raw);
				return;
			}
			const log: TokenProxyCompressionLog = { changed: false, addedLatencyMs: 0 };
			let body = raw;
			let headers = arrivedHeaders();
			if ('skipped' in read) {
				log.skipped = read.skipped;
				if (read.error !== undefined) log.error = read.error;
			} else {
				try {
					const result = await compress(kind, read.text, {
						early: entry.mode === 'compress-early',
					});
					log.originalTokens = estimateTokenCount(read.text);
					log.sentTokens = log.originalTokens;
					log.stats = result.stats;
					log.blocks = result.blocks;
					if (result.changed) {
						// The new body goes out as plain UTF-8, so the length and
						// the encoding the client declared no longer describe it.
						body = Buffer.from(result.body, 'utf-8');
						headers = [
							...forwardableHeaders(req.rawHeaders, ['host', 'content-length', 'content-encoding']),
							'Content-Length',
							String(body.length),
							'Host',
							upstream.host,
						];
						log.changed = true;
						log.sentTokens = estimateTokenCount(result.body);
					}
				} catch (error) {
					// The request goes out as it arrived. Nothing else is safe to send.
					log.skipped = 'failed';
					log.error = errorText(error);
					log.changed = false;
					body = raw;
					headers = arrivedHeaders();
				}
			}
			log.addedLatencyMs = Date.now() - heldAt;
			entry.compression = log;
			// The client left while the body was held: there is nobody to answer.
			if (closed) return;
			if (log.changed) sentBytes = body.length;
			forward(upstream, headers).end(body);
		};

		const onBodyEnd = (): void => void readAndSend(Buffer.concat(received));
		const onBodyChunk = (chunk: Buffer): void => {
			received.push(chunk);
			receivedBytes += chunk.length;
			if (receivedBytes <= MAX_COMPRESS_BODY_BYTES) return;
			// Too large to hold. Send what has arrived and stream the rest.
			req.off('data', onBodyChunk);
			req.off('end', onBodyEnd);
			req.pause();
			if (compress) {
				entry.compression = { skipped: 'too-large', changed: false, addedLatencyMs: 0 };
			}
			if (background) entry.background = { skipped: 'too-large', addedLatencyMs: 0 };
			const outgoing = forward(upstream, arrivedHeaders());
			for (const part of received) outgoing.write(part);
			received.length = 0;
			req.pipe(outgoing);
		};
		req.on('data', onBodyChunk);
		req.once('end', onBodyEnd);
	}

	return {
		listen(port: number): Promise<number> {
			return new Promise<number>((resolve, reject) => {
				const onError = (error: Error): void => reject(error);
				server.once('error', onError);
				server.listen(port, TOKEN_PROXY_HOST, () => {
					server.off('error', onError);
					resolve((server.address() as AddressInfo).port);
				});
			});
		},
		port(): number | null {
			const address = server.address();
			return address && typeof address === 'object' ? address.port : null;
		},
		close(closeOptions: { force?: boolean } = {}): Promise<void> {
			return new Promise<void>((resolve) => {
				if (!server.listening) {
					resolve();
					return;
				}
				server.close(() => resolve());
				if (closeOptions.force) server.closeAllConnections();
				else server.closeIdleConnections();
			});
		},
	};
}
