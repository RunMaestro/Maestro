import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

const { findAncestorWithDirRemote, getSshRemoteById } = vi.hoisted(() => ({
	findAncestorWithDirRemote: vi.fn(),
	getSshRemoteById: vi.fn(),
}));

vi.mock('../../../main/utils/remote-fs', () => ({ findAncestorWithDirRemote }));
vi.mock('../../../main/stores/getters', () => ({ getSshRemoteById }));

import {
	ancestorDirs,
	invalidateVaultRootCache,
	resolveVaultRoot,
	VAULT_MARKER_DIR,
	__resetVaultRootCacheForTest,
} from '../../../main/dataview/vault-root';

const FIXTURE_VAULT = path.resolve(__dirname, '..', '..', 'fixtures', 'dataview-vault');
const NESTED_NOTE = path.join(FIXTURE_VAULT, 'Projects', 'Alpha', 'Other.md');

const remote = {
	id: 'remote-1',
	name: 'Remote',
	host: 'dev.example.com',
	port: 22,
	username: 'u',
	privateKeyPath: '',
	enabled: true,
};

describe('resolveVaultRoot', () => {
	let tempDir: string;

	beforeEach(() => {
		__resetVaultRootCacheForTest();
		vi.restoreAllMocks();
		findAncestorWithDirRemote.mockReset();
		getSshRemoteById.mockReset();
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dataview-vault-root-'));
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it('finds the fixture vault root from a nested note', async () => {
		const root = await resolveVaultRoot(NESTED_NOTE, { agentCwd: tempDir });
		expect(root).toBe(FIXTURE_VAULT);
	});

	it('finds the root when the note sits directly in the vault folder', async () => {
		const root = await resolveVaultRoot(path.join(FIXTURE_VAULT, 'README.md'), {
			agentCwd: tempDir,
		});
		expect(root).toBe(FIXTURE_VAULT);
	});

	it('falls back to the agent cwd when no ancestor holds .obsidian', async () => {
		const notes = path.join(tempDir, 'notes');
		fs.mkdirSync(notes);
		const agentCwd = path.join(tempDir, 'agent');

		const root = await resolveVaultRoot(path.join(notes, 'a.md'), { agentCwd });
		expect(root).toBe(agentCwd);
	});

	it('ignores a file named .obsidian (only a directory marks a vault)', async () => {
		const notes = path.join(tempDir, 'notes');
		fs.mkdirSync(notes);
		fs.writeFileSync(path.join(notes, VAULT_MARKER_DIR), '');

		const root = await resolveVaultRoot(path.join(notes, 'a.md'), { agentCwd: tempDir });
		expect(root).toBe(tempDir);
	});

	it('stops the walk at the filesystem root', async () => {
		const fsRoot = path.parse(tempDir).root;
		const start = path.join(fsRoot, 'no-such-dataview-dir', 'deeper');
		const statSpy = vi.spyOn(fs.promises, 'stat');

		const root = await resolveVaultRoot(path.join(start, 'note.md'), { agentCwd: tempDir });

		expect(root).toBe(tempDir);
		const checked = statSpy.mock.calls.map(([p]) => p);
		expect(checked).toEqual([
			path.join(start, VAULT_MARKER_DIR),
			path.join(fsRoot, 'no-such-dataview-dir', VAULT_MARKER_DIR),
			path.join(fsRoot, VAULT_MARKER_DIR),
		]);
	});

	it('caches per directory and keeps the cwd fallback per call', async () => {
		const notes = path.join(tempDir, 'notes');
		fs.mkdirSync(notes);
		const statSpy = vi.spyOn(fs.promises, 'stat');

		const first = await resolveVaultRoot(path.join(notes, 'a.md'), { agentCwd: 'cwd-a' });
		const callsAfterFirst = statSpy.mock.calls.length;
		const second = await resolveVaultRoot(path.join(notes, 'b.md'), { agentCwd: 'cwd-b' });

		expect(first).toBe('cwd-a');
		expect(second).toBe('cwd-b');
		expect(statSpy.mock.calls.length).toBe(callsAfterFirst);
	});

	it('reuses cached ancestors for a sibling folder', async () => {
		await resolveVaultRoot(NESTED_NOTE, { agentCwd: tempDir });
		const statSpy = vi.spyOn(fs.promises, 'stat');

		const root = await resolveVaultRoot(path.join(FIXTURE_VAULT, 'People', 'Dana Sample.md'), {
			agentCwd: tempDir,
		});

		expect(root).toBe(FIXTURE_VAULT);
		// People/ itself is new; the vault folder above it is already cached.
		expect(statSpy.mock.calls.map(([p]) => p)).toEqual([
			path.join(FIXTURE_VAULT, 'People', VAULT_MARKER_DIR),
		]);
	});

	it('picks up a new .obsidian folder after the watcher invalidates', async () => {
		const notes = path.join(tempDir, 'vault', 'notes');
		fs.mkdirSync(notes, { recursive: true });
		const file = path.join(notes, 'a.md');

		expect(await resolveVaultRoot(file, { agentCwd: 'cwd' })).toBe('cwd');

		const marker = path.join(tempDir, 'vault', VAULT_MARKER_DIR);
		fs.mkdirSync(marker);
		// Still cached until the watcher reports the new folder.
		expect(await resolveVaultRoot(file, { agentCwd: 'cwd' })).toBe('cwd');

		expect(invalidateVaultRootCache(marker)).toBe(true);
		expect(await resolveVaultRoot(file, { agentCwd: 'cwd' })).toBe(path.join(tempDir, 'vault'));

		fs.rmSync(marker, { recursive: true });
		expect(invalidateVaultRootCache(marker)).toBe(true);
		expect(await resolveVaultRoot(file, { agentCwd: 'cwd' })).toBe('cwd');
	});

	it('ignores watcher events for anything but a .obsidian folder', async () => {
		await resolveVaultRoot(NESTED_NOTE, { agentCwd: tempDir });
		expect(invalidateVaultRootCache(path.join(FIXTURE_VAULT, 'People'))).toBe(false);
		expect(invalidateVaultRootCache(path.join(FIXTURE_VAULT, '.obsidian', 'app.json'))).toBe(false);
	});

	it('leaves cached directories outside the changed folder alone', async () => {
		await resolveVaultRoot(NESTED_NOTE, { agentCwd: tempDir });
		const elsewhere = path.join(tempDir, 'other', VAULT_MARKER_DIR);
		expect(invalidateVaultRootCache(elsewhere)).toBe(false);
	});

	it('shares one walk between concurrent lookups of one folder', async () => {
		const statSpy = vi.spyOn(fs.promises, 'stat');
		const [a, b] = await Promise.all([
			resolveVaultRoot(NESTED_NOTE, { agentCwd: tempDir }),
			resolveVaultRoot(path.join(path.dirname(NESTED_NOTE), 'x.md'), { agentCwd: tempDir }),
		]);
		expect(a).toBe(FIXTURE_VAULT);
		expect(b).toBe(FIXTURE_VAULT);
		// Alpha, Projects, then the vault folder: one walk, three stats.
		expect(statSpy).toHaveBeenCalledTimes(3);
	});

	describe('over SSH', () => {
		it('resolves in one remote command and caches every directory up to the root', async () => {
			getSshRemoteById.mockReturnValue(remote);
			findAncestorWithDirRemote.mockResolvedValue({ success: true, data: '/home/u/vault' });

			const root = await resolveVaultRoot('/home/u/vault/a/b/note.md', {
				agentCwd: '/home/u',
				sshRemoteId: 'remote-1',
			});

			expect(root).toBe('/home/u/vault');
			expect(findAncestorWithDirRemote).toHaveBeenCalledTimes(1);
			expect(findAncestorWithDirRemote).toHaveBeenCalledWith(
				'/home/u/vault/a/b',
				VAULT_MARKER_DIR,
				remote
			);

			// `/home/u/vault/a` was on the chain, so it is answered from the cache.
			const sibling = await resolveVaultRoot('/home/u/vault/a/other.md', {
				agentCwd: '/home/u',
				sshRemoteId: 'remote-1',
			});
			expect(sibling).toBe('/home/u/vault');
			expect(findAncestorWithDirRemote).toHaveBeenCalledTimes(1);
		});

		it('falls back to the agent cwd when the remote finds no vault', async () => {
			getSshRemoteById.mockReturnValue(remote);
			findAncestorWithDirRemote.mockResolvedValue({ success: true, data: null });

			const root = await resolveVaultRoot('/srv/notes/a.md', {
				agentCwd: '/srv',
				sshRemoteId: 'remote-1',
			});
			expect(root).toBe('/srv');
		});

		it('keeps local and remote caches apart', async () => {
			getSshRemoteById.mockReturnValue(remote);
			findAncestorWithDirRemote.mockResolvedValue({ success: true, data: null });
			const remoteNote = path.posix.join('/', 'remote-only', 'note.md');

			await resolveVaultRoot(remoteNote, { agentCwd: '/r', sshRemoteId: 'remote-1' });
			const local = await resolveVaultRoot(NESTED_NOTE, { agentCwd: tempDir });

			expect(local).toBe(FIXTURE_VAULT);
		});

		it('invalidates only the matching remote', async () => {
			getSshRemoteById.mockReturnValue(remote);
			findAncestorWithDirRemote.mockResolvedValue({ success: true, data: null });
			await resolveVaultRoot('/home/u/vault/note.md', {
				agentCwd: '/home/u',
				sshRemoteId: 'remote-1',
			});

			expect(invalidateVaultRootCache('/home/u/vault/.obsidian', 'remote-2')).toBe(false);
			expect(invalidateVaultRootCache('/home/u/vault/.obsidian', 'remote-1')).toBe(true);
		});

		it('throws instead of reading the local disk when the remote is unknown', async () => {
			getSshRemoteById.mockReturnValue(undefined);
			await expect(
				resolveVaultRoot('/home/u/note.md', { agentCwd: '/home/u', sshRemoteId: 'gone' })
			).rejects.toThrow(/could not be resolved/);
			expect(findAncestorWithDirRemote).not.toHaveBeenCalled();
		});

		it('throws when the remote command fails', async () => {
			getSshRemoteById.mockReturnValue(remote);
			findAncestorWithDirRemote.mockResolvedValue({ success: false, error: 'Connection refused' });
			await expect(
				resolveVaultRoot('/home/u/note.md', { agentCwd: '/home/u', sshRemoteId: 'remote-1' })
			).rejects.toThrow('Connection refused');
		});
	});
});

describe('ancestorDirs', () => {
	it('walks Windows-style paths up to the drive root', () => {
		const start = path.win32.join('C:\\', 'Users', 'me', 'vault', 'notes');
		expect(ancestorDirs(start, path.win32)).toEqual([
			path.win32.join('C:\\', 'Users', 'me', 'vault', 'notes'),
			path.win32.join('C:\\', 'Users', 'me', 'vault'),
			path.win32.join('C:\\', 'Users', 'me'),
			path.win32.join('C:\\', 'Users'),
			'C:\\',
		]);
	});

	it('walks POSIX paths up to /', () => {
		const start = path.posix.join('/', 'home', 'u', 'vault');
		expect(ancestorDirs(start, path.posix)).toEqual([
			path.posix.join('/', 'home', 'u', 'vault'),
			path.posix.join('/', 'home', 'u'),
			path.posix.join('/', 'home'),
			'/',
		]);
	});

	it('uses the host path rules by default', () => {
		const start = path.join(path.parse(process.cwd()).root, 'a', 'b');
		const dirs = ancestorDirs(start);
		expect(dirs[0]).toBe(start);
		expect(dirs[dirs.length - 1]).toBe(path.parse(process.cwd()).root);
	});
});
