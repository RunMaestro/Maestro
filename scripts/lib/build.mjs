import * as esbuild from 'esbuild';
import * as fs from 'fs';

/**
 * @typedef {Object} BuildArtifactOptions
 * @property {string} name Human-readable artifact name used in build output.
 * @property {string} entryPoint Absolute path to the artifact entry module.
 * @property {string} outfile Absolute path for the bundled executable.
 * @property {'node' | 'browser' | 'neutral'} platform esbuild platform for the artifact.
 * @property {string | string[]} target JavaScript target supported by the artifact runtime.
 * @property {'iife' | 'cjs' | 'esm'} format Module format consumed by the artifact runtime.
 * @property {string[]} [external] Package paths that must remain runtime-resolved.
 * @property {import('esbuild').Plugin[]} [plugins] Artifact-specific esbuild plugins.
 * @property {Record<string, string>} [define] Artifact-specific compile-time replacements.
 */

/**
 * Bundle one executable artifact with the repository's invariant esbuild mechanics.
 *
 * The artifact's entry point, output path, runtime target, module format, externals,
 * plugins, and compile-time definitions remain explicit at the call site.
 *
 * @param {BuildArtifactOptions} options
 * @returns {Promise<void>}
 */
export async function buildArtifact({
	name,
	entryPoint,
	outfile,
	platform,
	target,
	format,
	external = [],
	plugins = [],
	define = {},
}) {
	console.log(`Building ${name} with esbuild...`);

	try {
		await esbuild.build({
			entryPoints: [entryPoint],
			bundle: true,
			platform,
			target,
			outfile,
			format,
			sourcemap: true,
			minify: false,
			external,
			plugins,
			define,
		});

		fs.chmodSync(outfile, 0o755);

		const stats = fs.statSync(outfile);
		const sizeKB = (stats.size / 1024).toFixed(1);
		console.log(`✓ Built ${outfile} (${sizeKB} KB)`);
	} catch (error) {
		console.error('Build failed:', error);
		process.exit(1);
	}
}
