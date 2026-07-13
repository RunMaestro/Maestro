import { createHmac } from 'crypto';
import { describe, expect, it } from 'vitest';
import {
	acceptPluginArtifact,
	buildPluginArtifact,
	createVerifiedPluginArtifactSnapshot,
	parsePluginArtifact,
	PLUGIN_ARTIFACT_LIMITS,
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

	it('rejects oversized archive input before parsing, signing, or decoding files', () => {
		const oversizedRaw = Buffer.alloc(PLUGIN_ARTIFACT_LIMITS.maxArtifactBytes + 1, 0x20);
		expect(() => parsePluginArtifact(oversizedRaw)).toThrow('artifact exceeds byte limit');
		expect(() =>
			buildPluginArtifact({
				...input,
				files: [
					{
						path: 'large.js',
						content: Buffer.alloc(PLUGIN_ARTIFACT_LIMITS.maxFileBytes + 1),
					},
				],
			})
		).toThrow('file exceeds byte limit');
	});

	it('rejects adversarial file counts, paths, duplicate names, encoded payloads, and decoded totals', () => {
		const smallFile = { path: 'small.js', content: Buffer.from('x') };
		expect(() =>
			buildPluginArtifact({
				...input,
				files: Array.from({ length: PLUGIN_ARTIFACT_LIMITS.maxFiles + 1 }, (_, index) => ({
					path: `file-${index}.js`,
					content: Buffer.from('x'),
				})),
			})
		).toThrow('file count limit');
		expect(() =>
			buildPluginArtifact({
				...input,
				files: [
					{
						...smallFile,
						path: `${'segment/'.repeat(PLUGIN_ARTIFACT_LIMITS.maxPathDepth)}file.js`,
					},
				],
			})
		).toThrow('unsafe plugin artifact path');
		expect(() => buildPluginArtifact({ ...input, files: [smallFile, { ...smallFile }] })).toThrow(
			'duplicate plugin artifact path'
		);

		const parsedArtifact = (files: { path: string; content: string }[]) =>
			Buffer.from(
				JSON.stringify({
					schemaVersion: 1,
					pluginId: input.pluginId,
					version: input.version,
					contractSha256: input.contractSha256,
					trustRoot,
					files,
					signature: 'fixture',
				})
			);
		expect(() =>
			parsePluginArtifact(
				parsedArtifact([
					{
						path: 'large.js',
						content: 'A'.repeat(PLUGIN_ARTIFACT_LIMITS.maxEncodedFileBytes + 4),
					},
				])
			)
		).toThrow('file encoding');
		const encodedMaxFile = Buffer.alloc(PLUGIN_ARTIFACT_LIMITS.maxFileBytes).toString('base64');
		expect(() =>
			parsePluginArtifact(
				parsedArtifact(
					Array.from({ length: 5 }, (_, index) => ({
						path: `file-${index}.js`,
						content: encodedMaxFile,
					}))
				)
			)
		).toThrow('decoded byte limit');
	});

	it('retains bounded immutable execution bytes independently of artifact files', () => {
		const artifact = buildPluginArtifact(input);
		const verified = verifySignedPluginArtifact(artifact, trustRoot, verifier);
		const snapshot = createVerifiedPluginArtifactSnapshot(verified, artifact);

		verified.files[0]!.content = Buffer.from('attacker bytes').toString('base64');
		expect(snapshot.text('index.js')).toBe('export default 1;');
		expect(snapshot.fileCount).toBe(2);
		expect(snapshot.byteLength).toBe(Buffer.byteLength('export default 1;{"name":"omp"}'));
		snapshot.release();
		expect(snapshot.text('index.js')).toBeNull();
		expect(snapshot.fileCount).toBe(0);
		expect(snapshot.byteLength).toBe(0);
		expect(Object.isFrozen(snapshot.identity)).toBe(true);
	});
});
