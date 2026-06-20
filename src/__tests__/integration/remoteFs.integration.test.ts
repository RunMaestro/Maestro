import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SshRemoteConfig } from '../../shared/types';
import type { RemoteFsDeps } from '../../main/utils/remote-fs';
import {
	countItemsRemote,
	deleteRemote,
	directorySizeRemote,
	existsRemote,
	incrementalScanRemote,
	listAllFilesRemote,
	mkdirRemote,
	readDirRemote,
	readFileRemote,
	renameRemote,
	statRemote,
	writeFileRemote,
} from '../../main/utils/remote-fs';

const sshRemote: SshRemoteConfig = {
	id: 'remote-1',
	name: 'Remote One',
	host: 'remote.example.test',
	port: 22,
	username: 'agent',
	privateKeyPath: '~/.ssh/id_ed25519',
	enabled: true,
};

const execSsh = vi.fn();
const buildSshArgs = vi.fn(() => ['agent@remote.example.test']);

const deps: RemoteFsDeps = {
	execSsh,
	buildSshArgs,
};

function commandFrom(args: string[]): string {
	return args[args.length - 1] ?? '';
}

beforeEach(() => {
	execSsh.mockReset();
	buildSshArgs.mockClear();
});

describe('remote-fs integration', () => {
	it('parses remote directory, file, stat, size, existence, and count operations', async () => {
		execSsh.mockImplementation(async (_sshPath: string, args: string[]) => {
			const command = commandFrom(args);

			if (command.startsWith('ls -1AF')) {
				return {
					exitCode: 0,
					stderr: '',
					stdout: [
						'src/',
						'run.sh*',
						'linked@',
						'queue|',
						'socket=',
						'README.md',
						'__LS_ERROR__',
						'__SYMDIR__',
						'linked',
					].join('\n'),
				};
			}

			if (command.startsWith('cat ') && command.includes('README.md')) {
				return { exitCode: 0, stderr: '', stdout: '# Remote Readme\n' };
			}

			if (command.startsWith('stat ')) {
				return { exitCode: 0, stderr: '', stdout: '128\nregular file\n1700000000' };
			}

			if (command.startsWith('du -sb')) {
				return { exitCode: 0, stderr: '', stdout: '4096\t/repo' };
			}

			if (command.startsWith('test -e') && command.includes('exists.txt')) {
				return { exitCode: 0, stderr: '', stdout: 'EXISTS\n' };
			}

			if (command.startsWith('test -e') && command.includes('missing.txt')) {
				return { exitCode: 0, stderr: '', stdout: 'NOT_EXISTS\n' };
			}

			if (command.startsWith('echo "FILES:')) {
				return { exitCode: 0, stderr: '', stdout: 'FILES:3\nDIRS:2\n' };
			}

			throw new Error(`Unexpected command: ${command}`);
		});

		await expect(readDirRemote('/repo', sshRemote, deps)).resolves.toEqual({
			success: true,
			data: [
				{ name: 'src', isDirectory: true, isSymlink: false },
				{ name: 'run.sh', isDirectory: false, isSymlink: false },
				{ name: 'linked', isDirectory: true, isSymlink: true },
				{ name: 'queue', isDirectory: false, isSymlink: false },
				{ name: 'socket', isDirectory: false, isSymlink: false },
				{ name: 'README.md', isDirectory: false, isSymlink: false },
			],
		});
		await expect(readFileRemote('/repo/README.md', sshRemote, deps)).resolves.toEqual({
			success: true,
			data: '# Remote Readme\n',
		});
		await expect(statRemote('/repo/README.md', sshRemote, deps)).resolves.toEqual({
			success: true,
			data: {
				size: 128,
				isDirectory: false,
				mtime: 1_700_000_000_000,
			},
		});
		await expect(directorySizeRemote('/repo', sshRemote, deps)).resolves.toEqual({
			success: true,
			data: 4096,
		});
		await expect(existsRemote('/repo/exists.txt', sshRemote, deps)).resolves.toEqual({
			success: true,
			data: true,
		});
		await expect(existsRemote('/repo/missing.txt', sshRemote, deps)).resolves.toEqual({
			success: true,
			data: false,
		});
		await expect(countItemsRemote('/repo', sshRemote, deps)).resolves.toEqual({
			success: true,
			data: { fileCount: 3, folderCount: 2 },
		});

		expect(execSsh).toHaveBeenCalledWith(
			expect.stringMatching(/ssh(?:\.exe)?$/),
			expect.arrayContaining(['agent@remote.example.test']),
			undefined
		);
	});

	it('maps common remote command failures to user-facing errors', async () => {
		execSsh.mockImplementation(async (_sshPath: string, args: string[]) => {
			const command = commandFrom(args);

			if (command.startsWith('ls -1AF')) {
				return { exitCode: 0, stderr: '', stdout: '__LS_ERROR__\n__SYMDIR__\n' };
			}
			if (command.startsWith('cat ') && command.includes('missing')) {
				return { exitCode: 1, stderr: 'cat: No such file or directory', stdout: '' };
			}
			if (command.startsWith('cat ') && command.includes('directory')) {
				return { exitCode: 1, stderr: 'cat: Is a directory', stdout: '' };
			}
			if (command.startsWith('cat ') && command.includes('private')) {
				return { exitCode: 1, stderr: 'cat: Permission denied', stdout: '' };
			}
			if (command.startsWith('stat ') && command.includes('bad-stat')) {
				return { exitCode: 0, stderr: '', stdout: 'not-a-number\nregular file\nbad-time' };
			}
			if (command.startsWith('stat ') && command.includes('missing')) {
				return { exitCode: 1, stderr: 'stat: No such file or directory', stdout: '' };
			}
			if (command.startsWith('du -sb') && command.includes('malformed-size')) {
				return { exitCode: 0, stderr: '', stdout: 'size unknown' };
			}
			if (command.startsWith('du -sb') && command.includes('private')) {
				return { exitCode: 1, stderr: 'Permission denied', stdout: '' };
			}
			if (command.startsWith('test -e')) {
				return { exitCode: 2, stderr: 'ssh failed', stdout: '' };
			}
			if (command.startsWith('mkdir') && command.includes('exists')) {
				return { exitCode: 1, stderr: 'File exists', stdout: '' };
			}
			if (command.startsWith('mv') && command.includes('missing')) {
				return { exitCode: 1, stderr: 'No such file', stdout: '' };
			}
			if (command.startsWith('rm') && command.includes('private')) {
				return { exitCode: 1, stderr: 'Permission denied', stdout: '' };
			}
			if (command.startsWith('echo "FILES:')) {
				return { exitCode: 1, stderr: 'No such file', stdout: '' };
			}

			throw new Error(`Unexpected command: ${command}`);
		});

		await expect(readDirRemote('/missing-dir', sshRemote, deps)).resolves.toEqual({
			success: false,
			error: 'Directory not found or not accessible: /missing-dir',
		});
		await expect(readFileRemote('/repo/missing.txt', sshRemote, deps)).resolves.toEqual({
			success: false,
			error: 'File not found: /repo/missing.txt',
		});
		await expect(readFileRemote('/repo/directory', sshRemote, deps)).resolves.toEqual({
			success: false,
			error: 'Path is a directory: /repo/directory',
		});
		await expect(readFileRemote('/repo/private.txt', sshRemote, deps)).resolves.toEqual({
			success: false,
			error: 'Permission denied: /repo/private.txt',
		});
		await expect(statRemote('/repo/bad-stat', sshRemote, deps)).resolves.toEqual({
			success: false,
			error: 'Failed to parse stat output for: /repo/bad-stat',
		});
		await expect(statRemote('/repo/missing', sshRemote, deps)).resolves.toEqual({
			success: false,
			error: 'Path not found: /repo/missing',
		});
		await expect(directorySizeRemote('/repo/malformed-size', sshRemote, deps)).resolves.toEqual({
			success: false,
			error: 'Failed to parse du output for: /repo/malformed-size',
		});
		await expect(directorySizeRemote('/repo/private', sshRemote, deps)).resolves.toEqual({
			success: false,
			error: 'Permission denied: /repo/private',
		});
		await expect(existsRemote('/repo/unknown', sshRemote, deps)).resolves.toEqual({
			success: false,
			error: 'ssh failed',
		});
		await expect(mkdirRemote('/repo/exists', sshRemote, false, deps)).resolves.toEqual({
			success: false,
			error: 'Directory already exists: /repo/exists',
		});
		await expect(renameRemote('/repo/missing', '/repo/new', sshRemote, deps)).resolves.toEqual({
			success: false,
			error: 'Path not found: /repo/missing',
		});
		await expect(deleteRemote('/repo/private', sshRemote, false, deps)).resolves.toEqual({
			success: false,
			error: 'Permission denied: /repo/private',
		});
		await expect(countItemsRemote('/repo/missing', sshRemote, deps)).resolves.toEqual({
			success: false,
			error: 'Directory not found: /repo/missing',
		});
	});

	it('writes, creates, renames, deletes, scans, and retries transient SSH failures', async () => {
		let flakyReadAttempts = 0;
		execSsh.mockImplementation(async (_sshPath: string, args: string[]) => {
			const command = commandFrom(args);

			if (command.startsWith('cat ') && command.includes('flaky.txt')) {
				flakyReadAttempts += 1;
				if (flakyReadAttempts === 1) {
					return { exitCode: 255, stderr: 'connection reset by peer', stdout: '' };
				}
				return { exitCode: 0, stderr: '', stdout: 'Recovered\n' };
			}
			if (command.includes('base64 -d >')) {
				return { exitCode: 0, stderr: '', stdout: '' };
			}
			if (command.startsWith('mkdir')) {
				return { exitCode: 0, stderr: '', stdout: '' };
			}
			if (command.startsWith('mv')) {
				return { exitCode: 0, stderr: '', stdout: '' };
			}
			if (command.startsWith('rm')) {
				return { exitCode: 0, stderr: '', stdout: '' };
			}
			if (command.startsWith('find') && command.includes('-newermt')) {
				return {
					exitCode: 0,
					stderr: '',
					stdout: ['/repo/src/a.ts', '/repo/src/b.ts', '/outside/c.ts'].join('\n'),
				};
			}
			if (command.startsWith('find') && command.includes('-maxdepth 3')) {
				return {
					exitCode: 0,
					stderr: '',
					stdout: ['/repo/src/a.ts', '/repo/src/b.ts', '/outside/c.ts'].join('\n'),
				};
			}

			throw new Error(`Unexpected command: ${command}`);
		});

		await expect(readFileRemote('/repo/flaky.txt', sshRemote, deps)).resolves.toEqual({
			success: true,
			data: 'Recovered\n',
		});
		expect(flakyReadAttempts).toBe(2);

		await expect(
			writeFileRemote('/repo/output.txt', 'Hello remote', sshRemote, deps)
		).resolves.toEqual({
			success: true,
		});
		await expect(
			writeFileRemote('/repo/binary.bin', Buffer.from([1, 2, 3]), sshRemote, deps)
		).resolves.toEqual({
			success: true,
		});
		await expect(mkdirRemote('/repo/new-dir', sshRemote, true, deps)).resolves.toEqual({
			success: true,
		});
		await expect(renameRemote('/repo/old', '/repo/new', sshRemote, deps)).resolves.toEqual({
			success: true,
		});
		await expect(deleteRemote('/repo/old', sshRemote, true, deps)).resolves.toEqual({
			success: true,
		});

		const incremental = await incrementalScanRemote('/repo', sshRemote, 1_700_000_000, deps);
		expect(incremental.success).toBe(true);
		expect(incremental.data).toMatchObject({
			added: ['src/a.ts', 'src/b.ts', '/outside/c.ts'],
			deleted: [],
			hasChanges: true,
		});
		expect(incremental.data?.scanTime).toEqual(expect.any(Number));

		await expect(listAllFilesRemote('/repo', sshRemote, 3, deps)).resolves.toEqual({
			success: true,
			data: ['src/a.ts', 'src/b.ts', '/outside/c.ts'],
		});

		const writeCall = execSsh.mock.calls.find(([, args]) =>
			commandFrom(args as string[]).includes('/repo/output.txt')
		);
		expect(writeCall?.[2]).toBe(Buffer.from('Hello remote', 'utf-8').toString('base64'));
	});

	it('handles malformed outputs and scan command failures', async () => {
		execSsh.mockImplementation(async (_sshPath: string, args: string[]) => {
			const command = commandFrom(args);

			if (command.startsWith('ls -1AF') && command.includes('ssh-failed')) {
				return { exitCode: 255, stderr: 'ssh permission denied', stdout: '' };
			}
			if (command.startsWith('ls -1AF') && command.includes('odd-listing')) {
				return {
					exitCode: 0,
					stderr: '',
					stdout: ['*', 'visible.txt', '__SYMDIR__'].join('\n'),
				};
			}
			if (command.startsWith('stat ') && command.includes('short-stat')) {
				return { exitCode: 0, stderr: '', stdout: '1\nregular file' };
			}
			if (command.includes('base64 -d >') && command.includes('private')) {
				return { exitCode: 1, stderr: 'Permission denied', stdout: '' };
			}
			if (command.includes('base64 -d >') && command.includes('missing-parent')) {
				return { exitCode: 1, stderr: 'No such file or directory', stdout: '' };
			}
			if (command.startsWith('find') && command.includes('-newermt')) {
				return { exitCode: 2, stderr: 'find failed', stdout: '' };
			}
			if (command.startsWith('find') && command.includes('-maxdepth')) {
				return { exitCode: 2, stderr: 'list failed', stdout: '' };
			}

			throw new Error(`Unexpected command: ${command}`);
		});

		await expect(readDirRemote('/repo/ssh-failed', sshRemote, deps)).resolves.toEqual({
			success: false,
			error: 'ssh permission denied',
		});
		await expect(readDirRemote('/repo/odd-listing', sshRemote, deps)).resolves.toEqual({
			success: true,
			data: [{ name: 'visible.txt', isDirectory: false, isSymlink: false }],
		});
		await expect(statRemote('/repo/short-stat', sshRemote, deps)).resolves.toEqual({
			success: false,
			error: 'Invalid stat output for: /repo/short-stat',
		});
		await expect(writeFileRemote('/repo/private.txt', 'secret', sshRemote, deps)).resolves.toEqual({
			success: false,
			error: 'Permission denied: /repo/private.txt',
		});
		await expect(
			writeFileRemote('/repo/missing-parent/file.txt', 'content', sshRemote, deps)
		).resolves.toEqual({
			success: false,
			error: 'Parent directory not found: /repo/missing-parent/file.txt',
		});
		await expect(incrementalScanRemote('/repo', sshRemote, 1_700_000_000, deps)).resolves.toEqual({
			success: false,
			error: 'find failed',
		});
		await expect(listAllFilesRemote('/repo', sshRemote, 4, deps)).resolves.toEqual({
			success: false,
			error: 'list failed',
		});
	});
});
