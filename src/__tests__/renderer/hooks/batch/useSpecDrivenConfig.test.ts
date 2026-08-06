import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSpecDrivenConfig } from '../../../../renderer/hooks/batch/useSpecDrivenConfig';
import { useBatchStore } from '../../../../renderer/stores/batchStore';

describe('useSpecDrivenConfig', () => {
	beforeEach(() => {
		useBatchStore.setState({
			documentTaskCounts: new Map(),
			isLoadingDocuments: false,
		});
	});

	it('seeds documents and loop settings from an initial config', () => {
		const document = {
			id: 'remote-document',
			filename: 'nested/spec',
			resetOnCompletion: true,
			isDuplicate: false,
		};
		const { result } = renderHook(() =>
			useSpecDrivenConfig({
				presetDocuments: ['preset'],
				initialConfig: {
					documents: [document],
					loopEnabled: true,
					maxLoops: 3,
				},
				allDocuments: [],
				getDocumentTaskCount: vi.fn(),
			})
		);

		expect(result.current.documents).toEqual([document]);
		expect(result.current.initialDocumentsRef.current).toEqual(['nested/spec']);
		expect(result.current.loopEnabled).toBe(true);
		expect(result.current.maxLoops).toBe(3);
		expect(result.current.initialLoopEnabledRef.current).toBe(true);
		expect(result.current.initialMaxLoopsRef.current).toBe(3);
	});
});
