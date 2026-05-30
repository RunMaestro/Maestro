/**
 * @fileoverview Tests for useRemotePathValidation hook
 * Tests: debounced remote path validation via SSH
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useRemotePathValidation } from '../../../renderer/hooks/agent/useRemotePathValidation';

describe('useRemotePathValidation', () => {
	beforeEach(() => {
		vi.mocked(window.maestro.fs.stat).mockReset();
	});

	it('should return default state when SSH is disabled', () => {
		const { result } = renderHook(() =>
			useRemotePathValidation({
				isSshEnabled: false,
				path: '/some/path',
				sshRemoteId: 'remote-1',
			})
		);

		expect(result.current).toEqual({
			checking: false,
			valid: false,
			isDirectory: false,
		});
	});

	it('should return default state when path is empty', () => {
		const { result } = renderHook(() =>
			useRemotePathValidation({
				isSshEnabled: true,
				path: '',
				sshRemoteId: 'remote-1',
			})
		);

		expect(result.current).toEqual({
			checking: false,
			valid: false,
			isDirectory: false,
		});
	});

	it('should return default state when path is only whitespace', () => {
		const { result } = renderHook(() =>
			useRemotePathValidation({
				isSshEnabled: true,
				path: '   ',
				sshRemoteId: 'remote-1',
			})
		);

		expect(result.current).toEqual({
			checking: false,
			valid: false,
			isDirectory: false,
		});
	});

	it('should return default state when sshRemoteId is null', () => {
		const { result } = renderHook(() =>
			useRemotePathValidation({
				isSshEnabled: true,
				path: '/some/path',
				sshRemoteId: null,
			})
		);

		expect(result.current).toEqual({
			checking: false,
			valid: false,
			isDirectory: false,
		});
	});

	it('should return default state when sshRemoteId is undefined', () => {
		const { result } = renderHook(() =>
			useRemotePathValidation({
				isSshEnabled: true,
				path: '/some/path',
				sshRemoteId: undefined,
			})
		);

		expect(result.current).toEqual({
			checking: false,
			valid: false,
			isDirectory: false,
		});
	});

	it('should return valid: true for directory stat result', async () => {
		vi.mocked(window.maestro.fs.stat).mockResolvedValue({
			isDirectory: true,
			isFile: false,
			size: 4096,
			mtimeMs: Date.now(),
		});

		const { result } = renderHook(() =>
			useRemotePathValidation({
				isSshEnabled: true,
				path: '/home/user/project',
				sshRemoteId: 'remote-1',
				debounceMs: 10, // Short debounce for tests
			})
		);

		await waitFor(() => {
			expect(result.current).toEqual({
				checking: false,
				valid: true,
				isDirectory: true,
			});
		});

		expect(window.maestro.fs.stat).toHaveBeenCalledWith('/home/user/project', 'remote-1');
	});

	it('should return error for file stat result', async () => {
		vi.mocked(window.maestro.fs.stat).mockResolvedValue({
			isDirectory: false,
			isFile: true,
			size: 1024,
			mtimeMs: Date.now(),
		});

		const { result } = renderHook(() =>
			useRemotePathValidation({
				isSshEnabled: true,
				path: '/home/user/file.txt',
				sshRemoteId: 'remote-1',
				debounceMs: 10,
			})
		);

		await waitFor(() => {
			expect(result.current).toEqual({
				checking: false,
				valid: false,
				isDirectory: false,
				error: 'Path is a file, not a directory',
			});
		});
	});

	it('should return error when stat returns null', async () => {
		vi.mocked(window.maestro.fs.stat).mockResolvedValue(null as any);

		const { result } = renderHook(() =>
			useRemotePathValidation({
				isSshEnabled: true,
				path: '/nonexistent/path',
				sshRemoteId: 'remote-1',
				debounceMs: 10,
			})
		);

		await waitFor(() => {
			expect(result.current).toEqual({
				checking: false,
				valid: false,
				isDirectory: false,
				error: 'Path not found or not accessible',
			});
		});
	});

	it('should return error when stat throws', async () => {
		vi.mocked(window.maestro.fs.stat).mockRejectedValue(new Error('Connection refused'));

		const { result } = renderHook(() =>
			useRemotePathValidation({
				isSshEnabled: true,
				path: '/some/path',
				sshRemoteId: 'remote-1',
				debounceMs: 10,
			})
		);

		await waitFor(() => {
			expect(result.current).toEqual({
				checking: false,
				valid: false,
				isDirectory: false,
				error: 'Path not found or not accessible',
			});
		});
	});

	it('should reset to default when SSH is toggled off', async () => {
		vi.mocked(window.maestro.fs.stat).mockResolvedValue({
			isDirectory: true,
			isFile: false,
			size: 0,
			mtimeMs: 0,
		});

		const { result, rerender } = renderHook((props) => useRemotePathValidation(props), {
			initialProps: {
				isSshEnabled: true,
				path: '/some/path',
				sshRemoteId: 'remote-1' as string | null | undefined,
				debounceMs: 10,
			},
		});

		// Wait for validation to complete
		await waitFor(() => {
			expect(result.current.valid).toBe(true);
		});

		// Toggle SSH off
		rerender({
			isSshEnabled: false,
			path: '/some/path',
			sshRemoteId: 'remote-1',
			debounceMs: 10,
		});

		await waitFor(() => {
			expect(result.current).toEqual({
				checking: false,
				valid: false,
				isDirectory: false,
			});
		});
	});

	it('should not call stat when SSH is disabled even with valid path and remoteId', async () => {
		vi.mocked(window.maestro.fs.stat).mockResolvedValue({
			isDirectory: true,
			isFile: false,
			size: 0,
			mtimeMs: 0,
		});

		renderHook(() =>
			useRemotePathValidation({
				isSshEnabled: false,
				path: '/some/path',
				sshRemoteId: 'remote-1',
				debounceMs: 10,
			})
		);

		// Wait a bit to ensure debounce would have fired
		await new Promise((r) => setTimeout(r, 50));

		expect(window.maestro.fs.stat).not.toHaveBeenCalled();
	});
});
