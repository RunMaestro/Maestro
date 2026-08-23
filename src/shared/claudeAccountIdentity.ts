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

/**
 * One entry per Anthropic account: the key that owns the data, plus every
 * other key that reaches the same account.
 */
export interface AccountKeyGroup {
	/** The key whose snapshot represents the account. */
	primaryKey: string;
	/** Other keys folded into `primaryKey`, in input order. Possibly empty. */
	aliasKeys: string[];
}

/**
 * Fold a list of account keys into one entry per Anthropic account, so the
 * dashboard renders a row per ACCOUNT rather than a row per directory.
 *
 * Two inputs decide what collapses, and they answer different questions:
 *
 *   - `aliasesByKey` is what the SAMPLER already collapsed. It is
 *     authoritative: those keys have no snapshot of their own precisely
 *     because the sampler recognized them as the same account and skipped
 *     them. Ignoring it would render a permanently empty row.
 *   - `identities` catches pairs the sampler did not collapse - snapshots
 *     cached before the collapse existed, or two dirs that were each sampled
 *     while their `.claude.json` still disagreed.
 *
 * A key that is claimed as an alias never becomes a primary, and the first
 * key claiming a given account wins, so the output is stable and no key
 * appears twice. Keys with no resolvable identity stand alone - two unknowns
 * are not evidence of a match.
 */
export function collapseAccountKeys(
	keys: string[],
	identities: Record<string, ClaudeAccountIdentity | null | undefined>,
	aliasesByKey: Record<string, string[] | undefined> = {}
): AccountKeyGroup[] {
	const keySet = new Set(keys);

	// Sampler-declared aliases first: an alias listed by a primary that is not
	// itself in `keys` is dropped, since there is no row to fold it into.
	const primaryOfAlias = new Map<string, string>();
	for (const key of keys) {
		for (const alias of aliasesByKey[key] ?? []) {
			if (alias === key || !keySet.has(alias)) continue;
			if (!primaryOfAlias.has(alias)) primaryOfAlias.set(alias, key);
		}
	}

	const groups: AccountKeyGroup[] = [];
	const groupByPrimary = new Map<string, AccountKeyGroup>();
	const primaryOfFingerprint = new Map<string, string>();

	for (const key of keys) {
		const declaredPrimary = primaryOfAlias.get(key);
		if (declaredPrimary && declaredPrimary !== key) continue; // folded below

		const fingerprint = accountIdentityFingerprint(identities[key]);
		const existingPrimary = fingerprint ? primaryOfFingerprint.get(fingerprint) : undefined;
		if (existingPrimary) {
			groupByPrimary.get(existingPrimary)?.aliasKeys.push(key);
			continue;
		}

		const group: AccountKeyGroup = { primaryKey: key, aliasKeys: [] };
		groups.push(group);
		groupByPrimary.set(key, group);
		if (fingerprint) primaryOfFingerprint.set(fingerprint, key);
	}

	// Attach sampler-declared aliases to their primary's group. Done after the
	// primary pass so an alias that appears before its primary in `keys` still
	// lands in the right group instead of opening one of its own.
	for (const [alias, primary] of primaryOfAlias) {
		groupByPrimary.get(primary)?.aliasKeys.push(alias);
	}

	return groups;
}
