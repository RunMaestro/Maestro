/**
 * Main-process reader for `dist/build-provenance.json`.
 *
 * See `src/shared/buildProvenance.ts` for why the Sentry DSN lives in a
 * build-time artifact instead of in source.
 */

import { readFileSync } from 'fs';
import path from 'path';
import { app } from 'electron';
import {
	parseBuildProvenance,
	UNOFFICIAL_BUILD,
	type BuildProvenance,
} from '../../shared/buildProvenance';

/** Where `scripts/write-build-provenance.mjs` puts the file, relative to the app root. */
export const BUILD_PROVENANCE_RELATIVE_PATH = path.join('dist', 'build-provenance.json');

let cached: BuildProvenance | null = null;

/**
 * Read this build's provenance, caching the result.
 *
 * A missing file is the normal case for a build from source (a fork, or a local
 * `npm run build` without `MAESTRO_SENTRY_DSN`), so it reads as unofficial with
 * no DSN and never logs an error.
 *
 * An override via `MAESTRO_SENTRY_DSN` in the runtime environment is honored and
 * marked unofficial: it lets a fork or a local debug session point crash reports
 * at their own project, while keeping `official` reserved for the release
 * pipeline's own builds so channel tags stay meaningful.
 */
export function getBuildProvenance(): BuildProvenance {
	if (cached) return cached;

	const envDsn = process.env.MAESTRO_SENTRY_DSN?.trim();
	if (envDsn) {
		cached = { official: false, sentryDsn: envDsn };
		return cached;
	}

	let raw: string | null = null;
	try {
		raw = readFileSync(path.join(app.getAppPath(), BUILD_PROVENANCE_RELATIVE_PATH), 'utf-8');
	} catch {
		// No provenance file. Expected for any build from source.
		cached = UNOFFICIAL_BUILD;
		return cached;
	}

	cached = parseBuildProvenance(raw);
	return cached;
}

/** Reset the cache. Test-only. */
export function resetBuildProvenanceCache(): void {
	cached = null;
}
