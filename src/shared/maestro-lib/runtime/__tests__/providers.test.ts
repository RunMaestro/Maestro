import { describe, expect, it, vi } from 'vitest';
import type { BinaryDetectionResult } from '../../launch/path-prober';
import { createProviderLister, PROVIDER_CACHE_MS } from '../providers';

type Probe = (binaryName: string, customPath?: string) => Promise<BinaryDetectionResult>;

describe('provider lister', () => {
	const probe = (): ReturnType<typeof vi.fn<Probe>> =>
		vi.fn<Probe>(async (binaryName, customPath) => {
			if (customPath) return { exists: customPath === '/opt/good/codex', path: customPath };
			return binaryName === 'claude'
				? { exists: true, path: '/usr/local/bin/claude' }
				: { exists: false };
		});

	it('lists every visible provider, installed or not, and never the terminal', async () => {
		const list = createProviderLister({ readCustomPaths: () => ({}), probe: probe() });
		const providers = await list();
		const ids = providers.map((info) => info.id);
		expect(ids).toContain('claude-code');
		expect(ids).toContain('codex');
		expect(ids).not.toContain('terminal');
		const claude = providers.find((info) => info.id === 'claude-code')!;
		expect(claude).toMatchObject({
			available: true,
			path: '/usr/local/bin/claude',
			name: 'Claude Code',
		});
		const codex = providers.find((info) => info.id === 'codex')!;
		expect(codex.available).toBe(false);
		expect(codex.unavailableReason).toContain('codex was not found');
	});

	it('probes a provider-level custom path instead of the search path', async () => {
		const spy = probe();
		const list = createProviderLister({
			readCustomPaths: () => ({ codex: '/opt/good/codex', 'claude-code': '/opt/missing/claude' }),
			probe: spy,
		});
		const providers = await list();
		expect(spy).toHaveBeenCalledWith('codex', '/opt/good/codex');
		expect(providers.find((info) => info.id === 'codex')).toMatchObject({
			available: true,
			path: '/opt/good/codex',
		});
		const claude = providers.find((info) => info.id === 'claude-code')!;
		expect(claude.available).toBe(false);
		expect(claude.unavailableReason).toContain('/opt/missing/claude');
	});

	it('ignores a blank custom path', async () => {
		const spy = probe();
		const list = createProviderLister({ readCustomPaths: () => ({ codex: '   ' }), probe: spy });
		await list();
		expect(spy).toHaveBeenCalledWith('codex', undefined);
	});

	it('reports a probe that throws as unavailable and still answers for the others', async () => {
		const list = createProviderLister({
			readCustomPaths: () => ({}),
			probe: async (binaryName) => {
				if (binaryName === 'codex') throw new Error('which timed out');
				return { exists: true, path: `/bin/${binaryName}` };
			},
		});
		const providers = await list();
		expect(providers.find((info) => info.id === 'codex')).toMatchObject({
			available: false,
			unavailableReason: 'Probing failed: which timed out',
		});
		expect(providers.find((info) => info.id === 'claude-code')?.available).toBe(true);
	});

	it('caches for a minute, then probes again', async () => {
		let now = 1_000;
		const spy = probe();
		const list = createProviderLister({ readCustomPaths: () => ({}), probe: spy, now: () => now });
		await list();
		const calls = spy.mock.calls.length;
		now += PROVIDER_CACHE_MS - 1;
		await list();
		expect(spy.mock.calls.length).toBe(calls);
		now += 2;
		await list();
		expect(spy.mock.calls.length).toBe(calls * 2);
	});

	it('shares one probe between concurrent callers', async () => {
		const spy = probe();
		const list = createProviderLister({ readCustomPaths: () => ({}), probe: spy });
		const [a, b] = await Promise.all([list(), list()]);
		expect(spy.mock.calls.length).toBe(a.length);
		expect(a).toEqual(b);
	});

	it('hands out copies, so a caller cannot edit the cache', async () => {
		const list = createProviderLister({ readCustomPaths: () => ({}), probe: probe() });
		const first = await list();
		first[0].available = !first[0].available;
		const second = await list();
		expect(second[0].available).not.toBe(first[0].available);
	});
});
