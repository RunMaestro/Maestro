/**
 * Tests for IPC Wrapper Utility
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
	createIpcMethod,
	IpcMethodOptionsWithDefault,
	IpcMethodOptionsRethrow,
} from '../../../renderer/services/ipcWrapper';

describe('ipcWrapper', () => {
	// Store console.error spy
	let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
	});

	afterEach(() => {
		consoleErrorSpy.mockRestore();
	});

	describe('createIpcMethod', () => {
		describe('with defaultValue (swallow errors)', () => {
			it('should return the result on success', async () => {
				const result = await createIpcMethod({
					call: () => Promise.resolve({ data: 'test' }),
					errorContext: 'Test operation',
					defaultValue: { data: 'default' },
				});

				expect(result).toEqual({ data: 'test' });
				expect(consoleErrorSpy).not.toHaveBeenCalled();
			});

			it('should return the default value on error', async () => {
				const result = await createIpcMethod({
					call: () => Promise.reject(new Error('IPC failed')),
					errorContext: 'Test operation',
					defaultValue: { data: 'default' },
				});

				expect(result).toEqual({ data: 'default' });
				expect(consoleErrorSpy).toHaveBeenCalledWith('Test operation error:', expect.any(Error));
			});

			it('should return empty array as default value', async () => {
				const result = await createIpcMethod({
					call: () => Promise.reject(new Error('Failed')),
					errorContext: 'Git branches',
					defaultValue: [] as string[],
				});

				expect(result).toEqual([]);
			});

			it('should return false as default value', async () => {
				const result = await createIpcMethod({
					call: () => Promise.reject(new Error('Failed')),
					errorContext: 'Is repo',
					defaultValue: false,
				});

				expect(result).toBe(false);
			});

			it('should return null as default value', async () => {
				const result = await createIpcMethod({
					call: () => Promise.reject(new Error('Failed')),
					errorContext: 'Get URL',
					defaultValue: null as string | null,
				});

				expect(result).toBeNull();
			});

			it('should apply transform function on success', async () => {
				const result = await createIpcMethod({
					call: () => Promise.resolve({ stdout: 'branch-name\n' }),
					errorContext: 'Git branch',
					defaultValue: { stdout: '' },
					transform: (r) => ({ stdout: r.stdout.trim() }),
				});

				expect(result).toEqual({ stdout: 'branch-name' });
			});

			it('should not apply transform function on error', async () => {
				const transform = vi.fn((r) => r);
				const result = await createIpcMethod({
					call: () => Promise.reject(new Error('Failed')),
					errorContext: 'Git branch',
					defaultValue: { stdout: '' },
					transform,
				});

				expect(result).toEqual({ stdout: '' });
				expect(transform).not.toHaveBeenCalled();
			});
		});

		describe('with rethrow: true (propagate errors)', () => {
			it('should return the result on success', async () => {
				const result = await createIpcMethod({
					call: () => Promise.resolve('success'),
					errorContext: 'Process spawn',
					rethrow: true,
				});

				expect(result).toBe('success');
				expect(consoleErrorSpy).not.toHaveBeenCalled();
			});

			it('should rethrow error after logging', async () => {
				const error = new Error('Spawn failed');

				await expect(
					createIpcMethod({
						call: () => Promise.reject(error),
						errorContext: 'Process spawn',
						rethrow: true,
					})
				).rejects.toThrow('Spawn failed');

				expect(consoleErrorSpy).toHaveBeenCalledWith('Process spawn error:', error);
			});

			it('should apply transform function on success', async () => {
				const result = await createIpcMethod({
					call: () => Promise.resolve(5),
					errorContext: 'Get count',
					rethrow: true,
					transform: (n) => n * 2,
				});

				expect(result).toBe(10);
			});

			it('should not apply transform function on error', async () => {
				const transform = vi.fn((r) => r);

				await expect(
					createIpcMethod({
						call: () => Promise.reject(new Error('Failed')),
						errorContext: 'Get count',
						rethrow: true,
						transform,
					})
				).rejects.toThrow('Failed');

				expect(transform).not.toHaveBeenCalled();
			});
		});

		describe('type safety', () => {
			it('should infer correct return type with defaultValue', async () => {
				const options: IpcMethodOptionsWithDefault<{ branches: string[] }> = {
					call: () => Promise.resolve({ branches: ['main', 'dev'] }),
					errorContext: 'Git branches',
					defaultValue: { branches: [] },
				};

				const result = await createIpcMethod(options);
				// Type should be { branches: string[] }
				expect(result.branches).toEqual(['main', 'dev']);
			});

			it('should infer correct return type with rethrow', async () => {
				const options: IpcMethodOptionsRethrow<void> = {
					call: () => Promise.resolve(),
					errorContext: 'Process kill',
					rethrow: true,
				};

				const result = await createIpcMethod(options);
				// Type should be void
				expect(result).toBeUndefined();
			});
		});
	});

	describe('error message formatting', () => {
		it('should format error context consistently', async () => {
			await createIpcMethod({
				call: () => Promise.reject(new Error('Test')),
				errorContext: 'Git status',
				defaultValue: null,
			});

			expect(consoleErrorSpy).toHaveBeenCalledWith('Git status error:', expect.any(Error));
		});

		it('should include the original error object', async () => {
			const originalError = new Error('Original error message');

			await createIpcMethod({
				call: () => Promise.reject(originalError),
				errorContext: 'Operation',
				defaultValue: null,
			});

			expect(consoleErrorSpy).toHaveBeenCalledWith('Operation error:', originalError);
		});

		it('should handle non-Error objects as errors', async () => {
			await createIpcMethod({
				call: () => Promise.reject('string error'),
				errorContext: 'Operation',
				defaultValue: null,
			});

			expect(consoleErrorSpy).toHaveBeenCalledWith('Operation error:', 'string error');
		});
	});
});
