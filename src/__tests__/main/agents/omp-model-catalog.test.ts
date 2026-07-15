import { describe, expect, it, beforeEach } from 'vitest';
import {
	setOmpModelCatalog,
	getOmpModelContextWindow,
	computeOmpCatalogKey,
	__resetOmpModelCatalogForTests,
	type OmpCatalogEntry,
} from '../../../main/agents/omp-model-catalog';

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
});
