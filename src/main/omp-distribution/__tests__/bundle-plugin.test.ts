import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Script } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { bundleOmpPlugin } from '../bundle-plugin';

const pluginRoot = join(process.cwd(), 'plugins', 'com.maestro.omp');

describe('runnable OMP plugin package', () => {
	it('bundles only runnable assets, rewrites manifest entries, starts the sandbox script, and loads panel assets', async () => {
		const bundle = await bundleOmpPlugin(pluginRoot);
		const filesByPath = new Map(bundle.files.map((file) => [file.path, file.content]));
		const manifest = JSON.parse(
			Buffer.from(filesByPath.get('plugin.json') ?? '').toString('utf8')
		) as Record<string, unknown>;
		const contributes = manifest.contributes as { interactivePanels: { entry: string }[] };

		expect([...filesByPath.keys()].sort()).toEqual([
			'dist/panel.html',
			'dist/runtime.js',
			'plugin.json',
		]);
		expect(manifest.entry).toBe('dist/runtime.js');
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
