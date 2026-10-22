// Explicit opt-in only. This file is preparation, not an automatically executed acceptance case.
import { build } from 'esbuild';
import { mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const workspace = await realpath(path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
if (!process.argv.includes('--execute-isolated-acceptance')) {
	throw new Error(
		'Acceptance is not authorized by default. Explicitly request a run, then supply --execute-isolated-acceptance, --claude-auth, --codex-auth, --recall-question and --expected-recall.'
	);
}
const directory = path.join(
	workspace,
	'.maestro',
	'scratch',
	'provider-translation-acceptance-driver'
);
await mkdir(directory, { recursive: true, mode: 0o700 });
const bundle = path.join(directory, 'driver.mjs');
await build({
	entryPoints: [path.join(workspace, 'scripts/provider-translation-acceptance/driver.ts')],
	outfile: bundle,
	bundle: true,
	platform: 'node',
	target: 'node22',
	format: 'esm',
	packages: 'external',
});
const { runIsolatedAcceptance } = await import(pathToFileURL(bundle).href);
await runIsolatedAcceptance(workspace, process.argv.slice(2));
