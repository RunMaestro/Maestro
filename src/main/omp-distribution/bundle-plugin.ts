import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { Script } from 'node:vm';
import { build, transform } from 'esbuild';
import type { PluginArtifactFile } from './plugin-artifact';

const PLUGIN_ID = 'com.maestro.omp';
const RUNTIME_ENTRY = 'src/runtime/index.ts';
const PANEL_ENTRY = 'src/panel/index.tsx';
const DESCRIPTOR_METADATA_FILE = 'artifact-build.json';

interface ArtifactBuildMetadata {
	schemaVersion: 1;
	pluginId: typeof PLUGIN_ID;
	bridgeDescriptor: string;
}

interface MutablePluginManifest {
	id?: unknown;
	entry?: unknown;
	contributes?: {
		interactivePanels?: { entry?: unknown; bridge?: unknown }[];
	};
}

interface BundledEntry {
	javaScript: Buffer;
	css: Buffer;
}

export interface RunnablePluginBundle {
	contractSha256: string;
	files: readonly PluginArtifactFile[];
}

/** Bundles the real OMP source root into the only files the sandbox and panel host can execute. */
export async function bundleOmpPlugin(pluginRoot: string): Promise<RunnablePluginBundle> {
	const root = resolve(pluginRoot);
	const [manifestBytes, metadataBytes, runtimeOutput, panelOutput] = await Promise.all([
		readFile(resolve(root, 'plugin.json')),
		readFile(resolve(root, DESCRIPTOR_METADATA_FILE)),
		bundleEntry(resolve(root, RUNTIME_ENTRY), 'neutral', 'cjs'),
		bundleEntry(resolve(root, PANEL_ENTRY), 'browser', 'iife'),
	]);
	const metadata = parseArtifactBuildMetadata(metadataBytes);
	const descriptorPath = resolve(root, metadata.bridgeDescriptor);
	if (!isWithinRoot(root, descriptorPath))
		throw new Error('artifact bridge descriptor path escapes plugin root');
	const [descriptorBytes, bridge] = await Promise.all([
		readFile(descriptorPath),
		evaluateBridgeDescriptor(descriptorPath),
	]);
	const expectedDescriptorBytes = await readFile(descriptorPath);
	if (!expectedDescriptorBytes.equals(descriptorBytes))
		throw new Error('artifact bridge descriptor changed during bundle');

	const manifest = rewriteManifest(manifestBytes, bridge);
	const panelJavaScript = panelOutput.javaScript;
	const panelCss = panelOutput.css;
	const contractSha256 = createHash('sha256').update(descriptorBytes).digest('hex');
	return {
		contractSha256,
		files: [
			{ path: 'plugin.json', content: Buffer.from(JSON.stringify(manifest, null, '\t') + '\n') },
			{ path: 'dist/runtime.js', content: runtimeOutput.javaScript },
			{ path: 'dist/panel.html', content: Buffer.from(panelHtml(panelJavaScript, panelCss)) },
		],
	};
}

async function evaluateBridgeDescriptor(descriptorPath: string): Promise<unknown> {
	const result = await build({
		bundle: true,
		entryPoints: [descriptorPath],
		format: 'cjs',
		outdir: 'dist',
		legalComments: 'none',
		platform: 'node',
		sourcemap: false,
		target: 'es2020',
		write: false,
	});
	const javaScript = result.outputFiles.find((file) => file.path.endsWith('.js'));
	if (!javaScript) throw new Error('OMP bridge descriptor emitted no JavaScript');
	const module = { exports: {} as Record<string, unknown> };
	new Script(Buffer.from(javaScript.contents).toString('utf8')).runInNewContext({
		module,
		exports: module.exports,
	});
	const serialized = module.exports.OMP_PANEL_BRIDGE_DESCRIPTOR_JSON;
	if (typeof serialized !== 'string') {
		throw new Error('OMP bridge descriptor does not export OMP_PANEL_BRIDGE_DESCRIPTOR_JSON');
	}
	return parseJsonObject(serialized, 'invalid OMP bridge descriptor JSON');
}

async function bundleEntry(
	entryPoint: string,
	platform: 'browser' | 'neutral',
	format: 'cjs' | 'iife'
): Promise<BundledEntry> {
	const result = await build({
		bundle: true,
		entryNames: 'bundle',
		entryPoints: [entryPoint],
		format,
		...(platform === 'browser' ? { define: { 'process.env.NODE_ENV': '"production"' } } : {}),
		legalComments: 'none',
		minify: false,
		outdir: 'dist',
		platform,
		sourcemap: false,
		target: 'es2020',
		write: false,
	});
	const javaScript = result.outputFiles.find((file) => file.path.endsWith('.js'));
	if (!javaScript) throw new Error(`bundle emitted no JavaScript for ${entryPoint}`);
	const css = result.outputFiles.find((file) => file.path.endsWith('.css'));
	return {
		javaScript: Buffer.from(
			(await transform(javaScript.contents, { format, target: 'es2020' })).code
		),
		css: css ? Buffer.from(css.contents) : Buffer.alloc(0),
	};
}

function rewriteManifest(manifestBytes: Uint8Array, bridge: unknown): MutablePluginManifest {
	const manifest = parseJsonObject(
		Buffer.from(manifestBytes).toString('utf8'),
		'invalid plugin.json'
	) as MutablePluginManifest;
	if (manifest.id !== PLUGIN_ID) throw new Error(`plugin.json must declare ${PLUGIN_ID}`);
	if (typeof manifest.entry !== 'string') throw new Error('plugin.json has no runtime entry');
	const panels = manifest.contributes?.interactivePanels;
	if (!Array.isArray(panels) || panels.length !== 1 || typeof panels[0]?.entry !== 'string') {
		throw new Error('plugin.json must declare exactly one interactive panel entry');
	}
	return {
		...manifest,
		entry: 'dist/runtime.js',
		contributes: {
			...manifest.contributes,
			interactivePanels: [{ ...panels[0], entry: 'dist/panel.html', bridge }],
		},
	};
}

function parseArtifactBuildMetadata(bytes: Uint8Array): ArtifactBuildMetadata {
	const parsed = parseJsonObject(
		Buffer.from(bytes).toString('utf8'),
		'invalid artifact-build.json'
	);
	if (
		parsed.schemaVersion !== 1 ||
		parsed.pluginId !== PLUGIN_ID ||
		typeof parsed.bridgeDescriptor !== 'string' ||
		Object.keys(parsed).length !== 3
	) {
		throw new Error('invalid OMP artifact-build metadata');
	}
	return { schemaVersion: 1, pluginId: PLUGIN_ID, bridgeDescriptor: parsed.bridgeDescriptor };
}

function parseJsonObject(serialized: string, errorMessage: string): Record<string, unknown> {
	try {
		const parsed: unknown = JSON.parse(serialized);
		if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
			throw new Error(errorMessage);
		return parsed as Record<string, unknown>;
	} catch {
		throw new Error(errorMessage);
	}
}

function isWithinRoot(root: string, candidate: string): boolean {
	const pathRelative = relative(root, candidate);
	return pathRelative.length > 0 && !pathRelative.startsWith('..') && !pathRelative.includes('../');
}

function panelHtml(javaScript: Buffer, css: Buffer): string {
	const escapedJavaScript = javaScript.toString('utf8').replaceAll('</script', '<\\/script');
	const escapedCss = css.toString('utf8').replaceAll('</style', '<\\/style');
	const scriptHash = createHash('sha256').update(escapedJavaScript).digest('base64');
	const styleHash = createHash('sha256').update(escapedCss).digest('base64');
	return `<!doctype html>
<html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; base-uri 'none'; connect-src 'none'; script-src 'sha256-${scriptHash}'; style-src 'sha256-${styleHash}'"><style>${escapedCss}</style></head><body><div id="root"></div><script>${escapedJavaScript}</script></body></html>
`;
}
