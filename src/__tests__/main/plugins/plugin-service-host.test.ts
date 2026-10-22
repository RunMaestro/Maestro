import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PluginServiceHost } from '../../../main/plugins/plugin-service-host';
import { TRANSCRIPTION_CONTRACT, SERVICE_LIMITS } from '../../../shared/plugins/services';
import {
	validatePluginManifest,
	type PluginManifest,
} from '../../../shared/plugins/plugin-manifest';
import { grantsFromRequests, isPermitted } from '../../../shared/plugins/permissions';
import type { PluginMediaTools, MediaServiceLease } from '../../../main/plugins/plugin-media-tools';

const request = {
	jobId: 'owner-job',
	audioId: 'owner-audio',
	model: 'base' as const,
	language: 'de' as const,
};
const result = {
	text: 'Guten Tag',
	model: 'base' as const,
	language: 'de',
	durationSeconds: 1,
	multilingual: true as const,
	translated: false as const,
};
let host: PluginServiceHost;
let records: Record<string, PluginManifest>;
let revoked: Set<string>;
let invoke: ReturnType<typeof vi.fn>;
let leases: MediaServiceLease[];
let cleaned: number;
let closedFailure: boolean;
let lifetime: number;
let holding: boolean;
let running: Set<string>;
let changed: ReturnType<typeof vi.fn>;
let cancelProvider: ReturnType<typeof vi.fn>;
let media: Pick<PluginMediaTools, 'delegate' | 'serviceStatus'>;
beforeEach(() => {
	changed = vi.fn();
	cancelProvider = vi.fn();
	revoked = new Set();
	leases = [];
	cleaned = 0;
	closedFailure = false;
	holding = false;
	lifetime = SERVICE_LIMITS.timeoutMs;
	running = new Set(['consumer', 'provider']);
	records = {
		consumer: {
			id: 'consumer',
			name: 'Consumer',
			version: '1.0.0',
			tier: 1,
			maestro: { minHostApi: '1.24.0' },
			entry: 'main.js',
			requires: [
				{
					id: 'voice',
					provider: 'provider',
					service: 'transcription',
					contract: TRANSCRIPTION_CONTRACT,
					version: '^1.0.0',
					optional: true,
				},
			],
		},
		provider: {
			id: 'provider',
			name: 'Provider',
			version: '1.0.0',
			tier: 1,
			maestro: { minHostApi: '1.24.0' },
			entry: 'main.js',
			provides: [
				{
					id: 'transcription',
					contract: TRANSCRIPTION_CONTRACT,
					version: '1.0.0',
					settingsPanel: 'config',
				},
			],
		},
	};
	invoke = vi.fn((_provider, _command, _request, signal: AbortSignal) =>
		holding
			? new Promise((_resolve, reject) =>
					signal.addEventListener('abort', () => reject(signal.reason), { once: true })
				)
			: Promise.resolve(result)
	);
	media = {
		delegate: vi.fn((owner, job, audio, _options, authorize) => {
			if (!records[owner]?.requires || job !== request.jobId || audio !== request.audioId)
				throw Object.assign(new Error('MediaInvalid'), { code: 'MediaInvalid' });
			authorize();
			const controller = new AbortController();
			const lease: MediaServiceLease = {
				audioId: `alias-${leases.length}`,
				expiresAt: Date.now() + lifetime,
				signal: controller.signal,
				call: vi.fn(async () => ({ durationSeconds: 1 })),
				close: vi.fn(async () => {
					controller.abort(Object.assign(new Error('MediaCancelled'), { code: 'MediaCancelled' }));
					await Promise.resolve();
					if (closedFailure) throw new Error('secret cleanup path');
					cleaned++;
				}),
			};
			leases.push(lease);
			return lease;
		}),
		serviceStatus: vi.fn(async () => ({
			profiles: ['whisper-cli'],
			models: ['base'],
			missing: [],
		})),
	};
	host = new PluginServiceHost({
		manifest: (id) => records[id],
		running: (id) => running.has(id),
		allowed: (id, cap, target) =>
			!revoked.has(`${id}:${cap}`) &&
			(cap !== 'services:call' || target === 'provider/transcription'),
		invoke,
		changed,
		cancelProvider,
		media: media as PluginMediaTools,
		settingsPanel: (_id, panel) => panel === 'config',
	});
	host.register('provider', 'transcription');
});
afterEach(async () => {
	closedFailure = false;
	await Promise.allSettled([...running].map((id) => host.cleanupPlugin(id)));
	await host.cleanupPlugin('consumer');
	await host.cleanupPlugin('provider');
	vi.useRealTimers();
});

describe('host-mediated service lifecycle', () => {
	it.each(['MediaInvalid', 'MediaTooLong', 'MediaTooLarge'])(
		'preserves invalid media classification across delegated %s failures',
		async (code) => {
			invoke.mockImplementation(async (_provider, _command, args) => {
				leases[0].call = vi.fn(async () => {
					throw Object.assign(new Error(code), { code });
				});
				return host.media('provider', 'probe', args.callId, args.audioId);
			});
			const { callId } = host.start('consumer', 'voice', request);
			await expect(host.result('consumer', callId)).rejects.toMatchObject({
				code: 'ServiceInvalid',
				message: 'ServiceInvalid',
			});
			expect(cleaned).toBeGreaterThan(0);
		}
	);
	it('uses native manifest permissions for exact consent and denies foreign or revoked scopes', async () => {
		for (const id of ['consumer', 'provider']) {
			const parsed = validatePluginManifest({
				...records[id],
				permissions:
					id === 'consumer'
						? [
								{ capability: 'services:call', scope: 'provider/transcription' },
								{ capability: 'media:tools', scope: 'discord-voice' },
							]
						: [
								{ capability: 'services:provide', scope: 'transcription' },
								{ capability: 'media:tools', scope: 'service-transcription' },
							],
			});
			expect(parsed.errors).toEqual([]);
			expect(parsed.manifest).not.toBeNull();
			records[id] = parsed.manifest!;
		}
		const grants = Object.fromEntries(
			Object.entries(records).map(([id, manifest]) => [
				id,
				grantsFromRequests(manifest.permissions ?? [], 1),
			])
		);
		host = new PluginServiceHost({
			manifest: (id) => records[id],
			running: (id) => running.has(id),
			allowed: (id, capability, target) => isPermitted(grants[id] ?? [], capability, target),
			invoke,
			media: media as PluginMediaTools,
		});
		// Declaring a dependency alone never grants consent.
		const approved = grants.consumer;
		grants.consumer = [];
		host.register('provider', 'transcription');
		expect(host.available('consumer', 'voice')).toBe(false);
		expect((await host.status('consumer', 'voice')).state).toBe('denied');
		expect(() => host.start('consumer', 'voice', request)).toThrow('ServiceDenied');
		grants.consumer = approved;
		expect(host.available('consumer', 'voice')).toBe(true);
		expect((await host.status('consumer', 'voice')).state).toBe('ready');
		const { callId } = host.start('consumer', 'voice', request);
		await expect(host.result('consumer', callId)).resolves.toEqual(result);
		expect(invoke).toHaveBeenCalledTimes(1);
		vi.mocked(media.delegate).mockClear();
		for (const scope of [
			'foreign/transcription',
			'provider/other',
			'provider/*',
			'provider/transcription,provider/*',
			undefined,
		]) {
			grants.consumer = approved.map((grant) =>
				grant.capability === 'services:call' ? { ...grant, scope } : grant
			);
			expect(host.available('consumer', 'voice')).toBe(false);
			expect((await host.status('consumer', 'voice')).state).toBe('denied');
			expect(() => host.start('consumer', 'voice', request)).toThrow('ServiceDenied');
		}
		grants.consumer = approved.filter((grant) => grant.capability !== 'services:call');
		expect((await host.status('consumer', 'voice')).state).toBe('denied');
		expect(() => host.start('consumer', 'voice', request)).toThrow('ServiceDenied');
		expect(media.delegate).not.toHaveBeenCalled();
		expect(invoke).toHaveBeenCalledTimes(1);
	});
	it.each([
		'consumer:services:call',
		'consumer:media:tools',
		'provider:services:provide',
		'provider:media:tools',
	])('withholds readiness when %s is revoked during status I/O', async (permission) => {
		media.serviceStatus = vi.fn(async () => {
			revoked.add(permission);
			return { profiles: ['whisper-cli'], models: ['base'], missing: [] } as const;
		});
		const status = await host.status('consumer', 'voice');
		expect(status.state).toBe('denied');
		expect(status.readiness).toBeUndefined();
	});
	it('allows only one result waiter, while cancellation remains available', async () => {
		holding = true;
		const { callId } = host.start('consumer', 'voice', request);
		const value = host.result('consumer', callId);
		await expect(host.result('consumer', callId)).rejects.toMatchObject({ code: 'ServiceInvalid' });
		await host.cancel('consumer', callId);
		await expect(value).rejects.toMatchObject({ code: 'ServiceCancelled' });
	});
	it('routes a pinned versioned provider and withholds owner handles/URLs; cleans before result', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		expect(await host.status('consumer', 'voice')).toMatchObject({
			state: 'ready',
			provider: 'provider',
			version: '1.0.0',
			readiness: { models: ['base'], languages: ['de', 'en'] },
			settingsTarget: { pluginId: 'provider', panelId: 'config' },
		});
		const { callId } = host.start('consumer', 'voice', request);
		expect(invoke).toHaveBeenCalledWith(
			'provider',
			'service:transcription',
			expect.objectContaining({ callId, audioId: 'alias-0' }),
			expect.any(AbortSignal),
			SERVICE_LIMITS.timeoutMs
		);
		expect(JSON.stringify(invoke.mock.calls[0][2])).not.toContain('owner-');
		expect(await host.result('consumer', callId)).toEqual(result);
		expect(cleaned).toBeGreaterThan(0);
	});
	it('returns denied metadata without mounting/activating anything when optional consent is absent', async () => {
		revoked.add('consumer:services:call');
		expect(await host.status('consumer', 'voice')).toMatchObject({ state: 'denied' });
		expect(() => host.start('consumer', 'voice', request)).toThrow('ServiceDenied');
		expect(media.delegate).not.toHaveBeenCalled();
	});
	it('never selects another provider and rejects absent, untrusted/inactive, incompatible or unregistered services', async () => {
		records.provider.provides![0].version = '1.5.0';
		records.consumer.requires![0].version = '1.0.0';
		expect(await host.status('consumer', 'voice')).toMatchObject({ state: 'incompatible' });
		delete records.provider;
		expect(await host.status('consumer', 'voice')).toMatchObject({ state: 'unavailable' });
		expect(invoke).not.toHaveBeenCalled();
	});
	it.each([
		'consumer:services:call',
		'consumer:media:tools',
		'provider:services:provide',
		'provider:media:tools',
	])('revokes %s while a call is in flight', async (permission) => {
		holding = true;
		const { callId } = host.start('consumer', 'voice', request);
		revoked.add(permission);
		const value = host.result('consumer', callId);
		await expect(value).rejects.toMatchObject({ code: 'ServiceDenied' });
		expect(leases[0].signal.aborted).toBe(true);
		expect(cleaned).toBeGreaterThan(0);
	});
	it('cancels idempotently after consumer consent is revoked; foreign cancellation cannot affect work', async () => {
		holding = true;
		const { callId } = host.start('consumer', 'voice', request);
		await host.cancel('intruder', callId);
		expect(leases[0].signal.aborted).toBe(false);
		revoked.add('consumer:services:call');
		const value = host.result('consumer', callId);
		await host.cancel('consumer', callId);
		await expect(value).rejects.toMatchObject({ code: 'ServiceCancelled' });
		await host.cancel('consumer', callId);
		expect(leases[0].signal.aborted).toBe(true);
	});
	it('expires under the original shorter deadline, including when results are never fetched', async () => {
		lifetime = 15;
		holding = true;
		const { callId } = host.start('consumer', 'voice', request);
		await expect(host.result('consumer', callId)).rejects.toMatchObject({ code: 'ServiceTimeout' });
		expect(invoke.mock.calls[0][4]).toBeLessThanOrEqual(15);
		expect(leases[0].signal.aborted).toBe(true);
	});
	it.each(['consumer', 'provider'])(
		'disable/crash/update/uninstall of %s revokes work and registration',
		async (id) => {
			holding = true;
			const { callId } = host.start('consumer', 'voice', request);
			const value = host.result('consumer', callId);
			running.delete(id);
			host.cleanupPlugin(id);
			await expect(value).rejects.toMatchObject({ code: 'ServiceUnavailable' });
			expect(leases[0].signal.aborted).toBe(true);
		}
	);
	it.each([true, false])(
		'consumer cleanup releases both local slots after drain (in flight: %s)',
		async (inFlight) => {
			vi.useFakeTimers();
			holding = inFlight;
			const first = host.start('consumer', 'voice', request);
			host.start('consumer', 'voice', request);
			expect((await host.status('consumer', 'voice')).state).toBe('busy');
			const retained: boolean[] = [];
			changed.mockImplementation(() => retained.push(host.ownsCancel('consumer', first)));
			await host.cleanupPlugin('consumer');
			expect(leases.every((lease) => lease.signal.aborted)).toBe(true);
			expect((await host.status('consumer', 'voice')).state).toBe('ready');
			expect(vi.getTimerCount()).toBe(0);
			expect(host.ownsCancel('consumer', first)).toBe(false);
			await expect(host.result('consumer', first.callId)).rejects.toMatchObject({
				code: 'ServiceInvalid',
			});
			expect(retained[0]).toBe(true);
			expect(retained.at(-1)).toBe(false);
			host.start('consumer', 'voice', request);
			host.start('consumer', 'voice', request);
			expect(invoke).toHaveBeenCalledTimes(4);
		}
	);
	it('consumer cleanup releases four global slots for an unrelated surviving consumer', async () => {
		vi.useFakeTimers();
		holding = true;
		for (const id of ['other', 'survivor']) {
			records[id] = { ...records.consumer, id };
			running.add(id);
		}
		for (const id of ['consumer', 'other']) {
			host.start(id, 'voice', request);
			host.start(id, 'voice', request);
		}
		expect(() => host.start('survivor', 'voice', request)).toThrow('ServiceBusy');
		await Promise.all([host.cleanupPlugin('consumer'), host.cleanupPlugin('other')]);
		expect((await host.status('survivor', 'voice')).state).toBe('ready');
		expect(vi.getTimerCount()).toBe(0);
		host.start('survivor', 'voice', request);
		host.start('survivor', 'voice', request);
		expect(invoke).toHaveBeenCalledTimes(6);
	});
	it('retains owner reservations and cleanup barrier until media drain finishes', async () => {
		vi.useFakeTimers();
		holding = true;
		const first = host.start('consumer', 'voice', request);
		host.start('consumer', 'voice', request);
		const gate = Promise.withResolvers<void>();
		for (const lease of leases) {
			const close = lease.close;
			lease.close = vi.fn(async () => {
				await close();
				await gate.promise;
			});
		}
		let drained = false;
		const cleanup = host.cleanupPlugin('consumer').then(() => {
			drained = true;
		});
		await Promise.resolve();
		expect(drained).toBe(false);
		expect(host.ownsCancel('consumer', first)).toBe(true);
		expect((await host.status('consumer', 'voice')).state).toBe('busy');
		expect(() => host.start('consumer', 'voice', request)).toThrow('ServiceBusy');
		gate.resolve();
		await cleanup;
		expect(drained).toBe(true);
		expect(host.ownsCancel('consumer', first)).toBe(false);
		expect(vi.getTimerCount()).toBe(0);
		host.start('consumer', 'voice', request);
		host.start('consumer', 'voice', request);
	});
	it('retains failed owner cleanup for retry before releasing capacity', async () => {
		vi.useFakeTimers();
		holding = true;
		const first = host.start('consumer', 'voice', request);
		host.start('consumer', 'voice', request);
		closedFailure = true;
		await expect(host.cleanupPlugin('consumer')).rejects.toThrow('secret cleanup path');
		expect(host.ownsCancel('consumer', first)).toBe(true);
		expect((await host.status('consumer', 'voice')).state).toBe('busy');
		expect(() => host.start('consumer', 'voice', request)).toThrow('ServiceBusy');
		closedFailure = false;
		await host.cleanupPlugin('consumer');
		expect(vi.getTimerCount()).toBe(0);
		host.start('consumer', 'voice', request);
		host.start('consumer', 'voice', request);
	});
	it('provider cleanup retains unavailable errors for surviving consumers after re-registration', async () => {
		vi.useFakeTimers();
		holding = true;
		const first = host.start('consumer', 'voice', request);
		const second = host.start('consumer', 'voice', request);
		await host.cleanupPlugin('provider');
		expect((await host.status('consumer', 'voice')).state).toBe('unavailable');
		host.register('provider', 'transcription');
		expect((await host.status('consumer', 'voice')).state).toBe('busy');
		for (const call of [first, second]) {
			expect(host.ownsCancel('consumer', call)).toBe(true);
			await expect(host.result('consumer', call.callId)).rejects.toMatchObject({
				code: 'ServiceUnavailable',
			});
		}
		expect(vi.getTimerCount()).toBe(0);
		expect((await host.status('consumer', 'voice')).state).toBe('ready');
	});
	it('awaits late provider settlement during overlapping cleanup/cancel and preserves the first failure', async () => {
		vi.useFakeTimers();
		const reply = Promise.withResolvers<typeof result>();
		invoke.mockReturnValueOnce(reply.promise);
		const first = host.start('consumer', 'voice', request);
		const value = host.result('consumer', first.callId);
		const failed = expect(value).rejects.toMatchObject({ code: 'ServiceCancelled' });
		changed.mockClear();
		const cancel = host.cancel('consumer', first.callId);
		let drained = false;
		const cleanup = host.cleanupPlugin('consumer').then(() => {
			drained = true;
		});
		await Promise.resolve();
		expect(drained).toBe(false);
		expect(host.ownsCancel('consumer', first)).toBe(true);
		reply.resolve(result);
		await Promise.all([cancel, cleanup, failed]);
		expect(cancelProvider).toHaveBeenCalledTimes(1);
		expect(changed).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
		expect(host.ownsCancel('consumer', first)).toBe(false);
		const next = host.start('consumer', 'voice', request);
		await host.cleanupPlugin('consumer');
		expect(host.ownsCancel('consumer', next)).toBe(false);
		await vi.advanceTimersByTimeAsync(SERVICE_LIMITS.timeoutMs);
		expect(vi.getTimerCount()).toBe(0);
		expect(invoke).toHaveBeenCalledTimes(2);
	});
	it.each([false, true])(
		'unregister notifies service loss before pending/failed drain (failure: %s)',
		async (fail) => {
			vi.useFakeTimers();
			holding = true;
			const call = host.start('consumer', 'voice', request);
			const gate = Promise.withResolvers<void>();
			const close = leases[0].close;
			leases[0].close = vi.fn(async () => {
				await close();
				await gate.promise;
			});
			const availability: boolean[] = [];
			changed.mockClear();
			changed.mockImplementation(() => availability.push(host.available('consumer', 'voice')));
			const cleanup = host.unregister('provider', 'transcription');
			const invalidated = [...availability];
			expect(host.ownsCancel('consumer', call)).toBe(true);
			if (fail) {
				const rejected = expect(cleanup).rejects.toThrow('MediaProcessFailed');
				gate.reject(new Error('MediaProcessFailed'));
				await rejected;
				leases[0].close = close;
				await host.cleanupPlugin('provider');
			} else {
				gate.resolve();
				await cleanup;
			}
			await expect(host.result('consumer', call.callId)).rejects.toThrow(
				fail ? 'MediaProcessFailed' : 'ServiceUnavailable'
			);
			expect(invalidated).toEqual([false]);
		}
	);
	it('does not resurrect a revoked registration when permissions are restored', async () => {
		revoked.add('provider:services:provide');
		host.reconcile();
		revoked.clear();
		expect(await host.status('consumer', 'voice')).toMatchObject({ state: 'unavailable' });
		host.register('provider', 'transcription');
		expect(await host.status('consumer', 'voice')).toMatchObject({ state: 'ready' });
	});
	it('does not resurrect a settled result after consumer revocation and immediate restoration', async () => {
		const { callId } = host.start('consumer', 'voice', request);
		await vi.waitFor(() => expect(cleaned).toBeGreaterThan(0));
		revoked.add('consumer:media:tools');
		host.reconcile();
		revoked.clear();
		await expect(host.result('consumer', callId)).rejects.toMatchObject({ code: 'ServiceDenied' });
	});
	it.each([
		{ ...result, text: 'x'.repeat(12001) },
		{ ...result, language: 'en' },
		{ ...result, text: '😀'.repeat(12001) },
		{ ...result, translated: true },
		{ ...result, arbitrary: 'data' },
	])('rejects hostile results after cleanup', async (invalid) => {
		invoke.mockResolvedValue(invalid);
		const { callId } = host.start('consumer', 'voice', request);
		await expect(host.result('consumer', callId)).rejects.toMatchObject({ code: 'ServiceInvalid' });
		expect(cleaned).toBeGreaterThan(0);
	});
	it('never returns successful output when cleanup fails', async () => {
		closedFailure = true;
		const { callId } = host.start('consumer', 'voice', request);
		await expect(host.result('consumer', callId)).rejects.toThrow();
	});
	it('binds aliases to the exact provider/call and caps retained calls', async () => {
		holding = true;
		const { callId } = host.start('consumer', 'voice', request);
		await expect(host.media('intruder', 'probe', callId, 'alias-0')).rejects.toMatchObject({
			code: 'ServiceInvalid',
		});
		await host.media('provider', 'probe', callId, 'alias-0');
		await expect(host.result('intruder', callId)).rejects.toMatchObject({ code: 'ServiceInvalid' });
		host.start('consumer', 'voice', request);
		expect(() => host.start('consumer', 'voice', request)).toThrow('ServiceBusy');
		await host.cancel('consumer', callId);
		await expect(host.media('provider', 'probe', callId, 'alias-0')).rejects.toMatchObject({
			code: 'ServiceInvalid',
		});
	});
});
