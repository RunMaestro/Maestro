import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { request } from 'node:https';
import type { Socket } from 'node:dgram';
import { candidate } from '../../main/lite/discovery/types';
import { probeService, validateManifest } from '../../main/lite/discovery/probe';
import { MdnsBrowser } from '../../main/lite/discovery/mdns';

const row = candidate('aster-id', 'Aster', 'https://aster.example.test', 'lan', Date.now() + 60000);
const manifest = {
	protocol: 'maestro-discovery',
	version: 1,
	instanceId: 'aster-id',
	name: 'Aster',
	appVersion: '0.18.6-RC',
	setupRevision: 6,

	pairing: { protocol: 'maestro-device-pairing/1', scope: 'host.control', enabled: true },
	capabilities: ['host.control'],
	connection: {
		path: '/.well-known/maestro/connect',
		authentication: 'device-pairing',
		admission: 'device',
		capabilities: ['sessions', 'terminal', 'files', 'browserRelay'],
	},
};
afterEach(() => {
	vi.useRealTimers();
});

describe('service compatibility before PIN selection', () => {
	it.each([
		[{ version: 2 }, 'incompatible'],
		[{ setupRevision: undefined }, 'incompatible'],
		[{ setupRevision: 3 }, 'incompatible'],
		[{ appVersion: '0.18.5' }, 'incompatible'],
		[{ protocol: 'unrelated-service' }, 'incompatible'],
		[{ instanceId: 'substituted-id' }, 'incompatible'],
		[{ capabilities: ['agents.execute'] }, 'incompatible'],
		[{ pairing: { ...manifest.pairing, enabled: false } }, 'pairing-disabled'],
	] as const)('refuses incompatible or mismatched advertisement %#', (change, expected) => {
		expect(validateManifest(row, { ...manifest, ...change }).availability).toBe(expected);
	});
	it('adopts a named Service identity only after a compatible manifest, without authorizing full access', () => {
		const checked = validateManifest(
			{ ...row, id: 'maestro-service', identityHint: undefined },
			manifest
		);
		expect(checked).toMatchObject({
			id: 'aster-id',
			identityHint: 'aster-id',
			version: '0.18.6-RC',
			availability: 'ready',
		});
	});
	it.each([401, 403, 302])(
		'does not follow or bypass an authorization response %s',
		async (statusCode) => {
			let calls = 0;
			const send = ((
				_url: string,
				_options: unknown,
				callback: (response: PassThrough & { statusCode: number }) => void
			) => {
				calls++;
				return Object.assign(new EventEmitter(), {
					destroy() {},
					end() {
						const response = Object.assign(new PassThrough(), { statusCode });
						callback(response);
					},
				});
			}) as unknown as typeof request;
			const result = await probeService(row, new AbortController().signal, send);
			expect(result.availability).toBe('auth-required');
			expect(calls).toBe(1);
		}
	);
	it('bounds response bodies and total time even when headers arrive', async () => {
		vi.useFakeTimers();
		let response!: PassThrough & { statusCode: number };
		const destroyed = vi.fn();
		const send = ((
			_url: string,
			_options: unknown,
			callback: (response: PassThrough & { statusCode: number }) => void
		) =>
			Object.assign(new EventEmitter(), {
				destroy: destroyed,
				end() {
					response = Object.assign(new PassThrough(), { statusCode: 200 });
					callback(response);
				},
			})) as unknown as typeof request;
		const oversized = probeService(row, new AbortController().signal, send);
		response.write(Buffer.alloc(16385));
		expect((await oversized).availability).toBe('unreachable');
		expect(response.destroyed).toBe(true);
		const stalled = probeService(row, new AbortController().signal, send);
		await vi.advanceTimersByTimeAsync(4000);
		expect((await stalled).availability).toBe('unreachable');
		expect(destroyed).toHaveBeenCalledOnce();
	});
	it('reports multicast permission denial and closes the refused socket', async () => {
		let closed = false;
		class DeniedSocket extends EventEmitter {
			bind() {
				this.emit('error', Object.assign(new Error('no access'), { code: 'EACCES' }));
			}
			close() {
				closed = true;
			}
			dropMembership() {}
		}
		const failed = vi.fn();
		const browser = new MdnsBrowser('192.0.2.10', () => new DeniedSocket() as unknown as Socket);
		await expect(browser.start(() => undefined, failed)).rejects.toThrow('permission denied');
		expect(failed).toHaveBeenCalledWith(expect.stringContaining('permission denied'));
		expect(closed).toBe(true);
	});
});
