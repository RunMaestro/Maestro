/**
 * Codex Configuration Utilities
 *
 * Shared helpers for resolving Codex's on-disk slash-command sources. Codex
 * exposes two kinds of user-invocable `/name` entries in its TUI:
 *
 *   1. Skills   - `<CODEX_HOME>/skills/<name>/SKILL.md` and `<cwd>/.codex/skills/...`
 *                 (the current surface, verified against codex-cli 0.144.1)
 *   2. Prompts  - `<CODEX_HOME>/prompts/<name>.md` and `<cwd>/.codex/prompts/...`
 *                 (the older custom-prompt surface, still probed so users on
 *                 earlier Codex builds keep their commands)
 *
 * Both are plain markdown with optional YAML frontmatter, so they can be read
 * without spawning the CLI. Maestro drives Codex in headless `codex exec` mode,
 * where the CLI does NOT expand `/name` itself - so Maestro carries the file
 * body as the command's `prompt` and expands it renderer-side, the same way
 * OpenCode custom commands already work (see `opencode-config.ts`).
 */

import * as os from 'os';
import * as path from 'path';

/**
 * Resolve Codex's config home.
 *
 * Codex honours `CODEX_HOME` for every on-disk lookup (it is how `codex exec`
 * is pointed at an alternate profile), so respect it here too rather than
 * hard-coding `~/.codex` - otherwise a user running a non-default profile is
 * offered commands that their Codex will never see.
 */
export function getCodexHome(env?: Record<string, string | undefined>): string {
	const effectiveEnv = env ?? process.env;
	return effectiveEnv.CODEX_HOME || path.join(os.homedir(), '.codex');
}

/**
 * Ordered list of Codex skill directories to probe. Project-local first so a
 * repo-scoped skill wins over a same-named global one.
 */
export function getCodexSkillDirs(
	cwd?: string,
	env?: Record<string, string | undefined>
): string[] {
	const dirs: string[] = [];
	if (cwd) dirs.push(path.join(cwd, '.codex', 'skills'));
	dirs.push(path.join(getCodexHome(env), 'skills'));
	return dirs;
}

/**
 * Ordered list of Codex custom-prompt directories to probe (pre-skills builds).
 */
export function getCodexPromptDirs(
	cwd?: string,
	env?: Record<string, string | undefined>
): string[] {
	const dirs: string[] = [];
	if (cwd) dirs.push(path.join(cwd, '.codex', 'prompts'));
	dirs.push(path.join(getCodexHome(env), 'prompts'));
	return dirs;
}

export interface CodexMarkdownDoc {
	/** `name:` from frontmatter, when present. */
	name?: string;
	/** `description:` from frontmatter, when present. */
	description?: string;
	/**
	 * `user-invocable:` from frontmatter. Codex defaults this to true; `false`
	 * marks a background/reference-only skill that has no `/name` entry.
	 */
	userInvocable: boolean;
	/** Everything after the frontmatter block. */
	body: string;
}

/**
 * Parse the leading YAML frontmatter of a Codex skill/prompt file.
 *
 * Deliberately a line scanner rather than a YAML parse: these files are read
 * on every agent focus, only three scalar keys are needed, and a malformed
 * document must degrade to "no metadata, body is the whole file" instead of
 * throwing away a command the user can see in their own Codex TUI.
 */
export function parseCodexMarkdownDoc(content: string): CodexMarkdownDoc {
	const normalized = content.replace(/\r\n/g, '\n');
	const doc: CodexMarkdownDoc = { userInvocable: true, body: normalized.trim() };

	if (!normalized.startsWith('---\n')) return doc;
	const endIndex = normalized.indexOf('\n---', 3);
	if (endIndex === -1) return doc;

	const frontmatter = normalized.slice(4, endIndex);
	doc.body = normalized.slice(endIndex + 4).trim();

	// Top-level keys only: `metadata:` nests its own indented block, and an
	// indented `description:` under it is not the skill's description.
	for (const line of frontmatter.split('\n')) {
		const match = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
		if (!match) continue;
		const key = match[1];
		const value = match[2].trim().replace(/^["']|["']$/g, '');
		if (key === 'name' && value) doc.name = value;
		else if (key === 'description' && value) doc.description = value;
		else if (key === 'user-invocable') doc.userInvocable = value !== 'false';
	}

	return doc;
}
