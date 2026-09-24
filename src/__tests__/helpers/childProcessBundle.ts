/**
 * Run real OS processes against a TypeScript module, for cross-process tests.
 *
 * Mocked `fs` cannot reproduce a race between processes: the interesting
 * failures (lost read-modify-write updates, torn files, two lock holders) only
 * happen when separate processes contend for the same files. This bundles the
 * module under test to CommonJS with esbuild so plain `node` children can
 * `require()` it, then runs a script in N children at once.
 *
 * Node-only (child_process, fs). Import it only from a test file that declares
 * `@vitest-environment node`.
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { buildSync } from 'esbuild';

/** Bundle `entry` (a path under `src/`) to `<outDir>/<name>.cjs`; returns its path. */
export function bundleForChildProcess(entry: string, outDir: string, name: string): string {
	const outfile = path.join(outDir, `${name}.cjs`);
	buildSync({
		entryPoints: [path.resolve(__dirname, '..', '..', entry)],
		bundle: true,
		platform: 'node',
		format: 'cjs',
		target: 'node18',
		outfile,
		logLevel: 'silent',
	});
	return outfile;
}

export interface ChildResult {
	code: number | null;
	stdout: string;
	stderr: string;
}

/**
 * Run `script` (CommonJS source) in `count` node processes started together.
 * Each child receives its index as `process.env.CHILD_INDEX`.
 */
export async function runChildren(
	script: string,
	count: number,
	options: { dir: string; env?: NodeJS.ProcessEnv; timeoutMs?: number }
): Promise<ChildResult[]> {
	const scriptPath = path.join(options.dir, `child-${Date.now()}-${Math.random()}.cjs`);
	fs.writeFileSync(scriptPath, script, 'utf-8');
	const timeoutMs = options.timeoutMs ?? 20_000;
	return Promise.all(
		Array.from(
			{ length: count },
			(_, index) =>
				new Promise<ChildResult>((resolve, reject) => {
					const child = spawn(process.execPath, [scriptPath], {
						env: { ...process.env, ...options.env, CHILD_INDEX: String(index) },
						stdio: ['ignore', 'pipe', 'pipe'],
					});
					let stdout = '';
					let stderr = '';
					child.stdout.on('data', (chunk) => (stdout += chunk));
					child.stderr.on('data', (chunk) => (stderr += chunk));
					const timer = setTimeout(() => {
						child.kill('SIGKILL');
						reject(new Error(`child ${index} timed out\n${stderr}`));
					}, timeoutMs);
					child.on('error', reject);
					child.on('close', (code) => {
						clearTimeout(timer);
						resolve({ code, stdout, stderr });
					});
				})
		)
	);
}
