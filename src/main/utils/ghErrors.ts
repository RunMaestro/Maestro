/**
 * Pure classifiers for `gh` CLI failures.
 *
 * Kept import-free and apart from `cliDetection.ts` (which spawns processes and
 * is mocked wholesale by most tests) so every gh caller - the Cue GitHub poller,
 * Send Feedback - reads failures the same way.
 */

/**
 * Lowercased `message` + `stderr` of a `gh` CLI failure, joined for pattern
 * matching. `gh` reports the interesting detail (rate limits, HTTP status,
 * auth hints) in stderr text rather than in a structured error code, and
 * `execFile` rejections carry it on a separate property from the message, so
 * every classifier below has to look at both.
 */
export function ghErrorHaystack(err: unknown): string {
	const msg = (
		err && typeof err === 'object' && 'message' in err && typeof err.message === 'string'
			? err.message
			: String(err ?? '')
	).toLowerCase();
	const stderr =
		err &&
		typeof err === 'object' &&
		'stderr' in err &&
		typeof (err as { stderr: unknown }).stderr === 'string'
			? (err as { stderr: string }).stderr.toLowerCase()
			: '';
	return `${msg}\n${stderr}`;
}

/**
 * Detect GitHub CLI authentication failures - an expired, revoked, or missing
 * `gh` token.
 *
 * Deliberately NOT folded into `isGitHubConnectivityError`: that predicate is
 * documented and unit-tested as *not* matching auth/configuration failures, and
 * the two want different user-facing guidance ("GitHub is unreachable, we'll
 * retry" vs "re-authenticate `gh`"). What they share is that neither is a
 * Maestro bug, so neither should page Sentry. Without this, one install whose
 * token went stale files an event on every poll tick indefinitely - MAESTRO-KE
 * collected 924 of them from a single trigger.
 */
export function isGitHubAuthError(err: unknown): boolean {
	const haystack = ghErrorHaystack(err);
	return (
		/\bhttp\s+401\b/.test(haystack) ||
		haystack.includes('bad credentials') ||
		haystack.includes('gh auth login') ||
		haystack.includes('requires authentication') ||
		haystack.includes('authentication required') ||
		haystack.includes('not logged into any github hosts')
	);
}

/**
 * Detect an organization's OAuth App access restriction. The GitHub CLI signs in
 * as an OAuth app, so an org that restricts third-party apps refuses its token
 * even though the login itself is valid - `gh auth status` reports green and the
 * request still fails, with an error that reads like a broken login.
 */
export function isGitHubOAuthRestrictionError(err: unknown): boolean {
	return ghErrorHaystack(err).includes('oauth app access restrictions');
}

/** Detect a valid token that lacks a scope the request needs. */
export function isGitHubMissingScopeError(err: unknown): boolean {
	const haystack = ghErrorHaystack(err);
	return (
		haystack.includes('required scopes') ||
		/needs? the "?[a-z:_]+"? scope/.test(haystack) ||
		haystack.includes('missing required scope')
	);
}

/** The GitHub account a `gh` command acts as. */
export interface GhAccount {
	host: string;
	login: string;
}

/**
 * The ACTIVE account in `gh auth status` output, or undefined when it cannot be
 * named.
 *
 * gh lists every stored account per host and marks the one in use with
 * "Active account: true" on the lines below it. The entry reads
 * `Logged in to <host> account <login>` when the token works and
 * `Failed to log in to <host> account <login>` when it does not (older gh says
 * `as <login>`). An env token (`GH_TOKEN`) carries no login name, so when THAT
 * is the active credential nothing is named: falling back to the inactive
 * keyring account would put the wrong name on the pill. Output from a gh old
 * enough to print no "Active account" lines names its first account.
 */
export function parseGhActiveAccount(output: string): GhAccount | undefined {
	const entries: Array<{ host: string; login?: string; active: boolean }> = [];
	for (const line of output.split(/\r?\n/)) {
		const entry = /(?:Logged in to|log in to)\s+(\S+)\s+(?:account|as)\s+(\S+)/i.exec(line);
		if (entry) {
			entries.push({ host: entry[1], login: entry[2], active: false });
			continue;
		}
		const tokenEntry = /(?:Logged in to|log in to)\s+(\S+)\s+using token/i.exec(line);
		if (tokenEntry) {
			entries.push({ host: tokenEntry[1], active: false });
			continue;
		}
		if (/Active account:\s*true/i.test(line) && entries.length > 0) {
			entries[entries.length - 1].active = true;
		}
	}
	const anyActive = entries.some((e) => e.active);
	const chosen = anyActive ? entries.find((e) => e.active) : entries[0];
	return chosen?.login ? { host: chosen.host, login: chosen.login } : undefined;
}
