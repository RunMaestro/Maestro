#!/usr/bin/env node
/**
 * Write dist/build-provenance.json, the artifact that decides whether a build
 * can report crashes at all.
 *
 * The Sentry DSN is not in source. It arrives here through MAESTRO_SENTRY_DSN,
 * which the release workflow sets from a repository secret. A build from source
 * has no secret, so this script writes no file, so the app never initializes
 * Sentry and reports nowhere.
 *
 * That is deliberate: the DSN used to be a literal in src/main/index.ts, which
 * meant every fork inherited our crash-reporting address. Four separate forks
 * were found reporting into the smash-labs/maestro project simultaneously, one
 * of them 655 events in three hours from a retry loop in code that does not
 * exist upstream. See src/shared/buildProvenance.ts for the full rationale.
 *
 * Usage:
 *   node scripts/write-build-provenance.mjs            # write (or clear) provenance
 *   node scripts/write-build-provenance.mjs --verify    # exit 1 if no DSN was baked
 *
 * --verify is what the release workflow uses to fail loudly rather than shipping
 * an official build with crash reporting silently switched off.
 *
 * Forking Maestro? Set MAESTRO_SENTRY_DSN to your OWN DSN and your crash reports
 * go to your own project. Leave it unset and crash reporting is off.
 */

import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import process from 'process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const distDir = join(__dirname, '..', 'dist');
const outFile = join(distDir, 'build-provenance.json');

const verifyOnly = process.argv.includes('--verify');
const dsn = (process.env.MAESTRO_SENTRY_DSN || '').trim();

if (verifyOnly) {
	if (!dsn) {
		console.error(
			'build-provenance: MAESTRO_SENTRY_DSN is not set. An official build would ship with\n' +
				'crash reporting disabled. Set the MAESTRO_SENTRY_DSN repository secret, or drop the\n' +
				'--verify step if this build is intentionally unreported.'
		);
		process.exit(1);
	}
	console.log('build-provenance: MAESTRO_SENTRY_DSN present.');
	process.exit(0);
}

mkdirSync(distDir, { recursive: true });

if (!dsn) {
	// Remove any file left behind by a previous build that DID have the secret,
	// so a later unofficial build in the same tree cannot inherit it.
	rmSync(outFile, { force: true });
	console.log('build-provenance: no MAESTRO_SENTRY_DSN, crash reporting disabled for this build.');
	process.exit(0);
}

// `official` marks builds produced by our own pipeline. A fork supplying its own
// DSN gets a working file without claiming to be an official Maestro build.
const official = process.env.MAESTRO_OFFICIAL_BUILD === '1' || Boolean(process.env.GITHUB_ACTIONS);

writeFileSync(
	outFile,
	`${JSON.stringify({ official, sentryDsn: dsn, generatedAt: new Date().toISOString() }, null, '\t')}\n`,
	'utf-8'
);

console.log(`build-provenance: wrote ${outFile} (official=${official}, dsn=...${dsn.slice(-12)})`);
