/** Bounded endpoint-scoped TLS bytes. The host has no application protocol knowledge. */
import * as tls from 'node:tls';
import type { LookupFunction } from 'node:net';
import { randomBytes } from 'node:crypto';
import { pluginEndpointScope, type PluginEndpoint } from '../../shared/plugins/primitives';
import { PluginAuthorityError, pluginRequest, assertPluginAuthority } from './plugin-authority';
import type { EgressGuard } from './net-egress-guard';
import type {
	PluginToolRunIdentity,
	PluginToolInvocationContext,
} from './plugin-tool-run-identity';

export const PLUGIN_TLS_LIMITS = Object.freeze({
	streams: 4,
	callBytes: 65536,
	parts: 16,
	bufferedBytes: 262144,
	receivedBytes: 25 * 1024 * 1024,
	sentBytes: 1024 * 1024,
	lifetimeMs: 30000,
});

export interface PluginPrimitiveLifetime {
	generation: string;
	signal: AbortSignal;
	assertActive(): void;
	prepare(): Promise<void>;
}
export interface PluginTlsDeps {
	identity: PluginToolRunIdentity;
	egress: EgressGuard;
	capture(pluginId: string): PluginPrimitiveLifetime;
	/** Exact current child ownership, available for release after consent revocation. */
	generation(pluginId: string): string;
	assertEndpoint(pluginId: string, scope: string): void;
	encodeSecret(pluginId: string, endpoint: PluginEndpoint, ref: string, check: () => void): Buffer;
	/** Host-only transport injection for offline fixtures. */
	connect?: typeof tls.connect;
}
interface Stream {
	id: string;
	pluginId: string;
	endpoint: PluginEndpoint;
	scope: string;
	invocationId: string;
	invocation: PluginToolInvocationContext;
	lifetime: PluginPrimitiveLifetime;
	controller: AbortController;
	socket?: tls.TLSSocket;
	closed: Promise<void>;
	onClosed?: () => void;
	closing: boolean;
	connecting: boolean;
	eof: boolean;
	chunks: Buffer[];
	buffered: number;
	received: number;
	sent: number;
	writing: boolean;
	reading: boolean;
	wake?: () => void;
	timer: ReturnType<typeof setTimeout>;
	detach: () => void;
}

export class PluginTlsHost {
	private readonly streams = new Map<string, Stream>();
	private readonly drains = new Map<string, Set<Promise<void>>>();
	constructor(private readonly deps: PluginTlsDeps) {}

	private check(stream: Stream): void {
		if (stream.closing || stream.controller.signal.aborted)
			throw new PluginAuthorityError('PLUGIN_CANCELED');
		assertPluginAuthority(stream.lifetime.assertActive);
		stream.invocation.assertActive();
		assertPluginAuthority(() => this.deps.assertEndpoint(stream.pluginId, stream.scope));
		if (stream.closing || stream.controller.signal.aborted || stream.lifetime.signal.aborted)
			throw new PluginAuthorityError('PLUGIN_CANCELED');
		stream.invocation.assertActive();
	}

	private owned(pluginId: string, id: unknown, invocationId?: unknown): Stream {
		const s = typeof id === 'string' ? this.streams.get(id) : undefined;
		if (
			!s ||
			s.pluginId !== pluginId ||
			this.deps.generation(pluginId) !== s.lifetime.generation ||
			(invocationId !== undefined && invocationId !== s.invocationId)
		)
			throw new PluginAuthorityError('PLUGIN_DENIED');
		return s;
	}

	/** Remove authority first; track teardown until the real socket has closed. */
	private closeStream(s: Stream): Promise<void> {
		if (s.closing) return s.closed;
		s.closing = true;
		s.controller.abort();
		clearTimeout(s.timer);
		s.detach();
		for (const chunk of s.chunks) chunk.fill(0);
		s.chunks = [];
		s.buffered = 0;
		s.wake?.();
		let drains = this.drains.get(s.pluginId);
		if (!drains) this.drains.set(s.pluginId, (drains = new Set()));
		drains.add(s.closed);
		void s.closed.then(() => {
			this.streams.delete(s.id);
			drains!.delete(s.closed);
			if (!drains!.size) this.drains.delete(s.pluginId);
		});
		if (s.socket) s.socket.destroy();
		else if (!s.connecting) s.onClosed?.();
		return s.closed;
	}

	async open(pluginId: string, params: unknown): Promise<{ streamId: string }> {
		const p = pluginRequest(params, ['host', 'port', 'invocationId']);
		const scope = pluginEndpointScope(p.host, p.port);
		if (!scope || typeof p.invocationId !== 'string')
			throw new PluginAuthorityError('PLUGIN_INVALID');
		const lifetime = this.deps.capture(pluginId);
		const invocation = this.deps.identity.resolveInvocation(pluginId, p.invocationId);
		if (
			[...this.streams.values()].filter((s) => s.pluginId === pluginId).length >=
			PLUGIN_TLS_LIMITS.streams
		)
			throw new PluginAuthorityError('PLUGIN_LIMIT');
		let onClosed!: () => void;
		const closed = new Promise<void>((resolve) => {
			onClosed = resolve;
		});
		const s: Stream = {
			id: randomBytes(32).toString('hex'),
			pluginId,
			scope,
			endpoint: { host: p.host as string, port: p.port as number },
			invocationId: p.invocationId,
			invocation,
			lifetime,
			controller: new AbortController(),
			closed,
			onClosed,
			closing: false,
			connecting: false,
			eof: false,
			chunks: [],
			buffered: 0,
			received: 0,
			sent: 0,
			writing: false,
			reading: false,
			timer: setTimeout(() => {
				void this.closeStream(s);
			}, PLUGIN_TLS_LIMITS.lifetimeMs),
			detach: () => {},
		};
		s.timer.unref();
		this.streams.set(s.id, s);
		const abort = () => {
			void this.closeStream(s);
		};
		invocation.signal.addEventListener('abort', abort, { once: true });
		lifetime.signal.addEventListener('abort', abort, { once: true });
		s.detach = () => {
			invocation.signal.removeEventListener('abort', abort);
			lifetime.signal.removeEventListener('abort', abort);
		};
		try {
			await s.lifetime.prepare();
			this.check(s);
			await this.deps.egress.assertUrlAllowed(`https://${s.scope}/`);
			await s.lifetime.prepare();
			this.check(s);
			s.connecting = true;
			const socket = (this.deps.connect ?? tls.connect)({
				host: s.endpoint.host,
				port: s.endpoint.port,
				servername: s.endpoint.host,
				rejectUnauthorized: true,
				minVersion: 'TLSv1.2',
				lookup: this.deps.egress.lookup as LookupFunction,
			});
			s.socket = socket;
			s.connecting = false;
			socket.once('close', () => {
				onClosed();
				s.eof = true;
				s.wake?.();
			});
			socket.on('error', () => {
				void this.closeStream(s);
			});
			socket.on('end', () => {
				s.eof = true;
				s.wake?.();
			});
			socket.on('data', (data: Buffer) => {
				try {
					// Buffering is host-private. Fresh identity/consent checks remain at
					// read/write/publication boundaries, not on every network fragment.
					if (
						s.closing ||
						s.controller.signal.aborted ||
						s.lifetime.signal.aborted ||
						s.invocation.signal.aborted
					)
						throw new PluginAuthorityError('PLUGIN_CANCELED');
					if (
						!Buffer.isBuffer(data) ||
						s.buffered + data.length > PLUGIN_TLS_LIMITS.bufferedBytes ||
						s.received + data.length > PLUGIN_TLS_LIMITS.receivedBytes
					)
						throw new PluginAuthorityError('PLUGIN_LIMIT');
					s.received += data.length;
					s.buffered += data.length;
					s.chunks.push(Buffer.from(data));
					if (s.buffered >= PLUGIN_TLS_LIMITS.bufferedBytes - PLUGIN_TLS_LIMITS.callBytes)
						socket.pause();
					s.wake?.();
				} catch {
					void this.closeStream(s);
				}
			});
			// A host dependency may synchronously revoke during connect; drain this late socket too.
			if (s.closing) {
				socket.destroy();
				await closed;
				throw new PluginAuthorityError('PLUGIN_CANCELED');
			}
			await new Promise<void>((resolve, reject) => {
				const cleanup = () => {
					socket.removeListener('secureConnect', ready);
					socket.removeListener('close', failed);
				};
				const failed = () => {
					cleanup();
					reject(new PluginAuthorityError('PLUGIN_UNAVAILABLE'));
				};
				const ready = () => {
					cleanup();
					if (!socket.authorized) reject(new PluginAuthorityError('PLUGIN_DENIED'));
					else resolve();
				};
				socket.once('secureConnect', ready);
				socket.once('close', failed);
			});
			await s.lifetime.prepare();
			this.check(s);
			return { streamId: s.id };
		} catch (error) {
			s.connecting = false;
			if (!s.socket) s.onClosed?.();
			await this.closeStream(s);
			throw error instanceof PluginAuthorityError
				? error
				: new PluginAuthorityError('PLUGIN_UNAVAILABLE');
		}
	}

	async read(pluginId: string, params: unknown): Promise<{ base64: string; eof: boolean }> {
		const p = pluginRequest(params, ['streamId', 'invocationId', 'maxBytes']);
		if (
			typeof p.invocationId !== 'string' ||
			!Number.isInteger(p.maxBytes) ||
			(p.maxBytes as number) < 1 ||
			(p.maxBytes as number) > PLUGIN_TLS_LIMITS.callBytes
		)
			throw new PluginAuthorityError('PLUGIN_INVALID');
		const s = this.owned(pluginId, p.streamId, p.invocationId);
		await s.lifetime.prepare();
		this.check(s);
		if (s.reading) throw new PluginAuthorityError('PLUGIN_LIMIT');
		s.reading = true;
		try {
			if (!s.buffered && !s.eof)
				await new Promise<void>((resolve) => {
					s.wake = resolve;
				});
			await s.lifetime.prepare();
			this.check(s);
			const result = Buffer.alloc(Math.min(s.buffered, p.maxBytes as number));
			let offset = 0;
			while (offset < result.length) {
				const chunk = s.chunks[0];
				const n = Math.min(chunk.length, result.length - offset);
				chunk.copy(result, offset, 0, n);
				chunk.fill(0, 0, n);
				offset += n;
				s.buffered -= n;
				if (n === chunk.length) s.chunks.shift();
				else s.chunks[0] = chunk.subarray(n);
			}
			if (!s.eof && s.buffered < PLUGIN_TLS_LIMITS.bufferedBytes - PLUGIN_TLS_LIMITS.callBytes)
				s.socket!.resume();
			try {
				await s.lifetime.prepare();
				this.check(s);
				return { base64: result.toString('base64'), eof: s.eof && !s.buffered };
			} finally {
				result.fill(0);
			}
		} finally {
			s.wake = undefined;
			s.reading = false;
		}
	}

	async write(pluginId: string, params: unknown): Promise<{ writtenBytes: number }> {
		const p = pluginRequest(params, ['streamId', 'invocationId', 'parts']);
		if (
			typeof p.invocationId !== 'string' ||
			!Array.isArray(p.parts) ||
			!p.parts.length ||
			p.parts.length > PLUGIN_TLS_LIMITS.parts
		)
			throw new PluginAuthorityError('PLUGIN_INVALID');
		const s = this.owned(pluginId, p.streamId, p.invocationId);
		await s.lifetime.prepare();
		this.check(s);
		if (s.writing) throw new PluginAuthorityError('PLUGIN_LIMIT');
		s.writing = true;
		const chunks: Buffer[] = [];
		let bytes: Buffer | undefined;
		try {
			let length = 0;
			for (const value of p.parts) {
				const part = pluginRequest(value, [], ['base64', 'secretRef', 'encoding']);
				let chunk: Buffer;
				if (Object.keys(part).length === 1 && typeof part.base64 === 'string') {
					if (
						part.base64.length > 87384 ||
						!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(part.base64)
					)
						throw new PluginAuthorityError('PLUGIN_INVALID');
					chunk = Buffer.from(part.base64, 'base64');
					if (chunk.toString('base64') !== part.base64) {
						chunk.fill(0);
						throw new PluginAuthorityError('PLUGIN_INVALID');
					}
				} else if (
					Object.keys(part).length === 2 &&
					typeof part.secretRef === 'string' &&
					part.encoding === 'quoted-ascii'
				) {
					chunk = this.deps.encodeSecret(pluginId, s.endpoint, part.secretRef, () => this.check(s));
				} else throw new PluginAuthorityError('PLUGIN_INVALID');
				chunks.push(chunk);
				length += chunk.length;
				if (length > PLUGIN_TLS_LIMITS.callBytes || s.sent + length > PLUGIN_TLS_LIMITS.sentBytes)
					throw new PluginAuthorityError('PLUGIN_LIMIT');
			}
			bytes = Buffer.concat(chunks, length);
			await s.lifetime.prepare();
			this.check(s);
			s.sent += length;
			await new Promise<void>((resolve, reject) => {
				const failed = () => {
					reject(new PluginAuthorityError('PLUGIN_CANCELED'));
				};
				s.socket!.once('close', failed);
				s.socket!.write(bytes!, (error) => {
					s.socket!.removeListener('close', failed);
					if (error) reject(new PluginAuthorityError('PLUGIN_UNAVAILABLE'));
					else resolve();
				});
			});
			await s.lifetime.prepare();
			this.check(s);
			return { writtenBytes: length };
		} catch (error) {
			await this.closeStream(s);
			throw error instanceof PluginAuthorityError
				? error
				: new PluginAuthorityError('PLUGIN_UNAVAILABLE');
		} finally {
			bytes?.fill(0);
			for (const chunk of chunks) chunk.fill(0);
			s.writing = false;
		}
	}

	async close(pluginId: string, params: unknown): Promise<{ closed: true }> {
		const p = pluginRequest(params, ['streamId']);
		const s = this.owned(pluginId, p.streamId);
		await this.closeStream(s);
		return { closed: true };
	}
	/** Final RPC delivery check against the stored real endpoint, never request hints. */
	assertResult(pluginId: string, streamId: unknown, invocationId: unknown): void {
		this.check(this.owned(pluginId, streamId, invocationId));
	}

	async stopPlugin(pluginId: string): Promise<void> {
		await Promise.all(
			[...this.streams.values()]
				.filter((s) => s.pluginId === pluginId)
				.map((s) => this.closeStream(s))
		);
		await Promise.all(this.drains.get(pluginId) ?? []);
	}
}
