import { describe, it, expect, vi, beforeEach } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	readDirRemote,
	readDirNamesRemote,
	readFileRemote,
	readFileInRootRemote,
	readBinaryFileRemoteAsBase64,
	readBinaryFileBlockRemoteAsBase64,
	readFileTailRemote,
	statRemote,
	lstatRemote,
	realpathRemote,
	readlinkRemote,
	symlinkRemote,
	findAncestorWithDirRemote,
	listFilesWithStatsRemote,
	directorySizeRemote,
	writeFileRemote,
	writeFileAtomicRemote,
	createExclusiveRemote,
	existsRemote,
	mkdirRemote,
	compressFolderRemote,
	listDirWithStatsRemote,
	bulkStatFileInSubdirsRemote,
	listTreeRemote,
	deleteManyRemote,
	__resetHostLimitersForTest,
	type RemoteFsDeps,
} from '../../../main/utils/remote-fs';
import type { SshRemoteConfig } from '../../../shared/types';
import type { ExecResult } from '../../../main/utils/execFile';
import { shellEscapeRemotePath } from '../../../main/utils/shell-escape';

describe('remote-fs', () => {
	// Base SSH config for testing
	const baseConfig: SshRemoteConfig = {
		id: 'test-remote-1',
		name: 'Test Remote',
		host: 'dev.example.com',
		port: 22,
		username: 'testuser',
		privateKeyPath: '~/.ssh/id_ed25519',
		enabled: true,
	};

	// Create mock dependencies
	function createMockDeps(execResult: ExecResult): RemoteFsDeps {
		return {
			execSsh: vi.fn().mockResolvedValue(execResult),
			buildSshArgs: vi
				.fn()
				.mockReturnValue([
					'-i',
					'/home/user/.ssh/id_ed25519',
					'-o',
					'BatchMode=yes',
					'-p',
					'22',
					'testuser@dev.example.com',
				]),
		};
	}

	describe('readDirNamesRemote', () => {
		it('preserves hidden names, newlines, whitespace and quotes without following links', async () => {
			const deps = createMockDeps({
				stdout: "./.hidden\0./a\nb\0./ with space \0./quote'\0",
				stderr: '',
				exitCode: 0,
			});
			const file = "/remote/a user's folder";
			expect(await readDirNamesRemote(file, baseConfig, {}, deps)).toEqual({
				success: true,
				data: ['.hidden', 'a\nb', ' with space ', "quote'"],
			});
			const command = vi.mocked(deps.execSsh).mock.calls[0][1].at(-1)!;
			expect(command).toContain(shellEscapeRemotePath(file));
			expect(command).toContain('find . -mindepth 1 -maxdepth 1');
			expect(command).not.toContain('find -L');
			await readDirNamesRemote(file, baseConfig, { recursive: true }, deps);
			expect(vi.mocked(deps.execSsh).mock.calls[1][1].at(-1)).not.toContain('-maxdepth');
		});
		it('rejects truncated listings and propagates permissions instead of returning no files', async () => {
			const deps = createMockDeps({ stdout: './partial', stderr: '', exitCode: 0 });
			expect((await readDirNamesRemote('/remote', baseConfig, {}, deps)).success).toBe(false);
			vi.mocked(deps.execSsh).mockResolvedValue({
				stdout: '',
				stderr: 'Permission denied',
				exitCode: 1,
			});
			expect(await readDirNamesRemote('/remote', baseConfig, {}, deps)).toMatchObject({
				success: false,
				error: 'Permission denied',
			});
		});
	});

	describe('readDirRemote', () => {
		it('parses ls output correctly for regular files and directories', async () => {
			const deps = createMockDeps({
				stdout: 'file1.txt\nfile2.js\nsrc/\nnode_modules/\n',
				stderr: '',
				exitCode: 0,
			});

			const result = await readDirRemote('/home/user/project', baseConfig, deps);

			expect(result.success).toBe(true);
			expect(result.data).toEqual([
				{ name: 'file1.txt', isDirectory: false, isSymlink: false },
				{ name: 'file2.js', isDirectory: false, isSymlink: false },
				{ name: 'src', isDirectory: true, isSymlink: false },
				{ name: 'node_modules', isDirectory: true, isSymlink: false },
			]);
		});

		it('identifies symbolic links from ls -F output', async () => {
			const deps = createMockDeps({
				stdout: 'link-to-dir@\nlink-to-file@\nregular.txt\n',
				stderr: '',
				exitCode: 0,
			});

			const result = await readDirRemote('/home/user', baseConfig, deps);

			expect(result.success).toBe(true);
			expect(result.data).toEqual([
				{ name: 'link-to-dir', isDirectory: false, isSymlink: true },
				{ name: 'link-to-file', isDirectory: false, isSymlink: true },
				{ name: 'regular.txt', isDirectory: false, isSymlink: false },
			]);
		});

		it('handles hidden files (from -A flag)', async () => {
			const deps = createMockDeps({
				stdout: '.gitignore\n.env\npackage.json\nsrc/\n',
				stderr: '',
				exitCode: 0,
			});

			const result = await readDirRemote('/project', baseConfig, deps);

			expect(result.success).toBe(true);
			expect(result.data?.map((e) => e.name)).toContain('.gitignore');
			expect(result.data?.map((e) => e.name)).toContain('.env');
		});

		it('strips executable indicator (*) from files', async () => {
			const deps = createMockDeps({
				stdout: 'run.sh*\nscript.py*\ndata.txt\n',
				stderr: '',
				exitCode: 0,
			});

			const result = await readDirRemote('/scripts', baseConfig, deps);

			expect(result.success).toBe(true);
			expect(result.data).toEqual([
				{ name: 'run.sh', isDirectory: false, isSymlink: false },
				{ name: 'script.py', isDirectory: false, isSymlink: false },
				{ name: 'data.txt', isDirectory: false, isSymlink: false },
			]);
		});

		it('returns error when directory does not exist', async () => {
			const deps = createMockDeps({
				stdout: '__LS_ERROR__\n',
				stderr: '',
				exitCode: 0,
			});

			const result = await readDirRemote('/nonexistent', baseConfig, deps);

			expect(result.success).toBe(false);
			expect(result.error).toContain('not found or not accessible');
		});

		it('returns error on SSH failure', async () => {
			const deps = createMockDeps({
				stdout: '',
				stderr: 'Permission denied',
				exitCode: 1,
			});

			const result = await readDirRemote('/protected', baseConfig, deps);

			expect(result.success).toBe(false);
			expect(result.error).toContain('Permission denied');
		});

		it('handles empty directory', async () => {
			const deps = createMockDeps({
				stdout: '',
				stderr: '',
				exitCode: 0,
			});

			const result = await readDirRemote('/empty-dir', baseConfig, deps);

			expect(result.success).toBe(true);
			expect(result.data).toEqual([]);
		});

		it('builds correct SSH command with escaped path', async () => {
			const deps = createMockDeps({
				stdout: 'file.txt\n',
				stderr: '',
				exitCode: 0,
			});

			await readDirRemote("/path/with spaces/and'quotes", baseConfig, deps);

			// Accept full SSH binary path (e.g., /usr/bin/ssh or C:\Windows\System32\OpenSSH\ssh.exe) for cross-platform compatibility.
			// readDir streams no stdin payload, so the optional `input` arg is undefined.
			expect(deps.execSsh).toHaveBeenCalledWith(
				expect.stringMatching(/ssh(\.exe)?$/),
				expect.any(Array),
				undefined
			);
			const call = (deps.execSsh as any).mock.calls[0][1];
			const remoteCommand = call[call.length - 1];
			// Path should be properly escaped in the command
			expect(remoteCommand).toContain("'/path/with spaces/and'\\''quotes'");
		});

		it('uses find rather than shell globs so zsh NOMATCH cannot fail the command', async () => {
			// Regression: an earlier implementation scanned for symlinks with
			// `for f in <path>/* <path>/.[!.]* <path>/..?*; do ...; done`, which
			// aborts with exit 1 under zsh (the default shell on macOS) whenever
			// any pattern has no match - common for directories without dotfiles.
			// Using `find -type l` avoids shell glob expansion entirely.
			const deps = createMockDeps({ stdout: 'file.txt\n', stderr: '', exitCode: 0 });

			await readDirRemote('/some/dir', baseConfig, deps);

			const call = (deps.execSsh as any).mock.calls[0][1];
			const remoteCommand = call[call.length - 1];
			expect(remoteCommand).toMatch(/find .* -type l/);
			expect(remoteCommand).not.toMatch(/\.\[!\.\]\*/);
			expect(remoteCommand).not.toMatch(/\.\.\?\*/);
		});

		it('uses find -exec for the symlink scan so a pipeline does not leak [ -d ] exit status', async () => {
			// Regression: a `find … | while read f; do [ -d "$f" ] && basename "$f"; done`
			// pipeline exits with the status of its last body command, so any directory
			// containing a symlink whose target was NOT a directory (common - e.g. a
			// file-symlink in a project root) made the whole SSH command exit 1 and
			// `readDirRemote` report failure even though `ls` succeeded. Seen in the
			// field on a remote checkout with a single file-symlink.
			const deps = createMockDeps({ stdout: 'file.txt\n', stderr: '', exitCode: 0 });

			await readDirRemote('/some/dir', baseConfig, deps);

			const call = (deps.execSsh as any).mock.calls[0][1];
			const remoteCommand = call[call.length - 1];
			expect(remoteCommand).toMatch(/-exec test -d \{\} \\;/);
			expect(remoteCommand).toMatch(/-exec basename \{\} \\;/);
			expect(remoteCommand).not.toMatch(/while IFS= read/);
		});

		it('expands remote home-relative paths before executing over SSH', async () => {
			const deps = createMockDeps({
				stdout: 'file.txt\n',
				stderr: '',
				exitCode: 0,
			});

			await readDirRemote('~/.copilot/session-state', baseConfig, deps);

			const call = (deps.execSsh as any).mock.calls[0][1];
			const remoteCommand = call[call.length - 1];
			expect(remoteCommand).toContain('"$HOME/.copilot/session-state"');
		});
	});

	describe('listTreeRemote', () => {
		// Two find invocations are bundled into one SSH command; output is
		// `dirs\n__MAESTRO_FIND_SEP__\nfiles`.
		const SEP = '__MAESTRO_FIND_SEP__';

		it('parses combined dir/file find output and strips ./ prefixes', async () => {
			const stdout = `./src\n./src/components\n./docs\n${SEP}\n./README.md\n./src/index.ts\n./src/components/Button.tsx\n`;
			const deps = createMockDeps({ stdout, stderr: '', exitCode: 0 });

			const result = await listTreeRemote('/project', { maxDepth: 5 }, baseConfig, deps);

			expect(result.success).toBe(true);
			expect(result.data?.directories).toEqual(['src', 'src/components', 'docs']);
			expect(result.data?.files).toEqual([
				'README.md',
				'src/index.ts',
				'src/components/Button.tsx',
			]);
			expect(result.data?.truncated).toBe(false);
		});

		it('returns the files of a root with no subdirectories (separator on the first line)', async () => {
			// An empty dir section means stdout starts with the separator itself.
			const stdout = `${SEP}\n./Phase-01-Initial-Setup.md\n./Phase-02-Build.md\n`;
			const deps = createMockDeps({ stdout, stderr: '', exitCode: 0 });

			const result = await listTreeRemote('/playbooks/run', { maxDepth: 5 }, baseConfig, deps);

			expect(result.success).toBe(true);
			expect(result.data?.directories).toEqual([]);
			expect(result.data?.files).toEqual(['Phase-01-Initial-Setup.md', 'Phase-02-Build.md']);
		});

		it('detects truncation when file count exceeds maxFiles', async () => {
			// head returned cap+1 entries - the helper should slice off the marker
			// entry and flag truncated=true.
			const files = ['a', 'b', 'c', 'd'].map((n) => `./${n}.txt`).join('\n');
			const stdout = `./src\n${SEP}\n${files}\n`;
			const deps = createMockDeps({ stdout, stderr: '', exitCode: 0 });

			const result = await listTreeRemote(
				'/project',
				{ maxDepth: 5, maxFiles: 3 },
				baseConfig,
				deps
			);

			expect(result.success).toBe(true);
			expect(result.data?.truncated).toBe(true);
			expect(result.data?.files).toEqual(['a.txt', 'b.txt', 'c.txt']);
		});

		it('reports CD failure as a missing directory error', async () => {
			const deps = createMockDeps({ stdout: '__CD_ERROR__\n', stderr: '', exitCode: 0 });

			const result = await listTreeRemote('/missing', { maxDepth: 5 }, baseConfig, deps);

			expect(result.success).toBe(false);
			expect(result.error).toContain('not found or not accessible');
		});

		it('builds a single SSH command containing both find invocations and a head cap', async () => {
			const deps = createMockDeps({ stdout: `${SEP}\n`, stderr: '', exitCode: 0 });

			await listTreeRemote(
				'/project',
				{
					maxDepth: 4,
					ignorePatterns: ['node_modules', '.git'],
					excludePaths: ['.maestro'],
					maxFiles: 1000,
				},
				baseConfig,
				deps
			);

			const call = (deps.execSsh as any).mock.calls[0][1];
			const remoteCommand = call[call.length - 1] as string;
			// Two find calls split by the marker echo.
			expect(remoteCommand).toContain('-type d -print');
			expect(remoteCommand).toContain('-type f -print');
			expect(remoteCommand).toContain(`echo "${SEP}"`);
			// Depth is plumbed through.
			expect(remoteCommand).toMatch(/-maxdepth 4/);
			// Ignore patterns turn into -name prunes.
			expect(remoteCommand).toContain("-name 'node_modules'");
			expect(remoteCommand).toContain("-name '.git'");
			// excludePaths turn into -path prunes (relative to the cd'd root).
			expect(remoteCommand).toContain("-path './.maestro'");
			// File cap goes to head with cap+1 to detect overflow.
			expect(remoteCommand).toContain('| head -n 1001');
			// Symlinks followed so symlinks-to-dirs appear as their target.
			expect(remoteCommand).toContain('find -L');
		});

		it('skips ignore patterns containing slashes (find -name matches base names only)', async () => {
			const deps = createMockDeps({ stdout: `${SEP}\n`, stderr: '', exitCode: 0 });

			await listTreeRemote(
				'/project',
				{
					maxDepth: 5,
					ignorePatterns: ['node_modules', 'dist/cache', 'build/**'],
				},
				baseConfig,
				deps
			);

			const call = (deps.execSsh as any).mock.calls[0][1];
			const remoteCommand = call[call.length - 1] as string;
			expect(remoteCommand).toContain("-name 'node_modules'");
			// Path-bearing patterns are dropped - they cannot work with -name.
			expect(remoteCommand).not.toContain('dist/cache');
			expect(remoteCommand).not.toContain('build/**');
		});
	});

	describe('readFileRemote', () => {
		it('returns file contents successfully', async () => {
			const deps = createMockDeps({
				stdout: '# README\n\nThis is my project.\n',
				stderr: '',
				exitCode: 0,
			});

			const result = await readFileRemote('/project/README.md', baseConfig, deps);

			expect(result.success).toBe(true);
			expect(result.data).toBe('# README\n\nThis is my project.\n');
		});

		it('handles file not found error', async () => {
			const deps = createMockDeps({
				stdout: '',
				stderr: 'cat: /missing.txt: No such file or directory',
				exitCode: 1,
			});

			const result = await readFileRemote('/missing.txt', baseConfig, deps);

			expect(result.success).toBe(false);
			expect(result.error).toContain('File not found');
		});

		it('handles permission denied error', async () => {
			const deps = createMockDeps({
				stdout: '',
				stderr: 'cat: /etc/shadow: Permission denied',
				exitCode: 1,
			});

			const result = await readFileRemote('/etc/shadow', baseConfig, deps);

			expect(result.success).toBe(false);
			expect(result.error).toContain('Permission denied');
		});

		it('handles reading directory error', async () => {
			const deps = createMockDeps({
				stdout: '',
				stderr: 'cat: /etc/: Is a directory',
				exitCode: 1,
			});

			const result = await readFileRemote('/etc/', baseConfig, deps);

			expect(result.success).toBe(false);
			expect(result.error).toContain('is a directory');
		});

		it('handles empty file', async () => {
			const deps = createMockDeps({
				stdout: '',
				stderr: '',
				exitCode: 0,
			});

			const result = await readFileRemote('/empty.txt', baseConfig, deps);

			expect(result.success).toBe(true);
			expect(result.data).toBe('');
		});

		it('preserves binary-safe content (within UTF-8)', async () => {
			const deps = createMockDeps({
				stdout: 'Line 1\nLine 2\r\nLine 3\tTabbed',
				stderr: '',
				exitCode: 0,
			});

			const result = await readFileRemote('/file.txt', baseConfig, deps);

			expect(result.success).toBe(true);
			expect(result.data).toBe('Line 1\nLine 2\r\nLine 3\tTabbed');
		});
	});

	describe('readBinaryFileRemoteAsBase64', () => {
		it('runs base64 on the remote and returns a whitespace-free payload', async () => {
			// GNU base64 wraps at 76 cols; the result must be stripped to one line.
			const deps = createMockDeps({
				stdout: 'iVBORw0KGgoAAAANSUhEUg\nAAAAEAAAABCAQAAAC1\nHAwCAAAAC0lEQVR42mNk\n',
				stderr: '',
				exitCode: 0,
			});

			const result = await readBinaryFileRemoteAsBase64('/project/logo.png', baseConfig, deps);

			expect(result.success).toBe(true);
			expect(result.data).toBe('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk');
			// Must invoke `base64`, not `cat` (which would mangle binary bytes). The
			// remote command is the last element of the ssh args array. The file must
			// be fed via stdin redirect (`base64 < file`), not a positional path -
			// BSD/macOS `base64` rejects a positional argument.
			const sshArgs = (deps.execSsh as any).mock.calls[0][1] as string[];
			expect(sshArgs[sshArgs.length - 1]).toContain('base64 < ');
		});

		it('maps a missing remote image to a file-not-found error', async () => {
			const deps = createMockDeps({
				stdout: '',
				stderr: 'base64: /missing.png: No such file or directory',
				exitCode: 1,
			});

			const result = await readBinaryFileRemoteAsBase64('/missing.png', baseConfig, deps);

			expect(result.success).toBe(false);
			expect(result.error).toContain('File not found');
		});
	});

	describe('readBinaryFileBlockRemoteAsBase64', () => {
		it('seeks with dd by block index rather than reading and discarding', async () => {
			const deps = createMockDeps({ stdout: 'YWJj\n', stderr: '', exitCode: 0 });

			const result = await readBinaryFileBlockRemoteAsBase64(
				'/data/events.parquet',
				baseConfig,
				7,
				4194304,
				deps
			);

			expect(result.success).toBe(true);
			expect(result.data).toBe('YWJj');

			const sshArgs = (deps.execSsh as any).mock.calls[0][1] as string[];
			const remoteCommand = sshArgs[sshArgs.length - 1];
			// `bs`/`skip` is what makes this a seek: dd jumps to block*size
			// instead of streaming past the earlier bytes. `count=1` keeps the
			// read to exactly one block.
			expect(remoteCommand).toContain('bs=4194304');
			expect(remoteCommand).toContain('skip=7');
			expect(remoteCommand).toContain('count=1');
			expect(remoteCommand).toContain('| base64');
			// dd writes its summary to stderr; without this it looks like failure.
			expect(remoteCommand).toContain('2>/dev/null');
		});

		it('strips the line wrapping GNU base64 adds', async () => {
			const deps = createMockDeps({ stdout: 'aVBO\nRw0K\nGgoA\n', stderr: '', exitCode: 0 });

			const result = await readBinaryFileBlockRemoteAsBase64(
				'/f.parquet',
				baseConfig,
				0,
				1024,
				deps
			);

			expect(result.data).toBe('aVBORw0KGgoA');
		});

		it('returns empty data past EOF instead of erroring', async () => {
			// dd past the end exits 0 with nothing on stdout. The caller uses
			// that to detect a file that shrank mid-transfer.
			const deps = createMockDeps({ stdout: '', stderr: '', exitCode: 0 });

			const result = await readBinaryFileBlockRemoteAsBase64(
				'/f.parquet',
				baseConfig,
				99,
				1024,
				deps
			);

			expect(result.success).toBe(true);
			expect(result.data).toBe('');
		});

		it('maps a missing file to a file-not-found error', async () => {
			const deps = createMockDeps({
				stdout: '',
				stderr: 'dd: /missing.parquet: No such file or directory',
				exitCode: 1,
			});

			const result = await readBinaryFileBlockRemoteAsBase64(
				'/missing.parquet',
				baseConfig,
				0,
				1024,
				deps
			);

			expect(result.success).toBe(false);
			expect(result.error).toContain('File not found');
		});

		it('rejects a nonsensical block index or size without touching the network', async () => {
			const deps = createMockDeps({ stdout: '', stderr: '', exitCode: 0 });

			expect(
				(await readBinaryFileBlockRemoteAsBase64('/f', baseConfig, -1, 1024, deps)).success
			).toBe(false);
			expect((await readBinaryFileBlockRemoteAsBase64('/f', baseConfig, 0, 0, deps)).success).toBe(
				false
			);
			expect(
				(await readBinaryFileBlockRemoteAsBase64('/f', baseConfig, 1.5, 1024, deps)).success
			).toBe(false);
			expect(deps.execSsh).not.toHaveBeenCalled();
		});
	});

	describe('readFileTailRemote', () => {
		it('reads the whole file from offset 0 (tail -c +1)', async () => {
			const deps = createMockDeps({ stdout: 'a\nb\nc\n', stderr: '', exitCode: 0 });

			const result = await readFileTailRemote('/log/events.jsonl', baseConfig, 0, deps);

			expect(result.success).toBe(true);
			expect(result.data).toBe('a\nb\nc\n');
			const cmd = (deps.execSsh as any).mock.calls[0][1].at(-1);
			// tail -c +N is 1-indexed, so skipping 0 bytes starts at byte 1.
			expect(cmd).toMatch(/tail -c \+1 /);
		});

		it('starts at offset+1 so already-consumed bytes are skipped', async () => {
			const deps = createMockDeps({ stdout: 'new tail\n', stderr: '', exitCode: 0 });

			const result = await readFileTailRemote('/log/events.jsonl', baseConfig, 42, deps);

			expect(result.success).toBe(true);
			expect(result.data).toBe('new tail\n');
			const cmd = (deps.execSsh as any).mock.calls[0][1].at(-1);
			expect(cmd).toMatch(/tail -c \+43 /);
		});

		it('floors and clamps a fractional or negative offset', async () => {
			const deps = createMockDeps({ stdout: '', stderr: '', exitCode: 0 });

			await readFileTailRemote('/log/events.jsonl', baseConfig, 10.9, deps);
			expect((deps.execSsh as any).mock.calls[0][1].at(-1)).toMatch(/tail -c \+11 /);

			const deps2 = createMockDeps({ stdout: '', stderr: '', exitCode: 0 });
			await readFileTailRemote('/log/events.jsonl', baseConfig, -5, deps2);
			expect((deps2.execSsh as any).mock.calls[0][1].at(-1)).toMatch(/tail -c \+1 /);
		});

		it('shell-escapes the remote path', async () => {
			const deps = createMockDeps({ stdout: '', stderr: '', exitCode: 0 });

			await readFileTailRemote("/log/with spaces/events'.jsonl", baseConfig, 0, deps);

			const cmd = (deps.execSsh as any).mock.calls[0][1].at(-1);
			expect(cmd).toContain("'/log/with spaces/events'\\''.jsonl'");
		});

		it('maps a missing file to a "File not found" error', async () => {
			const deps = createMockDeps({
				stdout: '',
				stderr: 'tail: cannot open /gone.jsonl: No such file or directory',
				exitCode: 1,
			});

			const result = await readFileTailRemote('/gone.jsonl', baseConfig, 0, deps);

			expect(result.success).toBe(false);
			expect(result.error).toContain('File not found');
		});

		it('returns an empty string when nothing new is past the offset', async () => {
			const deps = createMockDeps({ stdout: '', stderr: '', exitCode: 0 });

			const result = await readFileTailRemote('/log/events.jsonl', baseConfig, 100, deps);

			expect(result.success).toBe(true);
			expect(result.data).toBe('');
		});
	});

	describe('statRemote', () => {
		it('parses GNU stat output for regular file', async () => {
			const deps = createMockDeps({
				stdout: '1234\nregular file\n1703836800\n',
				stderr: '',
				exitCode: 0,
			});

			const result = await statRemote('/project/package.json', baseConfig, deps);

			expect(result.success).toBe(true);
			expect(result.data).toEqual({
				size: 1234,
				isDirectory: false,
				mtime: 1703836800000, // Converted to milliseconds
			});
		});

		it('parses GNU stat output for directory', async () => {
			const deps = createMockDeps({
				stdout: '4096\ndirectory\n1703836800\n',
				stderr: '',
				exitCode: 0,
			});

			const result = await statRemote('/project/src', baseConfig, deps);

			expect(result.success).toBe(true);
			expect(result.data?.isDirectory).toBe(true);
		});

		it('parses BSD stat output format', async () => {
			// BSD stat -f '%z\n%HT\n%m' format
			const deps = createMockDeps({
				stdout: '5678\nRegular File\n1703836800\n',
				stderr: '',
				exitCode: 0,
			});

			const result = await statRemote('/project/file.txt', baseConfig, deps);

			expect(result.success).toBe(true);
			expect(result.data).toEqual({
				size: 5678,
				isDirectory: false,
				mtime: 1703836800000,
			});
		});

		it('handles file not found', async () => {
			const deps = createMockDeps({
				stdout: '',
				stderr: "stat: cannot stat '/missing': No such file or directory",
				exitCode: 1,
			});

			const result = await statRemote('/missing', baseConfig, deps);

			expect(result.success).toBe(false);
			expect(result.error).toContain('not found');
		});

		it('handles permission denied', async () => {
			const deps = createMockDeps({
				stdout: '',
				stderr: "stat: cannot stat '/protected': Permission denied",
				exitCode: 1,
			});

			const result = await statRemote('/protected', baseConfig, deps);

			expect(result.success).toBe(false);
			expect(result.error).toContain('Permission denied');
		});

		it('handles invalid output format', async () => {
			const deps = createMockDeps({
				stdout: 'invalid\n',
				stderr: '',
				exitCode: 0,
			});

			const result = await statRemote('/file', baseConfig, deps);

			expect(result.success).toBe(false);
			expect(result.error).toContain('Invalid stat output');
		});

		it('handles non-numeric values in output', async () => {
			const deps = createMockDeps({
				stdout: 'notanumber\nregular file\nalsonotanumber\n',
				stderr: '',
				exitCode: 0,
			});

			const result = await statRemote('/file', baseConfig, deps);

			expect(result.success).toBe(false);
			expect(result.error).toContain('Failed to parse stat output');
		});
	});

	describe('lstatRemote', () => {
		it.each([
			['GNU file', 'G|42|81ed|1703836800\n', 'file', 0o100755, false],
			['BSD file', 'B|42|100644|1703836800\n', 'file', 0o100644, false],
			['GNU directory', 'G|42|41c0|1703836800\n', 'directory', 0o40700, true],
			['BSD directory', 'B|42|40755|1703836800\n', 'directory', 0o40755, true],
			['GNU symlink', 'G|42|a1ff|1703836800\n', 'symlink', 0o120777, false],
			['BSD symlink', 'B|42|120755|1703836800\n', 'symlink', 0o120755, false],
			['GNU FIFO', 'G|42|1180|1703836800\n', 'other', 0o10600, false],
		])('parses %s without following links', async (_label, stdout, type, mode, isDirectory) => {
			const deps = createMockDeps({ stdout: String(stdout), stderr: '', exitCode: 0 });
			const filePath = "/home/a user's folder/link";
			expect(await lstatRemote(filePath, baseConfig, deps)).toEqual({
				success: true,
				data: { size: 42, type, mode, isDirectory, mtime: 1703836800000 },
			});
			const command = vi.mocked(deps.execSsh).mock.calls[0][1].at(-1)!;
			expect(command).toContain(shellEscapeRemotePath(filePath));
			expect(command).toContain('G|%s|%f|%Y');
			expect(command).toContain('B|%z|%p|%m');
			expect(command).not.toContain('stat -L');
			expect(command).not.toContain("$'");
		});

		it.each(['', 'G|12|81ed', 'G|oops|81ed|1', 'B|12|100888|1', 'G|1|fffff|1', 'G|1|81ed|no'])(
			'rejects malformed metadata %j',
			async (stdout) => {
				const deps = createMockDeps({ stdout, stderr: '', exitCode: 0 });
				expect(await lstatRemote('/file', baseConfig, deps)).toEqual({
					success: false,
					error: 'Invalid lstat output for: /file',
				});
			}
		);

		it('preserves transport and filesystem errors', async () => {
			const deps = createMockDeps({ stdout: '', stderr: 'Permission denied', exitCode: 1 });
			expect(await lstatRemote('/private', baseConfig, deps)).toEqual({
				success: false,
				error: 'Permission denied',
			});
		});
	});

	describe('realpathRemote', () => {
		it('uses remote home expansion and preserves whitespace in the resolved path', async () => {
			const deps = createMockDeps({
				stdout: '/remote/a folder/ name \n\n',
				stderr: '',
				exitCode: 0,
			});
			expect(await realpathRemote("~/a user's folder/link", baseConfig, deps)).toEqual({
				success: true,
				data: '/remote/a folder/ name \n',
			});
			const command = vi.mocked(deps.execSsh).mock.calls[0][1].at(-1)!;
			expect(command).toContain(shellEscapeRemotePath("~/a user's folder/link"));
			expect(command).toContain('command -v realpath');
			expect(command).toContain('readlink -f / >/dev/null 2>&1');
			expect(command).toContain('readlink -f -- "$1"');
		});

		it('reports the missing realpath/readlink capability clearly', async () => {
			const error = 'Remote path resolution requires realpath or readlink with -f support';
			const deps = createMockDeps({ stdout: '', stderr: error, exitCode: 127 });
			expect(await realpathRemote('/project', baseConfig, deps)).toEqual({ success: false, error });
			expect(vi.mocked(deps.execSsh).mock.calls[0][1].at(-1)).toContain(error);
		});

		it('does not accept a path from a failed command', async () => {
			const deps = createMockDeps({ stdout: '/partial', stderr: 'No such file', exitCode: 1 });
			expect(await realpathRemote('/missing/link', baseConfig, deps)).toEqual({
				success: false,
				error: 'No such file',
			});
		});

		it.each(['', 'relative/path\n'])('rejects invalid resolved output %j', async (stdout) => {
			const deps = createMockDeps({ stdout, stderr: '', exitCode: 0 });
			expect((await realpathRemote('/file', baseConfig, deps)).success).toBe(false);
		});
	});

	describe('readlinkRemote', () => {
		it('preserves a dangling relative target and escapes the link path', async () => {
			const deps = createMockDeps({ stdout: '../missing/ target \n\n', stderr: '', exitCode: 0 });
			const filePath = "/home/a user's folder/link";
			expect(await readlinkRemote(filePath, baseConfig, deps)).toEqual({
				success: true,
				data: '../missing/ target \n',
			});
			expect(vi.mocked(deps.execSsh).mock.calls[0][1].at(-1)).toBe(
				`readlink -- ${shellEscapeRemotePath(filePath)}`
			);
		});

		it('reports failure for non-links even when readlink supplies no stderr', async () => {
			const deps = createMockDeps({ stdout: '', stderr: '', exitCode: 1 });
			expect(await readlinkRemote('/file', baseConfig, deps)).toEqual({
				success: false,
				error: 'Failed to read symbolic link: /file',
			});
		});
	});

	describe('symlinkRemote', () => {
		it('escapes both paths and refuses to follow an existing destination link', async () => {
			const deps = createMockDeps({ stdout: '', stderr: '', exitCode: 0 });
			const target = "../a user's folder/target";
			const link = '~/a "quoted" folder/link';
			expect(await symlinkRemote(target, link, baseConfig, deps)).toEqual({ success: true });
			const command = vi.mocked(deps.execSsh).mock.calls[0][1].at(-1)!;
			expect(command).toContain(shellEscapeRemotePath(target));
			expect(command).toContain(shellEscapeRemotePath(link));
			expect(command).toContain('[ -e "$2" ] || [ -L "$2" ]');
			expect(command).toContain('ln -sT');
			expect(command).toContain('ln -sh');
			expect(command).not.toContain('ln -sf');
		});

		it('reports an existing path separately from permission failures', async () => {
			const deps = createMockDeps({ stdout: '', stderr: '', exitCode: 73 });
			expect(await symlinkRemote('../target', '/link', baseConfig, deps)).toEqual({
				success: false,
				code: 'EEXIST',
				error: 'Path already exists: /link',
			});
			vi.mocked(deps.execSsh).mockResolvedValue({
				stdout: '',
				stderr: 'Permission denied',
				exitCode: 1,
			});
			expect(await symlinkRemote('../target', '/link', baseConfig, deps)).toEqual({
				success: false,
				error: 'Permission denied',
			});
		});
	});

	describe('listDirWithStatsRemote', () => {
		it('parses pipe-separated stat output into entries with ms-resolution mtime', async () => {
			const deps = createMockDeps({
				stdout:
					'56943|1776365005|0196d5fb.jsonl\n' +
					'524327|1776179531|019e42cb.jsonl\n' +
					'1024|1776000000|partial.jsonl\n',
				stderr: '',
				exitCode: 0,
			});

			const result = await listDirWithStatsRemote(
				'/remote/project/sessions',
				baseConfig,
				{ nameSuffix: '.jsonl' },
				deps
			);

			expect(result.success).toBe(true);
			expect(result.data).toEqual([
				{ name: '0196d5fb.jsonl', size: 56943, mtime: 1776365005000 },
				{ name: '019e42cb.jsonl', size: 524327, mtime: 1776179531000 },
				{ name: 'partial.jsonl', size: 1024, mtime: 1776000000000 },
			]);
		});

		it('issues exactly one SSH call for a dir with many files', async () => {
			// Simulate 300 session files coming back in a single stat response - the
			// key property that separates this implementation from the previous
			// per-file stat fan-out that tripped OpenSSH MaxStartups.
			const lines: string[] = [];
			for (let i = 0; i < 300; i++) {
				lines.push(`${1000 + i}|${1_776_000_000 + i}|session-${i}.jsonl`);
			}
			const deps = createMockDeps({
				stdout: lines.join('\n') + '\n',
				stderr: '',
				exitCode: 0,
			});

			const result = await listDirWithStatsRemote(
				'/remote/sessions',
				baseConfig,
				{ nameSuffix: '.jsonl' },
				deps
			);

			expect(result.success).toBe(true);
			expect(result.data).toHaveLength(300);
			expect(deps.execSsh).toHaveBeenCalledTimes(1);
		});

		it('applies the nameSuffix filter to the remote glob', async () => {
			const deps = createMockDeps({
				stdout: '',
				stderr: '',
				exitCode: 0,
			});

			await listDirWithStatsRemote('/remote/sessions', baseConfig, { nameSuffix: '.jsonl' }, deps);

			const execMock = deps.execSsh as ReturnType<typeof vi.fn>;
			const sshArgs: string[] = execMock.mock.calls[0][1];
			const remoteCommand = sshArgs[sshArgs.length - 1];
			expect(remoteCommand).toContain('*.jsonl');
		});

		it('falls back to matching all files when nameSuffix is not provided', async () => {
			const deps = createMockDeps({
				stdout: '',
				stderr: '',
				exitCode: 0,
			});

			await listDirWithStatsRemote('/remote/sessions', baseConfig, undefined, deps);

			const execMock = deps.execSsh as ReturnType<typeof vi.fn>;
			const sshArgs: string[] = execMock.mock.calls[0][1];
			const remoteCommand = sshArgs[sshArgs.length - 1];
			// Glob is just `*` (no suffix) and the command should not contain
			// a stray `*.` token that would restrict matches.
			expect(remoteCommand).toMatch(/\s\*\s/);
		});

		it('returns an empty array when the remote directory is missing', async () => {
			// The shell wrapper uses `cd ... || exit 0`, so the command exits cleanly
			// with no output when the directory doesn't exist.
			const deps = createMockDeps({
				stdout: '',
				stderr: '',
				exitCode: 0,
			});

			const result = await listDirWithStatsRemote('/nonexistent', baseConfig, undefined, deps);

			expect(result.success).toBe(true);
			expect(result.data).toEqual([]);
		});

		it('skips malformed lines instead of failing the whole listing', async () => {
			const deps = createMockDeps({
				// Middle line is junk; the other two must still come through.
				stdout: '100|1000|good.jsonl\ngarbage-line\n200|2000|also-good.jsonl\n',
				stderr: '',
				exitCode: 0,
			});

			const result = await listDirWithStatsRemote(
				'/remote',
				baseConfig,
				{ nameSuffix: '.jsonl' },
				deps
			);

			expect(result.success).toBe(true);
			expect(result.data).toEqual([
				{ name: 'good.jsonl', size: 100, mtime: 1000000 },
				{ name: 'also-good.jsonl', size: 200, mtime: 2000000 },
			]);
		});

		it('preserves pipe characters that appear inside a filename', async () => {
			// Names are split on only the first two `|` separators so a pipe in
			// the filename itself does not corrupt the entry.
			const deps = createMockDeps({
				stdout: '42|1700|weird|name.jsonl\n',
				stderr: '',
				exitCode: 0,
			});

			const result = await listDirWithStatsRemote(
				'/remote',
				baseConfig,
				{ nameSuffix: '.jsonl' },
				deps
			);

			expect(result.success).toBe(true);
			expect(result.data).toEqual([{ name: 'weird|name.jsonl', size: 42, mtime: 1700000 }]);
		});

		it('returns an error result when the SSH command itself fails', async () => {
			const deps = createMockDeps({
				stdout: '',
				stderr: 'ssh: connection refused',
				exitCode: 255,
			});

			const result = await listDirWithStatsRemote(
				'/remote',
				baseConfig,
				{ nameSuffix: '.jsonl' },
				deps
			);

			expect(result.success).toBe(false);
			expect(result.error).toContain('connection refused');
		});

		it('expands a home-relative path via $HOME so the cd lands in the right directory', async () => {
			// Regression: shellEscape() single-quotes the path, which prevents
			// tilde expansion and silently sends the stat loop to the wrong
			// cwd - the bug that broke Claude/Copilot remote session listing.
			const deps = createMockDeps({
				stdout: '',
				stderr: '',
				exitCode: 0,
			});

			await listDirWithStatsRemote(
				'~/.claude/projects',
				baseConfig,
				{ nameSuffix: '.jsonl' },
				deps
			);

			const sshArgs = (deps.execSsh as any).mock.calls[0][1];
			const remoteCommand = sshArgs[sshArgs.length - 1];
			expect(remoteCommand).toContain('cd "$HOME/.claude/projects"');
			expect(remoteCommand).not.toContain("cd '~/");
		});
	});

	describe('bulkStatFileInSubdirsRemote', () => {
		it('returns one entry per matching subdirectory file with size + mtime', async () => {
			const deps = createMockDeps({
				stdout:
					'1024|1700000000|sess-a/events.jsonl\n' +
					'2048|1700000010|sess-b/events.jsonl\n' +
					'4096|1700000020|sess-c/events.jsonl\n',
				stderr: '',
				exitCode: 0,
			});

			const result = await bulkStatFileInSubdirsRemote(
				'/remote/sessions',
				'events.jsonl',
				baseConfig,
				deps
			);

			expect(result.success).toBe(true);
			expect(result.data).toEqual([
				{ name: 'sess-a', size: 1024, mtime: 1700000000000 },
				{ name: 'sess-b', size: 2048, mtime: 1700000010000 },
				{ name: 'sess-c', size: 4096, mtime: 1700000020000 },
			]);
		});

		it('issues exactly one SSH call regardless of subdirectory count', async () => {
			const lines: string[] = [];
			for (let i = 0; i < 200; i++) {
				lines.push(`${1000 + i}|${1_700_000_000 + i}|sess-${i}/events.jsonl`);
			}
			const deps = createMockDeps({
				stdout: lines.join('\n') + '\n',
				stderr: '',
				exitCode: 0,
			});

			const result = await bulkStatFileInSubdirsRemote(
				'/remote/sessions',
				'events.jsonl',
				baseConfig,
				deps
			);

			expect(result.success).toBe(true);
			expect(result.data).toHaveLength(200);
			expect(deps.execSsh).toHaveBeenCalledTimes(1);
		});

		it('expands a home-relative parentDir via $HOME so the cd lands in the right directory', async () => {
			// Regression: same single-quote tilde bug as listDirWithStatsRemote.
			// `~/.copilot/session-state` must turn into `cd "$HOME/.copilot/session-state"`.
			const deps = createMockDeps({
				stdout: '',
				stderr: '',
				exitCode: 0,
			});

			await bulkStatFileInSubdirsRemote(
				'~/.copilot/session-state',
				'events.jsonl',
				baseConfig,
				deps
			);

			const sshArgs = (deps.execSsh as any).mock.calls[0][1];
			const remoteCommand = sshArgs[sshArgs.length - 1];
			expect(remoteCommand).toContain('cd "$HOME/.copilot/session-state"');
			expect(remoteCommand).not.toContain("cd '~/");
		});

		it('rejects fileNames containing shell metacharacters to prevent injection', async () => {
			const deps = createMockDeps({ stdout: '', stderr: '', exitCode: 0 });

			const result = await bulkStatFileInSubdirsRemote(
				'/remote/sessions',
				'events.jsonl; rm -rf /',
				baseConfig,
				deps
			);

			expect(result.success).toBe(false);
			expect(result.error).toContain('Refusing unsafe fileName');
			// The command must never reach SSH.
			expect(deps.execSsh).not.toHaveBeenCalled();
		});

		it('drops rows that do not end with the requested fileName suffix', async () => {
			// Defensive: if stat ever returns an unexpected line shape, we skip
			// it instead of producing a session id that's actually a sibling path.
			const deps = createMockDeps({
				stdout:
					'100|1000|sess-good/events.jsonl\n' +
					'200|2000|something-else/other.txt\n' +
					'300|3000|sess-also-good/events.jsonl\n',
				stderr: '',
				exitCode: 0,
			});

			const result = await bulkStatFileInSubdirsRemote(
				'/remote/sessions',
				'events.jsonl',
				baseConfig,
				deps
			);

			expect(result.success).toBe(true);
			expect(result.data?.map((d: { name: string }) => d.name)).toEqual([
				'sess-good',
				'sess-also-good',
			]);
		});
	});

	describe('findAncestorWithDirRemote', () => {
		it('returns the ancestor the remote loop printed', async () => {
			const deps = createMockDeps({ stdout: '/home/u/vault', stderr: '', exitCode: 0 });

			const result = await findAncestorWithDirRemote(
				'/home/u/vault/notes',
				'.obsidian',
				baseConfig,
				deps
			);

			expect(result).toEqual({ success: true, data: '/home/u/vault' });
		});

		it('walks every ancestor in ONE ssh command', async () => {
			const deps = createMockDeps({ stdout: '', stderr: '', exitCode: 0 });

			await findAncestorWithDirRemote('/home/u/vault/notes', '.obsidian', baseConfig, deps);

			expect(deps.execSsh).toHaveBeenCalledTimes(1);
			const remoteCommand = (deps.execSsh as ReturnType<typeof vi.fn>).mock.calls[0][1].at(-1);
			expect(remoteCommand).toContain(`d='/home/u/vault/notes'`);
			expect(remoteCommand).toContain(`m='.obsidian'`);
			expect(remoteCommand).toContain('[ -d "$d/$m" ]');
			expect(remoteCommand).toContain('dirname "$d"');
		});

		it('returns null when no ancestor has the marker', async () => {
			const deps = createMockDeps({ stdout: '', stderr: '', exitCode: 0 });

			const result = await findAncestorWithDirRemote('/srv/notes', '.obsidian', baseConfig, deps);

			expect(result).toEqual({ success: true, data: null });
		});

		it('keeps a trailing space in the printed path', async () => {
			const deps = createMockDeps({ stdout: '/srv/vault \n', stderr: '', exitCode: 0 });

			const result = await findAncestorWithDirRemote(
				'/srv/vault /a',
				'.obsidian',
				baseConfig,
				deps
			);

			expect(result.data).toBe('/srv/vault ');
		});

		it('reports a failed command', async () => {
			const deps = createMockDeps({ stdout: '', stderr: 'Permission denied', exitCode: 1 });

			const result = await findAncestorWithDirRemote('/srv/notes', '.obsidian', baseConfig, deps);

			expect(result.success).toBe(false);
			expect(result.error).toBe('Permission denied');
		});
	});

	describe('listFilesWithStatsRemote', () => {
		it('parses size, mtime, birth time, and change time per file, keeping spaces in paths', async () => {
			const deps = createMockDeps({
				stdout:
					'120 1700000000 1690000000 1700000100 ./People/Pedram Amini.md\n' +
					'5 1700000001 0 1700000200 ./data/people.csv\r\n' +
					'9 1700000002 - 1700000300 ./No Birth.md\n' +
					'garbage line\n',
				stderr: '',
				exitCode: 0,
			});

			const result = await listFilesWithStatsRemote('/srv/vault', ['.*'], baseConfig, deps);

			expect(result).toEqual({
				success: true,
				data: [
					{
						path: 'People/Pedram Amini.md',
						size: 120,
						mtime: 1700000000000,
						birthtime: 1690000000000,
						ctime: 1700000100000,
					},
					{
						path: 'data/people.csv',
						size: 5,
						mtime: 1700000001000,
						birthtime: 0,
						ctime: 1700000200000,
					},
					{
						path: 'No Birth.md',
						size: 9,
						mtime: 1700000002000,
						birthtime: 0,
						ctime: 1700000300000,
					},
				],
			});
		});

		it('lists and stats the whole tree in ONE ssh command, GNU first then BSD', async () => {
			const deps = createMockDeps({ stdout: '', stderr: '', exitCode: 0 });

			await listFilesWithStatsRemote('/srv/my vault', ['.*', 'node_modules'], baseConfig, deps);

			expect(deps.execSsh).toHaveBeenCalledTimes(1);
			const remoteCommand = (deps.execSsh as ReturnType<typeof vi.fn>).mock.calls[0][1].at(-1);
			expect(remoteCommand).toContain(`cd '/srv/my vault'`);
			expect(remoteCommand).toContain(
				`\\( -name '.*' -o -name 'node_modules' \\) -prune -o -type f`
			);
			expect(remoteCommand).toContain(`f='%s %Y %W %Z %n'`);
			expect(remoteCommand).toContain(`f='%z %m %B %c %N'`);
			expect(remoteCommand).toContain('-exec stat -L "$o" "$f" {} +');
		});

		it('reports a root that cannot be entered', async () => {
			const deps = createMockDeps({ stdout: '__CD_ERROR__\n', stderr: '', exitCode: 0 });

			const result = await listFilesWithStatsRemote('/missing', [], baseConfig, deps);

			expect(result).toEqual({
				success: false,
				error: 'Directory not found or not accessible: /missing',
			});
		});
	});

	describe('directorySizeRemote', () => {
		it('parses du -sb output (GNU)', async () => {
			const deps = createMockDeps({
				stdout: '123456789\t/project\n',
				stderr: '',
				exitCode: 0,
			});

			const result = await directorySizeRemote('/project', baseConfig, deps);

			expect(result.success).toBe(true);
			expect(result.data).toBe(123456789);
		});

		it('parses awk-processed du -sk output (BSD fallback)', async () => {
			const deps = createMockDeps({
				stdout: '1234567890\n', // Awk output (size * 1024)
				stderr: '',
				exitCode: 0,
			});

			const result = await directorySizeRemote('/project', baseConfig, deps);

			expect(result.success).toBe(true);
			expect(result.data).toBe(1234567890);
		});

		it('handles directory not found', async () => {
			const deps = createMockDeps({
				stdout: '',
				stderr: "du: cannot access '/missing': No such file or directory",
				exitCode: 1,
			});

			const result = await directorySizeRemote('/missing', baseConfig, deps);

			expect(result.success).toBe(false);
			expect(result.error).toContain('not found');
		});

		it('handles permission denied', async () => {
			const deps = createMockDeps({
				stdout: '',
				stderr: "du: cannot read directory '/protected': Permission denied",
				exitCode: 1,
			});

			const result = await directorySizeRemote('/protected', baseConfig, deps);

			expect(result.success).toBe(false);
			expect(result.error).toContain('Permission denied');
		});

		it('handles invalid output format', async () => {
			const deps = createMockDeps({
				stdout: 'invalid output\n',
				stderr: '',
				exitCode: 0,
			});

			const result = await directorySizeRemote('/dir', baseConfig, deps);

			expect(result.success).toBe(false);
			expect(result.error).toContain('Failed to parse du output');
		});
	});

	describe('writeFileRemote', () => {
		it('writes content successfully using base64 encoding', async () => {
			const deps = createMockDeps({
				stdout: '',
				stderr: '',
				exitCode: 0,
			});

			const result = await writeFileRemote('/output.txt', 'Hello, World!', baseConfig, deps);

			expect(result.success).toBe(true);
			// The remote command decodes base64 read from stdin; the payload itself
			// is streamed via stdin (3rd execSsh arg), not embedded in the command,
			// to avoid the ARG_MAX "Argument list too long" failure on large files.
			const call = (deps.execSsh as any).mock.calls[0];
			const remoteCommand = call[1][call[1].length - 1];
			expect(remoteCommand).toContain('base64 -d');
			expect(remoteCommand).not.toContain('echo');
			expect(call[2]).toBe(Buffer.from('Hello, World!', 'utf-8').toString('base64'));
		});

		it('handles content with special characters', async () => {
			const deps = createMockDeps({
				stdout: '',
				stderr: '',
				exitCode: 0,
			});

			const content = "Line 1\nLine 2 with 'quotes' and $variables";
			const result = await writeFileRemote('/output.txt', content, baseConfig, deps);

			expect(result.success).toBe(true);
			// base64 encoding (passed via stdin) keeps special chars safe
			const input = (deps.execSsh as any).mock.calls[0][2];
			expect(input).toBe(Buffer.from(content, 'utf-8').toString('base64'));
		});

		it('handles permission denied on write', async () => {
			const deps = createMockDeps({
				stdout: '',
				stderr: '/etc/test.txt: Permission denied',
				exitCode: 1,
			});

			const result = await writeFileRemote('/etc/test.txt', 'test', baseConfig, deps);

			expect(result.success).toBe(false);
			expect(result.error).toContain('Permission denied');
		});

		it('handles parent directory not found', async () => {
			const deps = createMockDeps({
				stdout: '',
				stderr: '/nonexistent/file.txt: No such file or directory',
				exitCode: 1,
			});

			const result = await writeFileRemote('/nonexistent/file.txt', 'test', baseConfig, deps);

			expect(result.success).toBe(false);
			expect(result.error).toContain('Parent directory not found');
		});

		it('handles Buffer content for binary files', async () => {
			const deps = createMockDeps({
				stdout: '',
				stderr: '',
				exitCode: 0,
			});

			// Create a buffer with binary content (PNG magic bytes as example)
			const binaryContent = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
			const result = await writeFileRemote('/output.png', binaryContent, baseConfig, deps);

			expect(result.success).toBe(true);
			// Command decodes base64 from stdin; the encoded buffer rides on stdin
			const call = (deps.execSsh as any).mock.calls[0];
			const remoteCommand = call[1][call[1].length - 1];
			expect(remoteCommand).toContain('base64 -d');
			expect(call[2]).toBe(binaryContent.toString('base64'));
		});

		it('correctly encodes Buffer vs string content differently', async () => {
			const deps = createMockDeps({
				stdout: '',
				stderr: '',
				exitCode: 0,
			});

			// Same bytes interpreted as string vs buffer should produce different base64
			const testString = 'Hello';
			const testBuffer = Buffer.from([0x48, 0x65, 0x6c, 0x6c, 0x6f]); // Same as 'Hello' in ASCII

			await writeFileRemote('/string.txt', testString, baseConfig, deps);
			const stringInput = (deps.execSsh as any).mock.calls[0][2];

			await writeFileRemote('/buffer.txt', testBuffer, baseConfig, deps);
			const bufferInput = (deps.execSsh as any).mock.calls[1][2];

			// Both should produce the same base64 since 'Hello' === Buffer([0x48, 0x65, 0x6c, 0x6c, 0x6f])
			const expectedBase64 = Buffer.from('Hello', 'utf-8').toString('base64');
			expect(stringInput).toBe(expectedBase64);
			expect(bufferInput).toBe(expectedBase64);
		});
	});

	describe('writeFileAtomicRemote', () => {
		it('preserves explicitly requested permission bits before replacing the target', async () => {
			const deps = createMockDeps({ stdout: '', stderr: '', exitCode: 0 });
			await writeFileAtomicRemote('/file', 'data', baseConfig, { mode: 0o700 }, deps);
			const command = vi.mocked(deps.execSsh).mock.calls[0][1].at(-1)!;
			expect(command).toContain('chmod 700 "$tmp" || exit 1');
			expect(command.indexOf('chmod 700')).toBeLessThan(command.indexOf('mv -fT'));
		});
		it.each(['text with quotes: \' and "\n', 'caf\u00e9', Buffer.from([0, 255, 128, 10]), ''])(
			'stages payload %j over stdin and cleans up on failure',
			async (content) => {
				const deps = createMockDeps({ stdout: '', stderr: '', exitCode: 0 });
				const filePath = "/home/a user's folder/file";
				expect(await writeFileAtomicRemote(filePath, content, baseConfig, {}, deps)).toEqual({
					success: true,
				});
				const [, args, input] = vi.mocked(deps.execSsh).mock.calls[0];
				const command = args.at(-1)!;
				expect(input).toBe(Buffer.from(content).toString('base64'));
				if (input) expect(command).not.toContain(input);
				expect(command).toContain(shellEscapeRemotePath(filePath));
				expect(command).toMatch(new RegExp(` ${Buffer.byteLength(content)}$`));
				expect(command).toContain('mktemp -- "$target.maestro-XXXXXX"');
				expect(command).toContain('base64 -d > "$tmp" || exit 1');
				expect(command).toContain('byte_count=$(wc -c < "$tmp") || exit 1');
				expect(command.indexOf('Incomplete atomic write payload')).toBeLessThan(
					command.indexOf('mv -fT')
				);
				expect(command).toContain('rm -f -- "$tmp"');
				expect(command).toContain('HUP INT TERM');
				expect(command).toContain('mv -fT -- "$tmp" "$target"');
				expect(command).toContain('mv -fh -- "$tmp" "$target"');
				expect(command).not.toContain('> "$target"');
				expect(command).not.toContain('sync');
			}
		);

		it('flushes data before replacement and the rename afterwards when requested', async () => {
			const deps = createMockDeps({ stdout: '', stderr: '', exitCode: 0 });
			await writeFileAtomicRemote('~/file', 'data', baseConfig, { sync: true }, deps);
			const command = vi.mocked(deps.execSsh).mock.calls[0][1].at(-1)!;
			expect(command).toContain('"$HOME/file"');
			expect(command.indexOf('sync || exit 1')).toBeGreaterThan(command.indexOf('base64 -d'));
			expect(command.indexOf('sync || exit 1')).toBeLessThan(command.indexOf('mv -fT'));
			expect(command.lastIndexOf('sync || exit 1')).toBeGreaterThan(command.indexOf('mv -fh'));
		});

		it.each([
			'Permission denied',
			'base64: invalid input',
			'Incomplete atomic write payload',
			'sync: failed',
			'mv: failed',
		])('propagates write failures: %s', async (stderr) => {
			const deps = createMockDeps({ stdout: '', stderr, exitCode: 1 });
			expect(await writeFileAtomicRemote('/file', 'data', baseConfig, {}, deps)).toEqual({
				success: false,
				error: stderr,
			});
		});
	});

	describe('createExclusiveRemote', () => {
		it('honors durable writes and permissions without widening the default directory mode', async () => {
			const deps = createMockDeps({ stdout: '', stderr: '', exitCode: 0 });
			await createExclusiveRemote('/file', 'data', baseConfig, deps, { mode: 0o700, sync: true });
			const command = vi.mocked(deps.execSsh).mock.calls[0][1].at(-1)!;
			expect(command).toContain('chmod 700 "$target" || exit 1');
			expect(command.indexOf('sync || exit 1')).toBeGreaterThan(command.indexOf('chmod 700'));
			await mkdirRemote('/private', baseConfig, true, deps, { mode: 0o700 });
			expect(vi.mocked(deps.execSsh).mock.calls[1][1].at(-1)).toContain(
				'umask 077; mkdir -p -m 700'
			);
		});
		it('holds a noclobber descriptor while decoding stdin, without reopening for write', async () => {
			const deps = createMockDeps({ stdout: '', stderr: '', exitCode: 0 });
			const filePath = "/home/a user's folder/file";
			const content = Buffer.from([0, 128, 255]);
			expect(await createExclusiveRemote(filePath, content, baseConfig, deps)).toEqual({
				success: true,
			});
			const [, args, input] = vi.mocked(deps.execSsh).mock.calls[0];
			const command = args.at(-1)!;
			expect(input).toBe(content.toString('base64'));
			expect(command).not.toContain(input!);
			expect(command).toContain(shellEscapeRemotePath(filePath));
			expect(command).toContain('set -C');
			expect(command).toContain('base64 -d >&3 || exit 74');
			expect(command).toContain('byte_count=$(wc -c < "$target") || exit 1');
			expect(command).toContain('Incomplete exclusive create payload');
			expect(command).toMatch(/ 3$/);
			expect(command).toContain('3> "$target"');
			expect(command).toContain('[ -e "$target" ] || [ -L "$target" ]');
			expect(command).not.toContain('rm ');
		});

		it('returns EEXIST for a collision without replacing the existing path', async () => {
			const deps = createMockDeps({
				stdout: '',
				stderr: 'cannot overwrite existing file',
				exitCode: 73,
			});
			expect(await createExclusiveRemote('/file', 'new content', baseConfig, deps)).toEqual({
				success: false,
				code: 'EEXIST',
				error: 'Path already exists: /file',
			});
			expect(deps.execSsh).toHaveBeenCalledTimes(1);
		});

		it.each([
			'Permission denied',
			'No such file or directory',
			'base64: invalid input',
			'Incomplete exclusive create payload',
		])('does not misclassify %s as a collision', async (stderr) => {
			const deps = createMockDeps({ stdout: '', stderr, exitCode: 1 });
			expect(await createExclusiveRemote('/file', 'data', baseConfig, deps)).toEqual({
				success: false,
				error: stderr,
			});
		});
	});

	describe('translation write transport failures', () => {
		it.each(['atomic', 'exclusive', 'symlink'] as const)(
			'does not replay an ambiguous %s operation',
			async (operation) => {
				const deps = createMockDeps({
					stdout: '',
					stderr: 'Connection reset by peer',
					exitCode: 255,
				});
				vi.mocked(deps.execSsh)
					.mockResolvedValueOnce({ stdout: '', stderr: 'Connection reset by peer', exitCode: 255 })
					.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
				const result =
					operation === 'atomic'
						? await writeFileAtomicRemote('/file', 'data', baseConfig, {}, deps)
						: operation === 'exclusive'
							? await createExclusiveRemote('/file', 'data', baseConfig, deps)
							: await symlinkRemote('../target', '/link', baseConfig, deps);
				expect(result).toEqual({ success: false, error: 'Connection reset by peer' });
				expect(deps.execSsh).toHaveBeenCalledTimes(1);
			}
		);
	});

	describe('existsRemote', () => {
		it('returns true when path exists', async () => {
			const deps = createMockDeps({
				stdout: 'EXISTS\n',
				stderr: '',
				exitCode: 0,
			});

			const result = await existsRemote('/home/user/file.txt', baseConfig, deps);

			expect(result.success).toBe(true);
			expect(result.data).toBe(true);
		});

		it('returns false when path does not exist', async () => {
			const deps = createMockDeps({
				stdout: 'NOT_EXISTS\n',
				stderr: '',
				exitCode: 0,
			});

			const result = await existsRemote('/nonexistent', baseConfig, deps);

			expect(result.success).toBe(true);
			expect(result.data).toBe(false);
		});

		it('handles SSH error', async () => {
			const deps = createMockDeps({
				stdout: '',
				stderr: 'Connection refused',
				exitCode: 1,
			});

			const result = await existsRemote('/path', baseConfig, deps);

			expect(result.success).toBe(false);
			expect(result.error).toBeDefined();
		});
	});

	describe('mkdirRemote', () => {
		it('creates directory successfully', async () => {
			const deps = createMockDeps({
				stdout: '',
				stderr: '',
				exitCode: 0,
			});

			const result = await mkdirRemote('/home/user/newdir', baseConfig, true, deps);

			expect(result.success).toBe(true);
		});

		it('uses -p flag for recursive creation', async () => {
			const deps = createMockDeps({
				stdout: '',
				stderr: '',
				exitCode: 0,
			});

			await mkdirRemote('/home/user/a/b/c', baseConfig, true, deps);

			const call = (deps.execSsh as any).mock.calls[0][1];
			const remoteCommand = call[call.length - 1];
			expect(remoteCommand).toContain('mkdir -p');
		});

		it('omits -p flag when recursive is false', async () => {
			const deps = createMockDeps({
				stdout: '',
				stderr: '',
				exitCode: 0,
			});

			await mkdirRemote('/home/user/newdir', baseConfig, false, deps);

			const call = (deps.execSsh as any).mock.calls[0][1];
			const remoteCommand = call[call.length - 1];
			expect(remoteCommand).toContain('mkdir  ');
			expect(remoteCommand).not.toContain('-p');
		});

		it('handles permission denied', async () => {
			const deps = createMockDeps({
				stdout: '',
				stderr: "mkdir: cannot create directory '/etc/test': Permission denied",
				exitCode: 1,
			});

			const result = await mkdirRemote('/etc/test', baseConfig, true, deps);

			expect(result.success).toBe(false);
			expect(result.error).toContain('Permission denied');
		});

		it('handles directory already exists', async () => {
			const deps = createMockDeps({
				stdout: '',
				stderr: "mkdir: cannot create directory '/home': File exists",
				exitCode: 1,
			});

			const result = await mkdirRemote('/home', baseConfig, false, deps);

			expect(result.success).toBe(false);
			expect(result.error).toContain('already exists');
		});
	});

	describe('compressFolderRemote', () => {
		it('zips from the parent dir so the folder is the archive root', async () => {
			const deps = createMockDeps({ stdout: '', stderr: '', exitCode: 0 });

			const result = await compressFolderRemote(
				'/home/user/project/docs',
				'/home/user/project/docs.zip',
				baseConfig,
				deps
			);

			expect(result.success).toBe(true);
			const call = (deps.execSsh as any).mock.calls[0][1];
			const remoteCommand = call[call.length - 1];
			expect(remoteCommand).toContain("cd '/home/user/project'");
			expect(remoteCommand).toContain("zip -r -q -y '/home/user/project/docs.zip' 'docs'");
		});

		it('reports a missing zip binary in plain language', async () => {
			const deps = createMockDeps({
				stdout: '',
				stderr: 'bash: zip: command not found',
				exitCode: 127,
			});

			const result = await compressFolderRemote(
				'/home/user/docs',
				'/home/user/docs.zip',
				baseConfig,
				deps
			);

			expect(result.success).toBe(false);
			expect(result.error).toContain('zip');
			expect(result.error).toContain('installed');
		});

		it('handles permission denied on the destination', async () => {
			const deps = createMockDeps({
				stdout: '',
				stderr: 'zip I/O error: Permission denied',
				exitCode: 1,
			});

			const result = await compressFolderRemote('/srv/docs', '/srv/docs.zip', baseConfig, deps);

			expect(result.success).toBe(false);
			expect(result.error).toContain('Permission denied');
		});
	});

	describe('SSH context integration', () => {
		it('passes correct SSH remote config to buildSshArgs', async () => {
			const customConfig: SshRemoteConfig = {
				...baseConfig,
				host: 'custom.host.com',
				port: 2222,
				username: 'customuser',
			};

			const deps = createMockDeps({
				stdout: 'file.txt\n',
				stderr: '',
				exitCode: 0,
			});

			await readDirRemote('/path', customConfig, deps);

			expect(deps.buildSshArgs).toHaveBeenCalledWith(customConfig);
		});

		it('handles useSshConfig mode correctly', async () => {
			const sshConfigMode: SshRemoteConfig = {
				...baseConfig,
				useSshConfig: true,
				privateKeyPath: '',
				username: '',
			};

			const deps = createMockDeps({
				stdout: 'EXISTS\n',
				stderr: '',
				exitCode: 0,
			});

			await existsRemote('/test', sshConfigMode, deps);

			expect(deps.buildSshArgs).toHaveBeenCalledWith(sshConfigMode);
		});
	});

	describe('error handling edge cases', () => {
		it('handles network timeout', async () => {
			const deps = createMockDeps({
				stdout: '',
				stderr: 'Connection timed out',
				exitCode: 255,
			});

			const result = await readFileRemote('/file.txt', baseConfig, deps);

			expect(result.success).toBe(false);
			expect(result.error).toContain('timed out');
		});

		it('handles SSH authentication failure', async () => {
			const deps = createMockDeps({
				stdout: '',
				stderr: 'Permission denied (publickey)',
				exitCode: 255,
			});

			const result = await statRemote('/file', baseConfig, deps);

			expect(result.success).toBe(false);
		});

		it('handles empty response with non-zero exit code', async () => {
			const deps = createMockDeps({
				stdout: '',
				stderr: '',
				exitCode: 1,
			});

			const result = await readFileRemote('/file', baseConfig, deps);

			expect(result.success).toBe(false);
			expect(result.error).toBeDefined();
		});
	});

	// Verifies that the per-host concurrency cap actually serializes excess
	// SSH calls. Without this, a recursive file scan can fan out hundreds of
	// concurrent SSH+cloudflared processes and starve unrelated callers
	// (agent spawn, terminal, git) until cloudflared rate-limits.
	describe('per-host SSH concurrency limit', () => {
		beforeEach(() => {
			__resetHostLimitersForTest();
		});

		/** execSsh stub whose resolution is deferred until release() is called. */
		function deferredDeps(): {
			deps: RemoteFsDeps;
			pending: () => number;
			release: () => void;
		} {
			let inFlight = 0;
			const releasers: Array<() => void> = [];
			const deps: RemoteFsDeps = {
				execSsh: vi.fn().mockImplementation(async () => {
					inFlight++;
					await new Promise<void>((resolve) => releasers.push(resolve));
					inFlight--;
					return { stdout: '', stderr: '', exitCode: 0 } satisfies ExecResult;
				}),
				buildSshArgs: vi.fn().mockReturnValue(['testuser@dev.example.com']),
			};
			return {
				deps,
				pending: () => inFlight,
				release: () => {
					const next = releasers.shift();
					if (next) next();
				},
			};
		}

		/** Poll until pending count stabilizes at the expected value (or fail on timeout). */
		async function waitForPending(
			pending: () => number,
			expected: number,
			timeoutMs = 500
		): Promise<void> {
			const deadline = Date.now() + timeoutMs;
			while (Date.now() < deadline) {
				if (pending() === expected) return;
				await new Promise((r) => setTimeout(r, 5));
			}
			throw new Error(`pending() never reached ${expected}, last value ${pending()}`);
		}

		it('caps concurrent SSH calls per host at 4', async () => {
			const { deps, pending, release } = deferredDeps();

			// Fire 8 calls - cap is 4, so only 4 should reach execSsh.
			const calls = Array.from({ length: 8 }, (_, i) =>
				readFileRemote(`/file-${i}`, baseConfig, deps)
			);

			await waitForPending(pending, 4);

			// pending should never exceed the cap while calls are queued.
			await new Promise((r) => setTimeout(r, 30));
			expect(pending()).toBe(4);

			// Drain everything - release one slot at a time, waiting between
			// each so the next queued call has time to start (and push its
			// releaser onto the deferred queue) before the next release fires.
			for (let i = 0; i < 8; i++) {
				release();
				await new Promise((r) => setTimeout(r, 5));
			}
			await Promise.all(calls);
			expect(pending()).toBe(0);
		});

		it('uses separate limiters per distinct host', async () => {
			const { deps, pending, release } = deferredDeps();
			const otherConfig: SshRemoteConfig = { ...baseConfig, host: 'other.example.com' };

			// 4 to each host - both should saturate independently (8 in flight).
			const calls = [
				...Array.from({ length: 4 }, (_, i) => readFileRemote(`/a-${i}`, baseConfig, deps)),
				...Array.from({ length: 4 }, (_, i) => readFileRemote(`/b-${i}`, otherConfig, deps)),
			];

			await waitForPending(pending, 8);

			for (let i = 0; i < 8; i++) release();
			await Promise.all(calls);
		});

		it('releases the slot even when the SSH call rejects', async () => {
			const failingDeps: RemoteFsDeps = {
				execSsh: vi.fn().mockRejectedValue(new Error('boom')),
				buildSshArgs: vi.fn().mockReturnValue(['testuser@dev.example.com']),
			};

			// Fire 5 calls - if the slot weren't released on rejection, the 5th
			// would hang forever waiting on an acquire() that never resolves.
			const results = await Promise.allSettled(
				Array.from({ length: 5 }, (_, i) => readFileRemote(`/x-${i}`, baseConfig, failingDeps))
			);

			expect(results.every((r) => r.status === 'rejected')).toBe(true);
		});
	});

	describe('deleteManyRemote', () => {
		const ok: ExecResult = { stdout: '', stderr: '', exitCode: 0 };

		it('deletes a whole batch in a single SSH round trip', async () => {
			const deps = createMockDeps(ok);

			const results = await deleteManyRemote(
				['/remote/a.txt', '/remote/b.txt', '/remote/c.txt'],
				baseConfig,
				true,
				deps
			);

			// This is the whole point: one handshake for N paths, not N.
			expect(deps.execSsh).toHaveBeenCalledTimes(1);
			const cmd = (deps.execSsh as any).mock.calls[0][1].at(-1);
			expect(cmd).toBe("rm -rf '/remote/a.txt' '/remote/b.txt' '/remote/c.txt'");
			expect(results).toEqual([{ success: true }, { success: true }, { success: true }]);
		});

		it('uses rm -f when recursive is off', async () => {
			const deps = createMockDeps(ok);

			await deleteManyRemote(['/remote/a.txt'], baseConfig, false, deps);

			expect((deps.execSsh as any).mock.calls[0][1].at(-1)).toBe("rm -f '/remote/a.txt'");
		});

		it('escapes paths so a hostile filename cannot break out of the command', async () => {
			const deps = createMockDeps(ok);

			await deleteManyRemote(["/remote/a'; rm -rf ~; echo '.txt"], baseConfig, true, deps);

			const cmd = (deps.execSsh as any).mock.calls[0][1].at(-1);
			// The whole filename stays one single-quoted argument - the embedded
			// quote is closed and re-opened as '\'' rather than ending it, so the
			// injected `rm -rf ~` is data the outer rm receives, not a command the
			// shell runs. Batching several paths into one command line makes this
			// the load-bearing property of the whole function.
			expect(cmd).toBe(`rm -rf '/remote/a'\\''; rm -rf ~; echo '\\''.txt'`);
		});

		it('chunks a batch too large for one command line', async () => {
			const deps = createMockDeps(ok);
			// Each path is ~1 KB escaped, so 64 of them blow past the 32 KB cap.
			const paths = Array.from({ length: 64 }, (_, i) => `/remote/${'x'.repeat(1000)}-${i}.txt`);

			const results = await deleteManyRemote(paths, baseConfig, true, deps);

			expect((deps.execSsh as any).mock.calls.length).toBeGreaterThan(1);
			for (const call of (deps.execSsh as any).mock.calls) {
				expect(Buffer.byteLength(call[1].at(-1), 'utf8')).toBeLessThanOrEqual(32 * 1024);
			}
			// Chunking must not drop or reorder anything.
			expect(results).toHaveLength(paths.length);
			expect(results.every((r) => r.success)).toBe(true);
		});

		it('retries a failed chunk per path to attribute the failure', async () => {
			// `rm` exits non-zero without naming the offending argument, so the
			// batch is replayed one path at a time to find out which one failed.
			const execSsh = vi
				.fn()
				// Batch attempt fails as a whole.
				.mockResolvedValueOnce({ stdout: '', stderr: 'rm: permission denied', exitCode: 1 })
				// Per-path replay: a.txt fine, b.txt is the culprit, c.txt fine.
				.mockResolvedValueOnce(ok)
				.mockResolvedValueOnce({
					stdout: '',
					stderr: 'rm: /remote/b.txt: Permission denied',
					exitCode: 1,
				})
				.mockResolvedValueOnce(ok);
			const deps: RemoteFsDeps = {
				execSsh,
				buildSshArgs: vi.fn().mockReturnValue(['testuser@dev.example.com']),
			};

			const results = await deleteManyRemote(
				['/remote/a.txt', '/remote/b.txt', '/remote/c.txt'],
				baseConfig,
				true,
				deps
			);

			expect(results[0]).toEqual({ success: true });
			expect(results[1].success).toBe(false);
			expect(results[1].error).toContain('Permission denied');
			expect(results[2]).toEqual({ success: true });
		});

		it('returns nothing and opens no connection for an empty batch', async () => {
			const deps = createMockDeps(ok);

			expect(await deleteManyRemote([], baseConfig, true, deps)).toEqual([]);
			expect(deps.execSsh).not.toHaveBeenCalled();
		});
	});

	describe('readFileInRootRemote', () => {
		const ROOT = '/home/u/vault';

		it('runs ONE remote script that resolves the root and the file with realpath before reading', async () => {
			const deps = createMockDeps({ stdout: 'view();\n', stderr: '', exitCode: 0 });

			const result = await readFileInRootRemote(ROOT, 'views/x/view.js', 1024, baseConfig, deps);

			expect(result).toEqual({ success: true, data: 'view();\n' });
			expect(deps.execSsh).toHaveBeenCalledTimes(1);
			const command = (deps.execSsh as ReturnType<typeof vi.fn>).mock.calls[0][1].at(-1) as string;
			expect(command).toContain(`realpath '${ROOT}'`);
			expect(command).toContain(`realpath '${ROOT}/views/x/view.js'`);
			// The containment check runs on the REAL paths, before the read, which reads the resolved file.
			expect(command).toContain('case "$f" in "$r"/*)');
			expect(command.indexOf('case "$f"')).toBeLessThan(command.indexOf('cat "$f"'));
			expect(command).toContain('[ "$s" -le 1024 ]');
		});

		it('quotes a path holding shell syntax so it can never run', async () => {
			const deps = createMockDeps({ stdout: '', stderr: '', exitCode: 0 });

			await readFileInRootRemote(ROOT, "a'$(touch pwned)`id`.md", 1024, baseConfig, deps);

			const command = (deps.execSsh as ReturnType<typeof vi.fn>).mock.calls[0][1].at(-1) as string;
			expect(command).toContain(`'${ROOT}/a'\\''$(touch pwned)\`id\`.md'`);
		});

		it('answers null for a path with no regular file behind it', async () => {
			const deps = createMockDeps({ stdout: '', stderr: '', exitCode: 3 });

			expect(await readFileInRootRemote(ROOT, 'gone.md', 1024, baseConfig, deps)).toEqual({
				success: true,
				data: null,
			});
		});

		it('refuses a path whose real path leaves the root, a file over the cap, and a remote without realpath', async () => {
			const outside = await readFileInRootRemote(
				ROOT,
				'escape.md',
				1024,
				baseConfig,
				createMockDeps({ stdout: '', stderr: '', exitCode: 4 })
			);
			expect(outside.success).toBe(false);
			expect(outside.error).toContain('outside');

			const tooLarge = await readFileInRootRemote(
				ROOT,
				'big.csv',
				1024,
				baseConfig,
				createMockDeps({ stdout: '', stderr: '', exitCode: 5 })
			);
			expect(tooLarge.success).toBe(false);
			expect(tooLarge.error).toContain('1024 bytes');

			const noRealpath = await readFileInRootRemote(
				ROOT,
				'a.md',
				1024,
				baseConfig,
				createMockDeps({ stdout: '', stderr: '', exitCode: 6 })
			);
			expect(noRealpath.success).toBe(false);
			expect(noRealpath.error).toContain('realpath');

			const excluded = await readFileInRootRemote(
				ROOT,
				'settings/app.json',
				1024,
				baseConfig,
				createMockDeps({ stdout: '', stderr: '', exitCode: 7 })
			);
			expect(excluded.success).toBe(false);
			expect(excluded.error).toContain('hidden folder or node_modules');
		});

		it.skipIf(process.platform === 'win32')(
			'refuses, under a real shell, a symlink out of the root or into a dot folder or node_modules',
			async () => {
				const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'remote-in-root-')));
				try {
					const root = path.join(base, 'vault');
					fs.mkdirSync(path.join(root, '.obsidian'), { recursive: true });
					fs.mkdirSync(path.join(root, 'node_modules'));
					fs.writeFileSync(path.join(root, 'a.md'), 'inside');
					fs.writeFileSync(path.join(root, '.obsidian', 'app.json'), 'token');
					fs.writeFileSync(path.join(root, 'node_modules', 'x.js'), 'module');
					fs.writeFileSync(path.join(base, 'secret.md'), 'secret');
					fs.symlinkSync(path.join(root, 'a.md'), path.join(root, 'alias.md'));
					fs.symlinkSync(path.join(base, 'secret.md'), path.join(root, 'escape.md'));
					fs.symlinkSync(path.join(root, '.obsidian'), path.join(root, 'settings'));
					fs.symlinkSync(path.join(root, 'node_modules'), path.join(root, 'mods'));

					// The generated script, run by the local shell as the remote would run it.
					const run = async (relPath: string) => {
						const deps = createMockDeps({ stdout: '', stderr: '', exitCode: 0 });
						await readFileInRootRemote(root, relPath, 1024, baseConfig, deps);
						const command = (deps.execSsh as ReturnType<typeof vi.fn>).mock.calls[0][1].at(
							-1
						) as string;
						const result = spawnSync('sh', ['-c', command], { encoding: 'utf8' });
						return { status: result.status, stdout: result.stdout };
					};

					expect(await run('a.md')).toEqual({ status: 0, stdout: 'inside' });
					expect(await run('alias.md')).toEqual({ status: 0, stdout: 'inside' });
					expect(await run('escape.md')).toEqual({ status: 4, stdout: '' });
					expect(await run('settings/app.json')).toEqual({ status: 7, stdout: '' });
					expect(await run('mods/x.js')).toEqual({ status: 7, stdout: '' });
				} finally {
					fs.rmSync(base, { recursive: true, force: true });
				}
			}
		);

		it('reports any other failure with the remote error text', async () => {
			const result = await readFileInRootRemote(
				ROOT,
				'a.md',
				1024,
				baseConfig,
				createMockDeps({ stdout: '', stderr: 'cat: a.md: Permission denied', exitCode: 1 })
			);
			expect(result).toEqual({ success: false, error: 'cat: a.md: Permission denied' });
		});
	});
});
