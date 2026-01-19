import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
	readDirRemote,
	readFileRemote,
	statRemote,
	directorySizeRemote,
	writeFileRemote,
	existsRemote,
	mkdirRemote,
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

			expect(deps.execSsh).toHaveBeenCalledWith('ssh', expect.any(Array));
			const call = (deps.execSsh as any).mock.calls[0][1];
			const remoteCommand = call[call.length - 1];
			// Path should be properly escaped in the command
			expect(remoteCommand).toContain("'/path/with spaces/and'\\''quotes'");
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
});
