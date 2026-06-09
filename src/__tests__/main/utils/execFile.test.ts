/**
 * Tests for src/main/utils/execFile.ts
 *
 * Tests cover the execFileNoThrow function which safely executes
 * commands without shell injection vulnerabilities.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import type { ExecResult } from '../../../main/utils/execFile';

// Create mock function
const mockExecFile = vi.fn();
const mockSpawn = vi.fn();

// Mock child_process module using vi.mock with dynamic import
vi.mock('child_process', async (importOriginal) => {
	const actual = await importOriginal<typeof import('child_process')>();
	return {
		...actual,
		default: {
			...actual,
			execFile: mockExecFile,
			spawn: mockSpawn,
		},
		execFile: mockExecFile,
		spawn: mockSpawn,
	};
});

// Mock util.promisify to return our mock function wrapped in a promise
vi.mock('util', async (importOriginal) => {
	const actual = await importOriginal<typeof import('util')>();
	return {
		...actual,
		default: {
			...actual,
			promisify: (fn: any) => {
				// If it's our mock, return it wrapped
				if (fn === mockExecFile) {
					return async (...args: any[]) => {
						return new Promise((resolve, reject) => {
							mockExecFile(...args, (error: Error | null, stdout: string, stderr: string) => {
								if (error) reject(error);
								else resolve({ stdout, stderr });
							});
						});
					};
				}
				return actual.promisify(fn);
			},
		},
		promisify: (fn: any) => {
			// If it's our mock, return it wrapped
			if (fn === mockExecFile) {
				return async (...args: any[]) => {
					return new Promise((resolve, reject) => {
						mockExecFile(...args, (error: Error | null, stdout: string, stderr: string) => {
							if (error) reject(error);
							else resolve({ stdout, stderr });
						});
					});
				};
			}
			return actual.promisify(fn);
		},
	};
});

describe('execFile.ts', () => {
	const originalPlatform = process.platform;

	function mockPlatform(platform: string): void {
		Object.defineProperty(process, 'platform', {
			value: platform,
			configurable: true,
		});
	}

	function restorePlatform(): void {
		Object.defineProperty(process, 'platform', {
			value: originalPlatform,
			configurable: true,
		});
	}

	function createMockChild() {
		const child = new EventEmitter() as any;
		child.stdout = new EventEmitter();
		child.stderr = new EventEmitter();
		child.stdin = {
			write: vi.fn(),
			end: vi.fn(),
		};
		child.kill = vi.fn(() => {
			child.emit('close', null);
		});
		return child;
	}

	beforeEach(() => {
		vi.clearAllMocks();
		restorePlatform();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		restorePlatform();
		vi.useRealTimers();
	});

	describe('ExecResult interface', () => {
		it('should define the correct structure', () => {
			// Type test - verifying interface shape
			const result: ExecResult = {
				stdout: 'output',
				stderr: 'error',
				exitCode: 0,
			};

			expect(result).toHaveProperty('stdout');
			expect(result).toHaveProperty('stderr');
			expect(result).toHaveProperty('exitCode');
		});
	});

	describe('execFileNoThrow', () => {
		describe('needsWindowsShell', () => {
			it('should require shell execution for Windows batch files', async () => {
				const { needsWindowsShell } = await import('../../../main/utils/execFile');

				expect(needsWindowsShell('deploy.cmd')).toBe(true);
				expect(needsWindowsShell('build.bat')).toBe(true);
			});

			it('should not require shell execution for Windows executable files', async () => {
				const { needsWindowsShell } = await import('../../../main/utils/execFile');

				expect(needsWindowsShell('node.exe')).toBe(false);
				expect(needsWindowsShell('tool.com')).toBe(false);
			});

			it('should not require shell execution for known executable commands without extension', async () => {
				const { needsWindowsShell } = await import('../../../main/utils/execFile');

				for (const command of [
					'git',
					'node',
					'npm',
					'npx',
					'yarn',
					'pnpm',
					'python',
					'python3',
					'pip',
					'pip3',
					'C:\\Program Files\\Git\\bin\\git',
				]) {
					expect(needsWindowsShell(command)).toBe(false);
				}
			});

			it('should require shell execution for unknown commands without extension', async () => {
				const { needsWindowsShell } = await import('../../../main/utils/execFile');

				expect(needsWindowsShell('custom-tool')).toBe(true);
				expect(needsWindowsShell('C:\\Tools\\custom-tool')).toBe(true);
				expect(needsWindowsShell('')).toBe(true);
			});

			it('should not require shell execution for unknown commands with an extension', async () => {
				const { needsWindowsShell } = await import('../../../main/utils/execFile');

				expect(needsWindowsShell('custom-tool.ps1')).toBe(false);
			});
		});

		describe('successful execution', () => {
			it('should return stdout and stderr with exitCode 0 on success', async () => {
				mockExecFile.mockImplementation(
					(_cmd: string, _args: readonly string[], _options: any, callback?: any) => {
						if (callback) {
							callback(null, 'command output', 'stderr output');
						}
						return {} as any;
					}
				);

				const { execFileNoThrow } = await import('../../../main/utils/execFile');
				const result = await execFileNoThrow('echo', ['hello']);

				expect(result).toEqual({
					stdout: 'command output',
					stderr: 'stderr output',
					exitCode: 0,
				});
			});

			it('should call execFile with correct arguments', async () => {
				mockExecFile.mockImplementation(
					(_cmd: string, _args: readonly string[], _options: any, callback?: any) => {
						if (callback) {
							callback(null, 'output', '');
						}
						return {} as any;
					}
				);

				const { execFileNoThrow } = await import('../../../main/utils/execFile');
				await execFileNoThrow('git', ['status', '--short'], '/path/to/repo');

				expect(mockExecFile).toHaveBeenCalledWith(
					'git',
					['status', '--short'],
					expect.objectContaining({
						cwd: '/path/to/repo',
						encoding: 'utf8',
						maxBuffer: 10 * 1024 * 1024, // 10MB
					}),
					expect.any(Function)
				);
			});

			it('should use provided environment variables', async () => {
				mockExecFile.mockImplementation(
					(_cmd: string, _args: readonly string[], _options: any, callback?: any) => {
						if (callback) {
							callback(null, 'output', '');
						}
						return {} as any;
					}
				);

				const { execFileNoThrow } = await import('../../../main/utils/execFile');
				const customEnv = { PATH: '/custom/path', MY_VAR: 'value' };
				await execFileNoThrow('mycmd', [], '/cwd', customEnv);

				expect(mockExecFile).toHaveBeenCalledWith(
					'mycmd',
					[],
					expect.objectContaining({
						env: customEnv,
					}),
					expect.any(Function)
				);
			});

			it('should handle empty arguments array', async () => {
				mockExecFile.mockImplementation(
					(_cmd: string, _args: readonly string[], _options: any, callback?: any) => {
						if (callback) {
							callback(null, 'output', '');
						}
						return {} as any;
					}
				);

				const { execFileNoThrow } = await import('../../../main/utils/execFile');
				const result = await execFileNoThrow('ls');

				expect(result.exitCode).toBe(0);
				expect(mockExecFile).toHaveBeenCalledWith(
					'ls',
					[],
					expect.any(Object),
					expect.any(Function)
				);
			});

			it('should handle empty stdout and stderr', async () => {
				mockExecFile.mockImplementation(
					(_cmd: string, _args: readonly string[], _options: any, callback?: any) => {
						if (callback) {
							callback(null, '', '');
						}
						return {} as any;
					}
				);

				const { execFileNoThrow } = await import('../../../main/utils/execFile');
				const result = await execFileNoThrow('true');

				expect(result).toEqual({
					stdout: '',
					stderr: '',
					exitCode: 0,
				});
			});
		});

		describe('error handling', () => {
			it('should return non-zero exit code on command failure', async () => {
				const error = new Error('Command failed') as any;
				error.code = 1;
				error.stdout = 'partial output';
				error.stderr = 'error message';

				mockExecFile.mockImplementation(
					(_cmd: string, _args: readonly string[], _options: any, callback?: any) => {
						if (callback) {
							callback(error, '', '');
						}
						return {} as any;
					}
				);

				const { execFileNoThrow } = await import('../../../main/utils/execFile');
				const result = await execFileNoThrow('failing-cmd');

				expect(result).toEqual({
					stdout: 'partial output',
					stderr: 'error message',
					exitCode: 1,
				});
			});

			it('should use error.message as stderr when stderr is empty', async () => {
				const error = new Error('Command not found') as any;
				error.code = 127;
				error.stdout = '';
				error.stderr = '';

				mockExecFile.mockImplementation(
					(_cmd: string, _args: readonly string[], _options: any, callback?: any) => {
						if (callback) {
							callback(error, '', '');
						}
						return {} as any;
					}
				);

				const { execFileNoThrow } = await import('../../../main/utils/execFile');
				const result = await execFileNoThrow('nonexistent-cmd');

				expect(result).toEqual({
					stdout: '',
					stderr: 'Command not found',
					exitCode: 127,
				});
			});

			it('should default to exit code 1 when error.code is undefined', async () => {
				const error = new Error('Unknown error') as any;
				error.stdout = '';
				error.stderr = 'some error';

				mockExecFile.mockImplementation(
					(_cmd: string, _args: readonly string[], _options: any, callback?: any) => {
						if (callback) {
							callback(error, '', '');
						}
						return {} as any;
					}
				);

				const { execFileNoThrow } = await import('../../../main/utils/execFile');
				const result = await execFileNoThrow('cmd');

				expect(result.exitCode).toBe(1);
			});

			it('should handle missing stdout on error', async () => {
				const error = new Error('Error') as any;
				error.code = 2;
				error.stderr = 'error output';

				mockExecFile.mockImplementation(
					(_cmd: string, _args: readonly string[], _options: any, callback?: any) => {
						if (callback) {
							callback(error, '', '');
						}
						return {} as any;
					}
				);

				const { execFileNoThrow } = await import('../../../main/utils/execFile');
				const result = await execFileNoThrow('cmd');

				expect(result.stdout).toBe('');
			});

			it('should handle missing stderr and message on error', async () => {
				const error = {} as any;
				error.code = 3;

				mockExecFile.mockImplementation(
					(_cmd: string, _args: readonly string[], _options: any, callback?: any) => {
						if (callback) {
							callback(error, '', '');
						}
						return {} as any;
					}
				);

				const { execFileNoThrow } = await import('../../../main/utils/execFile');
				const result = await execFileNoThrow('cmd');

				expect(result.stderr).toBe('');
			});

			it('should handle ENOENT error (command not found)', async () => {
				const error = new Error('spawn nonexistent ENOENT') as any;
				error.code = 'ENOENT';
				error.stdout = '';
				error.stderr = '';

				mockExecFile.mockImplementation(
					(_cmd: string, _args: readonly string[], _options: any, callback?: any) => {
						if (callback) {
							callback(error, '', '');
						}
						return {} as any;
					}
				);

				const { execFileNoThrow } = await import('../../../main/utils/execFile');
				const result = await execFileNoThrow('nonexistent');

				expect(result.exitCode).toBe('ENOENT');
				expect(result.stderr).toBe('spawn nonexistent ENOENT');
			});

			it('should handle EPERM error (permission denied)', async () => {
				const error = new Error('spawn EPERM') as any;
				error.code = 'EPERM';
				error.stdout = '';
				error.stderr = 'Permission denied';

				mockExecFile.mockImplementation(
					(_cmd: string, _args: readonly string[], _options: any, callback?: any) => {
						if (callback) {
							callback(error, '', '');
						}
						return {} as any;
					}
				);

				const { execFileNoThrow } = await import('../../../main/utils/execFile');
				const result = await execFileNoThrow('/restricted/cmd');

				expect(result.exitCode).toBe('EPERM');
				expect(result.stderr).toBe('Permission denied');
			});
		});

		describe('edge cases', () => {
			it('should handle commands with special characters in arguments', async () => {
				mockExecFile.mockImplementation(
					(_cmd: string, _args: readonly string[], _options: any, callback?: any) => {
						if (callback) {
							callback(null, 'output', '');
						}
						return {} as any;
					}
				);

				const { execFileNoThrow } = await import('../../../main/utils/execFile');
				await execFileNoThrow('echo', ['hello world', 'test=value', '"quoted"']);

				expect(mockExecFile).toHaveBeenCalledWith(
					'echo',
					['hello world', 'test=value', '"quoted"'],
					expect.any(Object),
					expect.any(Function)
				);
			});

			it('should handle undefined cwd', async () => {
				mockExecFile.mockImplementation(
					(_cmd: string, _args: readonly string[], _options: any, callback?: any) => {
						if (callback) {
							callback(null, 'output', '');
						}
						return {} as any;
					}
				);

				const { execFileNoThrow } = await import('../../../main/utils/execFile');
				await execFileNoThrow('pwd', [], undefined);

				expect(mockExecFile).toHaveBeenCalledWith(
					'pwd',
					[],
					expect.objectContaining({
						cwd: undefined,
					}),
					expect.any(Function)
				);
			});

			it('should handle undefined env', async () => {
				mockExecFile.mockImplementation(
					(_cmd: string, _args: readonly string[], _options: any, callback?: any) => {
						if (callback) {
							callback(null, 'output', '');
						}
						return {} as any;
					}
				);

				const { execFileNoThrow } = await import('../../../main/utils/execFile');
				await execFileNoThrow('env', [], '/cwd', undefined);

				expect(mockExecFile).toHaveBeenCalledWith(
					'env',
					[],
					expect.objectContaining({
						env: undefined,
					}),
					expect.any(Function)
				);
			});

			it('should handle large output within buffer limit', async () => {
				const largeOutput = 'x'.repeat(1024 * 1024); // 1MB

				mockExecFile.mockImplementation(
					(_cmd: string, _args: readonly string[], _options: any, callback?: any) => {
						if (callback) {
							callback(null, largeOutput, '');
						}
						return {} as any;
					}
				);

				const { execFileNoThrow } = await import('../../../main/utils/execFile');
				const result = await execFileNoThrow('cat', ['largefile']);

				expect(result.stdout).toBe(largeOutput);
				expect(result.exitCode).toBe(0);
			});

			it('should handle unicode in stdout', async () => {
				const unicodeOutput = '你好世界 🎵 مرحبا';

				mockExecFile.mockImplementation(
					(_cmd: string, _args: readonly string[], _options: any, callback?: any) => {
						if (callback) {
							callback(null, unicodeOutput, '');
						}
						return {} as any;
					}
				);

				const { execFileNoThrow } = await import('../../../main/utils/execFile');
				const result = await execFileNoThrow('echo', [unicodeOutput]);

				expect(result.stdout).toBe(unicodeOutput);
			});

			it('should handle multiline output', async () => {
				const multilineOutput = 'line1\nline2\nline3\n';

				mockExecFile.mockImplementation(
					(_cmd: string, _args: readonly string[], _options: any, callback?: any) => {
						if (callback) {
							callback(null, multilineOutput, '');
						}
						return {} as any;
					}
				);

				const { execFileNoThrow } = await import('../../../main/utils/execFile');
				const result = await execFileNoThrow('ls', ['-la']);

				expect(result.stdout).toBe(multilineOutput);
			});

			it('should handle error with numeric code', async () => {
				const error = new Error('Exit with code 128') as any;
				error.code = 128;
				error.stdout = '';
				error.stderr = 'fatal: not a git repository';

				mockExecFile.mockImplementation(
					(_cmd: string, _args: readonly string[], _options: any, callback?: any) => {
						if (callback) {
							callback(error, '', '');
						}
						return {} as any;
					}
				);

				const { execFileNoThrow } = await import('../../../main/utils/execFile');
				const result = await execFileNoThrow('git', ['status']);

				expect(result.exitCode).toBe(128);
				expect(result.stderr).toBe('fatal: not a git repository');
			});

			it('should handle error code 0 (falsy but valid)', async () => {
				const error = new Error('Weird error') as any;
				error.code = 0;
				error.stdout = 'output';
				error.stderr = '';

				mockExecFile.mockImplementation(
					(_cmd: string, _args: readonly string[], _options: any, callback?: any) => {
						if (callback) {
							callback(error, '', '');
						}
						return {} as any;
					}
				);

				const { execFileNoThrow } = await import('../../../main/utils/execFile');
				const result = await execFileNoThrow('cmd');

				// Using ?? operator correctly preserves exit code 0 (which is falsy but valid)
				expect(result.exitCode).toBe(0);
			});
		});

		describe('max buffer configuration', () => {
			it('should set maxBuffer to 10MB', async () => {
				let capturedOptions: any;
				mockExecFile.mockImplementation(
					(_cmd: string, _args: readonly string[], options: any, callback?: any) => {
						capturedOptions = options;
						if (callback) {
							callback(null, '', '');
						}
						return {} as any;
					}
				);

				const { execFileNoThrow } = await import('../../../main/utils/execFile');
				await execFileNoThrow('cmd');

				expect(capturedOptions.maxBuffer).toBe(10 * 1024 * 1024);
			});
		});

		describe('encoding configuration', () => {
			it('should use utf8 encoding', async () => {
				let capturedOptions: any;
				mockExecFile.mockImplementation(
					(_cmd: string, _args: readonly string[], options: any, callback?: any) => {
						capturedOptions = options;
						if (callback) {
							callback(null, '', '');
						}
						return {} as any;
					}
				);

				const { execFileNoThrow } = await import('../../../main/utils/execFile');
				await execFileNoThrow('cmd');

				expect(capturedOptions.encoding).toBe('utf8');
			});
		});

		describe('timeout option', () => {
			it('should pass timeout to execFile options', async () => {
				let capturedOptions: any;
				mockExecFile.mockImplementation(
					(_cmd: string, _args: readonly string[], options: any, callback?: any) => {
						capturedOptions = options;
						if (callback) {
							callback(null, 'output', '');
						}
						return {} as any;
					}
				);

				const { execFileNoThrow } = await import('../../../main/utils/execFile');
				await execFileNoThrow('ssh', ['-T', 'host'], undefined, { timeout: 30000 });

				expect(capturedOptions.timeout).toBe(30000);
			});

			it('should return ETIMEDOUT exitCode when process killed by timeout', async () => {
				const error = new Error('Command timed out') as any;
				error.killed = true;
				error.code = undefined;
				error.signal = 'SIGTERM';
				error.stdout = 'partial';
				error.stderr = 'partial err';

				mockExecFile.mockImplementation(
					(_cmd: string, _args: readonly string[], _options: any, callback?: any) => {
						if (callback) {
							callback(error, '', '');
						}
						return {} as any;
					}
				);

				const { execFileNoThrow } = await import('../../../main/utils/execFile');
				const result = await execFileNoThrow('ssh', ['-T', 'host'], undefined, {
					timeout: 30000,
				});

				expect(result.exitCode).toBe('ETIMEDOUT');
				expect(result.stderr).toContain('ETIMEDOUT');
				expect(result.stderr).toContain('30000ms');
				expect(result.stdout).toBe('partial');
			});

			it('should report timeout even when timed-out process has no stderr', async () => {
				const error = new Error('Command timed out') as any;
				error.killed = true;
				error.code = undefined;
				error.stdout = '';
				error.stderr = '';

				mockExecFile.mockImplementation(
					(_cmd: string, _args: readonly string[], _options: any, callback?: any) => {
						if (callback) {
							callback(error, '', '');
						}
						return {} as any;
					}
				);

				const { execFileNoThrow } = await import('../../../main/utils/execFile');
				const result = await execFileNoThrow('ssh', ['host'], undefined, { timeout: 10 });

				expect(result.exitCode).toBe('ETIMEDOUT');
				expect(result.stderr).toBe('\nETIMEDOUT: process timed out after 10ms');
			});

			it('should NOT return ETIMEDOUT for maxBuffer kills', async () => {
				const error = new Error('maxBuffer exceeded') as any;
				error.killed = true;
				error.code = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
				error.stdout = 'huge output';
				error.stderr = '';

				mockExecFile.mockImplementation(
					(_cmd: string, _args: readonly string[], _options: any, callback?: any) => {
						if (callback) {
							callback(error, '', '');
						}
						return {} as any;
					}
				);

				const { execFileNoThrow } = await import('../../../main/utils/execFile');
				const result = await execFileNoThrow('cat', ['bigfile'], undefined, { timeout: 30000 });

				expect(result.exitCode).toBe('ERR_CHILD_PROCESS_STDIO_MAXBUFFER');
				expect(result.stderr).not.toContain('ETIMEDOUT');
			});

			it('should not detect timeout when no timeout option was set', async () => {
				const error = new Error('Killed') as any;
				error.killed = true;
				error.code = undefined;
				error.stdout = '';
				error.stderr = '';

				mockExecFile.mockImplementation(
					(_cmd: string, _args: readonly string[], _options: any, callback?: any) => {
						if (callback) {
							callback(error, '', '');
						}
						return {} as any;
					}
				);

				const { execFileNoThrow } = await import('../../../main/utils/execFile');
				const result = await execFileNoThrow('cmd');

				expect(result.exitCode).toBe(1);
			});

			it('should not detect timeout when timeout is set but process was not killed', async () => {
				const error = new Error('Failed before timeout') as any;
				error.killed = false;
				error.code = undefined;
				error.stdout = '';
				error.stderr = 'failed';

				mockExecFile.mockImplementation(
					(_cmd: string, _args: readonly string[], _options: any, callback?: any) => {
						if (callback) {
							callback(error, '', '');
						}
						return {} as any;
					}
				);

				const { execFileNoThrow } = await import('../../../main/utils/execFile');
				const result = await execFileNoThrow('cmd', [], undefined, { timeout: 30 });

				expect(result).toEqual({
					stdout: '',
					stderr: 'failed',
					exitCode: 1,
				});
			});
		});

		describe('Windows shell mode', () => {
			it('should enable shell mode for Windows commands that need PATHEXT resolution', async () => {
				mockPlatform('win32');
				let capturedOptions: any;
				mockExecFile.mockImplementation(
					(_cmd: string, _args: readonly string[], options: any, callback?: any) => {
						capturedOptions = options;
						callback?.(null, 'output', '');
						return {} as any;
					}
				);

				const { execFileNoThrow } = await import('../../../main/utils/execFile');
				await execFileNoThrow('custom-tool', ['--version']);

				expect(capturedOptions.shell).toBe(true);
			});

			it('should avoid shell mode for known Windows exe-backed commands', async () => {
				mockPlatform('win32');
				let capturedOptions: any;
				mockExecFile.mockImplementation(
					(_cmd: string, _args: readonly string[], options: any, callback?: any) => {
						capturedOptions = options;
						callback?.(null, 'output', '');
						return {} as any;
					}
				);

				const { execFileNoThrow } = await import('../../../main/utils/execFile');
				await execFileNoThrow('git', ['status']);

				expect(capturedOptions.shell).toBe(false);
			});

			it('should not enable shell mode on non-Windows platforms', async () => {
				mockPlatform('darwin');
				let capturedOptions: any;
				mockExecFile.mockImplementation(
					(_cmd: string, _args: readonly string[], options: any, callback?: any) => {
						capturedOptions = options;
						callback?.(null, 'output', '');
						return {} as any;
					}
				);

				const { execFileNoThrow } = await import('../../../main/utils/execFile');
				await execFileNoThrow('custom-tool', ['--version']);

				expect(capturedOptions.shell).toBe(false);
			});
		});

		describe('stdin input execution', () => {
			it('should use spawn, write stdin, collect output, and resolve on close', async () => {
				const child = createMockChild();
				mockSpawn.mockReturnValue(child);

				const { execFileNoThrow } = await import('../../../main/utils/execFile');
				const promise = execFileNoThrow('cat', ['-'], '/tmp', { input: 'hello' });

				child.stdout.emit('data', Buffer.from('out'));
				child.stderr.emit('data', Buffer.from('err'));
				child.emit('close', 0);

				await expect(promise).resolves.toEqual({
					stdout: 'out',
					stderr: 'err',
					exitCode: 0,
				});
				expect(mockSpawn).toHaveBeenCalledWith('cat', ['-'], {
					cwd: '/tmp',
					shell: false,
					stdio: ['pipe', 'pipe', 'pipe'],
				});
				expect(child.stdin.write).toHaveBeenCalledWith('hello');
				expect(child.stdin.end).toHaveBeenCalled();
			});

			it('should use Windows shell mode for stdin execution when required', async () => {
				mockPlatform('win32');
				const child = createMockChild();
				mockSpawn.mockReturnValue(child);

				const { execFileNoThrow } = await import('../../../main/utils/execFile');
				const promise = execFileNoThrow('script.cmd', [], undefined, { input: 'payload' });

				child.emit('close', 0);
				await promise;

				expect(mockSpawn).toHaveBeenCalledWith('script.cmd', [], {
					cwd: undefined,
					shell: true,
					stdio: ['pipe', 'pipe', 'pipe'],
				});
			});

			it('should resolve exit code 1 when spawned process closes without a code', async () => {
				const child = createMockChild();
				mockSpawn.mockReturnValue(child);

				const { execFileNoThrow } = await import('../../../main/utils/execFile');
				const promise = execFileNoThrow('cat', [], undefined, { input: 'hello' });

				child.emit('close', null);

				await expect(promise).resolves.toEqual({
					stdout: '',
					stderr: '',
					exitCode: 1,
				});
			});

			it('should resolve spawn errors without throwing', async () => {
				const child = createMockChild();
				mockSpawn.mockReturnValue(child);

				const { execFileNoThrow } = await import('../../../main/utils/execFile');
				const promise = execFileNoThrow('missing-command', [], undefined, { input: 'hello' });

				child.stdout.emit('data', Buffer.from('ignored'));
				child.emit('error', new Error('spawn ENOENT'));

				await expect(promise).resolves.toEqual({
					stdout: '',
					stderr: 'spawn ENOENT',
					exitCode: 1,
				});
			});

			it('should clear input timeout when spawned process errors', async () => {
				vi.useFakeTimers();
				const child = createMockChild();
				mockSpawn.mockReturnValue(child);

				const { execFileNoThrow } = await import('../../../main/utils/execFile');
				const promise = execFileNoThrow('missing-command', [], undefined, {
					input: 'hello',
					timeout: 50,
				});

				child.emit('error', new Error('spawn ENOENT'));
				vi.advanceTimersByTime(50);

				await expect(promise).resolves.toEqual({
					stdout: '',
					stderr: 'spawn ENOENT',
					exitCode: 1,
				});
				expect(child.kill).not.toHaveBeenCalled();
			});

			it('should skip stdin writes when stdin is unavailable', async () => {
				const child = createMockChild();
				child.stdin = undefined;
				mockSpawn.mockReturnValue(child);

				const { execFileNoThrow } = await import('../../../main/utils/execFile');
				const promise = execFileNoThrow('cat', [], undefined, { input: 'hello' });

				child.emit('close', 0);

				await expect(promise).resolves.toEqual({
					stdout: '',
					stderr: '',
					exitCode: 0,
				});
			});

			it('should kill spawned input process on timeout and report ETIMEDOUT', async () => {
				vi.useFakeTimers();
				const child = createMockChild();
				mockSpawn.mockReturnValue(child);

				const { execFileNoThrow } = await import('../../../main/utils/execFile');
				const promise = execFileNoThrow('cat', [], undefined, { input: 'hello', timeout: 50 });

				child.stderr.emit('data', Buffer.from('partial err'));
				vi.advanceTimersByTime(50);

				await expect(promise).resolves.toEqual({
					stdout: '',
					stderr: 'partial err\nETIMEDOUT: process timed out after 50ms',
					exitCode: 'ETIMEDOUT',
				});
				expect(child.kill).toHaveBeenCalled();
			});

			it('should not create a timeout for non-positive input timeouts', async () => {
				vi.useFakeTimers();
				const child = createMockChild();
				mockSpawn.mockReturnValue(child);

				const { execFileNoThrow } = await import('../../../main/utils/execFile');
				const promise = execFileNoThrow('cat', [], undefined, { input: 'hello', timeout: 0 });

				vi.runOnlyPendingTimers();
				expect(child.kill).not.toHaveBeenCalled();
				child.emit('close', 0);

				await promise;
			});
		});
	});
});
