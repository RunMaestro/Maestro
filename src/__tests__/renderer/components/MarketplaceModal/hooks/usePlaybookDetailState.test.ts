import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { usePlaybookDetailState } from '../../../../../renderer/components/MarketplaceModal/hooks';
import { makePlaybook } from '../_fixtures';

function createDeferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((resolver) => {
		resolve = resolver;
	});
	return { promise, resolve };
}

describe('usePlaybookDetailState', () => {
	it('opens detail view, generates default folder slug, and loads README', async () => {
		const fetchReadme = vi.fn().mockResolvedValue('# README');
		const fetchDocument = vi.fn();
		const playbook = makePlaybook({ title: 'API Review!!', path: 'playbooks/api-review' });

		const { result } = renderHook(() => usePlaybookDetailState({ fetchReadme, fetchDocument }));

		await act(async () => {
			await result.current.handleSelectPlaybook(playbook);
		});

		expect(result.current.selectedPlaybook).toBe(playbook);
		expect(result.current.showDetailView).toBe(true);
		expect(result.current.targetFolderName).toBe('api-review');
		expect(result.current.readmeContent).toBe('# README');
		expect(fetchReadme).toHaveBeenCalledWith('playbooks/api-review');
	});

	it('loads selected documents and switches back to README without refetching', async () => {
		const fetchReadme = vi.fn().mockResolvedValue('# README');
		const fetchDocument = vi.fn().mockResolvedValue('# Phase 1');
		const playbook = makePlaybook();

		const { result } = renderHook(() => usePlaybookDetailState({ fetchReadme, fetchDocument }));

		await act(async () => {
			await result.current.handleSelectPlaybook(playbook);
		});

		await act(async () => {
			await result.current.handleSelectDocument('phase-1');
		});

		expect(result.current.selectedDocFilename).toBe('phase-1');
		expect(result.current.documentContent).toBe('# Phase 1');
		expect(fetchDocument).toHaveBeenCalledWith(playbook.path, 'phase-1');

		await act(async () => {
			await result.current.handleSelectDocument('');
		});

		expect(result.current.selectedDocFilename).toBeNull();
		expect(result.current.documentContent).toBeNull();
		expect(fetchDocument).toHaveBeenCalledTimes(1);
	});

	it('does nothing when selecting a document without a selected playbook', async () => {
		const fetchReadme = vi.fn();
		const fetchDocument = vi.fn();

		const { result } = renderHook(() => usePlaybookDetailState({ fetchReadme, fetchDocument }));

		await act(async () => {
			await result.current.handleSelectDocument('phase-1');
		});

		expect(fetchDocument).not.toHaveBeenCalled();
		expect(result.current.selectedDocFilename).toBeNull();
	});

	it('ignores stale README responses after selecting another playbook', async () => {
		const firstReadme = createDeferred<string | null>();
		const secondReadme = createDeferred<string | null>();
		const fetchReadme = vi
			.fn()
			.mockReturnValueOnce(firstReadme.promise)
			.mockReturnValueOnce(secondReadme.promise);
		const fetchDocument = vi.fn();
		const firstPlaybook = makePlaybook({ id: 'first', title: 'First', path: 'first' });
		const secondPlaybook = makePlaybook({ id: 'second', title: 'Second', path: 'second' });

		const { result } = renderHook(() => usePlaybookDetailState({ fetchReadme, fetchDocument }));

		let firstSelect = Promise.resolve();
		act(() => {
			firstSelect = result.current.handleSelectPlaybook(firstPlaybook);
		});

		let secondSelect = Promise.resolve();
		act(() => {
			secondSelect = result.current.handleSelectPlaybook(secondPlaybook);
		});

		await act(async () => {
			secondReadme.resolve('# Second README');
			await secondSelect;
		});

		expect(result.current.selectedPlaybook).toBe(secondPlaybook);
		expect(result.current.readmeContent).toBe('# Second README');
		expect(result.current.isLoadingDocument).toBe(false);

		await act(async () => {
			firstReadme.resolve('# First README');
			await firstSelect;
		});

		expect(result.current.selectedPlaybook).toBe(secondPlaybook);
		expect(result.current.readmeContent).toBe('# Second README');
		expect(result.current.isLoadingDocument).toBe(false);
	});

	it('ignores stale document responses after selecting another document', async () => {
		const firstDocument = createDeferred<string | null>();
		const secondDocument = createDeferred<string | null>();
		const fetchReadme = vi.fn().mockResolvedValue('# README');
		const fetchDocument = vi
			.fn()
			.mockReturnValueOnce(firstDocument.promise)
			.mockReturnValueOnce(secondDocument.promise);
		const playbook = makePlaybook();

		const { result } = renderHook(() => usePlaybookDetailState({ fetchReadme, fetchDocument }));

		await act(async () => {
			await result.current.handleSelectPlaybook(playbook);
		});

		let firstSelect = Promise.resolve();
		act(() => {
			firstSelect = result.current.handleSelectDocument('phase-1');
		});

		let secondSelect = Promise.resolve();
		act(() => {
			secondSelect = result.current.handleSelectDocument('phase-2');
		});

		await act(async () => {
			secondDocument.resolve('# Phase 2');
			await secondSelect;
		});

		expect(result.current.selectedDocFilename).toBe('phase-2');
		expect(result.current.documentContent).toBe('# Phase 2');
		expect(result.current.isLoadingDocument).toBe(false);

		await act(async () => {
			firstDocument.resolve('# Phase 1');
			await firstSelect;
		});

		expect(result.current.selectedDocFilename).toBe('phase-2');
		expect(result.current.documentContent).toBe('# Phase 2');
		expect(result.current.isLoadingDocument).toBe(false);
	});

	it('back to list resets detail state', async () => {
		const fetchReadme = vi.fn().mockResolvedValue('# README');
		const fetchDocument = vi.fn().mockResolvedValue('# Phase');
		const { result } = renderHook(() => usePlaybookDetailState({ fetchReadme, fetchDocument }));

		await act(async () => {
			await result.current.handleSelectPlaybook(makePlaybook());
			await result.current.handleSelectDocument('phase-1');
		});

		act(() => {
			result.current.handleBackToList();
		});

		expect(result.current.showDetailView).toBe(false);
		expect(result.current.selectedPlaybook).toBeNull();
		expect(result.current.readmeContent).toBeNull();
		expect(result.current.selectedDocFilename).toBeNull();
		expect(result.current.documentContent).toBeNull();
		expect(result.current.targetFolderName).toBe('');
	});
});
