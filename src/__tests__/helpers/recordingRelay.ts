/**
 * A forwarding recorder for the opt-in end-to-end suites: an HTTP server on
 * loopback that sends every request on to one upstream and keeps what passed
 * in both directions.
 *
 * It exists for the questions the token proxy's own log cannot answer, because
 * that log never holds a body: WHICH request went where, and what the provider
 * said each one cost (`usage` in its response). Put it in front of the provider
 * (as the proxy's upstream) or in front of a local target, and read
 * `exchanges` afterwards.
 *
 * The bytes are not changed: headers go on through the proxy's own
 * `forwardableHeaders`, a body goes out as the buffer it arrived as, and the
 * response is piped while a copy is kept. A copy is decoded only for the
 * record.
 *
 * NOT re-exported from `./index`: it opens sockets, and only suites that run
 * real traffic need it.
 */

import * as http from 'http';
import * as https from 'https';
import type { AddressInfo } from 'net';
import * as zlib from 'zlib';

import { forwardableHeaders } from '../../main/local-models/proxy/server';

/** One request the relay carried, and the answer to it. */
export interface RelayedExchange {
	method: string;
	/** Path and query, as the client sent them. */
	path: string;
	/** The request body as text. Empty for a body that is not text. */
	requestBody: string;
	/** The upstream's status, or 0 when it never answered. */
	status: number;
	/** The response body as text, decoded when the upstream compressed it. */
	responseBody: string;
	/** From the whole request arriving to the answer ending. */
	durationMs: number;
}

export interface RecordingRelay {
	/** The base URL to use in place of the upstream's. */
	url: string;
	/** Every exchange that has ended, in the order each ended. */
	exchanges: RelayedExchange[];
	close(): Promise<void>;
}

/** The text of a body, decoded by its `Content-Encoding` when Node can. */
function bodyText(body: Buffer, encoding: string | undefined): string {
	try {
		const value = (encoding ?? '').trim().toLowerCase();
		const zstd = (zlib as unknown as { zstdDecompressSync?: typeof zlib.gunzipSync })
			.zstdDecompressSync;
		const decoded =
			value === 'gzip' || value === 'x-gzip'
				? zlib.gunzipSync(body)
				: value === 'deflate'
					? zlib.inflateSync(body)
					: value === 'br'
						? zlib.brotliDecompressSync(body)
						: value === 'zstd' && zstd
							? zstd(body)
							: body;
		return decoded.toString('utf-8');
	} catch {
		return '';
	}
}

/** Start a relay to `upstream` (a base URL) on a free loopback port. */
export async function startRecordingRelay(upstream: string): Promise<RecordingRelay> {
	const base = new URL(upstream);
	const secure = base.protocol === 'https:';
	const exchanges: RelayedExchange[] = [];

	const server = http.createServer((req, res) => {
		const received: Buffer[] = [];
		req.on('data', (chunk: Buffer) => received.push(chunk));
		req.on('error', () => {});
		req.on('end', () => {
			const body = Buffer.concat(received);
			const startedAt = Date.now();
			const exchange: RelayedExchange = {
				method: req.method ?? 'GET',
				path: req.url ?? '/',
				requestBody: bodyText(body, req.headers['content-encoding']),
				status: 0,
				responseBody: '',
				durationMs: 0,
			};
			// Once per exchange: a failure can follow an answer that already ended.
			let recorded = false;
			const record = (): void => {
				if (recorded) return;
				recorded = true;
				exchange.durationMs = Date.now() - startedAt;
				exchanges.push(exchange);
			};
			const fail = (): void => {
				record();
				res.destroy();
			};
			const outgoing = (secure ? https : http).request({
				protocol: base.protocol,
				hostname: base.hostname.replace(/^\[|\]$/g, ''),
				port: base.port || undefined,
				method: exchange.method,
				path: `${base.pathname.replace(/\/+$/, '')}${exchange.path}`,
				headers: [...forwardableHeaders(req.rawHeaders, ['host']), 'Host', base.host],
			});
			outgoing.on('error', fail);
			outgoing.on('response', (upstreamResponse) => {
				exchange.status = upstreamResponse.statusCode ?? 0;
				res.writeHead(
					exchange.status,
					upstreamResponse.statusMessage || undefined,
					forwardableHeaders(upstreamResponse.rawHeaders)
				);
				res.flushHeaders();
				const answered: Buffer[] = [];
				upstreamResponse.on('data', (chunk: Buffer) => answered.push(chunk));
				upstreamResponse.on('error', fail);
				upstreamResponse.on('end', () => {
					exchange.responseBody = bodyText(
						Buffer.concat(answered),
						upstreamResponse.headers['content-encoding']
					);
					record();
				});
				upstreamResponse.pipe(res);
			});
			// The client leaving ends the upstream request, as the proxy does.
			res.once('close', () => {
				if (!res.writableFinished) outgoing.destroy();
			});
			outgoing.end(body);
		});
	});

	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const { port } = server.address() as AddressInfo;
	return {
		url: `http://127.0.0.1:${port}`,
		exchanges,
		close: () =>
			new Promise<void>((resolve) => {
				server.close(() => resolve());
				server.closeAllConnections();
			}),
	};
}
