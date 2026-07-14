import { createHash } from 'node:crypto';
import { Script } from 'node:vm';
import { join } from 'node:path';
import { buildPluginArtifact, parsePluginArtifact } from '../plugin-artifact';
import { describe, expect, it } from 'vitest';
import { validatePluginManifest } from '../../../shared/plugins/plugin-manifest';
import { bundleOmpPlugin } from '../bundle-plugin';

const pluginRoot = join(process.cwd(), 'plugins', 'com.maestro.omp');

const fixtureTrustRoot = Object.freeze({
	keyId: 'omp-panel-html-test-root',
	algorithm: 'ed25519',
	publicKey: 'fixture-public-key',
});

describe('runnable OMP plugin package', () => {
	it('bundles the minimal runtime provider without a workspace or panel surface', async () => {
		const bundle = await bundleOmpPlugin(pluginRoot);
		const filesByPath = new Map(bundle.files.map((file) => [file.path, file.content]));
		const manifest = JSON.parse(
			Buffer.from(filesByPath.get('plugin.json') ?? '').toString('utf8')
		) as Record<string, unknown>;

		expect([...filesByPath.keys()].sort()).toEqual(['dist/runtime.js', 'plugin.json']);
		expect(manifest.entry).toBe('dist/runtime.js');
		expect(manifest.permissions).toEqual([
			{ capability: 'storage:read' },
			{ capability: 'storage:write' },
			{ capability: 'process:interactive', scope: 'omp' },
		]);
		expect(manifest.contributes).toBeUndefined();
		const artifactValidation = validatePluginManifest(manifest);
		expect(artifactValidation.errors).toEqual([]);
		expect(artifactValidation.manifest?.workspaceFoundation).toBeUndefined();

		const runtimeSource = filesByPath.get('dist/runtime.js') ?? Buffer.alloc(0);
		expect(bundle.contractSha256).toBe(createHash('sha256').update(runtimeSource).digest('hex'));
		const sandbox = {
			console: { log() {}, error() {} },
			module: { exports: {} as Record<string, unknown> },
			exports: {} as Record<string, unknown>,
		};
		expect(() =>
			new Script(Buffer.from(runtimeSource).toString('utf8')).runInNewContext(sandbox)
		).not.toThrow();
		expect(sandbox.module.exports).toMatchObject({
			activate: expect.any(Function),
			deactivate: expect.any(Function),
		});

		const repeatBundle = await bundleOmpPlugin(pluginRoot);
		const artifact = buildPluginArtifact({
			pluginId: manifest.id as string,
			version: manifest.version as string,
			contractSha256: bundle.contractSha256,
			trustRoot: fixtureTrustRoot,
			files: bundle.files,
			sign: () => 'fixture-signature',
		});
		const repeatArtifact = buildPluginArtifact({
			pluginId: manifest.id as string,
			version: manifest.version as string,
			contractSha256: repeatBundle.contractSha256,
			trustRoot: fixtureTrustRoot,
			files: repeatBundle.files,
			sign: () => 'fixture-signature',
		});
		expect(artifact).toEqual(repeatArtifact);
		expect(createHash('sha256').update(artifact).digest('hex')).toBe(
			createHash('sha256').update(repeatArtifact).digest('hex')
		);
		const packaged = parsePluginArtifact(artifact, fixtureTrustRoot);
		expect(packaged.files.map((file) => file.path).sort()).toEqual([
			'dist/runtime.js',
			'plugin.json',
		]);
	});
});
