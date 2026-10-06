import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PluginServiceHost } from '../../../main/plugins/plugin-service-host';
import { TRANSCRIPTION_CONTRACT, SERVICE_LIMITS } from '../../../shared/plugins/services';
import type { PluginManifest } from '../../../shared/plugins/plugin-manifest';
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
let media: Pick<PluginMediaTools, 'delegate' | 'serviceStatus'>;
beforeEach(() => {
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
			if (owner !== 'consumer' || job !== request.jobId || audio !== request.audioId)
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
		media: media as PluginMediaTools,
		settingsPanel: (_id, panel) => panel === 'config',
	});
	host.register('provider', 'transcription');
});
afterEach(async () => {
	host.cleanupPlugin('consumer');
	host.cleanupPlugin('provider');
	await Promise.resolve();
	vi.useRealTimers();
});

describe('host-mediated service lifecycle', () => {
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
