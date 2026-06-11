import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { UseRightPanelPropsDeps } from '../../../renderer/hooks/props/useRightPanelProps';
import { useRightPanelProps } from '../../../renderer/hooks/props/useRightPanelProps';

function makeDeps(overrides: Partial<UseRightPanelPropsDeps> = {}): UseRightPanelPropsDeps {
	const noop = vi.fn();

	return {
		theme: { name: 'dark' } as UseRightPanelPropsDeps['theme'],
		fileTreeContainerRef: { current: null },
		fileTreeFilterInputRef: { current: null },
		handleSetActiveRightTab: noop,
		toggleFolder: noop,
		handleFileClick: vi.fn().mockResolvedValue(undefined),
		expandAllFolders: noop,
		collapseAllFolders: noop,
		updateSessionWorkingDirectory: vi.fn().mockResolvedValue(undefined),
		refreshFileTree: vi.fn().mockResolvedValue(undefined),
		handleAutoRefreshChange: noop,
		showSuccessFlash: noop,
		handleAutoRunContentChange: noop,
		handleAutoRunModeChange: noop,
		handleAutoRunStateChange: noop,
		handleAutoRunSelectDocument: noop,
		handleAutoRunCreateDocument: vi.fn().mockResolvedValue(true),
		handleAutoRunRefresh: noop,
		handleAutoRunOpenSetup: noop,
		currentSessionBatchState: undefined,
		handleOpenBatchRunner: noop,
		handleStopBatchRun: noop,
		handleKillBatchRun: noop,
		handleSkipCurrentDocument: noop,
		handleAbortBatchOnError: noop,
		handleResumeAfterError: noop,
		handleJumpToAgentSession: noop,
		handleResumeSession: noop,
		handleOpenAboutModal: noop,
		handleOpenMarketplace: noop,
		handleLaunchWizardTab: noop,
		handleMainPanelFileClick: noop,
		handleFocusFileInGraph: noop,
		handleOpenLastDocumentGraph: noop,
		...overrides,
	};
}

describe('useRightPanelProps', () => {
	it('maps right-panel domain handlers to component prop names', () => {
		const handleSetActiveRightTab = vi.fn();
		const handleAutoRunCreateDocument = vi.fn().mockResolvedValue(false);
		const handleResumeSession = vi.fn();
		const handleFocusFileInGraph = vi.fn();
		const deps = makeDeps({
			handleSetActiveRightTab,
			handleAutoRunCreateDocument,
			handleResumeSession,
			handleFocusFileInGraph,
		});

		const { result } = renderHook(() => useRightPanelProps(deps));

		result.current.setActiveRightTab('files');
		result.current.onAutoRunCreateDocument('plan.md');
		result.current.onOpenSessionAsTab('agent-session-1');
		result.current.onOpenSessionAsTab('agent-session-2', '/other/project');
		result.current.onFocusFileInGraph('docs/plan.md');

		expect(result.current.theme).toBe(deps.theme);
		expect(result.current.fileTreeContainerRef).toBe(deps.fileTreeContainerRef);
		expect(result.current.onAutoRunCreateDocument).toBe(handleAutoRunCreateDocument);
		expect(handleSetActiveRightTab).toHaveBeenCalledWith('files');
		expect(handleAutoRunCreateDocument).toHaveBeenCalledWith('plan.md');
		// onOpenSessionAsTab forwards the (optional) project path to handleResumeSession's
		// trailing parameter so cross-project history entries read from the right storage.
		expect(handleResumeSession).toHaveBeenCalledWith(
			'agent-session-1',
			undefined,
			undefined,
			undefined,
			undefined,
			undefined
		);
		expect(handleResumeSession).toHaveBeenCalledWith(
			'agent-session-2',
			undefined,
			undefined,
			undefined,
			undefined,
			'/other/project'
		);
		expect(handleFocusFileInGraph).toHaveBeenCalledWith('docs/plan.md');
	});

	it('reuses the memoized object until a mapped dependency changes', () => {
		const deps = makeDeps();
		const { result, rerender } = renderHook(({ currentDeps }) => useRightPanelProps(currentDeps), {
			initialProps: { currentDeps: deps },
		});
		const initialProps = result.current;

		rerender({ currentDeps: { ...deps } });

		expect(result.current).toBe(initialProps);

		rerender({
			currentDeps: {
				...deps,
				currentSessionBatchState: {
					isRunning: true,
				} as UseRightPanelPropsDeps['currentSessionBatchState'],
			},
		});

		expect(result.current).not.toBe(initialProps);
	});
});
