// Source: src/__tests__/renderer/hooks/utils/usePathExistence.test.ts
// Source: src/__tests__/renderer/hooks/utils/useCachedResource.test.tsx
import { describe as describeSourceSuite } from 'vitest';
import { act } from '@testing-library/react';
import { renderHook } from '@testing-library/react';
import { beforeEach } from 'vitest';
import { describe } from 'vitest';
import { expect } from 'vitest';
import { it } from 'vitest';
import { vi } from 'vitest';
import { usePathExistence } from '../../../../renderer/hooks/utils/usePathExistence';
import { resetPathExistenceCache } from '../../../../renderer/utils/fileLinks/pathExistence';
import { clearCachedResources } from '../../../../renderer/hooks/utils/useCachedResource';
import { readCachedResource } from '../../../../renderer/hooks/utils/useCachedResource';
import { revalidateCachedResource } from '../../../../renderer/hooks/utils/useCachedResource';
import { useCachedResource } from '../../../../renderer/hooks/utils/useCachedResource';
describeSourceSuite('usePathExistence', () => {
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
});
describeSourceSuite('useCachedResource', () => {
	function deferred<T>() {
		let resolve: (value: T) => void = () => {};
		let reject: (error: unknown) => void = () => {};
		const promise = new Promise<T>((res, rej) => {
			resolve = res;
			reject = rej;
		});
		return { promise, resolve, reject };
	}

	describe('useCachedResource', () => {
		it('is loading until the first fetch lands', async () => {
			const pending = deferred<string>();
			const { result } = renderHook(() => useCachedResource('k:first', () => pending.promise));

			expect(result.current.loading).toBe(true);
			expect(result.current.data).toBeUndefined();

			await act(async () => pending.resolve('one'));
			expect(result.current.loading).toBe(false);
			expect(result.current.data).toBe('one');
			expect(result.current.fetchedAt).toBeGreaterThan(0);
		});

		it('renders the cached value on remount and refreshes it in place', async () => {
			const first = renderHook(() => useCachedResource('k:remount', () => Promise.resolve('old')));
			await act(async () => {});
			first.unmount();

			const next = deferred<string>();
			const second = renderHook(() => useCachedResource('k:remount', () => next.promise));
			// Instant: no loading state, the previous result on the first render.
			expect(second.result.current.loading).toBe(false);
			expect(second.result.current.data).toBe('old');
			expect(second.result.current.refreshing).toBe(true);

			await act(async () => next.resolve('new'));
			expect(second.result.current.data).toBe('new');
			expect(second.result.current.refreshing).toBe(false);
		});

		it('shares one fetch between consumers of a key', async () => {
			const fetcher = vi.fn(() => Promise.resolve(42));
			renderHook(() => {
				useCachedResource('k:shared', fetcher);
				useCachedResource('k:shared', fetcher);
			});
			await act(async () => {});
			expect(fetcher).toHaveBeenCalledTimes(1);
			expect(readCachedResource<number>('k:shared')).toBe(42);
		});

		it('keeps the last good data when a refresh fails, and reports the failure', async () => {
			const onError = vi.fn();
			let fail = false;
			const { result } = renderHook(() =>
				useCachedResource(
					'k:fail',
					() => (fail ? Promise.reject(new Error('boom')) : Promise.resolve('good')),
					{ onError }
				)
			);
			await act(async () => {});
			fail = true;
			await act(async () => {
				await result.current.refresh();
			});

			expect(result.current.data).toBe('good');
			expect(result.current.error).toBe('boom');
			expect(result.current.loading).toBe(false);
			expect(onError).toHaveBeenCalledTimes(1);
		});

		it('does not fetch while disabled or with a null key', async () => {
			const fetcher = vi.fn(() => Promise.resolve(1));
			const disabled = renderHook(() => useCachedResource('k:off', fetcher, { enabled: false }));
			const nullKey = renderHook(() => useCachedResource(null, fetcher));
			await act(async () => {});

			expect(fetcher).not.toHaveBeenCalled();
			expect(disabled.result.current.loading).toBe(false);
			expect(nullKey.result.current.loading).toBe(false);
		});

		it('drops a fetch that started before the cache was cleared', async () => {
			const pending = deferred<string>();
			const started = revalidateCachedResource('k:stale', () => pending.promise);
			clearCachedResources();
			pending.resolve('stale');
			await started;
			expect(readCachedResource('k:stale')).toBeUndefined();
		});
	});
});
