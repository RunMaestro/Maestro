import { createHmac } from 'crypto';
import { describe, expect, it } from 'vitest';
import {
	acceptPluginArtifact,
	buildPluginArtifact,
	parsePluginArtifact,
	verifySignedPluginArtifact,
	type ImmutableTrustRoot,
} from '../plugin-artifact';

const trustRoot: ImmutableTrustRoot = Object.freeze({
	keyId: 'maestro-omp-plugin-root-2026',
	algorithm: 'hmac-sha256',
	publicKey: 'fixture-public-key',
});
const signer = (payload: Uint8Array): string =>
	createHmac('sha256', 'fixture-private-key').update(payload).digest('base64url');
const verifier = (payload: Uint8Array, signature: string): boolean => signer(payload) === signature;
const input = {
	pluginId: 'com.maestro.omp',
	version: '1.0.0',
	contractSha256: 'a'.repeat(64),
	trustRoot,
	files: [
		{ path: 'index.js', content: Buffer.from('export default 1;') },
		{ path: 'manifest.json', content: Buffer.from('{"name":"omp"}') },
	],
	sign: signer,
};

describe('first-party OMP plugin artifact', () => {
	it('is deterministic and byte-identical for bundled and signed-installable output', () => {
		const bundled = buildPluginArtifact(input);
		const installable = buildPluginArtifact({ ...input, files: [...input.files].reverse() });

		expect(Buffer.compare(bundled, installable)).toBe(0);
		expect(verifySignedPluginArtifact(bundled, trustRoot, verifier)).toMatchObject({
			pluginId: 'com.maestro.omp',
			contractSha256: input.contractSha256,
			trustRoot,
		});
		expect(verifySignedPluginArtifact(installable, trustRoot, verifier).pluginId).toBe(
			'com.maestro.omp'
		);
	});

	it('rejects trust-root mutation, downgrade, and contract equivocation', () => {
		const artifact = buildPluginArtifact(input);
		const state = acceptPluginArtifact(undefined, artifact, trustRoot, verifier);
		expect(state.version).toBe('1.0.0');
		expect(() =>
			acceptPluginArtifact(
				state,
				buildPluginArtifact({ ...input, version: '0.9.0' }),
				trustRoot,
				verifier
			)
		).toThrow('downgrade');
		expect(() =>
			acceptPluginArtifact(
				state,
				buildPluginArtifact({ ...input, contractSha256: 'b'.repeat(64) }),
				trustRoot,
				verifier
			)
		).toThrow('equivocation');
		expect(() => parsePluginArtifact(artifact, { ...trustRoot, keyId: 'other-root' })).toThrow(
			'trust root mismatch'
		);
		expect(() => verifySignedPluginArtifact(artifact, trustRoot, () => false)).toThrow(
			'signature verification failed'
		);
	});
});
