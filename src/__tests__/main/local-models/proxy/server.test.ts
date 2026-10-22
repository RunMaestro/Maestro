/**
 * @file server.test.ts
 *
 * The token proxy as an exact passthrough, against a fake upstream on loopback:
 * a streamed response is delivered chunk by chunk, headers and encoded bodies
 * arrive as they were sent in both directions, an upstream error is forwarded
 * whole, and only a failure of the proxy itself is answered by the proxy.
 *
 * Then the mode switch: a request is read and handed to the compressor only
 * for an agent whose mode is `compress` and only when it holds a message list,
 * and a body that cannot be read, or a compressor that fails, goes out exactly
 * as it arrived.
 *
 * Then background routing: a side request on the provider's small model goes
 * to the agent's target with the target's key and model and nothing of the
 * provider's, every sign of a turn keeps a request on the provider byte for
 * byte, and a target that fails is the answer, never retried against the
 * provider.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import * as http from 'http';
import * as zlib from 'zlib';
import { randomBytes } from 'crypto';
import type { AddressInfo } from 'net';
import {
	createTokenProxyServer,
	streamAnnouncedItsEnd,
	forwardableHeaders,
	type TokenProxyBackgroundTarget,
	type TokenProxyRequestLog,
	type TokenProxyServer,
	type TokenProxyServerOptions,
} from '../../../../main/local-models/proxy/server';
import type { CompressRequestResult } from '../../../../main/local-models/proxy/compress';

interface SeenRequest {
	method: string;
	url: string;
	rawHeaders: string[];
	body: Buffer;
}

interface FakeUpstream {
	origin: string;
	host: string;
	seen: SeenRequest[];
	close(): Promise<void>;
}

type UpstreamHandler = (
	req: http.IncomingMessage,
	res: http.ServerResponse,
	body: Buffer
) => unknown;

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()!();
});

/** A real HTTP server standing in for a provider. Records what reached it. */
async function startUpstream(handler: UpstreamHandler): Promise<FakeUpstream> {
	const seen: SeenRequest[] = [];
	const server = http.createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on('data', (chunk: Buffer) => chunks.push(chunk));
		req.on('error', () => {});
		req.on('end', () => {
			const body = Buffer.concat(chunks);
			seen.push({
				method: req.method ?? '',
				url: req.url ?? '',
				rawHeaders: [...req.rawHeaders],
				body,
			});
			void handler(req, res, body);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const port = (server.address() as AddressInfo).port;
	const close = () =>
		new Promise<void>((resolve) => {
			server.close(() => resolve());
			server.closeAllConnections();
		});
	cleanups.push(close);
	return { origin: `http://127.0.0.1:${port}`, host: `127.0.0.1:${port}`, seen, close };
}

interface RunningProxy {
	proxy: TokenProxyServer;
	port: number;
	logs: TokenProxyRequestLog[];
}

async function startProxy(
	upstreams: Record<string, string>,
	extra: Pick<TokenProxyServerOptions, 'modeFor' | 'compress' | 'backgroundRouteFor'> = {}
): Promise<RunningProxy> {
	const logs: TokenProxyRequestLog[] = [];
	const proxy = createTokenProxyServer({
		upstreams,
		onRequest: (entry) => logs.push(entry),
		...extra,
	});
	const port = await proxy.listen(0);
	cleanups.push(() => proxy.close({ force: true }));
	return { proxy, port, logs };
}

interface Received {
	status: number;
	statusMessage: string;
	rawHeaders: string[];
	headers: http.IncomingHttpHeaders;
	body: Buffer;
}

/** Send one request with exactly these headers (raw form) and collect the answer. */
function send(
	port: number,
	options: { method?: string; path: string; headers?: string[]; body?: Buffer }
): Promise<Received> {
	return new Promise<Received>((resolve, reject) => {
		const req = http.request(
			{
				host: '127.0.0.1',
				port,
				method: options.method ?? 'POST',
				path: options.path,
				headers: [...(options.headers ?? []), 'Host', `127.0.0.1:${port}`],
				agent: false,
			},
			(res) => {
				const chunks: Buffer[] = [];
				res.on('data', (chunk: Buffer) => chunks.push(chunk));
				res.on('error', reject);
				res.on('end', () =>
					resolve({
						status: res.statusCode ?? 0,
						statusMessage: res.statusMessage ?? '',
						rawHeaders: [...res.rawHeaders],
						headers: res.headers,
						body: Buffer.concat(chunks),
					})
				);
			}
		);
		req.on('error', reject);
		req.end(options.body);
	});
}

/** Every value a raw header list holds for `name`, matched exactly as written. */
function rawValues(rawHeaders: string[], name: string): string[] {
	const values: string[] = [];
	for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
		if (rawHeaders[i] === name) values.push(rawHeaders[i + 1]);
	}
	return values;
}

function lowerNames(rawHeaders: string[]): string[] {
	return rawHeaders.filter((_, index) => index % 2 === 0).map((name) => name.toLowerCase());
}

describe('token proxy server', () => {
	describe('streaming passthrough', () => {
		it('delivers each server-sent event as it is written, without waiting for the end', async () => {
			let releaseSecondEvent: () => void = () => {};
			const secondEventMayGo = new Promise<void>((resolve) => {
				releaseSecondEvent = resolve;
			});
			const upstream = await startUpstream(async (_req, res) => {
				res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
				res.write('event: message_start\ndata: {"n":1}\n\n');
				// The second event is held until the client has the first. A proxy
				// that buffered the response would never let it go.
				await secondEventMayGo;
				res.write('event: message_stop\ndata: {"n":2}\n\n');
				res.end();
			});
			const { port, logs } = await startProxy({ anthropic: upstream.origin });

			const received: string[] = [];
			const whole = await new Promise<string>((resolve, reject) => {
				const req = http.request(
					{ host: '127.0.0.1', port, method: 'POST', path: '/anthropic/v1/messages', agent: false },
					(res) => {
						expect(res.statusCode).toBe(200);
						expect(res.headers['content-type']).toBe('text/event-stream');
						res.setEncoding('utf-8');
						res.on('data', (chunk: string) => {
							received.push(chunk);
							if (received.length === 1) releaseSecondEvent();
						});
						res.on('error', reject);
						res.on('end', () => resolve(received.join('')));
					}
				);
				req.on('error', reject);
				req.end('{"stream":true}');
			});

			expect(received[0]).toBe('event: message_start\ndata: {"n":1}\n\n');
			expect(whole).toBe(
				'event: message_start\ndata: {"n":1}\n\nevent: message_stop\ndata: {"n":2}\n\n'
			);
			await vi.waitFor(() => expect(logs).toHaveLength(1));
			expect(logs[0]).toMatchObject({
				route: 'anthropic',
				kind: 'anthropic-messages',
				method: 'POST',
				path: '/v1/messages',
				status: 200,
				requestBytes: Buffer.byteLength('{"stream":true}'),
				responseBytes: Buffer.byteLength(whole),
				outcome: 'completed',
			});
		});

		it('streams a chat completion and a response the same way', async () => {
			const upstream = await startUpstream((_req, res) => {
				res.writeHead(200, { 'content-type': 'text/event-stream' });
				res.write('data: {"delta":"a"}\n\n');
				res.end('data: [DONE]\n\n');
			});
			const { port, logs } = await startProxy({ openai: upstream.origin });

			const chat = await send(port, {
				path: '/openai/v1/chat/completions',
				body: Buffer.from('{}'),
			});
			const responses = await send(port, { path: '/openai/v1/responses', body: Buffer.from('{}') });

			expect(chat.body.toString()).toBe('data: {"delta":"a"}\n\ndata: [DONE]\n\n');
			expect(responses.body.toString()).toBe('data: {"delta":"a"}\n\ndata: [DONE]\n\n');
			expect(upstream.seen.map((request) => request.url)).toEqual([
				'/v1/chat/completions',
				'/v1/responses',
			]);
			await vi.waitFor(() => expect(logs).toHaveLength(2));
			expect(logs.map((entry) => entry.kind)).toEqual([
				'openai-chat-completions',
				'openai-responses',
			]);
		});
	});

	describe('header passthrough', () => {
		it('sends credentials and every other request header upstream as written', async () => {
			const upstream = await startUpstream((_req, res) => res.end('ok'));
			const { port } = await startProxy({ anthropic: upstream.origin });

			await send(port, {
				path: '/anthropic/v1/messages',
				headers: [
					'Authorization',
					'Bearer sk-ant-oat01-secret',
					'x-api-key',
					'sk-ant-api03-secret',
					'anthropic-version',
					'2023-06-01',
					'Anthropic-Beta',
					'oauth-2025-04-20',
					'X-Stainless-Retry-Count',
					'0',
					'x-dup',
					'first',
					'x-dup',
					'second',
					'Content-Type',
					'application/json',
				],
				body: Buffer.from('{"model":"m"}'),
			});

			const { rawHeaders } = upstream.seen[0];
			// Names keep their casing and values are byte for byte.
			expect(rawValues(rawHeaders, 'Authorization')).toEqual(['Bearer sk-ant-oat01-secret']);
			expect(rawValues(rawHeaders, 'x-api-key')).toEqual(['sk-ant-api03-secret']);
			expect(rawValues(rawHeaders, 'anthropic-version')).toEqual(['2023-06-01']);
			expect(rawValues(rawHeaders, 'Anthropic-Beta')).toEqual(['oauth-2025-04-20']);
			expect(rawValues(rawHeaders, 'X-Stainless-Retry-Count')).toEqual(['0']);
			expect(rawValues(rawHeaders, 'Content-Type')).toEqual(['application/json']);
			// A repeated header stays repeated, in order.
			expect(rawValues(rawHeaders, 'x-dup')).toEqual(['first', 'second']);
		});

		it('rewrites Host to the upstream and drops only hop-by-hop headers', async () => {
			const upstream = await startUpstream((_req, res) => res.end('ok'));
			const { port } = await startProxy({ anthropic: upstream.origin });

			await send(port, {
				path: '/anthropic/v1/messages',
				headers: [
					'Connection',
					'close, X-Hop',
					'X-Hop',
					'1',
					'Proxy-Authorization',
					'Basic abc',
					'TE',
					'trailers',
					'X-Kept',
					'yes',
				],
				body: Buffer.from('{}'),
			});

			const { rawHeaders } = upstream.seen[0];
			expect(rawValues(rawHeaders, 'Host')).toEqual([upstream.host]);
			expect(lowerNames(rawHeaders).filter((name) => name === 'host')).toHaveLength(1);
			expect(lowerNames(rawHeaders)).not.toContain('x-hop');
			expect(lowerNames(rawHeaders)).not.toContain('proxy-authorization');
			expect(lowerNames(rawHeaders)).not.toContain('te');
			expect(rawValues(rawHeaders, 'X-Kept')).toEqual(['yes']);
		});

		it('returns the response status line and headers as the upstream sent them', async () => {
			const upstream = await startUpstream((_req, res) => {
				res.writeHead(201, 'Made', [
					'Request-Id',
					'req_123',
					'anthropic-ratelimit-tokens-remaining',
					'9000',
					'Set-Cookie',
					'a=1',
					'Set-Cookie',
					'b=2',
					'Content-Type',
					'application/json',
				]);
				res.end('{"ok":true}');
			});
			const { port } = await startProxy({ anthropic: upstream.origin });

			const response = await send(port, {
				path: '/anthropic/v1/messages',
				body: Buffer.from('{}'),
			});

			expect(response.status).toBe(201);
			expect(response.statusMessage).toBe('Made');
			expect(rawValues(response.rawHeaders, 'Request-Id')).toEqual(['req_123']);
			expect(rawValues(response.rawHeaders, 'anthropic-ratelimit-tokens-remaining')).toEqual([
				'9000',
			]);
			expect(rawValues(response.rawHeaders, 'Set-Cookie')).toEqual(['a=1', 'b=2']);
			expect(response.body.toString()).toBe('{"ok":true}');
		});

		it('keeps the query string and the upstream base path on the forwarded request', async () => {
			const upstream = await startUpstream((_req, res) => res.end('ok'));
			const { port } = await startProxy({
				anthropic: upstream.origin,
				chatgpt: `${upstream.origin}/backend-api/codex`,
			});

			await send(port, {
				path: '/anthropic/v1/messages?beta=true&q=a%20b',
				body: Buffer.from('{}'),
			});
			await send(port, { path: '/chatgpt/responses', body: Buffer.from('{}') });
			await send(port, { method: 'GET', path: '/anthropic/v1/models' });

			expect(upstream.seen.map((request) => `${request.method} ${request.url}`)).toEqual([
				'POST /v1/messages?beta=true&q=a%20b',
				'POST /backend-api/codex/responses',
				'GET /v1/models',
			]);
		});
	});

	describe('encoded body passthrough', () => {
		it('forwards a zstd-labelled request body byte for byte, without decoding it', async () => {
			// Random bytes are not valid zstd. Anything that tried to decode the
			// body would fail; a passthrough never looks.
			const body = randomBytes(256 * 1024);
			const upstream = await startUpstream((_req, res) => res.end('ok'));
			const { port, logs } = await startProxy({ openai: upstream.origin });

			await send(port, {
				path: '/openai/v1/responses',
				headers: [
					'Content-Encoding',
					'zstd',
					'Content-Type',
					'application/json',
					'Content-Length',
					String(body.length),
				],
				body,
			});

			const seen = upstream.seen[0];
			expect(seen.body.equals(body)).toBe(true);
			expect(rawValues(seen.rawHeaders, 'Content-Encoding')).toEqual(['zstd']);
			expect(rawValues(seen.rawHeaders, 'Content-Length')).toEqual([String(body.length)]);
			await vi.waitFor(() => expect(logs).toHaveLength(1));
			expect(logs[0].requestBytes).toBe(body.length);
		});

		it('forwards a body sent without a length (chunked) whole', async () => {
			const body = randomBytes(64 * 1024);
			const upstream = await startUpstream((_req, res) => res.end('ok'));
			const { port } = await startProxy({ openai: upstream.origin });

			await send(port, {
				path: '/openai/v1/responses',
				headers: ['Content-Encoding', 'zstd'],
				body,
			});

			expect(upstream.seen[0].body.equals(body)).toBe(true);
			expect(rawValues(upstream.seen[0].rawHeaders, 'Content-Encoding')).toEqual(['zstd']);
		});

		it('returns a compressed response as the bytes the upstream sent', async () => {
			const compressed = zlib.gzipSync(Buffer.from(JSON.stringify({ text: 'x'.repeat(5000) })));
			const upstream = await startUpstream((_req, res) => {
				res.writeHead(200, {
					'content-encoding': 'gzip',
					'content-type': 'application/json',
					'content-length': compressed.length,
				});
				res.end(compressed);
			});
			const { port, logs } = await startProxy({ anthropic: upstream.origin });

			const response = await send(port, {
				path: '/anthropic/v1/messages',
				body: Buffer.from('{}'),
			});

			expect(response.body.equals(compressed)).toBe(true);
			expect(response.headers['content-encoding']).toBe('gzip');
			expect(response.headers['content-length']).toBe(String(compressed.length));
			await vi.waitFor(() => expect(logs).toHaveLength(1));
			expect(logs[0].responseBytes).toBe(compressed.length);
		});
	});

	describe('upstream error passthrough', () => {
		it('forwards an upstream error status, headers and body untouched', async () => {
			const errorBody = JSON.stringify({
				type: 'error',
				error: { type: 'rate_limit_error', message: 'Slow down.' },
			});
			const upstream = await startUpstream((_req, res) => {
				res.writeHead(429, {
					'content-type': 'application/json',
					'retry-after': '7',
					'request-id': 'req_err',
				});
				res.end(errorBody);
			});
			const { port, logs } = await startProxy({ anthropic: upstream.origin });

			const response = await send(port, {
				path: '/anthropic/v1/messages',
				body: Buffer.from('{}'),
			});

			expect(response.status).toBe(429);
			expect(response.headers['retry-after']).toBe('7');
			expect(response.headers['request-id']).toBe('req_err');
			expect(response.body.toString()).toBe(errorBody);
			// The upstream answered. To the proxy that is a completed request.
			await vi.waitFor(() => expect(logs).toHaveLength(1));
			expect(logs[0]).toMatchObject({ status: 429, outcome: 'completed' });
			expect(logs[0].error).toBeUndefined();
		});

		it('forwards a 529 and a 401 the same way', async () => {
			const statuses = [529, 401];
			const upstream = await startUpstream((_req, res) => {
				const status = statuses.shift() ?? 500;
				res.writeHead(status, { 'content-type': 'application/json' });
				res.end(`{"status":${status}}`);
			});
			const { port } = await startProxy({ anthropic: upstream.origin });

			const overloaded = await send(port, {
				path: '/anthropic/v1/messages',
				body: Buffer.from('{}'),
			});
			const unauthorized = await send(port, {
				path: '/anthropic/v1/messages',
				body: Buffer.from('{}'),
			});

			expect([overloaded.status, overloaded.body.toString()]).toEqual([529, '{"status":529}']);
			expect([unauthorized.status, unauthorized.body.toString()]).toEqual([401, '{"status":401}']);
		});
	});

	describe('failures of the proxy itself', () => {
		it('answers a path with no route by name, and forwards nothing', async () => {
			const upstream = await startUpstream((_req, res) => res.end('ok'));
			const { port, logs } = await startProxy({ anthropic: upstream.origin });

			const response = await send(port, { path: '/v1/messages', body: Buffer.from('{}') });

			expect(response.status).toBe(404);
			const body = JSON.parse(response.body.toString());
			expect(body.error.type).toBe('maestro_token_proxy_error');
			expect(body.error.code).toBe('unknown-route');
			expect(body.error.message).toContain('Maestro token proxy');
			expect(upstream.seen).toHaveLength(0);
			await vi.waitFor(() => expect(logs).toHaveLength(1));
			expect(logs[0]).toMatchObject({ route: null, status: 404, outcome: 'unknown-route' });
		});

		it('answers 502 by name when the upstream cannot be reached', async () => {
			const dead = await startUpstream((_req, res) => res.end('ok'));
			await dead.close();
			const { port, logs } = await startProxy({ anthropic: dead.origin });

			const response = await send(port, {
				path: '/anthropic/v1/messages',
				body: Buffer.from('{}'),
			});

			expect(response.status).toBe(502);
			const body = JSON.parse(response.body.toString());
			expect(body.error.code).toBe('upstream-unreachable');
			expect(body.error.message).toContain('Maestro token proxy');
			expect(body.error.message).toContain(dead.origin);
			expect(body.error.message).toContain('not sent anywhere else');
			await vi.waitFor(() => expect(logs).toHaveLength(1));
			expect(logs[0]).toMatchObject({ status: 502, outcome: 'upstream-failed' });
		});

		it('cuts the client when the upstream drops mid-response, never ending it cleanly', async () => {
			const upstream = await startUpstream((_req, res) => {
				res.writeHead(200, { 'content-type': 'text/event-stream' });
				res.write('data: {"n":1}\n\n', () => res.socket?.destroy());
			});
			const { port, logs } = await startProxy({ anthropic: upstream.origin });

			const outcome = await new Promise<{ ended: boolean; complete: boolean }>((resolve) => {
				const req = http.request(
					{ host: '127.0.0.1', port, method: 'POST', path: '/anthropic/v1/messages', agent: false },
					(res) => {
						let ended = false;
						res.on('data', () => {});
						res.on('end', () => {
							ended = true;
						});
						res.on('error', () => {});
						res.on('close', () => resolve({ ended, complete: res.complete }));
					}
				);
				req.on('error', () => resolve({ ended: false, complete: false }));
				req.end('{}');
			});

			expect(outcome.complete).toBe(false);
			expect(outcome.ended).toBe(false);
			await vi.waitFor(() => expect(logs).toHaveLength(1));
			expect(logs[0]).toMatchObject({ status: 200, outcome: 'upstream-failed' });
		});

		it('ends the upstream request when the client goes away', async () => {
			let upstreamClosed: () => void = () => {};
			const upstreamSawClose = new Promise<void>((resolve) => {
				upstreamClosed = resolve;
			});
			const upstream = await startUpstream((_req, res) => {
				res.on('close', () => {
					if (!res.writableFinished) upstreamClosed();
				});
				res.writeHead(200, { 'content-type': 'text/event-stream' });
				// Never ends: only the client leaving can stop it.
				res.write('data: {"n":1}\n\n');
			});
			const { port, logs } = await startProxy({ anthropic: upstream.origin });

			await new Promise<void>((resolve) => {
				const req = http.request(
					{ host: '127.0.0.1', port, method: 'POST', path: '/anthropic/v1/messages', agent: false },
					(res) => {
						res.on('error', () => {});
						res.once('data', () => {
							req.destroy();
							resolve();
						});
					}
				);
				req.on('error', () => {});
				req.end('{}');
			});

			await upstreamSawClose;
			await vi.waitFor(() => expect(logs).toHaveLength(1));
			expect(logs[0]).toMatchObject({ outcome: 'client-aborted' });
		});

		it('counts a stream the client left after its final event as completed', async () => {
			// Codex hangs up as soon as it has `response.completed`, without waiting
			// for the upstream to close. On real traffic every one of its turns was
			// logged `client-aborted` although each had finished.
			const upstream = await startUpstream((_req, res) => {
				res.writeHead(200, { 'content-type': 'text/event-stream' });
				// The marker is split across two writes, as a network would split it.
				res.write(
					'event: response.output_text.delta\ndata: {"delta":"ok"}\n\nevent: response.comp'
				);
				setTimeout(() => res.write('leted\ndata: {"type":"response.completed"}\n\n'), 20);
				// Never ends: the client decides when it is done.
			});
			const { port, logs } = await startProxy({ chatgpt: upstream.origin });

			await new Promise<void>((resolve) => {
				const req = http.request(
					{ host: '127.0.0.1', port, method: 'POST', path: '/chatgpt/responses', agent: false },
					(res) => {
						let seen = '';
						res.on('error', () => {});
						res.on('data', (chunk: Buffer) => {
							seen += chunk.toString();
							if (seen.includes('response.completed')) {
								req.destroy();
								resolve();
							}
						});
					}
				);
				req.on('error', () => {});
				req.end('{}');
			});

			await vi.waitFor(() => expect(logs).toHaveLength(1));
			expect(logs[0]).toMatchObject({ status: 200, outcome: 'completed' });
		});

		it('reads the end of a turn from a stream sent with no content type', async () => {
			// The ChatGPT backend answers a Codex turn with an event stream and no
			// `Content-Type` header. Read only when typed, every finished Codex turn
			// was still logged `client-aborted`.
			const upstream = await startUpstream((_req, res) => {
				res.writeHead(200);
				res.write('event: response.completed\ndata: {"type":"response.completed"}\n\n');
			});
			const { port, logs } = await startProxy({ chatgpt: upstream.origin });

			const leaveAfterFirstChunk = (path: string) =>
				new Promise<void>((resolve) => {
					const req = http.request(
						{ host: '127.0.0.1', port, method: 'POST', path, agent: false },
						(res) => {
							res.on('error', () => {});
							res.once('data', () => {
								req.destroy();
								resolve();
							});
						}
					);
					req.on('error', () => {});
					req.end('{}');
				});

			await leaveAfterFirstChunk('/chatgpt/responses');
			await vi.waitFor(() => expect(logs).toHaveLength(1));
			expect(logs[0]).toMatchObject({ status: 200, outcome: 'completed' });

			// Only a message request is read that way. Anything else with no type
			// that the client leaves early is what it looks like.
			await leaveAfterFirstChunk('/chatgpt/models');
			await vi.waitFor(() => expect(logs).toHaveLength(2));
			expect(logs[1]).toMatchObject({ status: 200, outcome: 'client-aborted' });
		});

		it('refuses a WebSocket handshake by name, and forwards nothing', async () => {
			// Forwarded, the handshake reaches the upstream as a plain GET (the
			// `Upgrade` header is hop-by-hop) and comes back 405, which Codex retried
			// nine times before sending the turn over HTTP. 426 makes it switch at once.
			const upstream = await startUpstream((_req, res) => res.end('ok'));
			const { port, logs } = await startProxy({ chatgpt: upstream.origin });

			const response = await send(port, {
				method: 'GET',
				path: '/chatgpt/responses',
				headers: ['Connection', 'Upgrade', 'Upgrade', 'websocket'],
			});

			expect(response.status).toBe(426);
			const body = JSON.parse(response.body.toString());
			expect(body.error.type).toBe('maestro_token_proxy_error');
			expect(body.error.code).toBe('upgrade-not-supported');
			expect(body.error.message).toContain('carries HTTP requests only, not a websocket');
			expect(upstream.seen).toHaveLength(0);
			await vi.waitFor(() => expect(logs).toHaveLength(1));
			expect(logs[0]).toMatchObject({
				route: 'chatgpt',
				status: 426,
				outcome: 'upgrade-refused',
			});
		});

		it('reads the end of a turn from each provider, and from nothing else', () => {
			expect(streamAnnouncedItsEnd('event: response.completed\ndata: {}')).toBe(true);
			expect(streamAnnouncedItsEnd('event: response.failed\ndata: {}')).toBe(true);
			expect(streamAnnouncedItsEnd('data: [DONE]\n\n')).toBe(true);
			expect(streamAnnouncedItsEnd('event: message_stop\ndata: {"type":"message_stop"}')).toBe(
				true
			);
			expect(streamAnnouncedItsEnd('event: content_block_delta\ndata: {"n":1}')).toBe(false);
			expect(streamAnnouncedItsEnd('')).toBe(false);
		});
	});

	describe('listening', () => {
		it('binds loopback only, reports its port, and releases it on close', async () => {
			const proxy = createTokenProxyServer({ upstreams: {} });
			expect(proxy.port()).toBeNull();

			const port = await proxy.listen(0);
			expect(proxy.port()).toBe(port);

			await proxy.close({ force: true });
			expect(proxy.port()).toBeNull();

			// The port is free again: a second server takes the same one.
			const again = createTokenProxyServer({ upstreams: {} });
			cleanups.push(() => again.close({ force: true }));
			await expect(again.listen(port)).resolves.toBe(port);
		});

		it('rejects when the port is already taken', async () => {
			const first = createTokenProxyServer({ upstreams: {} });
			cleanups.push(() => first.close({ force: true }));
			const port = await first.listen(0);

			const second = createTokenProxyServer({ upstreams: {} });
			await expect(second.listen(port)).rejects.toMatchObject({ code: 'EADDRINUSE' });
		});

		it('lets a request in flight finish on a graceful close', async () => {
			let finish: () => void = () => {};
			const mayFinish = new Promise<void>((resolve) => {
				finish = resolve;
			});
			const upstream = await startUpstream(async (_req, res) => {
				res.writeHead(200, { 'content-type': 'text/plain' });
				res.write('first ');
				await mayFinish;
				res.end('second');
			});
			const { proxy, port } = await startProxy({ anthropic: upstream.origin });

			const whole = await new Promise<string>((resolve, reject) => {
				const req = http.request(
					{ host: '127.0.0.1', port, method: 'POST', path: '/anthropic/v1/messages', agent: false },
					(res) => {
						let text = '';
						res.setEncoding('utf-8');
						res.once('data', () => {
							// Stop the proxy while this response is half delivered.
							void proxy.close();
							finish();
						});
						res.on('data', (chunk: string) => {
							text += chunk;
						});
						res.on('error', reject);
						res.on('end', () => resolve(text));
					}
				);
				req.on('error', reject);
				req.end('{}');
			});

			expect(whole).toBe('first second');
			expect(proxy.port()).toBeNull();
		});
	});
});

describe('token proxy server, compress mode', () => {
	/** What a compressor run reports, for a body it changed or left alone. */
	function compressResult(body: string, changed: boolean): CompressRequestResult {
		return {
			body,
			changed,
			blocks: changed
				? [
						{
							hash: 'a'.repeat(64),
							originalTokens: 2000,
							compressedTokens: 200,
							compressors: ['logs'],
							cached: false,
						},
					]
				: [],
			stats: {
				candidates: 1,
				belowThreshold: 0,
				compressed: changed ? 1 : 0,
				kept: changed ? 0 : 1,
				cacheHits: 0,
				originalTokens: changed ? 2000 : 0,
				compressedTokens: changed ? 200 : 0,
				compressors: { json: 0, logs: changed ? 1 : 0, 'long-lines': 0, model: 0 },
				modelFailures: 0,
				storeFailures: 0,
			},
		};
	}

	const original = JSON.stringify({ messages: [{ role: 'user', content: 'x'.repeat(4000) }] });
	const shortened = JSON.stringify({ messages: [{ role: 'user', content: 'short' }] });
	const jsonHeaders = (body: Buffer): string[] => [
		'Content-Type',
		'application/json',
		'x-api-key',
		'sk-test',
		'Content-Length',
		String(body.length),
	];

	it('tells the compressor when the agent chose to compress early', async () => {
		const upstream = await startUpstream((_req, res) => res.end('ok'));
		const compress = vi.fn(async () => compressResult(shortened, true));
		const modeFor = vi.fn(() => 'compress-early' as const);
		const { port, logs } = await startProxy({ anthropic: upstream.origin }, { modeFor, compress });
		const body = Buffer.from(original, 'utf-8');

		await send(port, {
			path: '/agent/agent-1/anthropic/v1/messages',
			headers: jsonHeaders(body),
			body,
		});

		expect(compress).toHaveBeenCalledWith('anthropic-messages', original, { early: true });
		expect(upstream.seen[0].body.toString()).toBe(shortened);
		await vi.waitFor(() => expect(logs).toHaveLength(1));
		expect(logs[0]).toMatchObject({ mode: 'compress-early', compression: { changed: true } });
	});

	it('sends the shortened body, with its own length, for an agent in compress mode', async () => {
		const upstream = await startUpstream((_req, res) => res.end('ok'));
		const compress = vi.fn(async () => compressResult(shortened, true));
		const modeFor = vi.fn(() => 'compress' as const);
		const { port, logs } = await startProxy({ anthropic: upstream.origin }, { modeFor, compress });
		const body = Buffer.from(original, 'utf-8');

		const answer = await send(port, {
			path: '/agent/agent-1/anthropic/v1/messages?beta=true',
			headers: jsonHeaders(body),
			body,
		});

		expect(answer.body.toString()).toBe('ok');
		expect(modeFor).toHaveBeenCalledWith('agent-1');
		expect(compress).toHaveBeenCalledWith('anthropic-messages', original, { early: false });
		const seen = upstream.seen[0];
		// The agent prefix is the proxy's own: the upstream never sees it.
		expect(seen.url).toBe('/v1/messages?beta=true');
		expect(seen.body.toString('utf-8')).toBe(shortened);
		expect(rawValues(seen.rawHeaders, 'Content-Length')).toEqual([
			String(Buffer.byteLength(shortened)),
		]);
		// Everything else about the request is as it was sent.
		expect(rawValues(seen.rawHeaders, 'x-api-key')).toEqual(['sk-test']);
		expect(rawValues(seen.rawHeaders, 'Content-Type')).toEqual(['application/json']);

		await vi.waitFor(() => expect(logs).toHaveLength(1));
		expect(logs[0]).toMatchObject({
			agentId: 'agent-1',
			mode: 'compress',
			kind: 'anthropic-messages',
			requestBytes: body.length,
			sentBytes: Buffer.byteLength(shortened),
			outcome: 'completed',
		});
		expect(logs[0].compression).toMatchObject({
			changed: true,
			originalTokens: Math.ceil(original.length / 4),
			sentTokens: Math.ceil(shortened.length / 4),
		});
		expect(logs[0].compression?.addedLatencyMs).toBeGreaterThanOrEqual(0);
		expect(logs[0].compression?.blocks).toHaveLength(1);
	});

	it('forwards the bytes that arrived when the compressor changes nothing', async () => {
		const upstream = await startUpstream((_req, res) => res.end('ok'));
		const compress = vi.fn(async (_kind: string, text: string) => compressResult(text, false));
		const { port, logs } = await startProxy(
			{ anthropic: upstream.origin },
			{ modeFor: () => 'compress', compress }
		);
		const body = Buffer.from(original, 'utf-8');

		await send(port, {
			path: '/agent/agent-1/anthropic/v1/messages',
			headers: jsonHeaders(body),
			body,
		});

		expect(upstream.seen[0].body.equals(body)).toBe(true);
		expect(rawValues(upstream.seen[0].rawHeaders, 'Content-Length')).toEqual([String(body.length)]);
		await vi.waitFor(() => expect(logs).toHaveLength(1));
		expect(logs[0].sentBytes).toBe(body.length);
		expect(logs[0].compression).toMatchObject({
			changed: false,
			originalTokens: Math.ceil(original.length / 4),
			sentTokens: Math.ceil(original.length / 4),
		});
	});

	it('never reads a request in passthrough mode, the default', async () => {
		const upstream = await startUpstream((_req, res) => res.end('ok'));
		const compress = vi.fn(async () => compressResult(shortened, true));
		const body = Buffer.from(original, 'utf-8');

		// An agent whose mode is passthrough, and a request that names no agent.
		const modeFor = vi.fn((agentId: string | null) =>
			agentId === 'agent-c' ? ('compress' as const) : ('passthrough' as const)
		);
		const { port, logs } = await startProxy({ anthropic: upstream.origin }, { modeFor, compress });
		await send(port, {
			path: '/agent/agent-p/anthropic/v1/messages',
			headers: jsonHeaders(body),
			body,
		});
		await send(port, { path: '/anthropic/v1/messages', headers: jsonHeaders(body), body });

		expect(compress).not.toHaveBeenCalled();
		expect(modeFor).toHaveBeenCalledWith('agent-p');
		expect(modeFor).toHaveBeenCalledWith(null);
		expect(upstream.seen.map((seen) => seen.body.equals(body))).toEqual([true, true]);
		await vi.waitFor(() => expect(logs).toHaveLength(2));
		expect(logs.map((entry) => [entry.agentId, entry.mode, entry.compression])).toEqual([
			['agent-p', 'passthrough', undefined],
			[null, 'passthrough', undefined],
		]);
		expect(logs[0].sentBytes).toBe(body.length);
	});

	it('applies a mode change to the next request', async () => {
		const upstream = await startUpstream((_req, res) => res.end('ok'));
		const compress = vi.fn(async () => compressResult(shortened, true));
		let mode: 'passthrough' | 'compress' = 'passthrough';
		const { port } = await startProxy(
			{ anthropic: upstream.origin },
			{ modeFor: () => mode, compress }
		);
		const body = Buffer.from(original, 'utf-8');
		const request = { path: '/agent/a/anthropic/v1/messages', headers: jsonHeaders(body), body };

		await send(port, request);
		mode = 'compress';
		await send(port, request);
		mode = 'passthrough';
		await send(port, request);

		expect(upstream.seen.map((seen) => seen.body.toString('utf-8'))).toEqual([
			original,
			shortened,
			original,
		]);
		expect(compress).toHaveBeenCalledTimes(1);
	});

	it('leaves a request with no message list on the passthrough path', async () => {
		const upstream = await startUpstream((_req, res) => res.end('ok'));
		const compress = vi.fn(async () => compressResult(shortened, true));
		const { port, logs } = await startProxy(
			{ anthropic: upstream.origin },
			{ modeFor: () => 'compress', compress }
		);
		const body = Buffer.from(original, 'utf-8');

		await send(port, {
			path: '/agent/a/anthropic/v1/messages/count_tokens',
			headers: jsonHeaders(body),
			body,
		});

		expect(compress).not.toHaveBeenCalled();
		expect(upstream.seen[0].body.equals(body)).toBe(true);
		await vi.waitFor(() => expect(logs).toHaveLength(1));
		expect(logs[0]).toMatchObject({ kind: 'other', mode: 'compress' });
		expect(logs[0].compression).toBeUndefined();
	});

	it('decodes a gzip body to read it, and sends the shortened body plain', async () => {
		const upstream = await startUpstream((_req, res) => res.end('ok'));
		const compress = vi.fn(async () => compressResult(shortened, true));
		const { port } = await startProxy(
			{ openai: upstream.origin },
			{ modeFor: () => 'compress', compress }
		);
		const body = zlib.gzipSync(Buffer.from(original, 'utf-8'));

		await send(port, {
			path: '/agent/a/openai/v1/responses',
			headers: ['Content-Encoding', 'gzip', 'Content-Length', String(body.length)],
			body,
		});

		expect(compress).toHaveBeenCalledWith('openai-responses', original, { early: false });
		const seen = upstream.seen[0];
		expect(seen.body.toString('utf-8')).toBe(shortened);
		// The declared encoding no longer describes the body, so it is gone.
		expect(lowerNames(seen.rawHeaders)).not.toContain('content-encoding');
	});

	it('forwards an encoded body untouched when nothing in it changes', async () => {
		const upstream = await startUpstream((_req, res) => res.end('ok'));
		const compress = vi.fn(async (_kind: string, text: string) => compressResult(text, false));
		const { port } = await startProxy(
			{ openai: upstream.origin },
			{ modeFor: () => 'compress', compress }
		);
		const body = zlib.gzipSync(Buffer.from(original, 'utf-8'));

		await send(port, {
			path: '/agent/a/openai/v1/responses',
			headers: ['Content-Encoding', 'gzip', 'Content-Length', String(body.length)],
			body,
		});

		expect(upstream.seen[0].body.equals(body)).toBe(true);
		expect(rawValues(upstream.seen[0].rawHeaders, 'Content-Encoding')).toEqual(['gzip']);
	});

	it('sends a body it cannot read as it arrived, and says why', async () => {
		const upstream = await startUpstream((_req, res) => res.end('ok'));
		const compress = vi.fn(async () => compressResult(shortened, true));
		const { port, logs } = await startProxy(
			{ openai: upstream.origin },
			{ modeFor: () => 'compress', compress }
		);
		const cases: Array<{ headers: string[]; body: Buffer; skipped: string }> = [
			// An encoding this module has no decoder for.
			{ headers: ['Content-Encoding', 'snappy'], body: randomBytes(512), skipped: 'encoding' },
			// Bytes that are not UTF-8 would not survive the trip back.
			{ headers: [], body: Buffer.from([0xff, 0xfe, 0x00, 0xc3]), skipped: 'not-text' },
			// A gzip label on bytes that are not gzip.
			{ headers: ['Content-Encoding', 'gzip'], body: randomBytes(512), skipped: 'failed' },
		];

		for (const [index, entry] of cases.entries()) {
			const answer = await send(port, {
				path: '/agent/a/openai/v1/responses',
				headers: [...entry.headers, 'Content-Length', String(entry.body.length)],
				body: entry.body,
			});
			expect(answer.status).toBe(200);
			expect(upstream.seen[index].body.equals(entry.body)).toBe(true);
			await vi.waitFor(() => expect(logs).toHaveLength(index + 1));
			expect(logs[index].compression).toMatchObject({ skipped: entry.skipped, changed: false });
			expect(logs[index].sentBytes).toBe(entry.body.length);
		}
		expect(compress).not.toHaveBeenCalled();
	});

	it('sends the request as it arrived when the compressor throws', async () => {
		const upstream = await startUpstream((_req, res) => res.end('ok'));
		const compress = vi.fn(async () => {
			throw new Error('cache directory is gone');
		});
		const { port, logs } = await startProxy(
			{ anthropic: upstream.origin },
			{ modeFor: () => 'compress', compress }
		);
		const body = Buffer.from(original, 'utf-8');

		const answer = await send(port, {
			path: '/agent/a/anthropic/v1/messages',
			headers: jsonHeaders(body),
			body,
		});

		// The turn is not lost to a failure of the optimization.
		expect(answer.status).toBe(200);
		expect(upstream.seen[0].body.equals(body)).toBe(true);
		await vi.waitFor(() => expect(logs).toHaveLength(1));
		expect(logs[0].outcome).toBe('completed');
		expect(logs[0].compression).toMatchObject({
			skipped: 'failed',
			changed: false,
			error: 'cache directory is gone',
		});
	});

	it('is a passthrough when no compressor was given, whatever the mode', async () => {
		const upstream = await startUpstream((_req, res) => res.end('ok'));
		const { port, logs } = await startProxy(
			{ anthropic: upstream.origin },
			{ modeFor: () => 'compress' }
		);
		const body = Buffer.from(original, 'utf-8');

		await send(port, {
			path: '/agent/a/anthropic/v1/messages',
			headers: jsonHeaders(body),
			body,
		});

		expect(upstream.seen[0].body.equals(body)).toBe(true);
		await vi.waitFor(() => expect(logs).toHaveLength(1));
		expect(logs[0].compression).toBeUndefined();
	});

	it('still answers an upstream that cannot be reached by name', async () => {
		const compress = vi.fn(async () => compressResult(shortened, true));
		const { port, logs } = await startProxy(
			{ anthropic: 'http://127.0.0.1:1' },
			{ modeFor: () => 'compress', compress }
		);
		const body = Buffer.from(original, 'utf-8');

		const answer = await send(port, {
			path: '/agent/a/anthropic/v1/messages',
			headers: jsonHeaders(body),
			body,
		});

		expect(answer.status).toBe(502);
		expect(JSON.parse(answer.body.toString()).error.code).toBe('upstream-unreachable');
		await vi.waitFor(() => expect(logs).toHaveLength(1));
		expect(logs[0].outcome).toBe('upstream-failed');
	});
});

describe('token proxy server, background routing', () => {
	const HAIKU = 'claude-haiku-4-5-20251001';
	const TARGET_MODEL = 'qwen3.5-4b';
	const ROUTED_TO = `maestro-server:${TARGET_MODEL}`;

	/** A title request as Claude Code sends one: the small model, no tools, nothing cached. */
	function titleRequest(overrides: Record<string, unknown> = {}): string {
		return JSON.stringify({
			model: HAIKU,
			max_tokens: 64,
			system: [{ type: 'text', text: 'Write a title.', cache_control: { type: 'ephemeral' } }],
			messages: [{ role: 'user', content: 'fix the login bug' }],
			stream: false,
			...overrides,
		});
	}

	/** What the client holds for the provider. None of it may reach a target. */
	function clientHeaders(body: Buffer): string[] {
		return [
			'Content-Type',
			'application/json',
			'Authorization',
			'Bearer oauth-for-anthropic',
			'x-api-key',
			'sk-ant-secret',
			'anthropic-version',
			'2023-06-01',
			'Content-Length',
			String(body.length),
		];
	}

	const answerAs =
		(who: string, status = 200): UpstreamHandler =>
		(_req, res) => {
			res.writeHead(status, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ from: who }));
		};

	/**
	 * A provider, a target, and a proxy on which agent `bg` sends its background
	 * requests to the target. Every other agent sends them nowhere.
	 */
	async function setup(
		options: {
			target?: UpstreamHandler;
			resolve?: (targetOrigin: string) => Promise<TokenProxyBackgroundTarget>;
			extra?: Pick<TokenProxyServerOptions, 'modeFor' | 'compress'>;
		} = {}
	) {
		const provider = await startUpstream(answerAs('provider'));
		const target = await startUpstream(options.target ?? answerAs('target'));
		const resolve = vi.fn(
			(): Promise<TokenProxyBackgroundTarget> =>
				options.resolve
					? options.resolve(target.origin)
					: Promise.resolve({
							ok: true,
							baseUrl: target.origin,
							key: 'sk-target',
							model: TARGET_MODEL,
						})
		);
		const backgroundRouteFor = vi.fn((agentId: string | null) =>
			agentId === 'bg' ? { toolType: 'claude-code', routedTo: ROUTED_TO, resolve } : null
		);
		const running = await startProxy(
			{ anthropic: provider.origin, openai: provider.origin },
			{ backgroundRouteFor, ...options.extra }
		);
		return { provider, target, resolve, backgroundRouteFor, ...running };
	}

	function post(port: number, text: string, path = '/agent/bg/anthropic/v1/messages?beta=true') {
		const body = Buffer.from(text, 'utf-8');
		return send(port, { path, headers: clientHeaders(body), body });
	}

	it('sends a background request to the target, and not to the provider', async () => {
		const { provider, target, resolve, port, logs } = await setup();
		const original = titleRequest();

		const answer = await post(port, original);

		expect(JSON.parse(answer.body.toString())).toEqual({ from: 'target' });
		expect(provider.seen).toHaveLength(0);
		expect(resolve).toHaveBeenCalledTimes(1);
		const seen = target.seen[0];
		// The same path and query, without the proxy's own prefixes.
		expect(seen.url).toBe('/v1/messages?beta=true');
		// The same body, with one name changed.
		const sent = original.replace(`"model":"${HAIKU}"`, `"model":"${TARGET_MODEL}"`);
		expect(seen.body.toString('utf-8')).toBe(sent);
		expect(rawValues(seen.rawHeaders, 'Content-Length')).toEqual([String(Buffer.byteLength(sent))]);
		expect(rawValues(seen.rawHeaders, 'Host')).toEqual([target.host]);
		expect(rawValues(seen.rawHeaders, 'anthropic-version')).toEqual(['2023-06-01']);
		expect(rawValues(seen.rawHeaders, 'Content-Type')).toEqual(['application/json']);

		await vi.waitFor(() => expect(logs).toHaveLength(1));
		expect(logs[0]).toMatchObject({
			agentId: 'bg',
			kind: 'anthropic-messages',
			status: 200,
			outcome: 'completed',
			requestBytes: Buffer.byteLength(original),
			sentBytes: Buffer.byteLength(sent),
		});
		expect(logs[0].background).toMatchObject({ routedTo: ROUTED_TO });
		expect(logs[0].background?.skipped).toBeUndefined();
		expect(logs[0].background?.addedLatencyMs).toBeGreaterThanOrEqual(0);
		expect(logs[0].compression).toBeUndefined();
	});

	it("sends the target its own key, and none of the client's provider credentials", async () => {
		const { target, port } = await setup();

		await post(port, titleRequest());

		const headers = target.seen[0].rawHeaders;
		expect(rawValues(headers, 'Authorization')).toEqual(['Bearer sk-target']);
		expect(lowerNames(headers)).not.toContain('x-api-key');
		expect(headers.join('\n')).not.toContain('oauth-for-anthropic');
		expect(headers.join('\n')).not.toContain('sk-ant-secret');
	});

	it('sends no credential at all to a target that has no key', async () => {
		const { target, port } = await setup({
			resolve: async (origin) => ({ ok: true, baseUrl: origin, model: TARGET_MODEL }),
		});

		await post(port, titleRequest());

		const names = lowerNames(target.seen[0].rawHeaders);
		expect(names).not.toContain('authorization');
		expect(names).not.toContain('x-api-key');
	});

	it("puts the request's path after a base path of the target", async () => {
		const { target, port } = await setup({
			resolve: async (origin) => ({ ok: true, baseUrl: `${origin}/gateway/`, model: 'm' }),
		});

		await post(port, titleRequest());

		expect(target.seen[0].url).toBe('/gateway/v1/messages?beta=true');
	});

	it('decodes a gzip body to read it, and sends the target plain text', async () => {
		const { provider, target, port } = await setup();
		const original = titleRequest();
		const body = zlib.gzipSync(Buffer.from(original, 'utf-8'));

		await send(port, {
			path: '/agent/bg/anthropic/v1/messages',
			headers: ['Content-Encoding', 'gzip', 'Content-Length', String(body.length)],
			body,
		});

		expect(provider.seen).toHaveLength(0);
		expect(JSON.parse(target.seen[0].body.toString('utf-8')).model).toBe(TARGET_MODEL);
		expect(lowerNames(target.seen[0].rawHeaders)).not.toContain('content-encoding');
	});

	describe('a request that is not a background request', () => {
		const turns: Array<{ skipped: string; body: string }> = [
			{ skipped: 'not-small-model', body: titleRequest({ model: 'claude-sonnet-4-5-20250929' }) },
			{
				skipped: 'thinking',
				body: titleRequest({
					messages: [
						{ role: 'user', content: 'hi' },
						{ role: 'assistant', content: [{ type: 'thinking', thinking: 'x', signature: 's' }] },
						{ role: 'user', content: 'go on' },
					],
				}),
			},
			{
				skipped: 'thinking',
				body: titleRequest({
					messages: [
						{ role: 'user', content: 'hi' },
						{ role: 'assistant', content: [{ type: 'redacted_thinking', data: 'opaque' }] },
						{ role: 'user', content: 'go on' },
					],
				}),
			},
			{
				skipped: 'cache-control',
				body: titleRequest({
					messages: [
						{
							role: 'user',
							content: [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral' } }],
						},
					],
				}),
			},
			{
				skipped: 'tool-result',
				body: titleRequest({
					messages: [
						{ role: 'user', content: 'list' },
						{ role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'LS', input: {} }] },
						{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'a.ts' }] },
					],
				}),
			},
			{
				skipped: 'tools',
				body: titleRequest({ tools: [{ name: 'Read', input_schema: { type: 'object' } }] }),
			},
			{
				// The TUI's quota probe, as Claude Code 2.1.296 sends it.
				skipped: 'probe',
				body: JSON.stringify({
					model: HAIKU,
					max_tokens: 1,
					messages: [{ role: 'user', content: 'quota' }],
				}),
			},
			{ skipped: 'unreadable', body: '{"model":"claude-haiku-4-5-20251001"' },
		];

		it('goes to the provider exactly as it arrived, and starts no target', async () => {
			const { provider, target, resolve, port, logs } = await setup();

			for (const [index, turn] of turns.entries()) {
				const answer = await post(port, turn.body);

				expect(JSON.parse(answer.body.toString()), turn.skipped).toEqual({ from: 'provider' });
				const seen = provider.seen[index];
				expect(seen.body.toString('utf-8'), turn.skipped).toBe(turn.body);
				expect(seen.url).toBe('/v1/messages?beta=true');
				// The provider gets the credentials it was sent.
				expect(rawValues(seen.rawHeaders, 'Authorization')).toEqual(['Bearer oauth-for-anthropic']);
				expect(rawValues(seen.rawHeaders, 'x-api-key')).toEqual(['sk-ant-secret']);
				await vi.waitFor(() => expect(logs).toHaveLength(index + 1));
				expect(logs[index].background, turn.skipped).toMatchObject({ skipped: turn.skipped });
				expect(logs[index].background?.routedTo).toBeUndefined();
				expect(logs[index].sentBytes).toBe(Buffer.byteLength(turn.body));
			}
			expect(target.seen).toHaveLength(0);
			expect(resolve).not.toHaveBeenCalled();
		});

		it('goes to the provider when its body cannot be read at all', async () => {
			const { provider, target, port, logs } = await setup();
			const cases: Array<{ headers: string[]; body: Buffer; skipped: string }> = [
				{ headers: ['Content-Encoding', 'snappy'], body: randomBytes(256), skipped: 'encoding' },
				{ headers: [], body: Buffer.from([0xff, 0xfe, 0x00, 0xc3]), skipped: 'not-text' },
				{ headers: ['Content-Encoding', 'gzip'], body: randomBytes(256), skipped: 'failed' },
			];

			for (const [index, entry] of cases.entries()) {
				await send(port, {
					path: '/agent/bg/anthropic/v1/messages',
					headers: [...entry.headers, 'Content-Length', String(entry.body.length)],
					body: entry.body,
				});
				expect(provider.seen[index].body.equals(entry.body)).toBe(true);
				await vi.waitFor(() => expect(logs).toHaveLength(index + 1));
				expect(logs[index].background).toMatchObject({ skipped: entry.skipped });
			}
			expect(target.seen).toHaveLength(0);
		});
	});

	it('asks for a route only for an Anthropic Messages request', async () => {
		const { provider, target, backgroundRouteFor, port, logs } = await setup();
		const body = Buffer.from(titleRequest(), 'utf-8');

		// The same body on a path that is not the Messages route, on another
		// provider's route, and a request with no body at all.
		await send(port, {
			path: '/agent/bg/anthropic/v1/messages/count_tokens',
			headers: clientHeaders(body),
			body,
		});
		await send(port, {
			path: '/agent/bg/openai/v1/chat/completions',
			headers: clientHeaders(body),
			body,
		});
		await send(port, { method: 'GET', path: '/agent/bg/anthropic/v1/models' });

		expect(backgroundRouteFor).not.toHaveBeenCalled();
		expect(provider.seen).toHaveLength(3);
		expect(target.seen).toHaveLength(0);
		await vi.waitFor(() => expect(logs).toHaveLength(3));
		expect(logs.every((entry) => entry.background === undefined)).toBe(true);
	});

	it('leaves an agent with no target alone, and a request that names no agent', async () => {
		const { provider, target, backgroundRouteFor, port, logs } = await setup();

		await post(port, titleRequest(), '/agent/plain/anthropic/v1/messages');
		await post(port, titleRequest(), '/anthropic/v1/messages');

		expect(backgroundRouteFor).toHaveBeenCalledWith('plain');
		expect(backgroundRouteFor).toHaveBeenCalledWith(null);
		expect(provider.seen).toHaveLength(2);
		expect(target.seen).toHaveLength(0);
		await vi.waitFor(() => expect(logs).toHaveLength(2));
		expect(logs.every((entry) => entry.background === undefined)).toBe(true);
	});

	it('reads the target on every request, so a change applies to the next one', async () => {
		const { provider, target, backgroundRouteFor, port } = await setup();

		await post(port, titleRequest());
		backgroundRouteFor.mockReturnValue(null);
		await post(port, titleRequest());

		expect(target.seen).toHaveLength(1);
		expect(provider.seen).toHaveLength(1);
	});

	describe('a target that fails', () => {
		it("answers with the target's own error, and does not retry against the provider", async () => {
			const { provider, target, port, logs } = await setup({
				target: (_req, res) => {
					res.writeHead(500, { 'content-type': 'application/json', 'x-target': 'llama' });
					res.end('{"error":{"message":"model failed to load"}}');
				},
			});

			const answer = await post(port, titleRequest());

			expect(answer.status).toBe(500);
			expect(answer.headers['x-target']).toBe('llama');
			expect(answer.body.toString()).toBe('{"error":{"message":"model failed to load"}}');
			expect(target.seen).toHaveLength(1);
			expect(provider.seen).toHaveLength(0);
			await vi.waitFor(() => expect(logs).toHaveLength(1));
			expect(logs[0]).toMatchObject({ status: 500, outcome: 'completed' });
			expect(logs[0].background?.routedTo).toBe(ROUTED_TO);
		});

		it('answers by name when the target cannot be reached, and sends the provider nothing', async () => {
			const dead = await startUpstream((_req, res) => res.end('ok'));
			await dead.close();
			const { provider, port, logs } = await setup({
				resolve: async () => ({ ok: true, baseUrl: dead.origin, key: 'k', model: TARGET_MODEL }),
			});

			const answer = await post(port, titleRequest());

			expect(answer.status).toBe(502);
			const body = JSON.parse(answer.body.toString());
			expect(body.error.type).toBe('maestro_token_proxy_error');
			expect(body.error.code).toBe('upstream-unreachable');
			expect(body.error.message).toContain(dead.origin);
			expect(body.error.message).toContain('not sent anywhere else');
			expect(provider.seen).toHaveLength(0);
			await vi.waitFor(() => expect(logs).toHaveLength(1));
			expect(logs[0]).toMatchObject({ status: 502, outcome: 'upstream-failed' });
			expect(logs[0].background?.routedTo).toBe(ROUTED_TO);
		});

		it('answers by name when the target cannot be used, and sends nothing anywhere', async () => {
			const refusal =
				'This agent sends background requests to Qwen, but the Maestro model server could not serve it. The request was not sent to the provider.';
			const { provider, target, port, logs } = await setup({
				resolve: async () => ({ ok: false, error: refusal }),
			});

			const answer = await post(port, titleRequest());

			expect(answer.status).toBe(502);
			const body = JSON.parse(answer.body.toString());
			expect(body.error.code).toBe('background-target-unavailable');
			expect(body.error.message).toBe(refusal);
			expect(provider.seen).toHaveLength(0);
			expect(target.seen).toHaveLength(0);
			await vi.waitFor(() => expect(logs).toHaveLength(1));
			expect(logs[0]).toMatchObject({
				status: 502,
				outcome: 'upstream-failed',
				error: refusal,
				sentBytes: 0,
			});
			expect(logs[0].background?.routedTo).toBe(ROUTED_TO);
		});

		it('answers by name when the target cannot be made ready or has no usable address', async () => {
			const thrown = await setup({
				resolve: async () => {
					throw new Error('stores are not wired');
				},
			});
			const first = await post(thrown.port, titleRequest());
			expect(first.status).toBe(502);
			expect(JSON.parse(first.body.toString()).error).toMatchObject({
				code: 'background-target-unavailable',
				message: expect.stringContaining('stores are not wired'),
			});
			expect(thrown.provider.seen).toHaveLength(0);

			const badAddress = await setup({
				resolve: async () => ({ ok: true, baseUrl: 'not a url', model: TARGET_MODEL }),
			});
			const second = await post(badAddress.port, titleRequest());
			expect(second.status).toBe(502);
			expect(JSON.parse(second.body.toString()).error.message).toContain(
				'not sent to the provider'
			);
			expect(badAddress.provider.seen).toHaveLength(0);
			expect(badAddress.target.seen).toHaveLength(0);
		});

		it('fails by name when the key cannot be written as a header', async () => {
			const { provider, target, port } = await setup({
				resolve: async (origin) => ({
					ok: true,
					baseUrl: origin,
					key: 'line one\nline two',
					model: TARGET_MODEL,
				}),
			});

			const answer = await post(port, titleRequest());

			expect(answer.status).toBe(502);
			expect(JSON.parse(answer.body.toString()).error.code).toBe('background-target-unavailable');
			expect(provider.seen).toHaveLength(0);
			expect(target.seen).toHaveLength(0);
		});
	});

	it('sends nothing when the client leaves while the target is made ready', async () => {
		let release: () => void = () => {};
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const { provider, target, resolve, port, logs } = await setup({
			resolve: async (origin) => {
				await held;
				return { ok: true, baseUrl: origin, model: TARGET_MODEL };
			},
		});

		const req = http.request({
			host: '127.0.0.1',
			port,
			method: 'POST',
			path: '/agent/bg/anthropic/v1/messages',
			agent: false,
		});
		req.on('error', () => {});
		req.end(titleRequest());
		await vi.waitFor(() => expect(resolve).toHaveBeenCalled());
		// A model that is still loading: the client gives up after a while.
		await new Promise((resolveTick) => setTimeout(resolveTick, 30));
		req.destroy();
		await vi.waitFor(() => expect(logs).toHaveLength(1));
		// Logged with how long it was held, although the wait never finished.
		expect(logs[0].background?.addedLatencyMs).toBeGreaterThanOrEqual(25);
		release();
		await new Promise((resolveTick) => setTimeout(resolveTick, 20));

		expect(logs[0]).toMatchObject({ outcome: 'client-aborted', sentBytes: 0 });
		expect(target.seen).toHaveLength(0);
		expect(provider.seen).toHaveLength(0);
	});

	it('still compresses a turn of a compressing agent, and never a background request', async () => {
		const shortened = titleRequest({ model: 'claude-sonnet-4-5-20250929', messages: [] });
		const compress = vi.fn(
			async (): Promise<CompressRequestResult> => ({
				body: shortened,
				changed: true,
				blocks: [],
				stats: {
					candidates: 1,
					belowThreshold: 0,
					compressed: 1,
					kept: 0,
					cacheHits: 0,
					originalTokens: 10,
					compressedTokens: 5,
					compressors: { json: 0, logs: 1, 'long-lines': 0, model: 0 },
					modelFailures: 0,
					storeFailures: 0,
				},
			})
		);
		const { provider, target, port, logs } = await setup({
			extra: { modeFor: () => 'compress', compress },
		});

		// A turn: read once, kept on the provider, and handed to the compressor.
		const turn = titleRequest({ model: 'claude-sonnet-4-5-20250929' });
		await post(port, turn);
		expect(compress).toHaveBeenCalledWith('anthropic-messages', turn, { early: false });
		expect(provider.seen[0].body.toString('utf-8')).toBe(shortened);

		// A background request: to the target, as it arrived but for the model.
		await post(port, titleRequest());
		expect(compress).toHaveBeenCalledTimes(1);
		expect(target.seen).toHaveLength(1);
		expect(provider.seen).toHaveLength(1);

		await vi.waitFor(() => expect(logs).toHaveLength(2));
		expect(logs[0].compression).toMatchObject({ changed: true });
		expect(logs[0].background).toMatchObject({ skipped: 'not-small-model' });
		expect(logs[1].compression).toBeUndefined();
		expect(logs[1].background).toMatchObject({ routedTo: ROUTED_TO });
	});
});

describe('forwardableHeaders', () => {
	it('keeps order, casing and duplicates', () => {
		expect(forwardableHeaders(['B', '2', 'a', '1', 'B', '3'])).toEqual([
			'B',
			'2',
			'a',
			'1',
			'B',
			'3',
		]);
	});

	it('drops hop-by-hop headers in any casing', () => {
		expect(
			forwardableHeaders([
				'Connection',
				'keep-alive',
				'Keep-Alive',
				'timeout=5',
				'Transfer-Encoding',
				'chunked',
				'Upgrade',
				'h2c',
				'Trailer',
				'x',
				'Proxy-Connection',
				'keep-alive',
				'Proxy-Authenticate',
				'Basic',
				'X-Real',
				'1',
			])
		).toEqual(['X-Real', '1']);
	});

	it('drops what the Connection header names, and what the caller names', () => {
		expect(
			forwardableHeaders(['connection', 'X-One, x-two', 'x-one', '1', 'X-Two', '2', 'X-Three', '3'])
		).toEqual(['X-Three', '3']);
		expect(forwardableHeaders(['Host', 'a', 'X', '1'], ['host'])).toEqual(['X', '1']);
	});

	it('keeps end-to-end headers a proxy must not touch', () => {
		const headers = [
			'Authorization',
			'Bearer t',
			'Content-Encoding',
			'zstd',
			'Content-Length',
			'10',
			'Accept-Encoding',
			'gzip',
		];
		expect(forwardableHeaders(headers)).toEqual(headers);
	});
});
