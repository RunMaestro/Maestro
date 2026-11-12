/**
 * Additional Directories - extra paths an agent may read from and/or write to
 * beyond its working directory.
 *
 * Everything the desktop, the CLI, the prompt renderer, and the per-provider arg
 * builders need to agree on lives here:
 *
 *   1. `normalizeAdditionalDirectories` - what gets persisted on the session
 *      (tilde-expanded, trimmed, de-duped).
 *   2. `formatAdditionalDirectoriesForPrompt` - the markdown block substituted
 *      into `{{ADDITIONAL_DIRECTORIES}}` in the Maestro system prompt. EVERY
 *      agent gets this, whether or not its CLI can enforce anything.
 *   3. `dirsWithAnyAccess` / `dirsWithWriteAccess` / `repeatDirFlag` - the
 *      building blocks each provider's `additionalDirArgs` uses in
 *      `src/main/agents/definitions.ts` to translate grants into its own CLI
 *      vocabulary.
 *
 * Two layers of enforcement, and they are not equivalent:
 *
 *   - PROMPT (all agents): carries the full read/write nuance, including
 *     write-only, but is only as good as the agent's obedience.
 *   - NATIVE (agents with `supportsAdditionalDirectories`): actually enforced by
 *     the provider, but COARSER. No CLI today can express "write but never
 *     read", so a native grant opens the directory and the prompt is what holds
 *     the line on the finer rule.
 */

import type { AdditionalDirectory } from './types';

/**
 * Expand a leading `~` against the given home directory.
 *
 * Deliberately not `expandTilde` from `shared/pathUtils` - that module imports
 * `os`/`fs`, and this one is bundled into the renderer. Without a `homeDir` the
 * path is left untouched rather than guessed at.
 */
function expandHome(filePath: string, homeDir?: string): string {
	if (!homeDir) return filePath;
	if (filePath === '~') return homeDir;
	if (filePath.startsWith('~/')) return `${homeDir}/${filePath.slice(2)}`;
	return filePath;
}

/**
 * Clean a raw list from a form: expand `~`, trim, drop blank paths, and collapse
 * duplicate paths (last write wins, so the most recently edited row's toggles
 * survive). Entries with neither `read` nor `write` are kept - the user may be
 * toggling a row off temporarily - but they render nothing in the prompt.
 *
 * Returns undefined when nothing survives, so the session field stays absent
 * rather than persisting an empty array on every agent.
 */
export function normalizeAdditionalDirectories(
	dirs: AdditionalDirectory[] | undefined,
	homeDir?: string
): AdditionalDirectory[] | undefined {
	if (!dirs?.length) return undefined;

	const byPath = new Map<string, AdditionalDirectory>();
	for (const dir of dirs) {
		const path = expandHome(dir.path.trim(), homeDir);
		if (!path) continue;
		const description = dir.description?.trim();
		byPath.set(path, {
			path,
			read: !!dir.read,
			write: !!dir.write,
			// Keep the field absent (not an empty string) when unused so it doesn't
			// persist on every agent.
			...(description ? { description } : {}),
		});
	}

	const normalized = [...byPath.values()];
	return normalized.length > 0 ? normalized : undefined;
}

// ============================================================================
// Building blocks for a provider's `additionalDirArgs` (see agents/definitions)
// ============================================================================

/**
 * Grants the agent should be able to touch at all - anything with read or write.
 * The right input for CLIs whose flag means "allow tool access to this dir"
 * (Claude Code, Copilot-CLI).
 */
export function dirsWithAnyAccess(dirs: AdditionalDirectory[] | undefined): AdditionalDirectory[] {
	return (dirs ?? []).filter((d) => d.path.trim() && (d.read || d.write));
}

/**
 * Grants the agent may write to. The right input for CLIs whose flag means "add
 * a writable sandbox root" (Codex).
 */
export function dirsWithWriteAccess(
	dirs: AdditionalDirectory[] | undefined
): AdditionalDirectory[] {
	return (dirs ?? []).filter((d) => d.path.trim() && d.write);
}

/**
 * Emit `<flag> <path>` once per directory.
 *
 * Repeating the flag rather than passing a single variadic list (`--add-dir a b`)
 * is deliberate: a variadic option swallows any positional that follows it, and
 * the prompt is passed positionally on several spawn paths. Repeating the flag is
 * accepted by every provider we emit it for and cannot eat the prompt.
 */
export function repeatDirFlag(flag: string, dirs: AdditionalDirectory[]): string[] {
	return dirs.flatMap((d) => [flag, d.path.trim()]);
}

/** Human-readable access label for one directory. */
function accessLabel(dir: AdditionalDirectory): string {
	if (dir.read && dir.write) return 'Read + Write';
	if (dir.read) return 'Read only';
	if (dir.write) return 'Write only';
	return 'No access';
}

/**
 * Make a freeform description safe to drop into a markdown table cell: collapse
 * any newlines/runs of whitespace to single spaces and escape pipes so a stray
 * `|` in the user's hint can't break the table.
 */
function sanitizeDescriptionCell(description: string): string {
	return description.trim().replace(/\s+/g, ' ').replace(/\|/g, '\\|');
}

/**
 * Render the `{{ADDITIONAL_DIRECTORIES}}` block for the system prompt.
 *
 * Emits the section heading along with the table so the whole block collapses to
 * an empty string when the agent has no grants - a bare heading with nothing
 * under it reads to the agent like a section it failed to load.
 */
export function formatAdditionalDirectoriesForPrompt(
	dirs: AdditionalDirectory[] | undefined
): string {
	const granted = dirsWithAnyAccess(dirs);
	if (granted.length === 0) return '';

	// Only widen the table with a Notes column when at least one grant carries a
	// description - otherwise the block stays the lean two-column table.
	const hasNotes = granted.some((d) => d.description?.trim());

	const rows = granted
		.map((d) => {
			const cells = [`\`${d.path.trim()}\``, accessLabel(d)];
			if (hasNotes) cells.push(sanitizeDescriptionCell(d.description ?? ''));
			return `| ${cells.join(' | ')} |`;
		})
		.join('\n');

	const header = hasNotes
		? '| Directory | Access | Notes |\n| --------- | ------ | ----- |'
		: '| Directory | Access |\n| --------- | ------ |';

	return `## Additional Directories

The Conductor has granted you access to these directories in addition to your working directory. The listed permission is a hard rule, exactly like the working-directory restriction above:

- **Read + Write** - read from and write to this directory and its subdirectories.
- **Read only** - read freely; never create, modify, move, or delete anything inside it.
- **Write only** - create and modify files here; never read the existing contents back.
${hasNotes ? '\nThe Notes column is a hint from the Conductor on what a directory is for or how to use it; treat it as guidance, not as a change to the access rule.\n' : ''}
${header}
${rows}

These grants are additive. Every other directory outside your working directory remains read-only for reference and off-limits for writes. If a task needs access this list does not cover, say so instead of reaching outside it.`;
}
