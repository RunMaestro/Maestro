// Grok qualification harness launcher. Plans, admits and records
// the E01-E12 cases of grok-acceptance-environment/v1. With no --config every
// case is not-run: zero spawns, zero paid requests, zero network contacts.
//
//   node scripts/grok-qualification.mjs [--config tmp/grok-tier1-environment/runs/<file>.json]
//        [--cases E01,E03:acp-stdio:local] [--json] [--no-write]
import { build } from 'esbuild';
import { mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const workspace = await realpath(path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const directory = path.join(workspace, 'tmp', 'grok-tier1-environment', 'harness');
await mkdir(directory, { recursive: true, mode: 0o700 });
const bundle = path.join(directory, 'harness.mjs');
await build({
	entryPoints: [path.join(workspace, 'scripts/grok-qualification/harness.ts')],
	outfile: bundle,
	bundle: true,
	platform: 'node',
	target: 'node22',
	format: 'esm',
	packages: 'external',
	logLevel: 'warning',
});
const { main } = await import(pathToFileURL(bundle).href);
process.exitCode = await main(workspace, process.argv.slice(2));
