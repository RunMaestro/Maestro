/**
 * Memory Manager - read/write a provider's persistent memory files.
 *
 * Two providers keep a memory store Maestro can browse, and they lay it out
 * differently, so every operation here runs against a `MemoryLayout` rather
 * than a hard-coded path:
 *
 *   Claude Code - one store PER PROJECT, flat:
 *     <CLAUDE_CONFIG_DIR>/projects/<encoded-path>/memory/
 *       ├── MEMORY.md                 (index, one line per entry)
 *       └── <name>.md                 (individual entries w/ YAML frontmatter)
 *     where <encoded-path> is the project's absolute path with every
 *     non-alphanumeric character replaced by '-' (see resolveClaudeMemoryPath).
 *
 *   Codex - one store PER ACCOUNT, nested, written by Codex's own consolidation:
 *     <CODEX_HOME>/memories/
 *       ├── MEMORY.md, memory_summary.md, raw_memories.md   (generated)
 *       ├── rollout_summaries/*.md                           (one per session)
 *       ├── skills/<name>/*.md
 *       └── extensions/<name>/...                            (ad_hoc notes, ...)
 *     A person adds to it through `extensions/ad_hoc/notes/`, which Codex folds
 *     into the generated files on its next pass, so that is where a new memory
 *     is created.
 *
 * Which account dir a store lives under is resolved by the caller (see
 * `memory-location.ts`); this module is pure filesystem work over the layout.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import {
	resolveClaudeMemoryPath,
	analyzeMemoryLinks,
} from '../shared/maestro-lib/translation/memory';
import {
	MEMORY_INDEX_FILE,
	type MemoryEntry,
	type MemoryLayoutInfo,
	type MemorySearchMatch,
	type MemoryStats,
} from '../shared/agentMemory';

export type { MemoryEntry, MemoryStats, MemorySearchMatch, MemoryLayoutInfo };
export { MEMORY_INDEX_FILE };

/**
 * Where a provider keeps its memory and how the viewer may treat it.
 *
 * `tracksLinks` is false for Codex: its index names rollout files in plain
 * prose, so a link check there would report every file as unlinked.
 */
export interface MemoryLayout extends MemoryLayoutInfo {
	/** Absolute path of the memory root. */
	directoryPath: string;
	/** Whether the viewer may delete this entry. */
	isProtected: (name: string) => boolean;
}

export interface MemoryListResult {
	directoryPath: string;
	exists: boolean;
	entries: MemoryEntry[];
	stats: MemoryStats;
	layout: MemoryLayoutInfo;
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

/** Files Codex regenerates on every consolidation pass. */
const CODEX_GENERATED_FILES = new Set([MEMORY_INDEX_FILE, 'memory_summary.md', 'raw_memories.md']);

/** Longest body excerpt a search match carries back to the list row. */
const SNIPPET_MAX_CHARS = 120;

/**
 * The memory layout for a provider, given the account dir its agent runs under
 * (`CLAUDE_CONFIG_DIR` / `CODEX_HOME`, already resolved).
 */
export function memoryLayoutFor(
	toolType: string,
	options: { projectPath: string; accountDir: string }
): MemoryLayout {
	switch (toolType) {
		case 'claude-code':
			return {
				directoryPath: resolveClaudeMemoryPath(options.projectPath, options.accountDir),
				scope: 'project',
				nested: false,
				newEntryDir: '',
				tracksLinks: true,
				isProtected: (name) => name === MEMORY_INDEX_FILE,
			};
		case 'codex':
			return {
				directoryPath: path.join(options.accountDir, 'memories'),
				scope: 'account',
				nested: true,
				newEntryDir: 'extensions/ad_hoc/notes',
				tracksLinks: false,
				// An extension's instructions.md is what tells Codex how to read
				// that extension, so deleting it silently disables the extension.
				isProtected: (name) =>
					CODEX_GENERATED_FILES.has(name) || /^extensions\/[^/]+\/instructions\.md$/.test(name),
			};
		default:
			throw new Error(`Memory viewer is not supported for agent "${toolType}"`);
	}
}

function layoutInfo(layout: MemoryLayout): MemoryLayoutInfo {
	return {
		scope: layout.scope,
		nested: layout.nested,
		newEntryDir: layout.newEntryDir,
		tracksLinks: layout.tracksLinks,
	};
}

/**
 * Resolve an entry name to an absolute path inside the memory root, refusing
 * anything that could reach outside it. A nested layout accepts `/`-separated
 * segments; no layout accepts `..`, a backslash, an empty segment, or a dot
 * segment (`.git` lives in the Codex root and is not a memory).
 */
function resolveEntryPath(layout: MemoryLayout, filename: string): string {
	const segments = filename.split('/');
	const unsafe =
		!filename ||
		filename.includes('\\') ||
		(!layout.nested && segments.length > 1) ||
		segments.some((s) => !s || s.startsWith('.'));
	if (unsafe) {
		throw new Error(`Unsafe memory filename: ${filename}`);
	}
	if (!filename.toLowerCase().endsWith('.md')) {
		throw new Error(`Memory filenames must end with .md: ${filename}`);
	}
	return path.join(layout.directoryPath, ...segments);
}

/** Every `.md` file under the root, as `/`-separated relative names. */
async function collectMarkdownNames(layout: MemoryLayout): Promise<string[]> {
	const names: string[] = [];
	const walk = async (relDir: string): Promise<void> => {
		const dirents = await fs.readdir(path.join(layout.directoryPath, ...relDir.split('/')), {
			withFileTypes: true,
		});
		for (const dirent of dirents) {
			// Dot entries are tooling (`.git`, `.DS_Store`), never memories.
			if (dirent.name.startsWith('.')) continue;
			const rel = relDir ? `${relDir}/${dirent.name}` : dirent.name;
			if (dirent.isDirectory()) {
				// Symlinked directories are not followed: they are how a loop gets in.
				if (layout.nested) await walk(rel);
			} else if (dirent.name.toLowerCase().endsWith('.md')) {
				names.push(rel);
			}
		}
	};
	await walk('');
	return names;
}

export async function listMemoryEntries(layout: MemoryLayout): Promise<MemoryListResult> {
	const { directoryPath } = layout;
	let names: string[];
	try {
		names = await collectMarkdownNames(layout);
	} catch (err: unknown) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
			return {
				directoryPath,
				exists: false,
				entries: [],
				stats: { fileCount: 0, firstCreatedAt: null, lastModifiedAt: null, totalBytes: 0 },
				layout: layoutInfo(layout),
			};
		}
		throw err;
	}

	const entries: MemoryEntry[] = [];
	let firstCreatedMs: number | null = null;
	let lastModifiedMs: number | null = null;
	let totalBytes = 0;

	for (const name of names) {
		try {
			const stat = await fs.stat(resolveEntryPath(layout, name));
			// birthtime is not reliable on Linux; fall back to mtime.
			const created = stat.birthtimeMs && stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.mtimeMs;
			const modified = stat.mtimeMs;
			entries.push({
				name,
				size: stat.size,
				createdAt: new Date(created).toISOString(),
				modifiedAt: new Date(modified).toISOString(),
				...(layout.isProtected(name) ? { protected: true } : {}),
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
		const aIsIndex = a.name === MEMORY_INDEX_FILE;
		const bIsIndex = b.name === MEMORY_INDEX_FILE;
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
		layout: layoutInfo(layout),
	};
}

export async function readMemoryEntry(layout: MemoryLayout, filename: string): Promise<string> {
	return fs.readFile(resolveEntryPath(layout, filename), 'utf8');
}

export async function writeMemoryEntry(
	layout: MemoryLayout,
	filename: string,
	content: string
): Promise<void> {
	const full = resolveEntryPath(layout, filename);
	await fs.mkdir(path.dirname(full), { recursive: true });
	await fs.writeFile(full, content, 'utf8');
}

/**
 * Create a new memory entry with the given filename and starter content.
 * Fails if the file already exists.
 */
export async function createMemoryEntry(
	layout: MemoryLayout,
	filename: string,
	content: string
): Promise<void> {
	const full = resolveEntryPath(layout, filename);
	await fs.mkdir(path.dirname(full), { recursive: true });
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

export async function deleteMemoryEntry(layout: MemoryLayout, filename: string): Promise<void> {
	const full = resolveEntryPath(layout, filename);
	// The index, and files the provider regenerates, should not be casually deleted.
	if (layout.isProtected(filename)) {
		throw new Error(`${filename} is managed by the agent and cannot be deleted from the viewer`);
	}
	await fs.unlink(full);
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
	layout: MemoryLayout,
	query: string
): Promise<MemorySearchMatch[]> {
	const { entries } = await listMemoryEntries(layout);
	const needle = query.trim().toLowerCase();
	if (!needle) return entries.map((e) => ({ name: e.name, matchedName: false }));

	const matches: MemorySearchMatch[] = [];

	for (const entry of entries) {
		const matchedName = entry.name.toLowerCase().includes(needle);
		let snippet: string | undefined;
		try {
			const content = await fs.readFile(resolveEntryPath(layout, entry.name), 'utf8');
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
 * point at it. A layout that does not link its entries (`tracksLinks: false`)
 * reports nothing, since every entry would read as unlinked.
 */
export async function findOrphanMemories(layout: MemoryLayout): Promise<OrphanMemoryReport> {
	if (!layout.tracksLinks) return { orphans: [], brokenLinks: [] };
	const { entries } = await listMemoryEntries(layout);
	const contents = new Map<string, string>();
	for (const entry of entries) {
		let content = '';
		try {
			content = await fs.readFile(resolveEntryPath(layout, entry.name), 'utf8');
		} catch {
			/* Retain unreadable files as link targets. */
		}
		contents.set(entry.name, content);
	}
	const { referenced, brokenLinks } = analyzeMemoryLinks(contents);

	const orphans = entries
		.map((e) => e.name)
		.filter((name) => name !== MEMORY_INDEX_FILE && !referenced.has(name));

	return { orphans, brokenLinks };
}
