/**
 * `~` expansion for plugin filesystem paths (main process only).
 *
 * `maestro.fs.read` / `maestro.fs.write` resolve the path a plugin passes with
 * `path.resolve`, which does NOT expand `~` - that is a shell convention, not a
 * filesystem one. The sandbox has no `process`, no `os`, and no other way to
 * learn the home directory, so without this a plugin could not name a file
 * under the user's home AT ALL: it would have to hardcode `/Users/<someone>`,
 * which is unshippable.
 *
 * Expansion lives here, in the main process, and deliberately NOT in
 * `src/shared/plugins/`: those permission contracts are bundle-safe (no Node
 * imports) so the consent UI and the pure default-deny matcher stay testable
 * without a filesystem. Two main-process sites call this and they must agree:
 * - `resolveRealPath` (`plugin-host-handlers.ts`) expands before resolving, so
 *   the symlink re-authorization and the userData exclusion both see the real
 *   path rather than a literal `~` directory that does not exist.
 * - `PermissionBroker.authorize` expands the grant's path scope AND the call
 *   target before the pure matcher compares them, so a scope of
 *   `~/.maestro/kanban-boards` covers the expanded target.
 *
 * Only exactly `~` and a leading `~/` expand. `~user/...` is left alone (we do
 * not resolve another user's home directory), and a `~` anywhere but the first
 * character is an ordinary filename character.
 *
 * Expansion is `os.homedir()` verbatim, with no `realpathSync`. On a machine
 * whose home directory is ITSELF a symlink, the broker's expanded scope and the
 * handler's symlink-resolved real path disagree and the call is denied - it
 * fails closed, exactly as an absolute scope behind a symlink already does.
 * Resolving here instead would make the grant scope mean something the user
 * never read at the consent prompt, so we keep the literal home.
 *
 * What a plugin may ASK for is much narrower than what this expands:
 * `parsePermissions` (`src/shared/plugins/permissions.ts`) accepts a
 * home-relative path scope only in the form `~/.maestro/<name>[/<more>]`, so a
 * grant can never name the whole home directory.
 */

import { expandTilde } from '../../shared/pathUtils';

/**
 * Expand a leading `~` in a plugin-supplied path or in a grant's path scope.
 * Every other string passes through byte for byte - an absolute path, a
 * relative path, and `~user/...` are all returned unchanged.
 *
 * Delegates to the canonical `expandTilde()` rather than re-deriving the rule;
 * this wrapper exists to name the plugin boundary's single expansion seam so
 * the handlers, the broker, and the manifest validator cannot drift apart.
 */
export function expandPluginHomePath(p: string): string {
	return expandTilde(p);
}
