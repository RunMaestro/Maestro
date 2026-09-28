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

	describe('execFileNoThrow with input (stdin path)', () => {
		// Spawns a real short-lived node process, same as execFileStreaming below -
		// the child_process mock only replaces execFile, not spawn.
		const NODE = process.execPath;

		// A lone `{ input }` with no other fields is a real call shape (git.ts
		// pipes gist content to `gh` this way) - the discriminator fix for the
		// legacy-env-named-"input" collision must not break it.
		it('treats a lone { input } as ExecOptions and delivers it to stdin', async () => {
			const { execFileNoThrow } = await import('../../../main/utils/execFile');

			const result = await execFileNoThrow(
				NODE,
				['-e', 'process.stdin.on("data", (d) => process.stdout.write(d))'],
				undefined,
				{
					input: 'hello from stdin',
				}
			);

			expect(result.stdout).toBe('hello from stdin');
		});

		// Regression: when `input` is set, execFileNoThrow hands off to
		// execFileWithInput, which never received or forwarded `env` - a caller
		// passing { input, env } silently got process.env in the child instead
		// of the environment it asked for.
		it('passes env through to the spawned process', async () => {
			const { execFileNoThrow } = await import('../../../main/utils/execFile');

			const result = await execFileNoThrow(
				NODE,
				['-e', 'process.stdout.write(process.env.MAESTRO_TEST_VAR || "MISSING")'],
				undefined,
				{ input: 'unused stdin content', env: { MAESTRO_TEST_VAR: 'present' } }
			);

			expect(result.stdout).toBe('present');
		});
	});

	describe('execFileStreaming', () => {
		// These spawn real short-lived node processes: the child_process mock above
		// only replaces execFile, so spawn is the genuine implementation.
		const NODE = process.execPath;

		it('delivers stdout chunks as they arrive and resolves with the exit code', async () => {
			const { execFileStreaming } = await import('../../../main/utils/execFile');
			const chunks: Array<[string, string]> = [];

			const handle = execFileStreaming(NODE, ['-e', 'process.stdout.write("hello")'], {
				onChunk: (chunk, stream) => chunks.push([chunk, stream]),
			});
			const result = await handle.result;

			expect(chunks).toContainEqual(['hello', 'stdout']);
			expect(result.stdout).toBe('hello');
			expect(result.exitCode).toBe(0);
		});

		it('captures stderr separately and reports a non-zero exit code', async () => {
			const { execFileStreaming } = await import('../../../main/utils/execFile');
			const streams: string[] = [];

			const handle = execFileStreaming(
				NODE,
				['-e', 'process.stderr.write("boom"); process.exit(3)'],
				{ onChunk: (_chunk, stream) => streams.push(stream) }
			);
			const result = await handle.result;

			expect(streams).toEqual(['stderr']);
			expect(result.stderr).toBe('boom');
			expect(result.stdout).toBe('');
			expect(result.exitCode).toBe(3);
		});

		it('cancel() terminates the process and reports SIGTERM', async () => {
			const { execFileStreaming } = await import('../../../main/utils/execFile');

			const handle = execFileStreaming(
				NODE,
				['-e', 'process.stdout.write("up"); setInterval(() => {}, 1000)'],
				{
					onChunk: () => handle.cancel(),
				}
			);
			const result = await handle.result;

			expect(result.exitCode).toBe('SIGTERM');
			expect(result.stdout).toBe('up');
		});

		it('cancel() kills a grandchild that inherited the pipes', async () => {
			const { execFileStreaming } = await import('../../../main/utils/execFile');

			// The shape that made Cancel look broken: `git push` runs a pre-push
			// hook, the hook inherits stdout/stderr, and signalling git alone
			// leaves the hook running with the pipes open - so `close` never
			// fires and the console sits on "Running..." forever.
			const script = [
				'const { spawn } = require("child_process");',
				'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: ["ignore", "inherit", "inherit"] });',
				'process.stdout.write("pid:" + child.pid + "\\n");',
				'setInterval(() => {}, 1000);',
			].join('');

			let grandchildPid = 0;
			const handle = execFileStreaming(NODE, ['-e', script], {
				onChunk: (chunk) => {
					const match = /pid:(\d+)/.exec(chunk);
					if (!match) return;
					grandchildPid = Number(match[1]);
					handle.cancel();
				},
			});

			const result = await handle.result;
			expect(result.exitCode).toBe('SIGTERM');
			expect(grandchildPid).toBeGreaterThan(0);

			await vi.waitFor(() => {
				// kill(pid, 0) throws ESRCH once the process is gone.
				expect(() => process.kill(grandchildPid, 0)).toThrow();
			});
		});

		it('resolves with the spawn error code when the binary is missing', async () => {
			const { execFileStreaming } = await import('../../../main/utils/execFile');

			// Use a .exe suffix so Windows does not route through cmd.exe
			// (needsWindowsShell). Shell-spawned missing commands exit 1 instead
			// of surfacing spawn ENOENT.
			const handle = execFileStreaming('definitely-not-a-real-binary-xyz.exe', [], {
				onChunk: () => {},
			});
			const result = await handle.result;

			expect(result.exitCode).toBe('ENOENT');
			expect(result.stderr).toBeTruthy();
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
						maxBuffer: 100 * 1024 * 1024, // 100MB
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

			// Regression: the legacy/ExecOptions discriminator used to check only
			// whether a key named `input`/`timeout`/`env` was present, not its
			// value's shape. A real environment variable can be named any of
			// those, so a plain legacy env dict containing one got misread as the
			// structured form and had its actual entries dropped or mangled.
			it('treats a legacy env dict with a var literally named "timeout" as the whole environment', async () => {
				mockExecFile.mockImplementation(
					(_cmd: string, _args: readonly string[], _options: any, callback?: any) => {
						callback?.(null, 'output', '');
						return {} as any;
					}
				);

				const { execFileNoThrow } = await import('../../../main/utils/execFile');
				// A real env var's value is always a string, never the number
				// ExecOptions.timeout expects.
				const legacyEnv = { timeout: '30', PATH: '/custom/path' };
				await execFileNoThrow('mycmd', [], '/cwd', legacyEnv);

				expect(mockExecFile).toHaveBeenCalledWith(
					'mycmd',
					[],
					expect.objectContaining({ env: legacyEnv, timeout: undefined }),
					expect.any(Function)
				);
			});

			it('treats a legacy env dict with a var literally named "env" as the whole environment', async () => {
				mockExecFile.mockImplementation(
					(_cmd: string, _args: readonly string[], _options: any, callback?: any) => {
						callback?.(null, 'output', '');
						return {} as any;
					}
				);

				const { execFileNoThrow } = await import('../../../main/utils/execFile');
				// A real env var's value is always a string, never the object
				// ExecOptions.env expects.
				const legacyEnv = { env: 'production', PATH: '/custom/path' };
				await execFileNoThrow('mycmd', [], '/cwd', legacyEnv);

				expect(mockExecFile).toHaveBeenCalledWith(
					'mycmd',
					[],
					expect.objectContaining({ env: legacyEnv }),
					expect.any(Function)
				);
			});

			it('still recognizes the structured ExecOptions form when env is a real object', async () => {
				mockExecFile.mockImplementation(
					(_cmd: string, _args: readonly string[], _options: any, callback?: any) => {
						callback?.(null, 'output', '');
						return {} as any;
					}
				);

				const { execFileNoThrow } = await import('../../../main/utils/execFile');
				await execFileNoThrow('mycmd', [], '/cwd', { env: { MY_VAR: 'value' }, timeout: 5000 });

				expect(mockExecFile).toHaveBeenCalledWith(
					'mycmd',
					[],
					expect.objectContaining({ env: { MY_VAR: 'value' }, timeout: 5000 }),
					expect.any(Function)
				);
			});

			// Regression (CodeRabbit, PR #1383): a lone `{ input: 'x' }` is a real
			// ExecOptions call (git.ts uses exactly this shape to pipe gist content
			// to stdin), but `{ input: 'x', PATH: '/bin' }` is a legacy env dict that
			// happens to define a variable called `input` - the extra PATH key is
			// what tells them apart. Getting this wrong would silently feed the
			// caller's PATH override to the child's stdin instead of its environment.
			it('treats a legacy env dict with a var literally named "input" as the whole environment, not stdin content', async () => {
				mockExecFile.mockImplementation(
					(_cmd: string, _args: readonly string[], _options: any, callback?: any) => {
						callback?.(null, 'output', '');
						return {} as any;
					}
				);

				const { execFileNoThrow } = await import('../../../main/utils/execFile');
				const legacyEnv = { input: 'not stdin content', PATH: '/custom/path' };
				await execFileNoThrow('mycmd', [], '/cwd', legacyEnv);

				// Legacy interpretation goes through execFileAsync (mocked here), not
				// the spawn-based stdin path - if this were misread as ExecOptions.input,
				// mockExecFile would never be called at all.
				expect(mockExecFile).toHaveBeenCalledWith(
					'mycmd',
					[],
					expect.objectContaining({ env: legacyEnv }),
					expect.any(Function)
				);
			});

			// Regression (Greptile, PR #1383): `{ timeout: undefined }` is valid
			// ExecOptions (equivalent to omitting timeout), but the key is still
			// present, so a value-type check alone can't tell it apart from "key
			// absent". The all-keys-known check recognizes it regardless of value.
			it('still recognizes ExecOptions when a known field is explicitly undefined', async () => {
				mockExecFile.mockImplementation(
					(_cmd: string, _args: readonly string[], _options: any, callback?: any) => {
						callback?.(null, 'output', '');
						return {} as any;
					}
				);

				const { execFileNoThrow } = await import('../../../main/utils/execFile');
				await execFileNoThrow('mycmd', [], '/cwd', { timeout: undefined });

				// If misread as legacy, env would be the literal { timeout: undefined }
				// object instead of undefined (inherit the parent environment).
				expect(mockExecFile).toHaveBeenCalledWith(
					'mycmd',
					[],
					expect.objectContaining({ env: undefined }),
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
			it('should set maxBuffer to 100MB', async () => {
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

				expect(capturedOptions.maxBuffer).toBe(100 * 1024 * 1024);
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
		});
	});
});
