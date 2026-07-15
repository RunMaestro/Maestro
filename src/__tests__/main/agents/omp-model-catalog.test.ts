import { describe, expect, it, beforeEach } from 'vitest';
import {
	setOmpModelCatalog,
	getOmpModelContextWindow,
	__resetOmpModelCatalogForTests,
	type OmpCatalogEntry,
} from '../../../main/agents/omp-model-catalog';

// Mirrors the shape `omp models --json` returns for a couple of models.
const SAMPLE: OmpCatalogEntry[] = [
	{ id: 'claude-opus-4-8', selector: 'anthropic/claude-opus-4-8', contextWindow: 1_000_000 },
	{ id: 'claude-haiku-4-5', selector: 'anthropic/claude-haiku-4-5', contextWindow: 200_000 },
];

describe('omp-model-catalog', () => {
	beforeEach(() => {
		__resetOmpModelCatalogForTests();
	});

	it('returns null before the catalog is primed', () => {
		expect(getOmpModelContextWindow('claude-opus-4-8')).toBeNull();
	});

	it('resolves the real window by bare model id (what the stream reports)', () => {
		setOmpModelCatalog(SAMPLE);
		expect(getOmpModelContextWindow('claude-opus-4-8')).toBe(1_000_000);
		expect(getOmpModelContextWindow('claude-haiku-4-5')).toBe(200_000);
	});

	it('resolves by the provider-qualified selector too', () => {
		setOmpModelCatalog(SAMPLE);
		expect(getOmpModelContextWindow('anthropic/claude-opus-4-8')).toBe(1_000_000);
	});

	it('resolves a bare id even when only the selector was reported for the turn', () => {
		setOmpModelCatalog([{ selector: 'anthropic/claude-opus-4-8', contextWindow: 1_000_000 }]);
		// The stream may report the bare id; the selector entry still resolves it.
		expect(getOmpModelContextWindow('claude-opus-4-8')).toBe(1_000_000);
	});

	it('is case-insensitive', () => {
		setOmpModelCatalog(SAMPLE);
		expect(getOmpModelContextWindow('Claude-Opus-4-8')).toBe(1_000_000);
	});

	it('returns null for an unknown or empty model', () => {
		setOmpModelCatalog(SAMPLE);
		expect(getOmpModelContextWindow('gpt-6-imaginary')).toBeNull();
		expect(getOmpModelContextWindow('')).toBeNull();
		expect(getOmpModelContextWindow(undefined)).toBeNull();
	});

	it('ignores entries without a positive contextWindow', () => {
		setOmpModelCatalog([{ id: 'no-window' }, { id: 'zero-window', contextWindow: 0 }]);
		expect(getOmpModelContextWindow('no-window')).toBeNull();
		expect(getOmpModelContextWindow('zero-window')).toBeNull();
	});
});
