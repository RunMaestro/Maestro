/**
 * Tests for src/main/utils/execFile.ts
 *
 * Tests cover the execFileNoThrow function which safely executes
 * commands without shell injection vulnerabilities.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ExecResult } from '../../../main/utils/execFile';

// Create mock function
const mockExecFile = vi.fn();

// Mock child_process module using vi.mock with dynamic import
vi.mock('child_process', async (importOriginal) => {
	const actual = await importOriginal<typeof import('child_process')>();
	return {
		...actual,
		default: {
			...actual,
			execFile: mockExecFile,
		},
		execFile: mockExecFile,
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
	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.restoreAllMocks();
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
	});
});
