/**
 * Memory Manager — read/write project memory files.
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

export interface MemoryListResult {
	directoryPath: string;
	exists: boolean;
	entries: MemoryEntry[];
	stats: MemoryStats;
}

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
