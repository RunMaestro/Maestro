/**
 * Built-in publisher trust anchor for BUNDLED first-party plugins.
 *
 * A plugin shipped inside the Maestro app bundle (see the bundled-plugin seeding
 * in `src/main/plugins/bundled-plugins.ts`) is signed by Maestro's publisher
 * key. Baking the matching PUBLIC key here lets that bundled, signed plugin
 * resolve to `trusted` - and therefore run its sandboxed code (`isRunnable`) -
 * without the user manually adding a key. This is the ONLY built-in trust
 * anchor; every other trusted key is a user-supplied `pluginTrustedKeys` entry.
 *
 * SHIPPING CONTRACT:
 * - The matching PRIVATE key is a maintainer/CI secret and is NEVER committed.
 *   Release tooling signs the bundled plugin(s) with it at build time.
 * - This list was EMPTY until the publisher key below was minted. The seeder is
 *   trust-gated (it only installs a bundled plugin that verifies `trusted`), so
 *   an empty anchor meant bundled plugins were simply not auto-installed - never
 *   an orphaned, auto-installed-but-untrusted plugin the user did not choose.
 * - Base64 SPKI DER, one entry per publisher key, matching the `publicKey`
 *   field a `signature.json` carries (see `signing.ts`).
 */
export const MAESTRO_PUBLISHER_KEYS: readonly string[] = [
	// Maestro release-signing key (ed25519), minted 2026-07-23. The private half
	// lives ONLY in the MAESTRO_PLUGIN_SIGNING_KEY Actions secret (added
	// 2026-07-25); it is intentionally not held by any individual, so a bundled
	// plugin can only be signed by a maintainer-tagged release run. This value
	// must stay the public counterpart of that secret - the release drift guard
	// fails the build if they diverge. Rotation: see CLAUDE-PLUGINS.md
	// "Trust model (v1)", and note it is a TWO-part change (new secret AND a
	// re-baked key here, in the same release).
	'MCowBQYDK2VwAyEAgG9ilXDpkj83vdxhlOI64cehRMB2EpbW2CNQO3izPu0=',
];

/**
 * Union of the built-in publisher anchor and the user's configured trusted keys,
 * trimmed and de-duplicated. This is the single set every signature check should
 * resolve trust against, so a bundled first-party plugin and a user-trusted
 * community plugin are judged by the same rule.
 */
export function resolveTrustedKeys(userKeys: readonly string[]): string[] {
	const merged: string[] = [];
	for (const key of [...MAESTRO_PUBLISHER_KEYS, ...userKeys]) {
		const trimmed = typeof key === 'string' ? key.trim() : '';
		if (trimmed && !merged.includes(trimmed)) merged.push(trimmed);
	}
	return merged;
}
