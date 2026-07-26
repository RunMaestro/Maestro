import { describe, expect, it, beforeEach, vi } from 'vitest';
import * as path from 'path';

// Mock the omp subprocess at the module boundary so priming behavior (success,
// failure, and unusable-payload negative caching) is observable without running
// a real `omp models --json`.
vi.mock('../../../main/utils/execFile', () => ({
	execFileNoThrow: vi.fn(),
}));

import {
	setOmpModelCatalog,
	getOmpModelContextWindow,
	computeOmpCatalogKey,
	buildOmpPrimeEnv,
	primeOmpModelCatalog,
	__resetOmpModelCatalogForTests,
	type OmpCatalogEntry,
} from '../../../main/agents/omp-model-catalog';
import { execFileNoThrow } from '../../../main/utils/execFile';

// Mirrors the shape `omp models --json` returns for a couple of models.
const SAMPLE: OmpCatalogEntry[] = [
	{ id: 'claude-opus-4-8', selector: 'anthropic/claude-opus-4-8', contextWindow: 1_000_000 },
	{ id: 'claude-haiku-4-5', selector: 'anthropic/claude-haiku-4-5', contextWindow: 200_000 },
];

// A single fixed identity for the common-case tests.
const KEY = computeOmpCatalogKey('/usr/local/bin/omp', undefined);

describe('omp-model-catalog', () => {
	beforeEach(() => {
		__resetOmpModelCatalogForTests();
	});

	it('returns null before the catalog is primed', () => {
		expect(getOmpModelContextWindow('claude-opus-4-8', KEY)).toBeNull();
	});

	it('resolves the real window by bare model id (what the stream reports)', () => {
		setOmpModelCatalog(SAMPLE, KEY);
		expect(getOmpModelContextWindow('claude-opus-4-8', KEY)).toBe(1_000_000);
		expect(getOmpModelContextWindow('claude-haiku-4-5', KEY)).toBe(200_000);
	});

	it('resolves by the provider-qualified selector too', () => {
		setOmpModelCatalog(SAMPLE, KEY);
		expect(getOmpModelContextWindow('anthropic/claude-opus-4-8', KEY)).toBe(1_000_000);
	});

	it('resolves a bare id even when only the selector was reported for the turn', () => {
		setOmpModelCatalog([{ selector: 'anthropic/claude-opus-4-8', contextWindow: 1_000_000 }], KEY);
		// The stream may report the bare id; the selector entry still resolves it.
		expect(getOmpModelContextWindow('claude-opus-4-8', KEY)).toBe(1_000_000);
	});

	it('is case-insensitive', () => {
		setOmpModelCatalog(SAMPLE, KEY);
		expect(getOmpModelContextWindow('Claude-Opus-4-8', KEY)).toBe(1_000_000);
	});

	it('returns null for an unknown or empty model', () => {
		setOmpModelCatalog(SAMPLE, KEY);
		expect(getOmpModelContextWindow('gpt-6-imaginary', KEY)).toBeNull();
		expect(getOmpModelContextWindow('', KEY)).toBeNull();
		expect(getOmpModelContextWindow(undefined, KEY)).toBeNull();
	});

	it('ignores entries without a positive contextWindow', () => {
		setOmpModelCatalog([{ id: 'no-window' }, { id: 'zero-window', contextWindow: 0 }], KEY);
		expect(getOmpModelContextWindow('no-window', KEY)).toBeNull();
		expect(getOmpModelContextWindow('zero-window', KEY)).toBeNull();
	});

	it('does not serve one identity\u2019s catalog to another', () => {
		const keyA = computeOmpCatalogKey('/opt/omp-a/omp', undefined);
		const keyB = computeOmpCatalogKey('/opt/omp-b/omp', undefined);
		// Same bare model id, DIFFERENT windows across two local installs.
		setOmpModelCatalog([{ id: 'custom-model', contextWindow: 500_000 }], keyA);
		setOmpModelCatalog([{ id: 'custom-model', contextWindow: 128_000 }], keyB);
		expect(getOmpModelContextWindow('custom-model', keyA)).toBe(500_000);
		expect(getOmpModelContextWindow('custom-model', keyB)).toBe(128_000);
		// An unprimed identity resolves nothing.
		const keyC = computeOmpCatalogKey('/opt/omp-c/omp', undefined);
		expect(getOmpModelContextWindow('custom-model', keyC)).toBeNull();
	});

	it('env overrides produce distinct identities', () => {
		const base = computeOmpCatalogKey('/usr/local/bin/omp', undefined);
		const withEnv = computeOmpCatalogKey('/usr/local/bin/omp', { PI_MODEL: 'x' });
		expect(base).not.toBe(withEnv);
		// Order-independent: same overrides hash equal regardless of insertion order.
		const a = computeOmpCatalogKey('/usr/local/bin/omp', { A: '1', B: '2' });
		const b = computeOmpCatalogKey('/usr/local/bin/omp', { B: '2', A: '1' });
		expect(a).toBe(b);
	});

	it('does not resolve a bare id that collides on differing windows within an identity', () => {
		// Two providers expose the same bare `gpt-5` id at different windows.
		setOmpModelCatalog(
			[
				{ id: 'gpt-5', selector: 'openai/gpt-5', contextWindow: 400_000 },
				{ id: 'gpt-5', selector: 'proxy/gpt-5', contextWindow: 128_000 },
			],
			KEY
		);
		// Ambiguous bare/id -> no authoritative window.
		expect(getOmpModelContextWindow('gpt-5', KEY)).toBeNull();
		// The unambiguous provider-qualified selectors still resolve exactly.
		expect(getOmpModelContextWindow('openai/gpt-5', KEY)).toBe(400_000);
		expect(getOmpModelContextWindow('proxy/gpt-5', KEY)).toBe(128_000);
	});

	it('replaces (not merges) an identity\u2019s catalog on re-prime', () => {
		setOmpModelCatalog([{ id: 'gone-model', contextWindow: 300_000 }], KEY);
		expect(getOmpModelContextWindow('gone-model', KEY)).toBe(300_000);
		// A fresh snapshot no longer lists that model.
		setOmpModelCatalog(SAMPLE, KEY);
		expect(getOmpModelContextWindow('gone-model', KEY)).toBeNull();
		expect(getOmpModelContextWindow('claude-opus-4-8', KEY)).toBe(1_000_000);
	});

	describe('buildOmpPrimeEnv', () => {
		it('drops empty PATH components when prepending the binary dir', () => {
			// A PATH with a trailing/interior delimiter yields empty components after
			// split; on POSIX an empty entry means "search the CWD", so the prime
			// probe must never carry one.
			const env = buildOmpPrimeEnv('/opt/tester/.bun/bin/omp', {
				PATH: ['/usr/local/bin', '', '/usr/bin', ''].join(path.delimiter),
			});
			const entries = (env.PATH ?? '').split(path.delimiter);
			expect(entries).not.toContain('');
			// The binary's own dir leads so a co-located runtime resolves first.
			expect(entries[0]).toBe(path.dirname('/opt/tester/.bun/bin/omp'));
			expect(entries).toContain('/usr/local/bin');
			expect(entries).toContain('/usr/bin');
		});
	});

	describe('primeOmpModelCatalog negative caching', () => {
		beforeEach(() => {
			vi.mocked(execFileNoThrow).mockReset();
		});

		it('negative-caches a valid JSON payload without a models array', async () => {
			const key = computeOmpCatalogKey('/opt/x/omp', undefined);
			// Command runs and exits 0, but the payload has no `models` array - it is
			// unusable, so it must be treated like a failure for the TTL.
			vi.mocked(execFileNoThrow).mockResolvedValue({
				stdout: '{"notModels":[]}',
				stderr: '',
				exitCode: 0,
			});
			await primeOmpModelCatalog('/opt/x/omp', {}, key);
			// A second prime within the TTL is short-circuited by the failure cache
			// rather than re-running the same bad command.
			await primeOmpModelCatalog('/opt/x/omp', {}, key);
			expect(execFileNoThrow).toHaveBeenCalledTimes(1);
			// Nothing was cataloged for that identity.
			expect(getOmpModelContextWindow('claude-opus-4-8', key)).toBeNull();
		});

		it('re-primes and caches once a valid models array arrives', async () => {
			const key = computeOmpCatalogKey('/opt/y/omp', undefined);
			vi.mocked(execFileNoThrow).mockResolvedValue({
				stdout: JSON.stringify({ models: SAMPLE }),
				stderr: '',
				exitCode: 0,
			});
			await primeOmpModelCatalog('/opt/y/omp', {}, key);
			expect(getOmpModelContextWindow('claude-opus-4-8', key)).toBe(1_000_000);
			// Cached: a second call within the TTL doesn't re-run the command.
			await primeOmpModelCatalog('/opt/y/omp', {}, key);
			expect(execFileNoThrow).toHaveBeenCalledTimes(1);
		});
	});
});
