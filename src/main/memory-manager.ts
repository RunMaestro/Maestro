/**
 * Memory Manager - read/write project memory files.
 *
 * Claude Code stores per-project persistent memory at:
 *   ~/.claude/projects/<encoded-path>/memory/
 *     ├── MEMORY.md                 (index, one line per entry)
 *     └── <name>.md                 (individual entries w/ YAML frontmatter)
 *
 * where <encoded-path> is the project's absolute path with every
 * non-alphanumeric character replaced by '-' (see encodeClaudeProjectPath).
 *
 * This module exposes list / read / write / create / delete / stats
 * operations over that directory. It is used by the Memory Viewer UI.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { encodeClaudeProjectPath } from '../shared/pathUtils';

export interface MemoryEntry {
	name: string; // filename, e.g. "MEMORY.md" or "user_role.md"
	size: number; // bytes
	createdAt: string; // ISO8601
	modifiedAt: string; // ISO8601
}

export interface MemoryStats {
	fileCount: number;
	firstCreatedAt: string | null;
	lastModifiedAt: string | null;
	totalBytes: number;
}

export interface MemorySearchMatch {
	name: string; // filename of the matching entry
	matchedName: boolean; // the query matched the filename itself
	snippet?: string; // first matching body line, trimmed and capped
}

export interface MemoryListResult {
	directoryPath: string;
	exists: boolean;
	entries: MemoryEntry[];
	stats: MemoryStats;
}

/**
 * A memory nothing points at.
 *
 * Claude reads MEMORY.md to decide which entries to load, so an entry the index
 * does not list and no other entry links to is never recalled - it costs disk
 * and reads as remembered while being, in practice, forgotten. Surfacing these
 * is the whole point of the viewer's Unlinked filter.
 */
export interface OrphanMemoryReport {
	/** Filenames nothing references, in the same pinned/alphabetical list order. */
	orphans: string[];
	/**
	 * Link targets that resolve to no memory file, with the file that wrote
	 * them. These are the other half of the same problem: a pointer that renders
	 * as nothing, so the entry looks indexed and is not.
	 */
	brokenLinks: { source: string; target: string }[];
}

/** Longest body excerpt a search match carries back to the list row. */
const SNIPPET_MAX_CHARS = 120;

/** Resolve the memory directory path for a given project. */
export function getMemoryDirectoryPath(
	projectPath: string,
	agentId: string = 'claude-code',
	homeDir?: string
): string {
	if (agentId !== 'claude-code') {
		throw new Error(`Memory viewer is not supported for agent "${agentId}"`);
	}
	const encoded = encodeClaudeProjectPath(projectPath);
	return path.join(homeDir ?? os.homedir(), '.claude', 'projects', encoded, 'memory');
}

function assertSafeFilename(filename: string): void {
	if (!filename || filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
		throw new Error(`Unsafe memory filename: ${filename}`);
	}
	if (!filename.toLowerCase().endsWith('.md')) {
		throw new Error(`Memory filenames must end with .md: ${filename}`);
	}
}

export async function listMemoryEntries(
	projectPath: string,
	agentId: string = 'claude-code',
	homeDir?: string
): Promise<MemoryListResult> {
	const directoryPath = getMemoryDirectoryPath(projectPath, agentId, homeDir);
	let names: string[];
	try {
		names = await fs.readdir(directoryPath);
	} catch (err: unknown) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
			return {
				directoryPath,
				exists: false,
				entries: [],
				stats: { fileCount: 0, firstCreatedAt: null, lastModifiedAt: null, totalBytes: 0 },
			};
		}
		throw err;
	}

	const mdNames = names.filter((n) => n.toLowerCase().endsWith('.md'));

	const entries: MemoryEntry[] = [];
	let firstCreatedMs: number | null = null;
	let lastModifiedMs: number | null = null;
	let totalBytes = 0;

	for (const name of mdNames) {
		try {
			const stat = await fs.stat(path.join(directoryPath, name));
			// birthtime is not reliable on Linux; fall back to mtime.
			const created = stat.birthtimeMs && stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.mtimeMs;
			const modified = stat.mtimeMs;
			entries.push({
				name,
				size: stat.size,
				createdAt: new Date(created).toISOString(),
				modifiedAt: new Date(modified).toISOString(),
			});
			totalBytes += stat.size;
			if (firstCreatedMs === null || created < firstCreatedMs) firstCreatedMs = created;
			if (lastModifiedMs === null || modified > lastModifiedMs) lastModifiedMs = modified;
		} catch {
			// Skip entries we can't stat (may have been deleted between readdir and stat).
		}
	}

	// Sort: MEMORY.md pinned first, others alphabetical.
	entries.sort((a, b) => {
		const aIsIndex = a.name === 'MEMORY.md';
		const bIsIndex = b.name === 'MEMORY.md';
		if (aIsIndex && !bIsIndex) return -1;
		if (!aIsIndex && bIsIndex) return 1;
		return a.name.localeCompare(b.name);
	});

	return {
		directoryPath,
		exists: true,
		entries,
		stats: {
			fileCount: entries.length,
			firstCreatedAt: firstCreatedMs !== null ? new Date(firstCreatedMs).toISOString() : null,
			lastModifiedAt: lastModifiedMs !== null ? new Date(lastModifiedMs).toISOString() : null,
			totalBytes,
		},
	};
}

export async function readMemoryEntry(
	projectPath: string,
	filename: string,
	agentId: string = 'claude-code',
	homeDir?: string
): Promise<string> {
	assertSafeFilename(filename);
	const dir = getMemoryDirectoryPath(projectPath, agentId, homeDir);
	return fs.readFile(path.join(dir, filename), 'utf8');
}

export async function writeMemoryEntry(
	projectPath: string,
	filename: string,
	content: string,
	agentId: string = 'claude-code',
	homeDir?: string
): Promise<void> {
	assertSafeFilename(filename);
	const dir = getMemoryDirectoryPath(projectPath, agentId, homeDir);
	await fs.mkdir(dir, { recursive: true });
	await fs.writeFile(path.join(dir, filename), content, 'utf8');
}

/**
 * Create a new memory entry with the given filename and starter content.
 * Fails if the file already exists.
 */
export async function createMemoryEntry(
	projectPath: string,
	filename: string,
	content: string,
	agentId: string = 'claude-code',
	homeDir?: string
): Promise<void> {
	assertSafeFilename(filename);
	const dir = getMemoryDirectoryPath(projectPath, agentId, homeDir);
	await fs.mkdir(dir, { recursive: true });
	const full = path.join(dir, filename);
	try {
		// wx flag: fail if exists.
		const handle = await fs.open(full, 'wx');
		try {
			await handle.writeFile(content, 'utf8');
		} finally {
			await handle.close();
		}
	} catch (err: unknown) {
		if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
			throw new Error(`A memory file named "${filename}" already exists`);
		}
		throw err;
	}
}

export async function deleteMemoryEntry(
	projectPath: string,
	filename: string,
	agentId: string = 'claude-code',
	homeDir?: string
): Promise<void> {
	assertSafeFilename(filename);
	// MEMORY.md is the index and should not be casually deleted.
	if (filename === 'MEMORY.md') {
		throw new Error('MEMORY.md is the index and cannot be deleted from the viewer');
	}
	const dir = getMemoryDirectoryPath(projectPath, agentId, homeDir);
	await fs.unlink(path.join(dir, filename));
}

/**
 * Case-insensitive keyword search across memory files.
 *
 * Matches on the filename AND on the file body, because the viewer's filter box
 * is how the user finds a memory they only remember the contents of. Returns
 * the matching entries in the same pinned/alphabetical order `listMemoryEntries`
 * uses, each carrying the first matching body line so the list row can show why
 * it matched.
 *
 * An empty/whitespace query returns every entry (no filter applied).
 */
export async function searchMemoryEntries(
	projectPath: string,
	query: string,
	agentId: string = 'claude-code',
	homeDir?: string
): Promise<MemorySearchMatch[]> {
	const { entries } = await listMemoryEntries(projectPath, agentId, homeDir);
	const needle = query.trim().toLowerCase();
	if (!needle) return entries.map((e) => ({ name: e.name, matchedName: false }));

	const dir = getMemoryDirectoryPath(projectPath, agentId, homeDir);
	const matches: MemorySearchMatch[] = [];

	for (const entry of entries) {
		const matchedName = entry.name.toLowerCase().includes(needle);
		let snippet: string | undefined;
		try {
			const content = await fs.readFile(path.join(dir, entry.name), 'utf8');
			const line = content
				.split('\n')
				.find((l) => l.toLowerCase().includes(needle))
				?.trim();
			if (line)
				snippet = line.length > SNIPPET_MAX_CHARS ? `${line.slice(0, SNIPPET_MAX_CHARS)}…` : line;
		} catch {
			// Unreadable file (deleted mid-search): fall back to the name match alone.
		}
		if (matchedName || snippet) matches.push({ name: entry.name, matchedName, snippet });
	}

	return matches;
}

/**
 * Find memories nothing links to, and links that point at nothing.
 *
 * Resolution deliberately accepts BOTH ways these files address each other,
 * because both are in active use and a checker that knows only one reports
 * mass false positives:
 *   - the filename stem (`[[project_foo]]` -> `project_foo.md`), which is what
 *     the Document Graph resolves, and
 *   - the frontmatter `name:` slug, which is what the memory instructions tell
 *     the agent to write and what most existing entries actually use.
 *
 * Separator-insensitive on top of that (`-` vs `_`): the two spellings are a
 * single character apart, the mistake is invisible in rendered markdown, and
 * treating them as different targets is how a correct-looking index ends up
 * pointing nowhere.
 *
 * MEMORY.md is never an orphan - it is the index, so nothing is expected to
 * point at it.
 */
export async function findOrphanMemories(
	projectPath: string,
	agentId: string = 'claude-code',
	homeDir?: string
): Promise<OrphanMemoryReport> {
	const { entries } = await listMemoryEntries(projectPath, agentId, homeDir);
	const dir = getMemoryDirectoryPath(projectPath, agentId, homeDir);

	/** Normalize a link target so `-` and `_` spellings collapse together. */
	const normalize = (value: string): string =>
		value
			.trim()
			.toLowerCase()
			.replace(/\.(md|markdown)$/, '')
			.replace(/[-_]/g, '-');

	// Every alias a file answers to: its stem and its frontmatter name.
	const aliasToFile = new Map<string, string>();
	const contents = new Map<string, string>();
	for (const entry of entries) {
		let content = '';
		try {
			content = await fs.readFile(path.join(dir, entry.name), 'utf8');
		} catch {
			// Unreadable mid-scan. It still exists as a link TARGET, so register
			// its filename alias and move on rather than reporting it orphaned.
		}
		contents.set(entry.name, content);
		aliasToFile.set(normalize(entry.name), entry.name);
		const frontMatterName = /^name:\s*(.+)$/m.exec(content)?.[1];
		if (frontMatterName) aliasToFile.set(normalize(frontMatterName), entry.name);
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
			const resolved = aliasToFile.get(normalize(target));
			if (!resolved) {
				brokenLinks.push({ source, target: target.trim() });
				continue;
			}
			// A file linking to itself does not make it referenced.
			if (resolved !== source) referenced.add(resolved);
		}
	}

	const orphans = entries
		.map((e) => e.name)
		.filter((name) => name !== 'MEMORY.md' && !referenced.has(name));

	return { orphans, brokenLinks };
}
