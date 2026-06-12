/**
 * Tests for memory-manager.ts — project memory CRUD operations.
 *
 * Uses a per-test temporary directory passed explicitly as homeDir so we
 * never touch the user's real ~/.claude/projects/<encoded>/memory/.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import {
	getMemoryDirectoryPath,
	listMemoryEntries,
	readMemoryEntry,
	writeMemoryEntry,
	createMemoryEntry,
	deleteMemoryEntry,
} from '../../main/memory-manager';

let tempHome: string;

describe('memory-manager', () => {
	beforeEach(() => {
		tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-memory-test-'));
	});

	afterEach(() => {
		try {
			fs.rmSync(tempHome, { recursive: true, force: true });
		} catch {
			// ignore
		}
	});

	it('resolves the memory directory using the Claude project-path encoding', () => {
		const projectPath = '/Users/me/Projects/My App';
		const dir = getMemoryDirectoryPath(projectPath, 'claude-code', tempHome);
		expect(dir).toBe(
			path.join(tempHome, '.claude', 'projects', '-Users-me-Projects-My-App', 'memory')
		);
	});

	it('refuses non-claude-code agents', () => {
		expect(() => getMemoryDirectoryPath('/p', 'codex', tempHome)).toThrow(/not supported/);
	});

	it('returns exists:false with empty entries when the directory is missing', async () => {
		const result = await listMemoryEntries('/Users/me/Projects/Empty', 'claude-code', tempHome);
		expect(result.exists).toBe(false);
		expect(result.entries).toEqual([]);
		expect(result.stats.fileCount).toBe(0);
		expect(result.stats.totalBytes).toBe(0);
	});

	it('pins MEMORY.md to the top and sorts the rest alphabetically', async () => {
		const projectPath = '/Users/me/Projects/Pinning';
		await writeMemoryEntry(projectPath, 'zebra.md', 'z', 'claude-code', tempHome);
		await writeMemoryEntry(projectPath, 'alpha.md', 'a', 'claude-code', tempHome);
		await writeMemoryEntry(projectPath, 'MEMORY.md', '- index', 'claude-code', tempHome);
		const result = await listMemoryEntries(projectPath, 'claude-code', tempHome);
		expect(result.entries.map((e) => e.name)).toEqual(['MEMORY.md', 'alpha.md', 'zebra.md']);
	});

	it('round-trips write/read/delete for a single entry', async () => {
		const projectPath = '/Users/me/Projects/Rw';
		await writeMemoryEntry(projectPath, 'note.md', 'hello', 'claude-code', tempHome);
		expect(await readMemoryEntry(projectPath, 'note.md', 'claude-code', tempHome)).toBe('hello');
		await deleteMemoryEntry(projectPath, 'note.md', 'claude-code', tempHome);
		const after = await listMemoryEntries(projectPath, 'claude-code', tempHome);
		expect(after.entries.find((e) => e.name === 'note.md')).toBeUndefined();
	});

	it('createMemoryEntry fails if the file already exists', async () => {
		const projectPath = '/Users/me/Projects/Create';
		await createMemoryEntry(projectPath, 'dup.md', 'first', 'claude-code', tempHome);
		await expect(
			createMemoryEntry(projectPath, 'dup.md', 'second', 'claude-code', tempHome)
		).rejects.toThrow(/already exists/);
	});

	it('refuses filenames that would escape the memory directory', async () => {
		const projectPath = '/Users/me/Projects/Safety';
		await expect(
			writeMemoryEntry(projectPath, '../evil.md', 'x', 'claude-code', tempHome)
		).rejects.toThrow(/Unsafe/);
		await expect(
			writeMemoryEntry(projectPath, 'sub/evil.md', 'x', 'claude-code', tempHome)
		).rejects.toThrow(/Unsafe/);
		await expect(
			writeMemoryEntry(projectPath, 'no-extension', 'x', 'claude-code', tempHome)
		).rejects.toThrow(/must end with \.md/);
	});

	it('refuses to delete MEMORY.md via the viewer', async () => {
		const projectPath = '/Users/me/Projects/Protect';
		await writeMemoryEntry(projectPath, 'MEMORY.md', 'index', 'claude-code', tempHome);
		await expect(
			deleteMemoryEntry(projectPath, 'MEMORY.md', 'claude-code', tempHome)
		).rejects.toThrow(/cannot be deleted/);
	});

	it('reports aggregate stats across all entries', async () => {
		const projectPath = '/Users/me/Projects/Stats';
		await writeMemoryEntry(projectPath, 'a.md', 'a'.repeat(100), 'claude-code', tempHome);
		await writeMemoryEntry(projectPath, 'b.md', 'b'.repeat(250), 'claude-code', tempHome);
		const result = await listMemoryEntries(projectPath, 'claude-code', tempHome);
		expect(result.stats.fileCount).toBe(2);
		expect(result.stats.totalBytes).toBe(350);
		expect(result.stats.firstCreatedAt).toBeTruthy();
		expect(result.stats.lastModifiedAt).toBeTruthy();
	});
});
