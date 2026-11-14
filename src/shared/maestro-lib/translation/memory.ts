import { parseJsonWithBom } from '../../jsonUtils';
import type { TranslationFs } from './fs-port';
import { localTranslationFs } from './local-fs';
import * as path from 'node:path';
import { encodeClaudeProjectPath, expandTilde } from '../../pathUtils';

/** The host supplies the repository/worktree identity and effective account root. */
export function resolveClaudeMemoryPath(
	projectRoot: string,
	accountRoot: string,
	autoMemoryDirectory?: string,
	remoteHome?: string
): string {
	const paths = remoteHome ? path.posix : path;
	return autoMemoryDirectory
		? paths.resolve(projectRoot, expandTilde(autoMemoryDirectory, remoteHome))
		: paths.join(accountRoot, 'projects', encodeClaudeProjectPath(projectRoot), 'memory');
}

export async function discoverClaudeMemoryPath(
	projectRoot: string,
	accountRoot: string,
	memoryProjectRoot = projectRoot,
	nativeFs: TranslationFs = localTranslationFs
): Promise<string> {
	return (await discoverClaudeMemoryRoot(projectRoot, accountRoot, memoryProjectRoot, nativeFs))
		.path;
}

export async function discoverClaudeMemoryRoot(
	projectRoot: string,
	accountRoot: string,
	memoryProjectRoot = projectRoot,
	nativeFs: TranslationFs = localTranslationFs,
	remoteHome?: string
): Promise<{ path: string; source: 'default' | 'account' | 'project' }> {
	const paths = remoteHome ? path.posix : path;
	let directory: string | undefined;
	let source: 'default' | 'account' | 'project' = 'default';
	for (const settingsPath of [
		paths.join(accountRoot, 'settings.json'),
		paths.join(projectRoot, '.claude', 'settings.json'),
		paths.join(projectRoot, '.claude', 'settings.local.json'),
	]) {
		try {
			const settings = parseJsonWithBom<Record<string, unknown>>(
				(await nativeFs.readFile(settingsPath)).toString('utf8')
			);
			if (typeof settings.autoMemoryDirectory === 'string' && settings.autoMemoryDirectory.trim()) {
				directory = settings.autoMemoryDirectory;
				source = settingsPath === paths.join(accountRoot, 'settings.json') ? 'account' : 'project';
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
		}
	}
	return {
		path: resolveClaudeMemoryPath(
			directory ? projectRoot : memoryProjectRoot,
			accountRoot,
			directory,
			remoteHome
		),
		source,
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
	readCommonDirectory: (cwd: string) => Promise<string | undefined>,
	paths: path.PlatformPath = path
): Promise<string> {
	const common = await readCommonDirectory(projectRoot);
	if (!common) return projectRoot;
	const resolved = paths.resolve(projectRoot, common.trim());
	return paths.basename(resolved) === '.git' ? paths.dirname(resolved) : projectRoot;
}
