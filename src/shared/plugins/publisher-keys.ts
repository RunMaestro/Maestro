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
 * - Until a real publisher key is added here this list is EMPTY. The seeder is
 *   trust-gated (it only installs a bundled plugin that verifies `trusted`), so
 *   an empty anchor means bundled plugins are simply not auto-installed - never
 *   an orphaned, auto-installed-but-untrusted plugin the user did not choose.
 * - Base64 SPKI DER, one entry per publisher key, matching the `publicKey`
 *   field a `signature.json` carries (see `signing.ts`).
 */
export const MAESTRO_PUBLISHER_KEYS: readonly string[] = [];

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
