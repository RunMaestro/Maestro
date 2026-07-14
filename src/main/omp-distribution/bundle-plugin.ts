import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build, transform } from 'esbuild';
import type { PluginArtifactFile } from './plugin-artifact';

const PLUGIN_ID = 'com.maestro.omp';
const RUNTIME_ENTRY = 'src/runtime/index.ts';
interface MutablePluginManifest {
	id?: unknown;
	entry?: unknown;
}

interface BundledEntry {
	javaScript: Buffer;
}

export interface RunnablePluginBundle {
	contractSha256: string;
	files: readonly PluginArtifactFile[];
}

/** Bundles the minimal OMP provider runtime required by its tier-one manifest. */
export async function bundleOmpPlugin(pluginRoot: string): Promise<RunnablePluginBundle> {
	const root = resolve(pluginRoot);
	const [manifestBytes, runtimeOutput] = await Promise.all([
		readFile(resolve(root, 'plugin.json')),
		bundleEntry(root, resolve(root, RUNTIME_ENTRY), 'neutral', 'cjs', 'runtime.cjs'),
	]);
	const manifest = rewriteManifest(manifestBytes);
	return {
		contractSha256: createHash('sha256').update(runtimeOutput.javaScript).digest('hex'),
		files: [
			{ path: 'plugin.json', content: Buffer.from(JSON.stringify(manifest, null, '\t') + '\n') },
			{ path: 'dist/runtime.js', content: runtimeOutput.javaScript },
		],
	};
}

async function bundleEntry(
	pluginRoot: string,
	entryPoint: string,
	platform: 'neutral',
	format: 'cjs',
	outputName: string
): Promise<BundledEntry> {
	const outputPath = resolve(pluginRoot, '.maestro-omp-bundle', outputName);
	const result = await build({
		bundle: true,
		entryPoints: [entryPoint],
		legalComments: 'none',
		minify: false,
		outfile: outputPath,
		platform,
		sourcemap: false,
		target: 'es2020',
		write: false,
	});
	const javaScript = result.outputFiles.find((file) => resolve(file.path) === outputPath);
	if (!javaScript) throw new Error(`bundle emitted no JavaScript for ${entryPoint}`);
	return {
		javaScript: Buffer.from(
			(await transform(javaScript.contents, { format, target: 'es2020' })).code
		),
	};
}

function rewriteManifest(manifestBytes: Uint8Array): MutablePluginManifest {
	const manifest = parseJsonObject(
		Buffer.from(manifestBytes).toString('utf8'),
		'invalid plugin.json'
	) as MutablePluginManifest;
	if (manifest.id !== PLUGIN_ID) throw new Error(`plugin.json must declare ${PLUGIN_ID}`);
	if (typeof manifest.entry !== 'string') throw new Error('plugin.json has no runtime entry');
	return { ...manifest, entry: 'dist/runtime.js' };
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
