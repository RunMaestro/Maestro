import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Script } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { validatePluginManifest } from '../../../shared/plugins/plugin-manifest';
import { bundleOmpPlugin } from '../bundle-plugin';

const pluginRoot = join(process.cwd(), 'plugins', 'com.maestro.omp');

describe('runnable OMP plugin package', () => {
	it('bundles only runnable assets, rewrites manifest entries, starts the sandbox script, and loads panel assets', async () => {
		const bundle = await bundleOmpPlugin(pluginRoot);
		const filesByPath = new Map(bundle.files.map((file) => [file.path, file.content]));
		const manifest = JSON.parse(
			Buffer.from(filesByPath.get('plugin.json') ?? '').toString('utf8')
		) as Record<string, unknown>;
		const contributes = manifest.contributes as {
			interactivePanels: { entry: string; bridge: unknown }[];
		};

		expect([...filesByPath.keys()].sort()).toEqual([
			'dist/panel.html',
			'dist/runtime.js',
			'plugin.json',
		]);
		expect(manifest.entry).toBe('dist/runtime.js');
		const artifactValidation = validatePluginManifest(manifest);
		expect(artifactValidation.errors).toEqual([]);
		expect(artifactValidation.manifest?.workspaceFoundation?.panel.bridge).toMatchObject({
			requestSchemas: expect.any(Object),
			eventSchemas: expect.any(Object),
			resultSchemas: expect.any(Object),
			errorSchemas: expect.any(Object),
		});
		const bridge = contributes.interactivePanels[0]?.bridge as {
			requestSchemas: Record<string, unknown>;
			eventSchemas: Record<string, unknown>;
			resultSchemas: Record<string, unknown>;
			errorSchemas: Record<string, unknown>;
		};
		const workspaceBridge = artifactValidation.manifest?.workspaceFoundation?.panel.bridge as {
			requestSchemas: Record<string, unknown>;
			eventSchemas: Record<string, unknown>;
			resultSchemas: Record<string, unknown>;
			errorSchemas: Record<string, unknown>;
		};
		expect(Object.keys(bridge.requestSchemas)).toEqual(Object.keys(workspaceBridge.requestSchemas));
		expect(Object.keys(bridge.eventSchemas)).toEqual(Object.keys(workspaceBridge.eventSchemas));
		expect(Object.keys(bridge.resultSchemas)).toEqual(Object.keys(bridge.requestSchemas));
		expect(Object.keys(bridge.requestSchemas)).toHaveLength(24);
		expect(Object.keys(bridge.errorSchemas)).toEqual(Object.keys(bridge.requestSchemas));
		for (const operation of [
			'omp.prompt.send',
			'omp.steer.send',
			'omp.followUp.send',
			'omp.run.abortAndPrompt',
		]) {
			expect(bridge.requestSchemas[operation]).toEqual(expect.any(Object));
			expect(bridge.resultSchemas[operation]).toEqual(expect.any(Object));
			expect(bridge.errorSchemas[operation]).toEqual(expect.any(Object));
		}
		expect(contributes.interactivePanels[0]?.entry).toBe('dist/panel.html');
		expect(bundle.contractSha256).toBe(
			createHash('sha256')
				.update(readFileSync(join(pluginRoot, 'src/bridge/descriptor.ts')))
				.digest('hex')
		);
		const sandbox = {
			console: { log() {}, error() {} },
			module: { exports: {} as Record<string, unknown> },
			exports: {} as Record<string, unknown>,
		};
		expect(() =>
			new Script(
				Buffer.from(filesByPath.get('dist/runtime.js') ?? '').toString('utf8')
			).runInNewContext(sandbox)
		).not.toThrow();
		expect(sandbox.module.exports).toMatchObject({
			activate: expect.any(Function),
			startFromExplicitPanelAction: expect.any(Function),
			deactivate: expect.any(Function),
		});
		const panelHtml = Buffer.from(filesByPath.get('dist/panel.html') ?? '').toString('utf8');
		expect(panelHtml).toContain('Content-Security-Policy');
		expect(panelHtml).toContain("script-src 'sha256-");
		expect(panelHtml).toContain('<script>');
		expect(panelHtml).not.toMatch(/(?:src|href)=/);
	});
});
