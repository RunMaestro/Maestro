/**
 * Tests for src/main/vibes/vibes-bridge.ts
 * Validates the VibesCheck CLI bridge module: binary detection,
 * project status checks, and all vibescheck command wrappers.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { constants } from 'fs';

// Hoist mock functions so they're available during vi.mock factory execution
const { mockExecFile, mockAccess } = vi.hoisted(() => ({
	mockExecFile: vi.fn(),
	mockAccess: vi.fn(),
}));

// Mock child_process
vi.mock('child_process', async (importOriginal) => {
	const actual = await importOriginal<typeof import('child_process')>();
	return {
		...actual,
		default: { ...actual, execFile: mockExecFile },
		execFile: mockExecFile,
	};
});

// Mock util.promisify to wrap our mockExecFile
vi.mock('util', async (importOriginal) => {
	const actual = await importOriginal<typeof import('util')>();
	const promisifyMock = (fn: any) => {
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
	};
	return {
		...actual,
		default: { ...actual, promisify: promisifyMock },
		promisify: promisifyMock,
	};
});

// Mock fs/promises — provide constants from real fs module
vi.mock('fs/promises', async () => {
	const fsConstants = await import('fs').then((m) => m.constants);
	return {
		access: mockAccess,
		constants: fsConstants,
		default: { access: mockAccess, constants: fsConstants },
	};
});

describe('vibes-bridge', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	// Helper to make mockExecFile simulate a successful command
	function mockExecSuccess(stdout: string, stderr = '') {
		mockExecFile.mockImplementation(
			(_cmd: string, _args: readonly string[], _options: any, callback?: any) => {
				if (callback) {
					callback(null, stdout, stderr);
				}
				return {} as any;
			},
		);
	}

	// Helper to make mockExecFile simulate a failed command
	function mockExecFailure(stderr: string, exitCode: number = 1) {
		mockExecFile.mockImplementation(
			(_cmd: string, _args: readonly string[], _options: any, callback?: any) => {
				if (callback) {
					const err: any = new Error(stderr);
					err.code = exitCode;
					err.stderr = stderr;
					err.stdout = '';
					callback(err, '', stderr);
				}
				return {} as any;
			},
		);
	}

	// ========================================================================
	// findVibesCheckBinary
	// ========================================================================
	describe('findVibesCheckBinary', () => {
		it('should return custom path when it exists and is executable', async () => {
			mockAccess.mockResolvedValueOnce(undefined);
			const { findVibesCheckBinary } = await import('../../../main/vibes/vibes-bridge');
			const result = await findVibesCheckBinary('/usr/local/bin/vibescheck');
			expect(result).toBe('/usr/local/bin/vibescheck');
			expect(mockAccess).toHaveBeenCalledWith('/usr/local/bin/vibescheck', constants.X_OK);
		});

		it('should return null when custom path is not executable', async () => {
			mockAccess.mockRejectedValueOnce(new Error('EACCES'));
			const { findVibesCheckBinary } = await import('../../../main/vibes/vibes-bridge');
			const result = await findVibesCheckBinary('/nonexistent/vibescheck');
			expect(result).toBeNull();
		});

		it('should search $PATH when no custom path provided', async () => {
			const originalPath = process.env.PATH;
			process.env.PATH = '/usr/bin:/usr/local/bin';

			// First dir fails, second dir succeeds
			mockAccess.mockRejectedValueOnce(new Error('ENOENT'));
			mockAccess.mockResolvedValueOnce(undefined);

			const { findVibesCheckBinary } = await import('../../../main/vibes/vibes-bridge');
			const result = await findVibesCheckBinary();
			expect(result).toBe('/usr/local/bin/vibescheck');

			process.env.PATH = originalPath;
		});

		it('should return null when binary not found in $PATH', async () => {
			const originalPath = process.env.PATH;
			process.env.PATH = '/usr/bin:/usr/local/bin';

			mockAccess.mockRejectedValue(new Error('ENOENT'));

			const { findVibesCheckBinary } = await import('../../../main/vibes/vibes-bridge');
			const result = await findVibesCheckBinary();
			expect(result).toBeNull();

			process.env.PATH = originalPath;
		});

		it('should return null when $PATH is empty', async () => {
			const originalPath = process.env.PATH;
			process.env.PATH = '';

			const { findVibesCheckBinary } = await import('../../../main/vibes/vibes-bridge');
			const result = await findVibesCheckBinary();
			expect(result).toBeNull();

			process.env.PATH = originalPath;
		});
	});

	// ========================================================================
	// isVibesInitialized
	// ========================================================================
	describe('isVibesInitialized', () => {
		it('should return true when .ai-audit/config.json exists', async () => {
			mockAccess.mockResolvedValueOnce(undefined);
			const { isVibesInitialized } = await import('../../../main/vibes/vibes-bridge');
			const result = await isVibesInitialized('/my/project');
			expect(result).toBe(true);
		});

		it('should return false when .ai-audit/config.json does not exist', async () => {
			mockAccess.mockRejectedValueOnce(new Error('ENOENT'));
			const { isVibesInitialized } = await import('../../../main/vibes/vibes-bridge');
			const result = await isVibesInitialized('/my/project');
			expect(result).toBe(false);
		});
	});

	// ========================================================================
	// vibesInit
	// ========================================================================
	describe('vibesInit', () => {
		it('should run vibescheck init with required args', async () => {
			mockAccess.mockResolvedValueOnce(undefined);
			mockExecSuccess('Initialized .ai-audit/');

			const { vibesInit } = await import('../../../main/vibes/vibes-bridge');
			const result = await vibesInit(
				'/my/project',
				{ projectName: 'test-proj', assuranceLevel: 'medium' },
				'/usr/local/bin/vibescheck',
			);

			expect(result).toEqual({ success: true });
			expect(mockExecFile).toHaveBeenCalled();
			const execArgs = mockExecFile.mock.calls[0][1] as string[];
			expect(execArgs).toContain('init');
			expect(execArgs).toContain('--project-name');
			expect(execArgs).toContain('test-proj');
			expect(execArgs).toContain('--assurance-level');
			expect(execArgs).toContain('medium');
		});

		it('should pass extensions when provided', async () => {
			mockAccess.mockResolvedValueOnce(undefined);
			mockExecSuccess('Initialized');

			const { vibesInit } = await import('../../../main/vibes/vibes-bridge');
			await vibesInit(
				'/my/project',
				{
					projectName: 'test-proj',
					assuranceLevel: 'high',
					extensions: ['.ts', '.py'],
				},
				'/usr/local/bin/vibescheck',
			);

			expect(mockExecFile).toHaveBeenCalled();
			const execArgs = mockExecFile.mock.calls[0][1] as string[];
			expect(execArgs).toContain('--extensions');
			expect(execArgs).toContain('.ts,.py');
		});

		it('should return error when command fails', async () => {
			mockAccess.mockResolvedValueOnce(undefined);
			mockExecFailure('Permission denied', 1);

			const { vibesInit } = await import('../../../main/vibes/vibes-bridge');
			const result = await vibesInit(
				'/my/project',
				{ projectName: 'test-proj', assuranceLevel: 'low' },
				'/usr/local/bin/vibescheck',
			);

			expect(result.success).toBe(false);
			expect(result.error).toBeDefined();
		});

		it('should error when binary not found', async () => {
			mockAccess.mockRejectedValue(new Error('ENOENT'));

			const { vibesInit } = await import('../../../main/vibes/vibes-bridge');
			await expect(
				vibesInit('/my/project', {
					projectName: 'test-proj',
					assuranceLevel: 'low',
				}),
			).rejects.toThrow('vibescheck binary not found');
		});
	});

	// ========================================================================
	// vibesBuild
	// ========================================================================
	describe('vibesBuild', () => {
		it('should run vibescheck build successfully', async () => {
			mockAccess.mockResolvedValueOnce(undefined);
			mockExecSuccess('Build complete');

			const { vibesBuild } = await import('../../../main/vibes/vibes-bridge');
			const result = await vibesBuild('/my/project', '/usr/local/bin/vibescheck');
			expect(result).toEqual({ success: true });
		});

		it('should return error on build failure', async () => {
			mockAccess.mockResolvedValueOnce(undefined);
			mockExecFailure('No annotations found', 1);

			const { vibesBuild } = await import('../../../main/vibes/vibes-bridge');
			const result = await vibesBuild('/my/project', '/usr/local/bin/vibescheck');
			expect(result.success).toBe(false);
			expect(result.error).toContain('No annotations found');
		});
	});

	// ========================================================================
	// vibesStats
	// ========================================================================
	describe('vibesStats', () => {
		it('should run vibescheck stats successfully', async () => {
			mockAccess.mockResolvedValueOnce(undefined);
			mockExecSuccess('{"total_annotations": 42}');

			const { vibesStats } = await import('../../../main/vibes/vibes-bridge');
			const result = await vibesStats('/my/project', undefined, '/usr/local/bin/vibescheck');
			expect(result.success).toBe(true);
			expect(result.data).toBe('{"total_annotations": 42}');
		});

		it('should pass file argument when provided', async () => {
			mockAccess.mockResolvedValueOnce(undefined);
			mockExecSuccess('{"file_annotations": 5}');

			const { vibesStats } = await import('../../../main/vibes/vibes-bridge');
			await vibesStats('/my/project', 'src/index.ts', '/usr/local/bin/vibescheck');

			const execArgs = mockExecFile.mock.calls[0][1] as string[];
			expect(execArgs).toContain('stats');
			expect(execArgs).toContain('src/index.ts');
		});

		it('should return error on failure', async () => {
			mockAccess.mockResolvedValueOnce(undefined);
			mockExecFailure('Not initialized', 1);

			const { vibesStats } = await import('../../../main/vibes/vibes-bridge');
			const result = await vibesStats('/my/project', undefined, '/usr/local/bin/vibescheck');
			expect(result.success).toBe(false);
		});
	});

	// ========================================================================
	// vibesBlame
	// ========================================================================
	describe('vibesBlame', () => {
		it('should run vibescheck blame --json <file>', async () => {
			mockAccess.mockResolvedValueOnce(undefined);
			mockExecSuccess('[{"line":1,"action":"create"}]');

			const { vibesBlame } = await import('../../../main/vibes/vibes-bridge');
			const result = await vibesBlame('/my/project', 'src/app.ts', '/usr/local/bin/vibescheck');
			expect(result.success).toBe(true);
			expect(result.data).toBe('[{"line":1,"action":"create"}]');

			const execArgs = mockExecFile.mock.calls[0][1] as string[];
			expect(execArgs).toEqual(['blame', '--json', 'src/app.ts']);
		});
	});

	// ========================================================================
	// vibesLog
	// ========================================================================
	describe('vibesLog', () => {
		it('should run vibescheck log with no options', async () => {
			mockAccess.mockResolvedValueOnce(undefined);
			mockExecSuccess('Log output');

			const { vibesLog } = await import('../../../main/vibes/vibes-bridge');
			const result = await vibesLog('/my/project', undefined, '/usr/local/bin/vibescheck');
			expect(result.success).toBe(true);
			expect(result.data).toBe('Log output');
		});

		it('should pass all filter options', async () => {
			mockAccess.mockResolvedValueOnce(undefined);
			mockExecSuccess('{}');

			const { vibesLog } = await import('../../../main/vibes/vibes-bridge');
			await vibesLog(
				'/my/project',
				{
					file: 'src/app.ts',
					model: 'claude-4',
					session: 'abc123',
					limit: 10,
					json: true,
				},
				'/usr/local/bin/vibescheck',
			);

			const execArgs = mockExecFile.mock.calls[0][1] as string[];
			expect(execArgs).toContain('--file');
			expect(execArgs).toContain('src/app.ts');
			expect(execArgs).toContain('--model');
			expect(execArgs).toContain('claude-4');
			expect(execArgs).toContain('--session');
			expect(execArgs).toContain('abc123');
			expect(execArgs).toContain('--limit');
			expect(execArgs).toContain('10');
			expect(execArgs).toContain('--json');
		});
	});

	// ========================================================================
	// vibesCoverage
	// ========================================================================
	describe('vibesCoverage', () => {
		it('should run vibescheck coverage', async () => {
			mockAccess.mockResolvedValueOnce(undefined);
			mockExecSuccess('Coverage: 85%');

			const { vibesCoverage } = await import('../../../main/vibes/vibes-bridge');
			const result = await vibesCoverage('/my/project', false, '/usr/local/bin/vibescheck');
			expect(result.success).toBe(true);
			expect(result.data).toBe('Coverage: 85%');
		});

		it('should pass --json flag when requested', async () => {
			mockAccess.mockResolvedValueOnce(undefined);
			mockExecSuccess('{"coverage": 0.85}');

			const { vibesCoverage } = await import('../../../main/vibes/vibes-bridge');
			await vibesCoverage('/my/project', true, '/usr/local/bin/vibescheck');

			const execArgs = mockExecFile.mock.calls[0][1] as string[];
			expect(execArgs).toContain('--json');
		});
	});

	// ========================================================================
	// vibesReport
	// ========================================================================
	describe('vibesReport', () => {
		it('should run vibescheck report with default format', async () => {
			mockAccess.mockResolvedValueOnce(undefined);
			mockExecSuccess('# VIBES Report');

			const { vibesReport } = await import('../../../main/vibes/vibes-bridge');
			const result = await vibesReport('/my/project', undefined, '/usr/local/bin/vibescheck');
			expect(result.success).toBe(true);
			expect(result.data).toBe('# VIBES Report');
		});

		it('should pass format argument', async () => {
			mockAccess.mockResolvedValueOnce(undefined);
			mockExecSuccess('{}');

			const { vibesReport } = await import('../../../main/vibes/vibes-bridge');
			await vibesReport('/my/project', 'json', '/usr/local/bin/vibescheck');

			const execArgs = mockExecFile.mock.calls[0][1] as string[];
			expect(execArgs).toContain('--format');
			expect(execArgs).toContain('json');
		});

		it('should support html format', async () => {
			mockAccess.mockResolvedValueOnce(undefined);
			mockExecSuccess('<html>report</html>');

			const { vibesReport } = await import('../../../main/vibes/vibes-bridge');
			await vibesReport('/my/project', 'html', '/usr/local/bin/vibescheck');

			const execArgs = mockExecFile.mock.calls[0][1] as string[];
			expect(execArgs).toContain('--format');
			expect(execArgs).toContain('html');
		});
	});

	// ========================================================================
	// vibesSessions
	// ========================================================================
	describe('vibesSessions', () => {
		it('should run vibescheck sessions --json', async () => {
			mockAccess.mockResolvedValueOnce(undefined);
			mockExecSuccess('[{"session_id":"abc"}]');

			const { vibesSessions } = await import('../../../main/vibes/vibes-bridge');
			const result = await vibesSessions('/my/project', '/usr/local/bin/vibescheck');
			expect(result.success).toBe(true);
			expect(result.data).toBe('[{"session_id":"abc"}]');

			const execArgs = mockExecFile.mock.calls[0][1] as string[];
			expect(execArgs).toEqual(['sessions', '--json']);
		});
	});

	// ========================================================================
	// vibesModels
	// ========================================================================
	describe('vibesModels', () => {
		it('should run vibescheck models --json', async () => {
			mockAccess.mockResolvedValueOnce(undefined);
			mockExecSuccess('[{"model":"claude-4"}]');

			const { vibesModels } = await import('../../../main/vibes/vibes-bridge');
			const result = await vibesModels('/my/project', '/usr/local/bin/vibescheck');
			expect(result.success).toBe(true);
			expect(result.data).toBe('[{"model":"claude-4"}]');

			const execArgs = mockExecFile.mock.calls[0][1] as string[];
			expect(execArgs).toEqual(['models', '--json']);
		});
	});

	// ========================================================================
	// Error handling across commands
	// ========================================================================
	describe('error handling', () => {
		it('should throw when binary not found for any command', async () => {
			mockAccess.mockRejectedValue(new Error('ENOENT'));

			const mod = await import('../../../main/vibes/vibes-bridge');
			await expect(mod.vibesBuild('/my/project')).rejects.toThrow('vibescheck binary not found');
			await expect(mod.vibesStats('/my/project')).rejects.toThrow('vibescheck binary not found');
			await expect(mod.vibesBlame('/my/project', 'file.ts')).rejects.toThrow('vibescheck binary not found');
			await expect(mod.vibesLog('/my/project')).rejects.toThrow('vibescheck binary not found');
			await expect(mod.vibesCoverage('/my/project')).rejects.toThrow('vibescheck binary not found');
			await expect(mod.vibesReport('/my/project')).rejects.toThrow('vibescheck binary not found');
			await expect(mod.vibesSessions('/my/project')).rejects.toThrow('vibescheck binary not found');
			await expect(mod.vibesModels('/my/project')).rejects.toThrow('vibescheck binary not found');
		});
	});
});
