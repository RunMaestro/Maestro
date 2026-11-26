import { parseJsonWithBom } from '../../jsonUtils';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { encodeClaudeProjectPath, expandTilde, realpathThroughAncestor } from '../../pathUtils';
import { isPathAtOrUnderRoot } from '../../worktreePaths';

/** The host supplies the repository/worktree identity and effective account root. */
export function resolveClaudeMemoryPath(
	projectRoot: string,
	accountRoot: string,
	autoMemoryDirectory?: string
): string {
	return autoMemoryDirectory
		? path.resolve(projectRoot, expandTilde(autoMemoryDirectory))
		: path.join(accountRoot, 'projects', encodeClaudeProjectPath(projectRoot), 'memory');
}

export async function discoverClaudeMemoryPath(
	projectRoot: string,
	accountRoot: string,
	memoryProjectRoot = projectRoot
): Promise<string> {
	return (await discoverClaudeMemoryRoot(projectRoot, accountRoot, memoryProjectRoot)).path;
}

/** A project-level `autoMemoryDirectory` that was not honored (see `discoverClaudeMemoryRoot()`). */
export interface IgnoredMemoryDirectory {
	/** The project settings file that carried it. */
	settingsPath: string;
	/** The value as written. */
	directory: string;
	/** Where it points once `~`, `..` and symlinks are resolved. */
	resolvedPath: string;
}

function toComparableRootPath(p: string): string {
	// Convert backslashes only on Windows; on POSIX a backslash is a literal filename
	// character, so `/tmp/check\repo` must not fold onto `/tmp/check/repo`.
	return process.platform === 'win32' ? p.replace(/\\/g, '/') : p;
}

/**
 * Resolve a project-level `autoMemoryDirectory` and verify it stays inside the
 * project or account config directory. Returns `{ allowed: true, resolvedPath }`
 * when it stays inside, or `{ allowed: false, resolvedPath }` when it leaves
 * both roots. A repository writes its own `.claude/settings.json` and
 * `.claude/settings.local.json`, so it may name a folder inside itself, or inside
 * the account's config directory (where the default memory folder lives), and
 * nothing else: `~/.ssh`, `../../` or an absolute path elsewhere would make the
 * Memory Viewer and a provider migration read files the repository has no claim
 * to. Symlinks are followed on both sides, through the nearest existing ancestor
 * for a folder Claude has not created yet. The compare is case-sensitive on
 * purpose: an allow-list that mismatches on case rejects, it never admits.
 */
function checkProjectMemoryDirectory(
	projectRoot: string,
	accountRoot: string,
	directory: string
): { allowed: boolean; resolvedPath: string; approvedPath?: string } {
	const resolved = realpathThroughAncestor(path.resolve(projectRoot, expandTilde(directory)));
	const comparableResolved = toComparableRootPath(resolved);
	for (const root of [projectRoot, accountRoot]) {
		const absRoot = path.resolve(root);
		const realRoot = realpathThroughAncestor(absRoot);
		if (isPathAtOrUnderRoot(comparableResolved, toComparableRootPath(realRoot))) {
			// Anchor the resolved relative path under the caller's root so repo-owned
			// symlinks (e.g. `mem -> real-memory`) are dereferenced once at check time
			// while preserving OS-level root aliases such as macOS `/var -> /private/var`.
			const rel = path.relative(realRoot, resolved);
			return {
				allowed: true,
				resolvedPath: resolved,
				approvedPath: rel ? path.resolve(absRoot, rel) : absRoot,
			};
		}
	}
	return { allowed: false, resolvedPath: resolved };
}

/**
 * Which folder Claude keeps its memory in for this project: the default under the account's config
 * directory, or the `autoMemoryDirectory` of the account settings, the project's `.claude/settings.json` or
 * its `.claude/settings.local.json` (the last one set wins).
 *
 * The account's own value is the user's and is honored as written. A project-level value is not trusted: one
 * that leaves the project and the account's config directory is skipped (listed in `ignored`, so the caller
 * can say so) and the next value down applies, ending at the default. For an approved project-level value,
 * the returned path is the resolved target that passed the check so callers read the approved target directly.
 */
export async function discoverClaudeMemoryRoot(
	projectRoot: string,
	accountRoot: string,
	memoryProjectRoot = projectRoot
): Promise<{
	path: string;
	source: 'default' | 'account' | 'project';
	ignored: IgnoredMemoryDirectory[];
}> {
	let directory: string | undefined;
	let approvedProjectResolvedPath: string | undefined;
	let source: 'default' | 'account' | 'project' = 'default';
	const ignored: IgnoredMemoryDirectory[] = [];
	const accountSettings = path.join(accountRoot, 'settings.json');
	for (const settingsPath of [
		accountSettings,
		path.join(projectRoot, '.claude', 'settings.json'),
		path.join(projectRoot, '.claude', 'settings.local.json'),
	]) {
		try {
			const settings = parseJsonWithBom<Record<string, unknown>>(
				await fs.readFile(settingsPath, 'utf8')
			);
			if (typeof settings.autoMemoryDirectory === 'string' && settings.autoMemoryDirectory.trim()) {
				const fromAccount = settingsPath === accountSettings;
				if (!fromAccount) {
					const check = checkProjectMemoryDirectory(
						projectRoot,
						accountRoot,
						settings.autoMemoryDirectory
					);
					if (!check.allowed) {
						ignored.push({
							settingsPath,
							directory: settings.autoMemoryDirectory,
							resolvedPath: check.resolvedPath,
						});
						continue;
					}
					approvedProjectResolvedPath = check.approvedPath ?? check.resolvedPath;
				} else {
					approvedProjectResolvedPath = undefined;
				}
				directory = settings.autoMemoryDirectory;
				source = fromAccount ? 'account' : 'project';
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
		}
	}
	return {
		path:
			source === 'project' && approvedProjectResolvedPath
				? approvedProjectResolvedPath
				: resolveClaudeMemoryPath(
						directory ? projectRoot : memoryProjectRoot,
						accountRoot,
						directory
					),
		source,
		ignored,
	};
}

/** Canonical memory-link analysis shared by the viewer and migration preflight. */
export function analyzeMemoryLinks(contents: Map<string, string>): {
	referenced: Set<string>;
	brokenLinks: { source: string; target: string }[];
} {
	/** Normalize a link target so `-` and `_` spellings collapse together. */
	const normalize = (value: string): string =>
		value
			.trim()
			.toLowerCase()
			.replace(/\.(md|markdown)$/, '')
			.replace(/[-_]/g, '-');

	const aliasToFile = new Map<string, string>();
	for (const [name, content] of contents) {
		aliasToFile.set(normalize(name), name);
		aliasToFile.set(normalize(path.basename(name)), name);
		const frontMatterName = /^name:\s*(.+)$/m.exec(content)?.[1];
		if (frontMatterName) aliasToFile.set(normalize(frontMatterName), name);
	}
	const referenced = new Set<string>();
	const brokenLinks: { source: string; target: string }[] = [];

	for (const [source, content] of contents) {
		const targets: string[] = [];
		for (const match of content.matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)) {
			targets.push(match[1]);
		}
		for (const match of content.matchAll(/\]\(([^)]+\.(?:md|markdown))\)/gi)) {
			targets.push(match[1]);
		}
		for (const target of targets) {
			if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
			const resolved =
				aliasToFile.get(
					normalize(path.posix.normalize(path.posix.join(path.posix.dirname(source), target)))
				) ?? aliasToFile.get(normalize(target));
			if (!resolved) {
				brokenLinks.push({ source, target: target.trim() });
				continue;
			}
			// A file linking to itself does not make it referenced.
			if (resolved !== source) referenced.add(resolved);
		}
	}

	return { referenced, brokenLinks };
}

/** Keep a worktree's native session cwd separate from Claude's repository memory identity. */
export async function resolveMemoryRepositoryRoot(
	projectRoot: string,
	readCommonDirectory: (cwd: string) => Promise<string | undefined>
): Promise<string> {
	const common = await readCommonDirectory(projectRoot);
	if (!common) return projectRoot;
	const resolved = path.resolve(projectRoot, common.trim());
	return path.basename(resolved) === '.git' ? path.dirname(resolved) : projectRoot;
}
