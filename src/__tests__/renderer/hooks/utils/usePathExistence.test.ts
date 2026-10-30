import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { usePathExistence } from '../../../../renderer/hooks/utils/usePathExistence';
import { resetPathExistenceCache } from '../../../../renderer/utils/fileLinks/pathExistence';

const stat = () => vi.mocked(window.maestro.fs.stat);

describe('usePathExistence', () => {
	beforeEach(() => {
		resetPathExistenceCache();
		stat().mockReset();
	});

	it('changes identity when an answer it asked for lands', async () => {
		stat().mockResolvedValue({ isFile: true });
		const { result } = renderHook(() => usePathExistence());
		const first = result.current;

		expect(first('/Volumes/My Drive/a.md')).toBeUndefined();
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 0));
		});

		expect(result.current).not.toBe(first);
		expect(result.current('/Volumes/My Drive/a.md')).toBe(true);
	});

	it('keeps its identity when an answer it did not ask for lands', async () => {
		stat().mockResolvedValue({ isFile: true });
		const { result } = renderHook(() => usePathExistence());
		const other = renderHook(() => usePathExistence());
		const first = result.current;

		other.result.current('/elsewhere/x y.md');
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 0));
		});

		expect(result.current).toBe(first);
	});

	it('asks the SSH remote it was given', () => {
		stat().mockResolvedValue(null);
		const { result } = renderHook(() => usePathExistence('host-1'));
		result.current('/srv/my app/a.md');
		expect(stat()).toHaveBeenCalledWith('/srv/my app/a.md', 'host-1');
	});
});
