import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
	readDirRemote,
	readFileRemote,
	statRemote,
	directorySizeRemote,
	writeFileRemote,
	existsRemote,
	mkdirRemote,
	listDirWithStatsRemote,
	listTreeRemote,
	__resetHostLimitersForTest,
	type RemoteFsDeps,
} from '../../../main/utils/remote-fs';
import type { SshRemoteConfig } from '../../../shared/types';
import type { ExecResult } from '../../../main/utils/execFile';

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

			// Accept full SSH binary path (e.g., /usr/bin/ssh or C:\Windows\System32\OpenSSH\ssh.exe) for cross-platform compatibility
			expect(deps.execSsh).toHaveBeenCalledWith(
				expect.stringMatching(/ssh(\.exe)?$/),
				expect.any(Array)
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
			// any pattern has no match — common for directories without dotfiles.
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
			// containing a symlink whose target was NOT a directory (common — e.g. a
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

		it('detects truncation when file count exceeds maxFiles', async () => {
			// head returned cap+1 entries — the helper should slice off the marker
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
			// Path-bearing patterns are dropped — they cannot work with -name.
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
			// Simulate 300 session files coming back in a single stat response — the
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
			// Verify the SSH command includes base64-encoded content
			const call = (deps.execSsh as any).mock.calls[0][1];
			const remoteCommand = call[call.length - 1];
			expect(remoteCommand).toContain('base64 -d');
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
			// Verify base64 encoding is used (safe for special chars)
			const call = (deps.execSsh as any).mock.calls[0][1];
			const remoteCommand = call[call.length - 1];
			expect(remoteCommand).toContain(Buffer.from(content, 'utf-8').toString('base64'));
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
			// Verify the SSH command includes base64-encoded content from buffer
			const call = (deps.execSsh as any).mock.calls[0][1];
			const remoteCommand = call[call.length - 1];
			expect(remoteCommand).toContain('base64 -d');
			// Verify it contains the base64-encoded buffer content
			expect(remoteCommand).toContain(binaryContent.toString('base64'));
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
			const stringCall = (deps.execSsh as any).mock.calls[0][1];
			const stringCommand = stringCall[stringCall.length - 1];

			await writeFileRemote('/buffer.txt', testBuffer, baseConfig, deps);
			const bufferCall = (deps.execSsh as any).mock.calls[1][1];
			const bufferCommand = bufferCall[bufferCall.length - 1];

			// Both should produce the same base64 since 'Hello' === Buffer([0x48, 0x65, 0x6c, 0x6c, 0x6f])
			const expectedBase64 = Buffer.from('Hello', 'utf-8').toString('base64');
			expect(stringCommand).toContain(expectedBase64);
			expect(bufferCommand).toContain(expectedBase64);
		});
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

			// Fire 8 calls — cap is 4, so only 4 should reach execSsh.
			const calls = Array.from({ length: 8 }, (_, i) =>
				readFileRemote(`/file-${i}`, baseConfig, deps)
			);

			await waitForPending(pending, 4);

			// pending should never exceed the cap while calls are queued.
			await new Promise((r) => setTimeout(r, 30));
			expect(pending()).toBe(4);

			// Drain everything — release one slot at a time, waiting between
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

			// 4 to each host — both should saturate independently (8 in flight).
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

			// Fire 5 calls — if the slot weren't released on rejection, the 5th
			// would hang forever waiting on an acquire() that never resolves.
			const results = await Promise.allSettled(
				Array.from({ length: 5 }, (_, i) => readFileRemote(`/x-${i}`, baseConfig, failingDeps))
			);

			expect(results.every((r) => r.status === 'rejected')).toBe(true);
		});
	});
});
