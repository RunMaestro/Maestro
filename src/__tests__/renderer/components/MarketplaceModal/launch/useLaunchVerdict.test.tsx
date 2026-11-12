/**
 * Tests for useLaunchVerdict: the verdict the outro shows, cut from the report file a launched run
 * writes. A missing report is the normal case for a run that stopped early, so it is "no verdict",
 * not an error; a read that fails for another reason is reported and also reads as "no verdict".
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

vi.mock('../../../../../renderer/utils/sentry', () => ({
	captureException: vi.fn(),
	captureMessage: vi.fn(),
}));

import { useLaunchVerdict } from '../../../../../renderer/components/MarketplaceModal/launch/useLaunchVerdict';
import { captureException } from '../../../../../renderer/utils/sentry';

const readFile = vi.mocked(window.maestro.fs.readFile);

const REPORT = '/runs/docs/REPORT.md';

/** A read the test settles by hand, to look at the state in between. */
function deferredRead() {
	let resolve!: (content: string | null) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<string | null>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

beforeEach(() => {
	vi.clearAllMocks();
	readFile.mockReset();
	readFile.mockResolvedValue('');
});

describe('useLaunchVerdict', () => {
	describe('with no report file', () => {
		it('has no verdict and reads nothing', () => {
			const { result } = renderHook(() => useLaunchVerdict(undefined, undefined));

			expect(result.current).toEqual({ status: 'none' });
			expect(readFile).not.toHaveBeenCalled();
		});
	});

	describe('with a report file', () => {
		it('is loading while the file is read, then has the first section as the verdict', async () => {
			const read = deferredRead();
			readFile.mockReturnValueOnce(read.promise);

			const { result } = renderHook(() => useLaunchVerdict(REPORT, undefined));

			expect(result.current).toEqual({ status: 'loading' });
			await act(async () => {
				read.resolve('# Review\n\nAPPROVE: no blocking issues.\n\n## Findings\n\nNone.');
			});
			expect(result.current).toEqual({
				status: 'ready',
				section: { heading: 'Review', level: 1, body: 'APPROVE: no blocking issues.' },
			});
		});

		it('reads the file it was given, on the machine it was given', async () => {
			renderHook(() => useLaunchVerdict(REPORT, 'remote-1'));

			await waitFor(() => expect(readFile).toHaveBeenCalledTimes(1));
			expect(readFile).toHaveBeenCalledWith(REPORT, 'remote-1');
		});

		it('reads a file on this machine with no SSH remote', async () => {
			renderHook(() => useLaunchVerdict(REPORT, undefined));

			await waitFor(() => expect(readFile).toHaveBeenCalledWith(REPORT, undefined));
		});

		it('takes the section after a title that has nothing under it', async () => {
			readFile.mockResolvedValue('# Setup\n\n## Status\n\nINSTALLED-ACTIVE\n\n## Log\n\nx');

			const { result } = renderHook(() => useLaunchVerdict(REPORT, undefined));

			await waitFor(() => expect(result.current.status).toBe('ready'));
			expect(result.current).toEqual({
				status: 'ready',
				section: { heading: 'Status', level: 2, body: 'INSTALLED-ACTIVE' },
			});
		});

		it('leaves the front matter out, so a # comment in it is not a heading', async () => {
			readFile.mockResolvedValue(
				'---\ntype: report\n# a yaml comment\ncreated: 2026-11-10\n---\n# Report\n\nDone.'
			);

			const { result } = renderHook(() => useLaunchVerdict(REPORT, undefined));

			await waitFor(() => expect(result.current.status).toBe('ready'));
			expect(result.current).toEqual({
				status: 'ready',
				section: { heading: 'Report', level: 1, body: 'Done.' },
			});
		});

		it('has no verdict when the file is not there (a run that stopped before it wrote it)', async () => {
			readFile.mockResolvedValue(null);

			const { result } = renderHook(() => useLaunchVerdict(REPORT, undefined));

			await waitFor(() => expect(result.current).toEqual({ status: 'none' }));
			expect(captureException).not.toHaveBeenCalled();
		});

		it('has no verdict when no heading in the file has text under it', async () => {
			readFile.mockResolvedValue('Some text with no heading.\n\n# Title only');

			const { result } = renderHook(() => useLaunchVerdict(REPORT, undefined));

			await waitFor(() => expect(result.current).toEqual({ status: 'none' }));
		});

		it('has no verdict for an empty file', async () => {
			readFile.mockResolvedValue('');

			const { result } = renderHook(() => useLaunchVerdict(REPORT, undefined));

			await waitFor(() => expect(result.current).toEqual({ status: 'none' }));
		});

		it('reports a read that fails to Sentry, and has no verdict', async () => {
			const fault = new Error('EACCES: permission denied');
			readFile.mockRejectedValue(fault);

			const { result } = renderHook(() => useLaunchVerdict(REPORT, 'remote-1'));

			await waitFor(() => expect(result.current).toEqual({ status: 'none' }));
			expect(captureException).toHaveBeenCalledWith(fault, {
				extra: {
					operation: 'playbookOutro:readReport',
					reportPath: REPORT,
					sshRemoteId: 'remote-1',
				},
			});
		});
	});

	describe('when the report changes', () => {
		it('reads the new file and shows loading again', async () => {
			readFile.mockResolvedValueOnce('# One\n\nFirst.');
			const { result, rerender } = renderHook(
				({ path }: { path: string }) => useLaunchVerdict(path, undefined),
				{ initialProps: { path: '/runs/one.md' } }
			);
			await waitFor(() => expect(result.current.status).toBe('ready'));
			const second = deferredRead();
			readFile.mockReturnValueOnce(second.promise);

			rerender({ path: '/runs/two.md' });

			expect(result.current).toEqual({ status: 'loading' });
			await act(async () => {
				second.resolve('# Two\n\nSecond.');
			});
			expect(result.current).toEqual({
				status: 'ready',
				section: { heading: 'Two', level: 1, body: 'Second.' },
			});
		});

		it('ignores a late answer for the file it has moved off', async () => {
			const first = deferredRead();
			readFile.mockReturnValueOnce(first.promise);
			readFile.mockResolvedValueOnce('# Two\n\nSecond.');
			const { result, rerender } = renderHook(
				({ path }: { path: string }) => useLaunchVerdict(path, undefined),
				{ initialProps: { path: '/runs/one.md' } }
			);

			rerender({ path: '/runs/two.md' });
			await waitFor(() => expect(result.current.status).toBe('ready'));
			await act(async () => {
				first.resolve('# One\n\nFirst.');
			});

			expect(result.current).toEqual({
				status: 'ready',
				section: { heading: 'Two', level: 1, body: 'Second.' },
			});
		});

		it('has no verdict once the report is dropped', async () => {
			readFile.mockResolvedValue('# One\n\nFirst.');
			const { result, rerender } = renderHook(
				({ path }: { path: string | undefined }) => useLaunchVerdict(path, undefined),
				{ initialProps: { path: '/runs/one.md' as string | undefined } }
			);
			await waitFor(() => expect(result.current.status).toBe('ready'));

			rerender({ path: undefined });

			await waitFor(() => expect(result.current).toEqual({ status: 'none' }));
		});

		it('stays quiet when the dialog closes before the file arrives', async () => {
			const read = deferredRead();
			readFile.mockReturnValueOnce(read.promise);
			const { unmount } = renderHook(() => useLaunchVerdict(REPORT, undefined));

			unmount();
			await act(async () => {
				read.resolve('# One\n\nFirst.');
			});

			expect(captureException).not.toHaveBeenCalled();
		});

		it('still reports a failure that arrives after the dialog closed', async () => {
			const read = deferredRead();
			readFile.mockReturnValueOnce(read.promise);
			const { unmount } = renderHook(() => useLaunchVerdict(REPORT, undefined));

			unmount();
			await act(async () => {
				read.reject(new Error('late'));
			});

			// The fault happened, so it is reported; only the state update is skipped.
			expect(captureException).toHaveBeenCalledTimes(1);
		});
	});
});
