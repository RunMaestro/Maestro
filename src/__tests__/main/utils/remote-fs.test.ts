import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	readDirRemote,
	readFileRemote,
	readFileInRootRemote,
	observePathRemote,
	type RemotePathIdentity,
	readBinaryFileRemoteAsBase64,
	readBinaryFileBlockRemoteAsBase64,
	readFileTailRemote,
	statRemote,
	findAncestorWithDirRemote,
	listFilesWithStatsRemote,
	directorySizeRemote,
	writeFileRemote,
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
import { execFileNoThrow } from '../../../main/utils/execFile';
import { resolveSshPath } from '../../../main/utils/cliDetection';

// All transports are injected; even SSH discovery must stay off the real host.
vi.mock('../../../main/utils/cliDetection', () => ({
	resolveSshPath: vi.fn().mockResolvedValue('ssh'),
}));
vi.mock('../../../main/utils/execFile', () => ({
	execFileNoThrow: vi.fn(() => {
		throw new Error('Unexpected real transport in remote-fs tests');
	}),
}));

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

	describe('remote physical source identity', () => {
		const identity: RemotePathIdentity = {
			canonicalPath: '/physical/account/sessions/chat_history.jsonl',
			device: '18446744073709551615',
			inode: '9007199254740993',
			kind: 'file',
		};
		const launchReceipt = {
			launchCwd: { ...identity, kind: 'directory' },
			processCwd: { ...identity, kind: 'directory' },
			cwd: { ...identity, kind: 'directory' },
			account: { ...identity, kind: 'directory' },
			inherited: { HOME: null, GROK_HOME: null },
			effective: { HOME: null, GROK_HOME: null },
		};
		afterEach(() => {
			vi.useRealTimers();
			vi.restoreAllMocks();
			vi.clearAllMocks();
		});

		it.each([
			{ expectedIdentity: null },
			{ expectedIdentity: { ...identity, kind: 'directory' } },
			{ expectedIdentity: { ...identity, inode: '0' } },
			{ expectedIdentity: { ...identity, canonicalPath: '/a/../b' } },
			{ maxBytes: undefined },
			{ expectedIdentity: undefined, expectedPaths: [] },
			{ expectedPaths: {} },
			{ expectedPaths: Array(17).fill({ path: '/guard', identity }) },
			{ expectedPaths: [null] },
			{ expectedPaths: [{ path: '/guard', identity: {} }] },
			...['', '/bad\npath', '/bad\0path', 'a'.repeat(16385)].map((guard) => ({
				expectedPaths: [{ path: guard, identity }],
			})),
		])('rejects invalid requested identity/guards %# before transport', async (patch) => {
			const deps = createMockDeps({ stdout: '', stderr: '', exitCode: 0 });
			const options = { maxBytes: 8, expectedIdentity: identity, ...patch };
			expect(
				await readFileRemote(
					'/alias',
					baseConfig,
					deps,
					options as Parameters<typeof readFileRemote>[3]
				)
			).toMatchObject({ success: false, errorCode: 'identity-unavailable' });
			expect(deps.execSsh).not.toHaveBeenCalled();
			expect(deps.buildSshArgs).not.toHaveBeenCalled();
		});

		it.each(['file', 'directory'] as const)(
			'observes a physical %s without inventing endpoint identity',
			async (kind) => {
				const data = { ...identity, kind };
				const deps = createMockDeps({ stdout: JSON.stringify(data), stderr: '', exitCode: 0 });
				expect(await observePathRemote('~/account-alias', baseConfig, deps)).toEqual({
					success: true,
					data,
				});
				expect(deps.execSsh).toHaveBeenCalledTimes(1);
				expect(execFileNoThrow).not.toHaveBeenCalled();
			}
		);

		it.each([
			'null',
			'[]',
			'{}',
			'{',
			' '.repeat(100001),
			...[
				{ canonicalPath: 'relative' },
				{ canonicalPath: '/a/../b' },
				{ canonicalPath: '/a\0b' },
				{ canonicalPath: '/' + 'a'.repeat(16384) },
				{ device: 1 },
				{ device: '-1' },
				{ inode: '0' },
				{ inode: '01' },
				{ inode: '1'.repeat(21) },
				{ kind: 'symlink' },
				{ endpoint: 'configured-host-is-not-proof' },
			].map((patch) => JSON.stringify({ ...identity, ...patch })),
		])('rejects malformed physical observation %#', async (stdout) => {
			const deps = createMockDeps({ stdout, stderr: '', exitCode: 0 });
			expect(await observePathRemote('/alias', baseConfig, deps)).toMatchObject({
				success: false,
				errorCode: 'identity-unavailable',
			});
			expect(deps.execSsh).toHaveBeenCalledTimes(1);
		});

		it.each([
			{ account: { ...identity, kind: 'file' } },
			{ cwd: identity },
			{ effective: { HOME: null } },
			{ inherited: { HOME: null, GROK_HOME: 7 } },
			{ effective: { HOME: 'x'.repeat(16385), GROK_HOME: null } },
			{ inherited: { HOME: null, GROK_HOME: 'bad\nroot' } },
			{ extra: 'not-a-receipt' },
		])('rejects malformed launch ownership field %#', async (patch) => {
			const stdout = JSON.stringify({ ...launchReceipt, ...patch });
			const deps = createMockDeps({ stdout, stderr: '', exitCode: 0 });
			expect(await observePathRemote('/alias', baseConfig, deps, { env: {} })).toMatchObject({
				success: false,
				errorCode: 'identity-unavailable',
			});
			expect(deps.execSsh).toHaveBeenCalledTimes(1);
		});

		it.each(['HOME', 'GROK_HOME', 'nativeCwd'])('rejects invalid %s before SSH', async (key) => {
			for (const value of ['bad\nroot', 'bad\0root', 'x'.repeat(16385)]) {
				const deps = createMockDeps({ stdout: '', stderr: '', exitCode: 0 });
				const options =
					key === 'nativeCwd' ? { env: {}, nativeCwd: value } : { env: { [key]: value } };
				expect(await observePathRemote('/alias', baseConfig, deps, options)).toMatchObject({
					success: false,
					errorCode: 'identity-unavailable',
				});
				expect(deps.execSsh).not.toHaveBeenCalled();
				expect(deps.buildSshArgs).not.toHaveBeenCalled();
			}
		});

		it.each([100000, 100001])('bounds the launch receipt at %i ASCII bytes', async (size) => {
			const stdout = JSON.stringify(launchReceipt).padEnd(size, ' ');
			expect(Buffer.byteLength(stdout)).toBe(size);
			const deps = createMockDeps({ stdout, stderr: '', exitCode: 0 });
			const result = await observePathRemote('/alias', baseConfig, deps, { env: {} });
			if (size === 100000) expect(result).toEqual({ success: true, data: launchReceipt });
			else {
				expect(result).toMatchObject({ success: false, errorCode: 'identity-unavailable' });
				expect(result.data).toBeUndefined();
			}
			expect(deps.execSsh).toHaveBeenCalledTimes(1);
		});

		it.each([
			['launchCwd', 'canonicalPath'],
			['processCwd', 'canonicalPath'],
			['cwd', 'canonicalPath'],
			['account', 'canonicalPath'],
			['inherited', 'HOME'],
			['inherited', 'GROK_HOME'],
			['effective', 'HOME'],
			['effective', 'GROK_HOME'],
		] as const)('bounds launch receipt field %s.%s independently', async (section, key) => {
			for (const size of [16384, 16385]) {
				const receipt = {
					...launchReceipt,
					[section]: { ...launchReceipt[section], [key]: '/' + 'a'.repeat(size - 1) },
				};
				const deps = createMockDeps({ stdout: JSON.stringify(receipt), stderr: '', exitCode: 0 });
				const result = await observePathRemote('/alias', baseConfig, deps, { env: {} });
				if (size === 16384) expect(result).toEqual({ success: true, data: receipt });
				else {
					expect(result).toMatchObject({ success: false, errorCode: 'identity-unavailable' });
					expect(result.data).toBeUndefined();
				}
				expect(deps.execSsh).toHaveBeenCalledTimes(1);
			}
		});

		it.each([
			{ failures: 1, exitCode: 255, stderr: 'Connection reset by peer' },
			{ failures: 3, exitCode: 255, stderr: 'Broken pipe' },
			{ failures: 4, exitCode: 255, stderr: 'Connection reset by peer' },
			{ failures: 4, exitCode: 'ETIMEDOUT', stderr: '' },
		])(
			'bounds launch retries and ignores failed receipts %#',
			async ({ failures, exitCode, stderr }) => {
				vi.useFakeTimers();
				vi.spyOn(Math, 'random').mockReturnValue(0);
				const deps = createMockDeps({ stdout: JSON.stringify(launchReceipt), stderr, exitCode });
				vi.mocked(deps.buildSshArgs).mockImplementation(() => ['inert-fixture-host']);
				vi.mocked(deps.execSsh).mockImplementation(async () =>
					vi.mocked(deps.execSsh).mock.calls.length <= failures
						? { stdout: JSON.stringify(launchReceipt), stderr, exitCode }
						: { stdout: JSON.stringify(launchReceipt), stderr: '', exitCode: 0 }
				);
				const pending = observePathRemote('/alias', baseConfig, deps, { env: {} });
				await vi.advanceTimersByTimeAsync(0);
				expect(deps.execSsh).toHaveBeenCalledTimes(1);
				const attempts = Math.min(failures + 1, 4);
				for (let retry = 0; retry < attempts - 1; retry++) {
					await vi.advanceTimersByTimeAsync(500 * 2 ** retry - 1);
					expect(deps.execSsh).toHaveBeenCalledTimes(retry + 1);
					await vi.advanceTimersByTimeAsync(1);
					expect(deps.execSsh).toHaveBeenCalledTimes(retry + 2);
				}
				const result = await pending;
				if (failures < 4) expect(result).toEqual({ success: true, data: launchReceipt });
				else {
					expect(result).toEqual({
						success: false,
						errorCode: undefined,
						error: stderr || 'Remote path identity unavailable',
					});
					expect(result.data).toBeUndefined();
				}
				expect(vi.getTimerCount()).toBe(0);
				await vi.advanceTimersByTimeAsync(60000);
				expect(deps.execSsh).toHaveBeenCalledTimes(attempts);
				expect(deps.buildSshArgs).toHaveBeenCalledTimes(attempts);
				for (const call of vi.mocked(deps.execSsh).mock.calls)
					expect(call).toEqual(vi.mocked(deps.execSsh).mock.calls[0]);
				expect(execFileNoThrow).not.toHaveBeenCalled();
			}
		);

		it.each(['', '/bad\npath', '/bad\0path', 'a'.repeat(16385)])(
			'rejects invalid observer path %# before SSH',
			async (filePath) => {
				const deps = createMockDeps({ stdout: '', stderr: '', exitCode: 0 });
				expect(await observePathRemote(filePath, baseConfig, deps)).toMatchObject({
					success: false,
					errorCode: 'identity-unavailable',
				});
				expect(deps.execSsh).not.toHaveBeenCalled();
				expect(deps.buildSshArgs).not.toHaveBeenCalled();
			}
		);

		it.each([
			[70, 'absent, non-directory or inaccessible path', 'identity-unavailable'],
			[71, 'Remote source identity changed', 'identity-mismatch'],
			[127, 'python3 unavailable', 'identity-unavailable'],
			[73, 'unexpected filesystem failure', undefined],
			[255, 'Permission denied (publickey)', undefined],
		] as const)(
			'preserves observer/read refusal %s without a receipt or content',
			async (exitCode, stderr, errorCode) => {
				for (const operation of ['observe', 'launch', 'read']) {
					const deps = createMockDeps({ stdout: 'untrusted bytes', stderr, exitCode });
					const result =
						operation === 'observe'
							? await observePathRemote('/alias', baseConfig, deps)
							: operation === 'launch'
								? await observePathRemote('/alias', baseConfig, deps, { env: {} })
								: await readFileRemote('/alias', baseConfig, deps, {
										maxBytes: 8,
										expectedIdentity: identity,
									});
					expect(result).toEqual({ success: false, errorCode, error: stderr });
					expect(deps.execSsh).toHaveBeenCalledTimes(1);
				}
			}
		);

		it.each([
			{ body: Buffer.from('雪'), changed: false, exitCode: 0, errorCode: undefined },
			{ body: Buffer.from(''), changed: true, exitCode: 0, errorCode: undefined },
			{
				body: Buffer.from([0xf0, 0x90, 0x80]),
				changed: false,
				exitCode: 0,
				errorCode: 'invalid-encoding',
			},
			{ body: Buffer.from('four'), changed: true, exitCode: 0, errorCode: 'too-large' },
			{ body: Buffer.from(''), changed: false, exitCode: 72, errorCode: 'too-large' },
		])(
			'keeps descriptor ownership independent of content availability %#',
			async ({ body, changed, exitCode, errorCode }) => {
				const deps = createMockDeps({
					stdout:
						JSON.stringify({ identity, contentChanged: changed }) +
						'\n' +
						Buffer.concat([body, Buffer.from('\n0')]).toString('base64'),
					stderr: '',
					exitCode,
				});
				const result = await readFileRemote('/alias', baseConfig, deps, {
					maxBytes: 3,
					expectedIdentity: identity,
				});
				expect(result).toMatchObject({
					success: !errorCode,
					observedIdentity: identity,
					contentChanged: changed,
				});
				if (errorCode) {
					expect(result.errorCode).toBe(errorCode);
					expect(result.data).toBeUndefined();
				} else expect(result.data).toBe(body.toString('utf8'));
				expect(deps.execSsh).toHaveBeenCalledTimes(1);
			}
		);

		it.each([
			'{}',
			'{',
			JSON.stringify({ identity }),
			JSON.stringify({ identity, contentChanged: 'false' }),
			...[
				{ canonicalPath: '/replaced' },
				{ inode: '2' },
				{ device: '2' },
				{ kind: 'directory' },
			].map((patch) =>
				JSON.stringify({ identity: { ...identity, ...patch }, contentChanged: false })
			),
			' '.repeat(100001),
		])(
			'never exposes content from malformed or mismatched descriptor header %#',
			async (header) => {
				const deps = createMockDeps({ stdout: header + '\neAow', stderr: '', exitCode: 0 });
				expect(
					await readFileRemote('/alias', baseConfig, deps, {
						maxBytes: 8,
						expectedIdentity: identity,
					})
				).toEqual({
					success: false,
					errorCode: 'identity-unavailable',
					error: 'Remote descriptor identity unavailable',
				});
			}
		);

		it.each([
			['~/account 雪/file', '"$HOME/account 雪/file"'],
			["/account's/file", "'/account'\\''s/file'"],
			['-n', "'-n'"],
			['/a/$(whoami);`id`', "'/a/$(whoami);`id`'"],
		])('quotes observer/read path %s and every guarded alias', async (filePath, escaped) => {
			const deps = createMockDeps({ stdout: '', stderr: '', exitCode: 70 });
			vi.mocked(deps.buildSshArgs).mockImplementation(() => ['testuser@dev.example.com']);
			await observePathRemote(filePath, baseConfig, deps);
			await readFileRemote(filePath, baseConfig, deps, {
				maxBytes: 8,
				expectedIdentity: identity,
				expectedPaths: [{ path: "~/parent's 雪", identity: { ...identity, kind: 'directory' } }],
			});
			const commands = vi.mocked(deps.execSsh).mock.calls.map((call) => call[1].at(-1)!);
			expect(commands[0]).toMatch(/^python3 -I -S -B -c /);
			expect(commands[0].endsWith(' ' + escaped)).toBe(true);
			expect(commands[1]).toContain(` ${escaped} 8 '${JSON.stringify(identity)}'`);
			expect(commands[1]).toContain(' "$HOME/parent\'s 雪" ');
		});

		it.each(['observe', 'launch', 'read'])(
			'bounds the default %s SSH timeout',
			async (operation) => {
				vi.mocked(execFileNoThrow).mockResolvedValueOnce({
					stdout: '',
					stderr: 'unavailable',
					exitCode: 70,
				});
				if (operation === 'observe') await observePathRemote('/alias', baseConfig);
				else if (operation === 'launch')
					await observePathRemote('/alias', baseConfig, undefined, { env: {} });
				else
					await readFileRemote('/alias', baseConfig, undefined, {
						maxBytes: 1,
						expectedIdentity: identity,
					});
				expect(execFileNoThrow).toHaveBeenCalledExactlyOnceWith(
					'ssh',
					expect.any(Array),
					undefined,
					{
						timeout: 30000,
						input: undefined,
					}
				);
			}
		);
	});

	// This transport executes the emitted program; response-only mocks above do not.
	describe('emitted Python against disposable POSIX fixtures', () => {
		let root: string;
		let transcript: string;
		let alias: string;
		let account: string;
		let fault = '';
		let deps: RemoteFsDeps;
		let inherited: NodeJS.ProcessEnv;
		let passwdHome: string | null;
		const audits: Array<{
			reads: number;
			bytes: number;
			requests: number[];
			opened: number;
			closed: number;
			live: number;
			alarm: number;
			writes: string[];
			flags: number[];
			outputBytes: number;
			fileOpens: string[];
			passwdCalls: number;
			mutations: number;
		}> = [];
		// Instrument syscalls, not the program's branches. Faults model an external writer.
		const instrument = `import os, sys, json, shlex, signal, errno, stat, base64, pwd, types
v = json.load(sys.stdin)
args = shlex.split(v['command'])
root, fault = v['root'], v['fault']
launch = args[0] == '/bin/bash'
if launch:
 assert args[:4] == ['/bin/bash', '--norc', '--noprofile', '-c'] and len(args) == 5
 args = shlex.split(args[4])
 # Only the new absolute-cwd cases use this transport. Real Bash controls below
 # separately verify shell cd and literal export semantics.
 assert args[:6] == ['cd', root, '||', 'exit', '70;', 'exec']
 args = args[6:]
assert args[:5] == ['python3', '-I', '-S', '-B', '-c']
program, sys.argv = args[5], ['-c'] + args[6:]
assert all(os.path.commonpath([root, p]) == root for p in sys.argv[1:] if p.startswith('/'))
audit = dict(reads=0, bytes=0, requests=[], opened=0, closed=0, live=0, alarm=0,
 writes=[], flags=[], fileOpens=[], passwdCalls=0, mutations=0)
opened = set()
original_open, original_read, original_close = os.open, os.read, os.close
original_stat = os.stat
original_alarm = signal.alarm
injected = False
def passwd_home(uid):
 audit['passwdCalls'] += 1
 assert uid == os.getuid()
 if v['passwdHome'] is None: raise KeyError(uid)
 return types.SimpleNamespace(pw_dir=v['passwdHome'])
pwd.getpwuid = passwd_home
def mutation(which):
 global injected
 injected = True
 audit['mutations'] += 1
 try:
  if which == 'replace': os.replace(root + '/replacement', root + '/transcript')
  elif which == 'grow':
   fd = original_open(root + '/transcript', os.O_WRONLY | os.O_APPEND)
   try: os.write(fd, b'yz')
   finally: original_close(fd)
  elif which in ('home', 'cwd'):
   link = root + '/' + which + '-alias'
   os.unlink(link)
   os.symlink(root + '/account-b', link)
  else:
   link = root + ('/account-alias' if which == 'guard' else '/transcript-alias')
   os.unlink(link)
   os.symlink(root + ('/account-b' if which == 'guard' else '/replacement'), link)
 finally: injected = False
def audit_event(event, args):
 writing = event == 'open' and args[2] & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND)
 if not injected and (writing or event in ('os.remove', 'os.rename', 'os.symlink', 'os.mkdir')):
  audit['writes'].append(event)
  raise RuntimeError('Reader attempted a mutation')
 if not injected and event == 'open':
  audit['fileOpens'].append(str(args[0]))
  if launch: raise RuntimeError('Launch observer attempted a content read')
sys.addaudithook(audit_event)
def tracked_stat(p, *args, **kw):
 assert os.path.commonpath([root, os.path.abspath(p)]) == root
 result = original_stat(p, *args, **kw)
 trigger = root + ('/account-a/.grok' if fault == 'home' else '/.grok')
 if fault in ('home', 'cwd') and str(p) == trigger and audit['mutations'] == 0:
  mutation(fault)
 return result
os.stat = tracked_stat
def tracked_open(p, flags, *rest, **kw):
 if fault == 'replace-before-open': mutation('replace')
 fd = original_open(p, flags, *rest, **kw)
 opened.add(fd)
 audit['opened'] += 1
 audit['flags'].append(flags)
 if fault in ('alias-before', 'guard-before'): mutation(fault.split('-')[0])
 return fd
def tracked_read(fd, count):
 audit['reads'] += 1
 audit['requests'].append(count)
 if fault == 'read-error': raise OSError(errno.EIO, 'injected read failure')
 data = original_read(fd, count)
 audit['bytes'] += len(data)
 if audit['reads'] == 1 and fault in ('alias-during', 'guard-during', 'grow'):
  mutation(fault.split('-')[0])
 return data
def tracked_close(fd):
 original_close(fd)
 audit['closed'] += 1
 opened.remove(fd)
def tracked_alarm(seconds):
 audit['alarm'] = seconds
 return original_alarm(seconds)
os.open, os.read, os.close, signal.alarm = tracked_open, tracked_read, tracked_close, tracked_alarm
if fault == 'unsupported': del os.O_NOFOLLOW
try: exec(compile(program, '<emitted-remote-observer>', 'exec'))
finally:
 for fd in opened:
  try: os.fstat(fd); audit['live'] += 1
  except OSError as exc:
   if exc.errno != errno.EBADF: raise
 sys.stderr.write('\\nAUDIT:' + json.dumps(audit))
`;

		beforeEach((context) => {
			root = '';
			audits.length = 0;
			if (process.platform === 'win32') context.skip(true, 'POSIX Python observer requires POSIX');
			const probe = spawnSync(
				'python3',
				[
					'-I',
					'-S',
					'-B',
					'-c',
					'import os, signal; assert hasattr(os, "O_NOFOLLOW") and hasattr(signal, "alarm")',
				],
				{ timeout: 3000 }
			);
			if (probe.error || probe.status !== 0)
				context.skip(true, 'Python 3 descriptor APIs unavailable');
			const parent = path.resolve('tmp');
			fs.mkdirSync(parent, { recursive: true });
			root = fs.realpathSync(fs.mkdtempSync(path.join(parent, 'remote-identity-')));
			transcript = path.join(root, 'transcript');
			alias = path.join(root, 'transcript-alias');
			account = path.join(root, 'account-alias');
			for (const dir of ['account-a', 'account-b', 'pool']) fs.mkdirSync(path.join(root, dir));
			fs.writeFileSync(transcript, 'x');
			fs.writeFileSync(path.join(root, 'replacement'), 'other');
			fs.symlinkSync(transcript, alias);
			fs.symlinkSync(path.join(root, 'account-a'), account);
			fs.symlinkSync(path.join(root, 'pool'), path.join(root, 'account-a/sessions'));
			fault = '';
			inherited = { PATH: process.env.PATH, HOME: root, GROK_HOME: account };
			passwdHome = null;
			deps = createMockDeps({ stdout: '', stderr: '', exitCode: 0 });
			vi.mocked(deps.buildSshArgs).mockImplementation(() => ['inert-fixture-host']);
			vi.mocked(deps.execSsh).mockImplementation(async (_ssh, args) => {
				const result = spawnSync('python3', ['-I', '-S', '-B', '-c', instrument], {
					input: JSON.stringify({ command: args.at(-1), root, fault, passwdHome }),
					env: inherited,
					encoding: 'utf8',
					cwd: root,
					timeout: 3000,
					maxBuffer: 1024 * 1024,
				});
				expect(result.error).toBeUndefined();
				expect(result.signal).toBeNull();
				const marker = result.stderr.lastIndexOf('\nAUDIT:');
				expect(marker).toBeGreaterThanOrEqual(0);
				audits.push({
					...JSON.parse(result.stderr.slice(marker + 7)),
					outputBytes: Buffer.byteLength(result.stdout),
				});
				return {
					stdout: result.stdout,
					stderr: result.stderr.slice(0, marker),
					exitCode: result.status!,
				};
			});
		});
		afterEach(() => {
			if (root) fs.rmSync(root, { recursive: true, force: true });
			for (const audit of audits) {
				expect(audit).toMatchObject({ live: 0, alarm: 25, writes: [] });
				expect(audit.closed).toBe(audit.opened);
			}
		});

		describe('audited Grok launch ownership', () => {
			beforeEach(() => {
				for (const dir of ['.grok', 'passwd-home/.grok', 'account-a/.grok', 'account-b/.grok']) {
					fs.mkdirSync(path.join(root, dir), { recursive: true });
					// Synthetic contents make unexpected access detectable without real account data.
					fs.writeFileSync(path.join(root, dir, 'auth.json'), '{"fixture":"not-a-credential"}');
					fs.writeFileSync(path.join(root, dir, 'chat_history.jsonl'), '{"fixture":"not-a-chat"}');
				}
			});
			afterEach(() => {
				if (!root) return; // The enclosing POSIX prerequisite may skip this case.
				expect(audits).toHaveLength(1);
				expect(audits[0]).toMatchObject({
					fileOpens: [],
					reads: 0,
					bytes: 0,
					opened: 0,
					closed: 0,
					live: 0,
					writes: [],
				});
				expect(deps.execSsh).toHaveBeenCalledTimes(1);
			});

			it.each(
				[undefined, ''].flatMap((home) =>
					[
						{
							label: 'fixture home',
							passwd: 'passwd-home',
							success: true,
							suffix: 'passwd-home/.grok',
						},
						{ label: 'empty passwd home', passwd: '', success: true, suffix: '.grok' },
						{ label: 'missing passwd entry', passwd: null, success: false, suffix: '' },
						{
							label: 'missing passwd directory',
							passwd: 'missing-home',
							success: false,
							suffix: '',
						},
					].map((scenario) => ({ home, ...scenario }))
				)
			)(
				'uses only the stubbed passwd fallback for HOME=$home, $label',
				async ({ home, passwd, success, suffix }) => {
					inherited.HOME = home;
					delete inherited.GROK_HOME;
					passwdHome = passwd ? path.join(root, passwd) : passwd;
					const result = await observePathRemote(root, baseConfig, deps, { env: {} });
					if (success) {
						expect(result).toMatchObject({
							success: true,
							data: {
								account: { canonicalPath: path.join(root, suffix), kind: 'directory' },
								inherited: { HOME: home ?? null, GROK_HOME: null },
								effective: { HOME: home ?? null, GROK_HOME: null },
							},
						});
					} else {
						expect(result).toMatchObject({ success: false, errorCode: 'identity-unavailable' });
						expect(result.data).toBeUndefined();
					}
					expect(audits[0]).toMatchObject({ passwdCalls: 1, mutations: 0 });
				}
			);

			it.each([undefined, ''])(
				'resolves empty passwd home from native process cwd with HOME=%j',
				async (home) => {
					inherited.HOME = home;
					delete inherited.GROK_HOME;
					passwdHome = '';
					const nativeCwd = path.join(root, 'account-a');
					expect(
						await observePathRemote(root, baseConfig, deps, { env: {}, nativeCwd })
					).toMatchObject({
						success: true,
						data: {
							launchCwd: { canonicalPath: root },
							processCwd: { canonicalPath: nativeCwd },
							cwd: { canonicalPath: nativeCwd },
							account: { canonicalPath: path.join(nativeCwd, '.grok') },
						},
					});
					expect(audits[0]).toMatchObject({ passwdCalls: 1, mutations: 0 });
				}
			);

			it.each([undefined, ''])(
				'keeps an explicit account independent of HOME=%j and missing passwd',
				async (home) => {
					inherited.HOME = home;
					const result = await observePathRemote(root, baseConfig, deps, { env: {} });
					expect(result).toMatchObject({
						success: true,
						data: { account: { canonicalPath: path.join(root, 'account-a') } },
					});
					expect(audits[0]).toMatchObject({ passwdCalls: 0, mutations: 0 });
				}
			);

			it.each(['home', 'cwd'] as const)(
				'rejects a %s alias retargeted after initial observation',
				async (scenario) => {
					const link = path.join(root, `${scenario}-alias`);
					fs.symlinkSync(path.join(root, 'account-a'), link);
					inherited.HOME = scenario === 'home' ? link : root;
					inherited.GROK_HOME = scenario === 'home' ? undefined : path.join(root, '.grok');
					fault = scenario;
					const result = await observePathRemote(root, baseConfig, deps, {
						env: {},
						nativeCwd: scenario === 'cwd' ? link : undefined,
					});
					expect(result).toMatchObject({ success: false, errorCode: 'identity-mismatch' });
					expect(result.data).toBeUndefined();
					expect(audits[0]).toMatchObject({ passwdCalls: 0, mutations: 1 });
					expect(fs.realpathSync(link)).toBe(path.join(root, 'account-b'));
				}
			);
		});

		describe('Grok launch environment through the emitted bash wrapper', () => {
			beforeEach(() => {
				inherited = { PATH: process.env.PATH, HOME: root, GROK_HOME: account };
				for (const dir of [
					'.grok',
					'  ',
					'~/literal',
					"account 雪's",
					'alternate/.grok',
					'workspace/step/step',
				])
					fs.mkdirSync(path.join(root, dir), { recursive: true });
				vi.mocked(deps.execSsh).mockImplementation(async (_ssh, args) => {
					const command = args.at(-1)!;
					expect(command).toMatch(/^\/bin\/bash --norc --noprofile -c /);
					expect(command).not.toContain('secret-must-not-travel');
					const result = spawnSync('/bin/bash', ['--norc', '--noprofile', '-c', command], {
						env: inherited,
						cwd: root,
						encoding: 'utf8',
						timeout: 3000,
						maxBuffer: 128 * 1024,
					});
					expect(result.error).toBeUndefined();
					expect(result.signal).toBeNull();
					return { stdout: result.stdout, stderr: result.stderr, exitCode: result.status! };
				});
			});

			it.each([
				['inherited', undefined, 'account-a'],
				['empty', '', '.grok'],
				['whitespace', '  ', '  '],
				['relative', 'account-b', 'account-b'],
				['literal tilde', '~/literal', '~/literal'],
				['quoted Unicode', "account 雪's", "account 雪's"],
			])(
				'observes %s GROK_HOME without rewriting its native meaning',
				async (_label, value, suffix) => {
					const result = await observePathRemote(root, baseConfig, deps, {
						env: { GROK_HOME: value, GROK_AUTH: 'secret-must-not-travel' },
					});
					expect(result).toMatchObject({
						success: true,
						data: {
							account: { canonicalPath: path.join(root, suffix!), kind: 'directory' },
							inherited: { HOME: root, GROK_HOME: account },
							effective: { HOME: root, GROK_HOME: value ?? account },
						},
					});
					expect(deps.execSsh).toHaveBeenCalledTimes(1);
				}
			);

			it.each([undefined, ''])(
				'uses exported HOME after shell cd when GROK_HOME is %j',
				async (value) => {
					delete inherited.GROK_HOME;
					const result = await observePathRemote('~/workspace', baseConfig, deps, {
						env: { HOME: path.join(root, 'alternate'), GROK_HOME: value },
					});
					expect(result).toMatchObject({
						success: true,
						data: {
							launchCwd: { canonicalPath: path.join(root, 'workspace') },
							cwd: { canonicalPath: path.join(root, 'workspace') },
							account: { canonicalPath: path.join(root, 'alternate/.grok') },
							inherited: { HOME: root, GROK_HOME: null },
							effective: { HOME: path.join(root, 'alternate'), GROK_HOME: value ?? null },
						},
					});
				}
			);

			it('resolves relative account from native process cwd and repeats native cwd for the session', async () => {
				const result = await observePathRemote('~/workspace', baseConfig, deps, {
					env: { GROK_HOME: '../../account-b' },
					nativeCwd: 'step',
				});
				expect(result).toMatchObject({
					success: true,
					data: {
						launchCwd: { canonicalPath: path.join(root, 'workspace') },
						processCwd: { canonicalPath: path.join(root, 'workspace/step') },
						cwd: { canonicalPath: path.join(root, 'workspace/step/step') },
						account: { canonicalPath: path.join(root, 'account-b') },
					},
				});
			});

			it('honors explicit account even with unavailable HOME and an absolute native cwd', async () => {
				const result = await observePathRemote(root, baseConfig, deps, {
					env: { HOME: '/absent-fixture-home', GROK_HOME: account },
					nativeCwd: path.join(root, 'workspace'),
				});
				expect(result).toMatchObject({
					success: true,
					data: {
						account: { canonicalPath: path.join(root, 'account-a') },
						processCwd: { canonicalPath: path.join(root, 'workspace') },
						cwd: { canonicalPath: path.join(root, 'workspace') },
					},
				});
			});

			it.each([
				{ env: { GROK_HOME: 'missing-account' } },
				{ env: { GROK_HOME: 'transcript' } },
				{ env: { GROK_HOME: '', HOME: '~/missing-home' } },
				{ env: {}, nativeCwd: '~/workspace' },
				{ env: {}, nativeCwd: '' },
			])(
				'refuses absent/non-directory literal paths without creation or fallback %#',
				async (options) => {
					const before = fs.readdirSync(root, { recursive: true }).sort();
					expect(await observePathRemote(root, baseConfig, deps, options)).toMatchObject({
						success: false,
						errorCode: 'identity-unavailable',
					});
					expect(fs.readdirSync(root, { recursive: true }).sort()).toEqual(before);
					expect(deps.execSsh).toHaveBeenCalledTimes(1);
				}
			);
		});

		it('observes canonical account, sessions and transcript aliases without reading or writing', async () => {
			for (const [logical, physical, kind] of [
				[account, path.join(root, 'account-a'), 'directory'],
				[path.join(account, 'sessions'), path.join(root, 'pool'), 'directory'],
				[alias, transcript, 'file'],
			]) {
				const observed = await observePathRemote(logical, baseConfig, deps);
				const stat = fs.statSync(physical, { bigint: true });
				expect(observed).toEqual({
					success: true,
					data: {
						canonicalPath: physical,
						kind,
						device: String(stat.dev),
						inode: String(stat.ino),
					},
				});
				expect(audits.at(-1)).toMatchObject({ reads: 0, opened: 0 });
			}
		});

		it.each(['missing', 'transcript/child'])(
			'refuses absent/non-directory root %s',
			async (suffix) => {
				expect(await observePathRemote(path.join(root, suffix), baseConfig, deps)).toMatchObject({
					success: false,
					errorCode: 'identity-unavailable',
				});
				expect(audits.at(-1)).toMatchObject({ reads: 0, opened: 0 });
			}
		);

		it.each([
			['replace-before-open', 'identity-mismatch', 0, 1],
			['alias-before', 'identity-mismatch', 0, 1],
			['guard-before', 'identity-mismatch', 0, 1],
			['alias-during', 'identity-mismatch', 2, 1],
			['guard-during', 'identity-mismatch', 2, 1],
			['read-error', undefined, 1, 1],
			['unsupported', 'identity-unavailable', 0, 0],
		] as const)(
			'rejects %s and closes every descriptor',
			async (scenario, errorCode, reads, opened) => {
				const expected = (await observePathRemote(alias, baseConfig, deps)).data!;
				const guard = (await observePathRemote(account, baseConfig, deps)).data!;
				fault = scenario;
				const result = await readFileRemote(alias, baseConfig, deps, {
					maxBytes: 8,
					expectedIdentity: expected,
					expectedPaths: [{ path: account, identity: guard }],
				});
				expect(result).toMatchObject({ success: false, errorCode });
				expect(result.data).toBeUndefined();
				expect(result.observedIdentity).toBeUndefined();
				expect(audits.at(-1)).toMatchObject({ reads, opened, closed: opened, live: 0 });
			}
		);

		it.each([
			{ content: '雪', cap: 3, grow: false, bytes: 3, success: true, reads: 2 },
			{
				content: 'x'.repeat(65537),
				cap: 65537,
				grow: false,
				bytes: 65537,
				success: true,
				reads: 3,
			},
			{ content: '', cap: 1, grow: false, bytes: 0, success: true, reads: 1 },
			{ content: 'four', cap: 3, grow: false, bytes: 0, success: false, reads: 0 },
			{ content: 'x', cap: 8, grow: true, bytes: 3, success: true, reads: 3 },
			{ content: 'x', cap: 1, grow: true, bytes: 2, success: false, reads: 2 },
		])(
			'bounds actual content and sentinel reads %#',
			async ({ content, cap, grow, bytes, success, reads }) => {
				fs.writeFileSync(transcript, content);
				const names = fs.readdirSync(root, { recursive: true }).sort();
				const before = fs.statSync(transcript);
				const expected = (await observePathRemote(alias, baseConfig, deps)).data!;
				fault = grow ? 'grow' : '';
				const result = await readFileRemote(alias, baseConfig, deps, {
					maxBytes: cap,
					expectedIdentity: expected,
				});
				expect(result).toMatchObject({ success, observedIdentity: expected, contentChanged: grow });
				if (success) expect(result.data).toBe(content + (grow ? 'yz' : ''));
				else {
					expect(result.errorCode).toBe('too-large');
					expect(result.data).toBeUndefined();
				}
				const audit = audits.at(-1)!;
				expect(audit).toMatchObject({ bytes, reads, opened: 1, closed: 1 });
				expect(bytes).toBeLessThanOrEqual(cap + 1);
				expect(audit.outputBytes).toBeLessThanOrEqual(100001 + 4 * Math.ceil((cap + 3) / 3));
				expect(audit.requests.every((count) => count <= Math.min(65536, cap + 1))).toBe(true);
				expect(
					audit.flags[0] & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT)
				).toBe(0);
				expect(fs.readdirSync(root, { recursive: true }).sort()).toEqual(names);
				expect(fs.readFileSync(transcript, 'utf8')).toBe(content + (grow ? 'yz' : ''));
				if (!grow) expect(fs.statSync(transcript).mtimeMs).toBe(before.mtimeMs);
			}
		);
	});

	describe('readFileRemote', () => {
		afterEach(() => {
			vi.useRealTimers();
			vi.restoreAllMocks();
			try {
				expect(execFileNoThrow).not.toHaveBeenCalled();
			} finally {
				vi.clearAllMocks();
			}
		});

		it.each([undefined, {}, { maxBytes: undefined }])(
			'keeps legacy commands and raw output when the budget is absent: %j',
			async (options) => {
				const stdout = 'not base64: \uFFFD\0\n0\n';
				const deps = createMockDeps({ stdout, stderr: '', exitCode: 0 });
				expect(await readFileRemote('~/project/file.txt', baseConfig, deps, options)).toEqual({
					success: true,
					data: stdout,
				});
				expect(vi.mocked(deps.execSsh).mock.calls[0][1].slice(-1)).toEqual([
					'cat "$HOME/project/file.txt"',
				]);
				expect(deps.execSsh).toHaveBeenCalledTimes(1);
			}
		);

		it.each([0, -1, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER, 104857600, 104857601])(
			'rejects invalid byte budget %s before transport or argument construction',
			async (maxBytes) => {
				const deps = createMockDeps({ stdout: '', stderr: '', exitCode: 0 });
				await expect(readFileRemote('/file', baseConfig, deps, { maxBytes })).rejects.toThrow(
					RangeError
				);
				expect(deps.execSsh).not.toHaveBeenCalled();
				expect(deps.buildSshArgs).not.toHaveBeenCalled();
			}
		);

		it.each([
			['', 1],
			['a', 1],
			['abc', 3],
			['abc', 4],
			['é', 2],
			['雪', 3],
			['😀', 4],
			['\uFFFD', 3],
			['\uFEFF\0\r\n0\n255\n', 14],
			['a'.repeat(65535) + '😀', 65539],
			['small', 104857599],
		] as const)('round-trips bounded UTF-8 case %#', async (content, maxBytes) => {
			const deps = createMockDeps({
				stdout: Buffer.from(content + '\n0').toString('base64'),
				stderr: '',
				exitCode: 0,
			});
			expect(await readFileRemote('/file', baseConfig, deps, { maxBytes })).toEqual({
				success: true,
				data: content,
			});
			expect(deps.execSsh).toHaveBeenCalledTimes(1);
		});

		it.each(['\n', '\r\n'])(
			'accepts base64 line wrapping %j across Unicode bytes',
			async (newline) => {
				const content = 'x'.repeat(56) + '😀雪\uFFFD\n0\n';
				const encoded = Buffer.from(content + '\n0').toString('base64');
				const deps = createMockDeps({
					stdout: encoded.match(/.{1,76}/g)!.join(newline) + newline,
					stderr: '',
					exitCode: 0,
				});
				expect(
					await readFileRemote('/file', baseConfig, deps, { maxBytes: Buffer.byteLength(content) })
				).toEqual({ success: true, data: content });
			}
		);

		it.each([
			[0xf0, 0x90, 0x80], // Same byte count after lossy decoding: must inspect original bytes.
			[0x80],
			[0xc0, 0xaf],
			[0xed, 0xa0, 0x80],
			[0xf4, 0x90, 0x80, 0x80],
			[0xe2, 0x82],
		])('rejects malformed UTF-8 case %# without returning replacement text', async (...bytes) => {
			const deps = createMockDeps({
				stdout: Buffer.from([...bytes, 0x0a, 0x30]).toString('base64'),
				stderr: '',
				exitCode: 0,
			});
			expect(await readFileRemote('/file', baseConfig, deps, { maxBytes: bytes.length })).toEqual({
				success: false,
				error: 'File is not valid UTF-8: /file',
				errorCode: 'invalid-encoding',
			});
		});

		it.each([
			{ bytes: Buffer.from('abcd'), maxBytes: 3 },
			// The sentinel cuts through an emoji; overflow takes precedence over encoding.
			{ bytes: Buffer.from([0x61, 0xf0, 0x9f]), maxBytes: 2 },
			// An oversized peer response is rejected before decoding its allocation.
			{ bytes: Buffer.alloc(1024, 0x61), maxBytes: 3 },
		])('rejects sentinel or transport overflow case %#', async ({ bytes, maxBytes }) => {
			const deps = createMockDeps({
				stdout: Buffer.concat([bytes, Buffer.from('\n0')]).toString('base64'),
				stderr: '',
				exitCode: 0,
			});
			expect(await readFileRemote('/file', baseConfig, deps, { maxBytes })).toEqual({
				success: false,
				error: `File exceeds the ${maxBytes} byte read limit: /file`,
				errorCode: 'too-large',
			});
		});

		it('keeps a growing remote file bounded to one sentinel without rereading', async () => {
			const deps = createMockDeps({ stdout: '', stderr: '', exitCode: 0 });
			const grownFile = Buffer.alloc(1024 * 1024, 0x61);
			vi.mocked(deps.execSsh).mockImplementation(async (_ssh, args) => {
				const command = args[args.length - 1];
				expect(command).toContain("head -c 5 < '/file'");
				const requested = Number(command.match(/head -c (\d+) </)![1]);
				return {
					stdout: Buffer.concat([grownFile.subarray(0, requested), Buffer.from('\n0')]).toString(
						'base64'
					),
					stderr: '',
					exitCode: 0,
				};
			});
			expect(await readFileRemote('/file', baseConfig, deps, { maxBytes: 4 })).toMatchObject({
				success: false,
				errorCode: 'too-large',
			});
			expect(deps.execSsh).toHaveBeenCalledTimes(1);
		});

		it.each(['!', 'YQ=', 'YQ===', '=YQ=', 'Y Q=', 'YQ-_', 'YQ==\t'])(
			'rejects malformed base64 %j',
			async (stdout) => {
				const deps = createMockDeps({ stdout, stderr: '', exitCode: 0 });
				expect(await readFileRemote('/file', baseConfig, deps, { maxBytes: 16 })).toEqual({
					success: false,
					error: 'Invalid base64 file response: /file',
				});
			}
		);

		it.each([
			'',
			'body',
			'body\n',
			'body\n00',
			'body\n-1',
			'body\n256',
			'body\n1000',
			'body\nx',
			'body\n0\n',
			'body\n0\r',
		])('rejects missing or malformed head status %j', async (frame) => {
			const deps = createMockDeps({
				stdout: Buffer.from(frame).toString('base64'),
				stderr: '',
				exitCode: 0,
			});
			expect(await readFileRemote('/file', baseConfig, deps, { maxBytes: 16 })).toEqual({
				success: false,
				error: 'Missing remote file read status: /file',
			});
		});

		it.each([
			['~', '"$HOME"'],
			['~/account 雪/file', '"$HOME/account 雪/file"'],
			['~/a "quote"/$value', '"$HOME/a \\"quote\\"/\\$value"'],
			['$HOME/account space/file', '"$HOME/account space/file"'],
			["/account's/file", "'/account'\\''s/file'"],
			['-n', "'-n'"],
			['/space dir/$value;$(whoami)`id`\nfile', "'/space dir/$value;$(whoami)`id`\nfile'"],
		])(
			'guards and escapes remote path %j before bounded redirection',
			async (filePath, escaped) => {
				const deps = createMockDeps({ stdout: 'eAow', stderr: '', exitCode: 0 });
				// Fixed wire fixture is x + newline + status 0, independent of command assembly.
				expect(await readFileRemote(filePath, baseConfig, deps, { maxBytes: 1 })).toEqual({
					success: true,
					data: 'x',
				});
				expect(vi.mocked(deps.execSsh).mock.calls[0]).toEqual([
					'ssh',
					[
						'-i',
						'/home/user/.ssh/id_ed25519',
						'-o',
						'BatchMode=yes',
						'-p',
						'22',
						'testuser@dev.example.com',
						`if test -f ${escaped}; then { head -c 2 < ${escaped}; printf '\\n%s' "$?"; } | base64; else echo 'File not found or not a regular file' >&2; exit 1; fi`,
					],
					undefined,
				]);
				expect(deps.buildSshArgs).toHaveBeenCalledWith(baseConfig);
			}
		);

		it.each(['directory', 'fifo', 'device', 'missing', 'dangling-symlink'])(
			'discloses a rejected %s path with no partial content',
			async (kind) => {
				const deps = createMockDeps({
					stdout: '',
					stderr: 'File not found or not a regular file\n',
					exitCode: 1,
				});
				expect(
					await readFileRemote(`/fixture/${kind}`, baseConfig, deps, { maxBytes: 16 })
				).toEqual({
					success: false,
					error: 'File not found or not a regular file\n',
				});
				expect(deps.execSsh).toHaveBeenCalledTimes(1);
			}
		);

		it.each([
			['head: No such file or directory', 'File not found: /file'],
			['head: Permission denied', 'Permission denied: /file'],
			['head: Is a directory', 'Path is a directory: /file'],
			['head: Input/output error', 'head: Input/output error'],
			['', 'Failed to read file: /file'],
		])(
			'preserves read failure %j even after partial bytes and successful base64',
			async (stderr, error) => {
				for (const status of [1, 255]) {
					const deps = createMockDeps({
						stdout: Buffer.from(`partial\n${status}`).toString('base64'),
						stderr,
						exitCode: 0,
					});
					expect(await readFileRemote('/file', baseConfig, deps, { maxBytes: 16 })).toEqual({
						success: false,
						error,
					});
					expect(deps.execSsh).toHaveBeenCalledTimes(1);
				}
			}
		);

		it.each([
			[1, 'head: Permission denied', 'Permission denied: /file'],
			[1, 'head: No such file or directory', 'File not found: /file'],
			[127, 'base64: command not found', 'base64: command not found'],
			[255, 'Permission denied (publickey).', 'Permission denied: /file'],
		] as const)('does not decode stdout on outer exit %s: %s', async (exitCode, stderr, error) => {
			const deps = createMockDeps({ stdout: 'eAow', stderr, exitCode });
			expect(await readFileRemote('/file', baseConfig, deps, { maxBytes: 16 })).toEqual({
				success: false,
				error,
			});
			expect(deps.execSsh).toHaveBeenCalledTimes(1);
		});

		it.each([undefined, { maxBytes: 16 }])(
			'classifies max-buffer failure only for bounded reads: %j',
			async (options) => {
				const deps = createMockDeps({
					stdout: 'eAow',
					stderr: 'stdout maxBuffer length exceeded',
					exitCode: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
				});
				expect(await readFileRemote('/file', baseConfig, deps, options)).toEqual(
					options
						? {
								success: false,
								error: 'File exceeds the 16 byte read limit: /file',
								errorCode: 'too-large',
							}
						: { success: false, error: 'stdout maxBuffer length exceeded' }
				);
				expect(deps.execSsh).toHaveBeenCalledTimes(1);
			}
		);

		it.each([true, false])(
			'bounds disconnect retries and discards failed output (recovers: %s)',
			async (recovers) => {
				vi.useFakeTimers();
				const deps = createMockDeps({
					stdout: 'cGFydGlhbAow',
					stderr: 'Connection reset by peer',
					exitCode: 255,
				});
				vi.mocked(deps.buildSshArgs).mockImplementation(() => ['testuser@dev.example.com']);
				if (recovers)
					vi.mocked(deps.execSsh)
						.mockResolvedValueOnce({
							stdout: 'cGFydGlhbAow',
							stderr: 'Connection reset by peer',
							exitCode: 255,
						})
						.mockResolvedValue({ stdout: 'eAow', stderr: '', exitCode: 0 });
				const pending = readFileRemote('/file', baseConfig, deps, { maxBytes: 16 });
				await vi.runAllTimersAsync();
				expect(await pending).toEqual(
					recovers
						? { success: true, data: 'x' }
						: { success: false, error: 'Connection reset by peer' }
				);
				expect(deps.execSsh).toHaveBeenCalledTimes(recovers ? 2 : 4);
				const calls = vi.mocked(deps.execSsh).mock.calls;
				for (const call of calls) expect(call).toEqual(calls[0]);
				expect(vi.getTimerCount()).toBe(0);
			}
		);

		it('propagates unexpected transport exceptions without falling back to a real read', async () => {
			const fault = new Error('inert transport fault');
			const deps = createMockDeps({ stdout: '', stderr: '', exitCode: 0 });
			vi.mocked(deps.execSsh).mockRejectedValue(fault);
			await expect(readFileRemote('/file', baseConfig, deps, { maxBytes: 16 })).rejects.toBe(fault);
			expect(deps.execSsh).toHaveBeenCalledTimes(1);
		});

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

		it.each(['No such file or directory', 'no such file or directory'])(
			'maps a missing remote image (%s) to a file-not-found error',
			async (reason) => {
				const deps = createMockDeps({
					stdout: '',
					stderr: `base64: /missing.png: ${reason}`,
					exitCode: 1,
				});

				const result = await readBinaryFileRemoteAsBase64('/missing.png', baseConfig, deps);

				expect(result.success).toBe(false);
				expect(result.error).toContain('File not found');
			}
		);
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
