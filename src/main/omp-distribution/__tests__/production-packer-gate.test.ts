import { describe, expect, it } from 'vitest';
import { assertPackerGate } from '../production-packer-gate';

const sha256 = 'a'.repeat(64);
const production = {
	fixture: false,
	trustRoot: {
		keyId: 'maestro-production-root',
		algorithm: 'ed25519',
		publicKey: 'production-public-key',
	},
	signature: 'A'.repeat(32),
	expectedSha256: sha256,
	actualSha256: sha256,
	outputPaths: ['dist/omp/omp.omp-plugin.json'],
	trustRootPath: 'build/omp-trust-root.json',
};

describe('production artifact packer gate', () => {
	it('accepts only explicit valid production metadata and published digest', () => {
		expect(() => assertPackerGate(production)).not.toThrow();
	});

	it('rejects missing digest, fixture metadata, invalid signatures, and fixture output paths', () => {
		expect(() => assertPackerGate({ ...production, expectedSha256: undefined })).toThrow(
			'published expected SHA-256'
		);
		expect(() => assertPackerGate({ ...production, trustRootPath: 'fixtures/root.json' })).toThrow(
			'fixture trust metadata'
		);
		expect(() => assertPackerGate({ ...production, signature: 'short' })).toThrow(
			'valid signature'
		);
		expect(() =>
			assertPackerGate({ ...production, outputPaths: ['dist/omp-fixture/output.omp-plugin.json'] })
		).toThrow('fixture output paths');
	});

	it('permits fixture mode only when selected explicitly', () => {
		expect(() =>
			assertPackerGate({
				...production,
				fixture: true,
				expectedSha256: undefined,
				trustRootPath: 'fixtures/root.json',
			})
		).not.toThrow();
	});
});
