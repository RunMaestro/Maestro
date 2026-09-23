/**
 * Build provenance - proof that a build came out of Maestro's own release pipeline.
 *
 * WHY THIS EXISTS
 *
 * The Sentry DSN used to be a string literal in `src/main/index.ts`. A DSN is a
 * write-only ingest key, so it is not a secret in the security sense, but it IS
 * an address: anything holding it writes crash reports into the `smash-labs/maestro`
 * project. Because it sat in source, every fork inherited it. Four separate forks
 * were found reporting into our project at once (a "Command Center"/Telegram fork,
 * a "Squads" fork, "Voyager", and a rebrand calling itself "Superluminal Overport"),
 * and one of them alone produced 655 events in under three hours from a retry loop
 * in code that does not exist upstream. Error-volume alerts fired on other people's
 * bugs, and our issue stream became unreadable.
 *
 * It is also bad for the forks. Their users' stack traces, file paths, OS details,
 * and installation IDs were being shipped to a third party those users never chose.
 *
 * THE MECHANISM
 *
 * The DSN is no longer in source. It is injected at package time from a CI secret
 * and written to `dist/build-provenance.json` by `scripts/write-build-provenance.mjs`.
 * A build with no provenance file has no DSN, so it reports nowhere: `beforeSend`
 * never runs because Sentry is never initialized. Nothing to strip out of a fork,
 * nothing for a fork to accidentally keep.
 *
 * Deliberately NOT a filter. Filtering by release, or by whether stack frames match
 * an official build manifest, was considered and rejected: two of the four forks
 * reuse real Maestro version numbers, and frame matching breaks on every refactor.
 * A build either carries the pipeline's provenance or it cannot report at all.
 *
 * WHAT A FORK SHOULD DO
 *
 * Set `MAESTRO_SENTRY_DSN` to your OWN Sentry DSN before `npm run build`, and your
 * crash reports go to your own project. Leave it unset and crash reporting is off.
 */

/** Shape of `dist/build-provenance.json`. */
export interface BuildProvenance {
	/** True when this build was produced by a pipeline holding the ingest secret. */
	official: boolean;
	/** Sentry DSN to report to. Absent means crash reporting is disabled. */
	sentryDsn?: string;
	/** ISO timestamp of when the provenance was written, for debugging. */
	generatedAt?: string;
}

/** A build with no provenance file: no DSN, so no crash reporting anywhere. */
export const UNOFFICIAL_BUILD: BuildProvenance = { official: false };

/**
 * Parse the contents of `build-provenance.json`.
 *
 * Returns `UNOFFICIAL_BUILD` for anything malformed rather than throwing. A build
 * whose provenance we cannot read is one we must not trust with the DSN, and a
 * corrupt provenance file must never be the reason the app fails to start.
 */
export function parseBuildProvenance(raw: string | null | undefined): BuildProvenance {
	if (!raw) return UNOFFICIAL_BUILD;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return UNOFFICIAL_BUILD;
	}
	if (!parsed || typeof parsed !== 'object') return UNOFFICIAL_BUILD;
	const candidate = parsed as Record<string, unknown>;
	const dsn = typeof candidate.sentryDsn === 'string' ? candidate.sentryDsn.trim() : '';
	// `official` is only meaningful when a DSN actually came with it - a file
	// claiming official with no DSN still reports nowhere, so treat it as unofficial
	// instead of letting callers believe reporting is live.
	if (!dsn) return UNOFFICIAL_BUILD;
	return {
		official: candidate.official === true,
		sentryDsn: dsn,
		generatedAt: typeof candidate.generatedAt === 'string' ? candidate.generatedAt : undefined,
	};
}
