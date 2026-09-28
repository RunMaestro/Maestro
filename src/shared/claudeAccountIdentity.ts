/**
 * Claude Account Identity
 *
 * Who is actually logged into a given `CLAUDE_CONFIG_DIR`.
 *
 * The Usage Dashboard used to label each quota row by the config DIRECTORY
 * basename (`~/.claude-gmail` -> "gmail"), which is a name the user picked once
 * and which nothing keeps honest afterwards. Re-running `/login` inside a dir
 * silently repoints it at a different Anthropic account, so two dirs with
 * unrelated names can be the same account - and then their quota bars are
 * legitimately identical while the labels insist they are separate profiles.
 * That reads as a broken dashboard.
 *
 * The truth lives in `<configDir>/.claude.json` under `oauthAccount`, which the
 * Claude CLI refreshes from the API on login and on profile fetch. This module
 * owns the shape and the two pure operations over it:
 *
 *   - `parseClaudeAccountIdentity()` - pull the identity out of an already
 *     parsed `.claude.json` object. Pure so both processes and the tests can
 *     use it without touching a filesystem.
 *   - `groupAccountKeysByIdentity()` - work out which account keys share ONE
 *     Anthropic account, so the panel can say "shared quota with smash"
 *     instead of leaving the user to notice identical percentages and
 *     conclude the sampler is broken.
 *
 * Identity matching prefers `accountUuid` (stable, server-issued) and falls
 * back to a case-folded email only when the uuid is missing - an older
 * `.claude.json` can carry the email without the uuid. Matching on email alone
 * when a uuid exists would be strictly worse: the uuid already answers it.
 */

/** The subset of `.claude.json`'s `oauthAccount` the dashboard cares about. */
export interface ClaudeAccountIdentity {
	/** Login email, e.g. `pedram@smashlabs.com`. */
	email?: string;
	/** Server-issued account id - the authoritative "same account?" answer. */
	accountUuid?: string;
	/** Org display name, e.g. `pedram@smashlabs.com's Organization`. */
	organizationName?: string;
}

/**
 * Extract the account identity from a parsed `.claude.json`. Returns null when
 * the object carries no `oauthAccount` at all (a never-logged-in dir) or when
 * every field we read is missing - callers treat null as "unknown account" and
 * fall back to the directory name, which is the pre-existing behavior.
 *
 * Field-by-field tolerant on purpose: `.claude.json` is a large CLI-owned blob
 * whose shape moves between Claude Code releases, and a half-populated identity
 * ("we know the email but not the uuid") is still strictly better for labeling
 * than no identity at all.
 */
export function parseClaudeAccountIdentity(raw: unknown): ClaudeAccountIdentity | null {
	if (!raw || typeof raw !== 'object') return null;
	const oauthAccount = (raw as Record<string, unknown>).oauthAccount;
	if (!oauthAccount || typeof oauthAccount !== 'object') return null;

	const account = oauthAccount as Record<string, unknown>;
	const identity: ClaudeAccountIdentity = {};
	if (typeof account.emailAddress === 'string' && account.emailAddress.length > 0) {
		identity.email = account.emailAddress;
	}
	if (typeof account.accountUuid === 'string' && account.accountUuid.length > 0) {
		identity.accountUuid = account.accountUuid;
	}
	if (typeof account.organizationName === 'string' && account.organizationName.length > 0) {
		identity.organizationName = account.organizationName;
	}

	return Object.keys(identity).length > 0 ? identity : null;
}

/**
 * The value two account keys must agree on to be the same Anthropic account.
 * Returns null when the identity carries neither a uuid nor an email, in which
 * case the key can't be grouped with anything - two unknowns are not evidence
 * of a match.
 */
export function accountIdentityFingerprint(
	identity: ClaudeAccountIdentity | null | undefined
): string | null {
	if (!identity) return null;
	if (identity.accountUuid) return `uuid:${identity.accountUuid}`;
	if (identity.email) return `email:${identity.email.toLowerCase()}`;
	return null;
}

/**
 * Map each account key to the OTHER keys that resolve to the same Anthropic
 * account. Keys with no siblings are absent from the result, so a caller can
 * treat "present in the map" as "this row shares its quota with someone".
 *
 * Sibling order follows the input key order so the rendered "shared with ..."
 * list is stable across renders rather than reshuffling on every sample.
 */
export function groupAccountKeysByIdentity(
	identities: Record<string, ClaudeAccountIdentity | null | undefined>
): Record<string, string[]> {
	const byFingerprint = new Map<string, string[]>();
	for (const [key, identity] of Object.entries(identities)) {
		const fingerprint = accountIdentityFingerprint(identity);
		if (!fingerprint) continue;
		const bucket = byFingerprint.get(fingerprint);
		if (bucket) {
			bucket.push(key);
		} else {
			byFingerprint.set(fingerprint, [key]);
		}
	}

	const shared: Record<string, string[]> = {};
	for (const keys of byFingerprint.values()) {
		if (keys.length < 2) continue;
		for (const key of keys) {
			shared[key] = keys.filter((other) => other !== key);
		}
	}
	return shared;
}
