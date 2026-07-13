import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { Script } from 'node:vm';
import { buildPluginArtifact, parsePluginArtifact } from '../plugin-artifact';
import { describe, expect, it } from 'vitest';
import { validatePluginManifest } from '../../../shared/plugins/plugin-manifest';
import { bundleOmpPlugin, renderPanelDocument } from '../bundle-plugin';

interface PanelDom {
	readonly window: {
		readonly location: { readonly origin: string };
		readonly document: {
			querySelector(selector: string): object | null;
			querySelectorAll(selector: string): { readonly length: number };
		};
		close(): void;
	};
}

interface BrowserLikeJsdom {
	readonly JSDOM: new (
		html: string,
		options: {
			readonly runScripts: string;
			readonly url: string;
			readonly virtualConsole: { on(event: string, callback: (error: Error) => void): void };
		}
	) => PanelDom;
	readonly VirtualConsole: new () => {
		on(event: string, callback: (error: Error) => void): void;
	};
}

const { JSDOM, VirtualConsole } = createRequire(__filename)('jsdom') as BrowserLikeJsdom;
const pluginRoot = join(process.cwd(), 'plugins', 'com.maestro.omp');

const fixtureTrustRoot = Object.freeze({
	keyId: 'omp-panel-html-test-root',
	algorithm: 'ed25519',
	publicKey: 'fixture-public-key',
});

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
		const panelEntry = contributes.interactivePanels[0]?.entry;

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
		expect(Object.keys(bridge.requestSchemas)).toHaveLength(25);
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
		expect(panelEntry).toBe('dist/panel.html');
		expect(manifest.entry).not.toBe(panelEntry);
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
		const panelHtml = Buffer.from(filesByPath.get(panelEntry ?? '') ?? '').toString('utf8');
		expect(Buffer.from(filesByPath.get(manifest.entry as string) ?? '').toString('utf8')).not.toBe(
			panelHtml
		);
		expect(panelHtml.trimStart()).toMatch(/^<!doctype html>/i);
		expect(panelHtml).toContain('<html>');
		expect(panelHtml).toContain('<div id="root"></div>');
		expect(panelHtml).toContain('Content-Security-Policy');
		expect(panelHtml).toContain("script-src 'sha256-");
		expect(panelHtml).toMatch(/<script>[\s\S]+<\/script>/);
		expect(panelHtml.match(/<\/script/gi)).toHaveLength(1);
		expect(panelHtml).not.toMatch(/^\s*(?:\(|var |const |let |function |!function)/);

		const virtualConsole = new VirtualConsole();
		const startupErrors: string[] = [];
		virtualConsole.on('jsdomError', (error) => startupErrors.push(error.message));
		const document = new JSDOM(panelHtml, {
			runScripts: 'dangerously',
			url: 'data:text/html,maestro-omp-panel',
			virtualConsole,
		});
		const root = document.window.document.querySelector('#root');
		expect(document.window.location.origin).toBe('null');
		expect(document.window.document.querySelectorAll('[src], [href]')).toHaveLength(0);
		expect(startupErrors).toEqual([]);
		expect(root).not.toBeNull();
		expect(Object.getOwnPropertyNames(root ?? {})).toContainEqual(
			expect.stringMatching(/^__reactContainer\$/)
		);
		document.window.close();

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
		const packagedPanel = packaged.files.find((file) => file.path === panelEntry);
		expect(Buffer.from(packagedPanel?.content ?? '', 'base64').toString('utf8')).toBe(panelHtml);
	});

	it('escapes raw-text terminators and JavaScript line separators within inline panel assets', () => {
		const panelHtml = renderPanelDocument(
			Buffer.from("const payload = '</ScRiPt>\u2028\u2029';", 'utf8'),
			Buffer.from('/* </StYlE>\u2028\u2029 */', 'utf8')
		);

		expect(panelHtml).toContain('<\\/script>');
		expect(panelHtml).toContain('<\\/style>');
		expect(panelHtml).toContain('\\u2028');
		expect(panelHtml).toContain('\\u2029');
		expect(panelHtml.match(/<\/script/gi)).toHaveLength(1);
		expect(panelHtml.match(/<\/style/gi)).toHaveLength(1);
		expect(panelHtml).not.toMatch(/(?:src|href)=/);
	});
});
