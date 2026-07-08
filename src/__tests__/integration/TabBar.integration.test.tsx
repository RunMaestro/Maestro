import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TabBar } from '../../renderer/components/TabBar';
import type { AITab, FilePreviewTab, LogEntry, Theme, UnifiedTab } from '../../renderer/types';

function createTheme(): Theme {
	return {
		id: 'integration-dark',
		name: 'Integration Dark',
		mode: 'dark',
		colors: {
			bgMain: '#111827',
			bgSidebar: '#1f2937',
			bgActivity: '#0f172a',
			textMain: '#f9fafb',
			textDim: '#9ca3af',
			accent: '#2563eb',
			accentDim: '#1d4ed8',
			accentForeground: '#ffffff',
			border: '#374151',
			success: '#16a34a',
			warning: '#f59e0b',
			error: '#dc2626',
			info: '#0ea5e9',
			bgAccentHover: '#1d4ed8',
		},
	};
}

function createLightTheme(): Theme {
	const theme = createTheme();
	return {
		...theme,
		id: 'integration-light',
		name: 'Integration Light',
		mode: 'light',
		colors: {
			...theme.colors,
			bgMain: '#ffffff',
			bgSidebar: '#f8fafc',
			bgActivity: '#f1f5f9',
			textMain: '#111827',
			textDim: '#64748b',
			border: '#cbd5e1',
		},
	};
}

function createLog(id: string, text: string, source: LogEntry['source'] = 'assistant'): LogEntry {
	return {
		id,
		text,
		source,
		timestamp: 1700000000000,
	};
}

function createTab(overrides: Partial<AITab> = {}): AITab {
	return {
		id: 'tab-1',
		agentSessionId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
		state: 'idle',
		name: 'Planning',
		starred: false,
		hasUnread: false,
		inputValue: '',
		stagedImages: [],
		logs: [],
		createdAt: 1700000000000,
		saveToHistory: true,
		...overrides,
	};
}

function createFileTab(overrides: Partial<FilePreviewTab> = {}): FilePreviewTab {
	return {
		id: 'file-1',
		path: '/workspace/project/README.md',
		name: 'README',
		extension: '.md',
		content: '# README',
		scrollTop: 0,
		searchQuery: '',
		editMode: false,
		editContent: '# Draft README',
		createdAt: 1700000000000,
		lastModified: 1700000000000,
		...overrides,
	};
}

function createHarness(overrides: Partial<React.ComponentProps<typeof TabBar>> = {}) {
	const primaryTab = createTab({
		id: 'tab-1',
		name: 'Planning',
		hasUnread: true,
		inputValue: 'draft prompt',
		logs: [
			createLog('log-1', 'User question', 'user'),
			createLog('log-2', 'Assistant answer'),
			createLog('log-3', 'More context'),
			createLog('log-4', 'Even more context'),
			createLog('log-5', 'Enough for compact'),
		],
	});
	const secondaryTab = createTab({
		id: 'tab-2',
		name: '',
		agentSessionId: 'ses_4bcdef8c5ffe4kc1uv9nsmyedb',
		hasUnread: false,
		logs: [],
	});
	const fileTab = createFileTab();
	const unifiedTabs: UnifiedTab[] = [
		{ type: 'ai', id: primaryTab.id, data: primaryTab },
		{ type: 'file', id: fileTab.id, data: fileTab },
		{ type: 'ai', id: secondaryTab.id, data: secondaryTab },
	];

	const props = {
		tabs: [primaryTab, secondaryTab],
		activeTabId: primaryTab.id,
		theme: createTheme(),
		onTabSelect: vi.fn(),
		onTabClose: vi.fn(),
		onNewTab: vi.fn(),
		onRequestRename: vi.fn(),
		onTabReorder: vi.fn(),
		onUnifiedTabReorder: vi.fn(),
		onTabStar: vi.fn(),
		onTabMarkUnread: vi.fn(),
		onMergeWith: vi.fn(),
		onSendToAgent: vi.fn(),
		onSummarizeAndContinue: vi.fn(),
		onCopyContext: vi.fn(),
		onExportHtml: vi.fn(),
		onPublishGist: vi.fn(),
		ghCliAvailable: true,
		onOpenTabSearch: vi.fn(),
		onCloseAllTabs: vi.fn(),
		onCloseOtherTabs: vi.fn(),
		onCloseTabsLeft: vi.fn(),
		onCloseTabsRight: vi.fn(),
		unifiedTabs,
		activeFileTabId: null,
		onFileTabSelect: vi.fn(),
		onFileTabClose: vi.fn(),
		colorBlindMode: true,
		...overrides,
	};

	const result = render(<TabBar {...props} />);
	return { ...result, props, primaryTab, secondaryTab, fileTab };
}

function openOverlay(label: string) {
	const tab = screen.getAllByText(label)[0].closest('[data-tab-id]')!;
	fireEvent.mouseEnter(tab);
	act(() => {
		vi.advanceTimersByTime(450);
	});
}

function closeOverlayWithAction(label: string) {
	openOverlay('Planning');
	fireEvent.click(screen.getByText(label));
}

describe('TabBar integration', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.clearAllMocks();
		Object.defineProperty(navigator, 'clipboard', {
			configurable: true,
			value: { writeText: vi.fn().mockResolvedValue(undefined) },
		});
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it('coordinates unified AI and file tab selection, filtering, and drag reorder', () => {
		const { props } = createHarness();

		expect(screen.getByText('Planning')).toBeInTheDocument();
		expect(screen.getByText('README')).toBeInTheDocument();
		expect(screen.getByText('MD')).toBeInTheDocument();
		expect(screen.getByText('SES_4BCD')).toBeInTheDocument();

		fireEvent.click(screen.getByText('README'));
		expect(props.onFileTabSelect).toHaveBeenCalledWith('file-1');

		fireEvent.click(screen.getByText('SES_4BCD'));
		expect(props.onTabSelect).toHaveBeenCalledWith('tab-2');

		fireEvent.click(screen.getByTitle(/New tab/));
		expect(props.onNewTab).toHaveBeenCalledTimes(1);
		fireEvent.click(screen.getByTitle(/Search/));
		fireEvent.click(screen.getByRole('button', { name: /Search Tabs/ }));
		expect(props.onOpenTabSearch).toHaveBeenCalledTimes(1);

		const dataTransfer = {
			effectAllowed: '',
			dropEffect: '',
			setData: vi.fn(),
			getData: vi.fn(() => 'tab-1'),
		};
		const source = screen.getByText('Planning').closest('[data-tab-id]')!;
		const target = screen.getByText('README').closest('[data-tab-id]')!;
		fireEvent.dragStart(source, { dataTransfer });
		fireEvent.dragOver(target, { dataTransfer });
		fireEvent.drop(target, { dataTransfer });
		expect(props.onUnifiedTabReorder).toHaveBeenCalledWith(0, 1);

		fireEvent.click(screen.getByTitle(/Filter unread tabs/));
		expect(screen.getByText('Planning')).toBeInTheDocument();
		expect(screen.queryByText('README')).not.toBeInTheDocument();
		expect(screen.queryByText('SES_4BCD')).not.toBeInTheDocument();
	});

	it('runs AI and file hover-menu actions through callbacks, clipboard, and shell bridge', () => {
		const { props } = createHarness();

		openOverlay('Planning');
		fireEvent.click(screen.getByText('Copy Session ID'));
		expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
			'a1b2c3d4-e5f6-7890-abcd-ef1234567890'
		);
		fireEvent.click(screen.getByText('Star Session'));
		expect(props.onTabStar).toHaveBeenCalledWith('tab-1', true);

		openOverlay('Planning');
		fireEvent.click(screen.getByText('Rename Tab'));
		expect(props.onRequestRename).toHaveBeenCalledWith('tab-1');

		openOverlay('Planning');
		fireEvent.click(screen.getByText('Context: Compact'));
		expect(props.onSummarizeAndContinue).toHaveBeenCalledWith('tab-1');

		openOverlay('Planning');
		fireEvent.click(screen.getByText('Context: Publish as GitHub Gist'));
		expect(props.onPublishGist).toHaveBeenCalledWith('tab-1');

		openOverlay('README');
		fireEvent.click(screen.getByText('Copy File Path'));
		expect(navigator.clipboard.writeText).toHaveBeenCalledWith('/workspace/project/README.md');
		fireEvent.click(screen.getByText('Open in Default App'));
		expect(window.maestro.shell.openPath).toHaveBeenCalledWith('/workspace/project/README.md');

		openOverlay('README');
		fireEvent.click(screen.getByText('Reveal in Finder'));
		expect(window.maestro.shell.showItemInFolder).toHaveBeenCalledWith(
			'/workspace/project/README.md'
		);

		openOverlay('README');
		fireEvent.click(screen.getByText('Move to First Position'));
		expect(props.onUnifiedTabReorder).toHaveBeenCalledWith(1, 0);

		openOverlay('README');
		fireEvent.click(screen.getByText('Close Tabs to Left'));
		expect(props.onCloseTabsLeft).toHaveBeenCalledTimes(1);
	});

	it('routes remaining AI hover-menu actions and pointer dismissal paths', () => {
		const { props } = createHarness();

		closeOverlayWithAction('Mark as Unread');
		expect(props.onTabMarkUnread).toHaveBeenCalledWith('tab-1');

		closeOverlayWithAction('Context: Merge Into');
		expect(props.onMergeWith).toHaveBeenCalledWith('tab-1');

		closeOverlayWithAction('Context: Send to Agent');
		expect(props.onSendToAgent).toHaveBeenCalledWith('tab-1');

		closeOverlayWithAction('Context: Copy to Clipboard');
		expect(props.onCopyContext).toHaveBeenCalledWith('tab-1');

		closeOverlayWithAction('Export as HTML');
		expect(props.onExportHtml).toHaveBeenCalledWith('tab-1');

		closeOverlayWithAction('Move to Last Position');
		expect(props.onUnifiedTabReorder).toHaveBeenCalledWith(0, 2);

		closeOverlayWithAction('Close Other Tabs');
		expect(props.onCloseOtherTabs).toHaveBeenCalledTimes(1);

		closeOverlayWithAction('Close Tabs to Right');
		expect(props.onCloseTabsRight).toHaveBeenCalledTimes(1);

		closeOverlayWithAction('Close Tab');
		expect(props.onTabClose).toHaveBeenCalledWith('tab-1');

		const planningTab = screen.getAllByText('Planning')[0].closest('[data-tab-id]')!;
		fireEvent.mouseDown(planningTab, { button: 1 });
		expect(props.onTabClose).toHaveBeenCalledWith('tab-1');

		fireEvent.mouseEnter(planningTab);
		act(() => {
			vi.advanceTimersByTime(450);
		});
		const overlay = screen.getByText('Copy Session ID').closest('.fixed')!;
		fireEvent.mouseEnter(overlay);
		fireEvent.mouseLeave(planningTab);
		act(() => {
			vi.advanceTimersByTime(100);
		});
		expect(screen.getByText('Copy Session ID')).toBeInTheDocument();
		fireEvent.mouseLeave(overlay);
		expect(screen.queryByText('Copy Session ID')).not.toBeInTheDocument();
	});

	it('routes remaining file hover-menu actions and pointer dismissal paths', () => {
		const { props } = createHarness();

		openOverlay('README');
		fireEvent.click(screen.getByText('Copy File Name'));
		expect(navigator.clipboard.writeText).toHaveBeenCalledWith('README.md');

		openOverlay('README');
		fireEvent.click(screen.getByText('Move to Last Position'));
		expect(props.onUnifiedTabReorder).toHaveBeenCalledWith(1, 2);

		openOverlay('README');
		fireEvent.click(screen.getByText('Close Other Tabs'));
		expect(props.onCloseOtherTabs).toHaveBeenCalledTimes(1);

		openOverlay('README');
		fireEvent.click(screen.getByText('Close Tabs to Right'));
		expect(props.onCloseTabsRight).toHaveBeenCalledTimes(1);

		openOverlay('README');
		fireEvent.click(screen.getByText('Close Tab'));
		expect(props.onFileTabClose).toHaveBeenCalledWith('file-1');

		const readmeTab = screen.getByText('README').closest('[data-tab-id]')!;
		fireEvent.mouseDown(readmeTab, { button: 1 });
		expect(props.onFileTabClose).toHaveBeenCalledWith('file-1');

		fireEvent.mouseEnter(readmeTab);
		act(() => {
			vi.advanceTimersByTime(450);
		});
		const overlay = screen.getByText('Copy File Path').closest('.fixed')!;
		fireEvent.mouseEnter(overlay);
		fireEvent.mouseLeave(readmeTab);
		act(() => {
			vi.advanceTimersByTime(100);
		});
		expect(screen.getByText('Copy File Path')).toBeInTheDocument();
		fireEvent.mouseLeave(overlay);
		expect(screen.queryByText('Copy File Path')).not.toBeInTheDocument();
	});

	it('closes hover overlays from tab leave and direct tab controls', () => {
		const { props } = createHarness();

		const planningTab = screen.getAllByText('Planning')[0].closest('[data-tab-id]')!;
		fireEvent.mouseEnter(planningTab);
		act(() => {
			vi.advanceTimersByTime(450);
		});
		const aiOverlay = screen.getByText('Copy Session ID').closest('.fixed')!;
		fireEvent.click(aiOverlay);
		fireEvent.mouseLeave(planningTab);
		act(() => {
			vi.advanceTimersByTime(100);
		});
		expect(screen.queryByText('Copy Session ID')).not.toBeInTheDocument();

		openOverlay('SES_4BCD');
		fireEvent.click(screen.getByText('Close Tabs to Left'));
		expect(props.onCloseTabsLeft).toHaveBeenCalledTimes(1);

		const readmeTab = screen.getByText('README').closest('[data-tab-id]')!;
		fireEvent.mouseEnter(readmeTab);
		act(() => {
			vi.advanceTimersByTime(450);
		});
		const fileOverlay = screen.getByText('Copy File Path').closest('.fixed')!;
		fireEvent.click(fileOverlay);
		fireEvent.mouseLeave(readmeTab);
		act(() => {
			vi.advanceTimersByTime(100);
		});
		expect(screen.queryByText('Copy File Path')).not.toBeInTheDocument();

		fireEvent.mouseEnter(readmeTab);
		fireEvent.click(within(readmeTab).getByTitle('Close tab'));
		expect(props.onFileTabClose).toHaveBeenCalledWith('file-1');

		openOverlay('README');
		fireEvent.click(screen.getByText('Copy File Path'));
		expect(screen.getByText('Copied!')).toBeInTheDocument();
		act(() => {
			vi.advanceTimersByTime(1500);
		});
		expect(screen.getByText('Copy File Path')).toBeInTheDocument();

		const dataTransfer = {
			effectAllowed: '',
			setData: vi.fn(),
		};
		fireEvent.dragStart(readmeTab, { dataTransfer });
		expect(dataTransfer.setData).toHaveBeenCalledWith('text/plain', 'file-1');
	});

	it('renders session-id display-name fallbacks and suppresses empty single-tab overlays', () => {
		const threadTab = createTab({
			id: 'thread-tab',
			name: '',
			agentSessionId: 'thread_abcd1234efgh',
		});
		const uuidTab = createTab({
			id: 'uuid-tab',
			name: '',
			agentSessionId: 'abc123-def456',
		});
		const genericTab = createTab({
			id: 'generic-tab',
			name: '',
			agentSessionId: 'plainsession',
		});
		const emptyTab = createTab({
			id: 'empty-tab',
			name: '',
			agentSessionId: undefined,
		});

		const { unmount } = render(
			<TabBar
				tabs={[threadTab, uuidTab, genericTab, emptyTab]}
				activeTabId={threadTab.id}
				theme={createTheme()}
				onTabSelect={vi.fn()}
				onTabClose={vi.fn()}
				onNewTab={vi.fn()}
			/>
		);

		expect(screen.getByText('THR_ABCD')).toBeInTheDocument();
		expect(screen.getByText('ABC123')).toBeInTheDocument();
		expect(screen.getByText('PLAINSES')).toBeInTheDocument();
		expect(screen.getByText('New Session')).toBeInTheDocument();
		unmount();

		const singleTab = createTab({
			id: 'single-empty',
			name: '',
			agentSessionId: undefined,
			logs: [],
		});
		render(
			<TabBar
				tabs={[singleTab]}
				activeTabId={singleTab.id}
				theme={createTheme()}
				onTabSelect={vi.fn()}
				onTabClose={vi.fn()}
				onNewTab={vi.fn()}
			/>
		);

		fireEvent.mouseEnter(screen.getByText('New Session').closest('[data-tab-id]')!);
		act(() => {
			vi.advanceTimersByTime(450);
		});
		expect(screen.queryByText('Close Tab')).not.toBeInTheDocument();
	});

	it('supports legacy AI-only tab rendering, reordering, and close controls', () => {
		const { props } = createHarness({
			unifiedTabs: undefined,
			onUnifiedTabReorder: undefined,
		});

		expect(screen.getByText('Planning')).toBeInTheDocument();
		expect(screen.getByText('SES_4BCD')).toBeInTheDocument();
		expect(screen.queryByText('README')).not.toBeInTheDocument();

		const dataTransfer = {
			effectAllowed: '',
			dropEffect: '',
			setData: vi.fn(),
			getData: vi.fn(() => 'tab-1'),
		};
		const planningTab = screen.getByText('Planning').closest('[data-tab-id]')!;
		const sessionTab = screen.getByText('SES_4BCD').closest('[data-tab-id]')!;
		fireEvent.dragStart(planningTab, { dataTransfer });
		fireEvent.dragOver(sessionTab, { dataTransfer });
		fireEvent.dragEnd(planningTab);
		fireEvent.drop(sessionTab, { dataTransfer });
		expect(props.onTabReorder).toHaveBeenCalledWith(0, 1);

		openOverlay('Planning');
		fireEvent.click(screen.getByText('Move to Last Position'));
		expect(props.onTabReorder).toHaveBeenCalledWith(0, 1);

		openOverlay('SES_4BCD');
		fireEvent.click(screen.getByText('Move to First Position'));
		expect(props.onTabReorder).toHaveBeenCalledWith(1, 0);

		const closeButton = within(planningTab).getByTitle('Close tab');
		fireEvent.click(closeButton);
		expect(props.onTabClose).toHaveBeenCalledWith('tab-1');
	});

	it('keeps file tabs interactive when optional file callbacks are omitted', () => {
		const primaryTab = createTab({ id: 'tab-1', name: 'Planning' });
		const fileTab = createFileTab();

		render(
			<TabBar
				tabs={[primaryTab]}
				activeTabId={primaryTab.id}
				theme={createTheme()}
				onTabSelect={vi.fn()}
				onTabClose={vi.fn()}
				onNewTab={vi.fn()}
				unifiedTabs={[
					{ type: 'ai', id: primaryTab.id, data: primaryTab },
					{ type: 'file', id: fileTab.id, data: fileTab },
				]}
			/>
		);

		const readmeTab = screen.getByText('README').closest('[data-tab-id]')!;
		fireEvent.click(readmeTab);
		fireEvent.mouseDown(readmeTab, { button: 1 });
		expect(screen.getByText('README')).toBeInTheDocument();
	});

	it('renders AI tab indicators, starred actions, light hover styling, and single-tab disabled menu states', () => {
		const busyTab = createTab({
			id: 'busy-tab',
			name: 'Solo Busy',
			state: 'busy',
			isGeneratingName: true,
			starred: true,
			logs: [createLog('log-1', 'ready')],
		});
		const onTabStar = vi.fn();
		const onCloseOtherTabs = vi.fn();
		const onCloseTabsLeft = vi.fn();
		const onCloseTabsRight = vi.fn();

		render(
			<TabBar
				tabs={[busyTab]}
				activeTabId={busyTab.id}
				theme={createLightTheme()}
				onTabSelect={vi.fn()}
				onTabClose={vi.fn()}
				onNewTab={vi.fn()}
				onTabStar={onTabStar}
				onCloseOtherTabs={onCloseOtherTabs}
				onCloseTabsLeft={onCloseTabsLeft}
				onCloseTabsRight={onCloseTabsRight}
			/>
		);

		expect(screen.getByTitle('Generating tab name...')).toBeInTheDocument();
		openOverlay('Solo Busy');
		fireEvent.click(screen.getByText('Unstar Session'));
		expect(onTabStar).toHaveBeenCalledWith('busy-tab', false);

		openOverlay('Solo Busy');
		expect(screen.getByText('Close Other Tabs').closest('button')).toBeDisabled();
		expect(screen.getByText('Close Tabs to Left').closest('button')).toBeDisabled();
		expect(screen.getByText('Close Tabs to Right').closest('button')).toBeDisabled();
	});

	it('covers file-tab active and boundary menu states with optional move actions absent', () => {
		const fileTab = createFileTab({ id: 'solo-file', name: 'Notes', extension: '.txt' });

		render(
			<TabBar
				tabs={[]}
				activeTabId="missing-ai-tab"
				activeFileTabId={fileTab.id}
				theme={createLightTheme()}
				onTabSelect={vi.fn()}
				onTabClose={vi.fn()}
				onNewTab={vi.fn()}
				onCloseOtherTabs={vi.fn()}
				onCloseTabsLeft={vi.fn()}
				onCloseTabsRight={vi.fn()}
				unifiedTabs={[{ type: 'file', id: fileTab.id, data: fileTab }]}
			/>
		);

		const fileTabNode = screen.getByText('Notes').closest('[data-tab-id]') as HTMLElement;
		expect(fileTabNode.style.backgroundColor).toBe('rgb(255, 255, 255)');

		openOverlay('Notes');
		expect(screen.queryByText('Move to First Position')).not.toBeInTheDocument();
		expect(screen.queryByText('Move to Last Position')).not.toBeInTheDocument();
		expect(screen.getByText('Close Other Tabs').closest('button')).toBeDisabled();
		expect(screen.getByText('Close Tabs to Left').closest('button')).toBeDisabled();
		expect(screen.getByText('Close Tabs to Right').closest('button')).toBeDisabled();
	});

	it('shows empty unread filtering and suppresses gated context actions without enough logs', () => {
		const quietTab = createTab({
			id: 'quiet-tab',
			name: 'Quiet',
			agentSessionId: undefined,
			logs: [],
		});
		const oneLogTab = createTab({
			id: 'one-log-tab',
			name: 'One Log',
			logs: [createLog('log-1', 'partial')],
		});
		const { unmount } = render(
			<TabBar
				tabs={[quietTab]}
				activeTabId="missing-tab"
				showUnreadOnly
				theme={createTheme()}
				onTabSelect={vi.fn()}
				onTabClose={vi.fn()}
				onNewTab={vi.fn()}
			/>
		);

		expect(screen.getByText('No unread or draft tabs')).toBeInTheDocument();
		unmount();

		render(
			<TabBar
				tabs={[oneLogTab]}
				activeTabId={oneLogTab.id}
				theme={createTheme()}
				onTabSelect={vi.fn()}
				onTabClose={vi.fn()}
				onNewTab={vi.fn()}
				onSummarizeAndContinue={vi.fn()}
				onCopyContext={vi.fn()}
				onPublishGist={vi.fn()}
				ghCliAvailable={false}
			/>
		);

		openOverlay('One Log');
		expect(screen.getByText('Context: Copy to Clipboard')).toBeInTheDocument();
		expect(screen.queryByText('Context: Compact')).not.toBeInTheDocument();
		expect(screen.queryByText('Context: Publish as GitHub Gist')).not.toBeInTheDocument();
	});

	it('keeps drag/drop no-op paths safe for same-tab and invalid targets', () => {
		const { props, unmount } = createHarness();
		const planningTab = screen.getByText('Planning').closest('[data-tab-id]')!;
		const readmeTab = screen.getByText('README').closest('[data-tab-id]')!;
		const dataTransfer = {
			effectAllowed: '',
			dropEffect: '',
			setData: vi.fn(),
			getData: vi.fn(() => 'tab-1'),
		};

		fireEvent.dragStart(planningTab, { dataTransfer });
		fireEvent.dragOver(planningTab, { dataTransfer });
		fireEvent.drop(readmeTab, {
			dataTransfer: { getData: vi.fn(() => 'missing-tab') },
		});
		fireEvent.drop(readmeTab, {
			dataTransfer: { getData: vi.fn(() => '') },
		});
		expect(props.onUnifiedTabReorder).not.toHaveBeenCalled();
		unmount();

		const { props: legacyProps } = createHarness({
			unifiedTabs: undefined,
			onUnifiedTabReorder: undefined,
		});
		fireEvent.drop(screen.getByText('SES_4BCD').closest('[data-tab-id]')!, {
			dataTransfer: { getData: vi.fn(() => 'missing-tab') },
		});
		expect(legacyProps.onTabReorder).not.toHaveBeenCalled();
	});

	it('handles pending hover timers after unmount and scrolls active tabs around sticky rails', () => {
		const { unmount } = createHarness();
		fireEvent.mouseEnter(screen.getByText('Planning').closest('[data-tab-id]')!);
		unmount();
		act(() => {
			vi.advanceTimersByTime(450);
		});

		const rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
			callback(0);
			return 0;
		});
		const rectSpy = vi
			.spyOn(HTMLElement.prototype, 'getBoundingClientRect')
			.mockImplementation(function (this: HTMLElement) {
				if (this.classList.contains('overflow-x-auto')) {
					return { left: 0, right: 100, top: 0, bottom: 40, width: 100, height: 40 } as DOMRect;
				}
				if (this.getAttribute('data-tab-id') === 'tab-2') {
					return { left: 10, right: 130, top: 0, bottom: 40, width: 120, height: 40 } as DOMRect;
				}
				return { left: 0, right: 40, top: 0, bottom: 40, width: 40, height: 40 } as DOMRect;
			});
		const offsetWidthSpy = vi
			.spyOn(HTMLElement.prototype, 'offsetWidth', 'get')
			.mockReturnValue(20);
		const { container } = createHarness({ activeTabId: 'tab-2' });
		const scrollContainer = container.querySelector('.overflow-x-auto') as HTMLElement;
		Object.defineProperty(scrollContainer, 'scrollWidth', { configurable: true, value: 1000 });
		Object.defineProperty(scrollContainer, 'clientWidth', { configurable: true, value: 100 });

		act(() => {
			vi.runOnlyPendingTimers();
		});

		expect(scrollContainer.scrollLeft).toBeGreaterThan(0);
		expect(screen.getByTitle(/New tab/).closest('div')).toHaveClass('sticky', 'right-0');
		offsetWidthSpy.mockRestore();
		rectSpy.mockRestore();
		rafSpy.mockRestore();
	});

	it('keeps low-context AI tab actions inert across unified and legacy rendering', () => {
		const noLogTab = createTab({
			id: 'no-log-tab',
			name: 'No Logs',
			logs: undefined,
		});
		const logOnlyTab = createTab({
			id: 'log-only-tab',
			name: 'Log Only',
			agentSessionId: undefined,
			logs: [createLog('log-only', 'context without a session')],
		});
		const longTabs = Array.from({ length: 11 }, (_, index) =>
			createTab({
				id: `long-tab-${index}`,
				name: `Long ${index + 1}`,
				logs: undefined,
			})
		);
		const onRequestRename = vi.fn();
		const onTabClose = vi.fn();
		const onTabReorder = vi.fn();
		const onUnifiedTabReorder = vi.fn();
		const { unmount } = render(
			<TabBar
				tabs={[noLogTab, logOnlyTab, ...longTabs]}
				activeTabId={noLogTab.id}
				theme={createTheme()}
				onTabSelect={vi.fn()}
				onTabClose={onTabClose}
				onNewTab={vi.fn()}
				onRequestRename={onRequestRename}
				onUnifiedTabReorder={onUnifiedTabReorder}
				onMergeWith={vi.fn()}
				onSendToAgent={vi.fn()}
				onSummarizeAndContinue={vi.fn()}
				onCopyContext={vi.fn()}
				onPublishGist={vi.fn()}
				ghCliAvailable
				unifiedTabs={[
					{ type: 'ai', id: noLogTab.id, data: noLogTab },
					{ type: 'ai', id: logOnlyTab.id, data: logOnlyTab },
					...longTabs.map((tab) => ({ type: 'ai' as const, id: tab.id, data: tab })),
				]}
			/>
		);

		const noLogNode = screen.getByText('No Logs').closest('[data-tab-id]')!;
		fireEvent.mouseDown(noLogNode, { button: 0 });
		expect(onTabClose).not.toHaveBeenCalled();
		openOverlay('No Logs');
		expect(screen.queryByText('Context: Compact')).not.toBeInTheDocument();
		expect(screen.queryByText('Context: Copy to Clipboard')).not.toBeInTheDocument();
		expect(screen.queryByText('Context: Publish as GitHub Gist')).not.toBeInTheDocument();
		fireEvent.click(screen.getByText('Rename Tab'));
		expect(onRequestRename).toHaveBeenCalledWith('no-log-tab');

		openOverlay('Log Only');
		expect(screen.getByText('Context: Copy to Clipboard')).toBeInTheDocument();
		expect(screen.getByText('Context: Merge Into')).toBeInTheDocument();
		expect(screen.queryByText('Copy Session ID')).not.toBeInTheDocument();

		expect(screen.queryByText('10')).not.toBeInTheDocument();
		fireEvent.drop(screen.getByText('Long 2').closest('[data-tab-id]')!, {
			dataTransfer: { getData: vi.fn(() => 'long-tab-10') },
		});
		expect(onUnifiedTabReorder).toHaveBeenCalledWith(12, 3);
		unmount();

		const unreadOnlyRender = render(
			<TabBar
				tabs={[noLogTab]}
				activeTabId={noLogTab.id}
				showUnreadOnly
				theme={createTheme()}
				onTabSelect={vi.fn()}
				onTabClose={onTabClose}
				onNewTab={vi.fn()}
			/>
		);
		expect(screen.getByText('No Logs')).toBeInTheDocument();
		unreadOnlyRender.unmount();

		render(
			<TabBar
				tabs={[noLogTab, ...longTabs]}
				activeTabId={noLogTab.id}
				theme={createTheme()}
				onTabSelect={vi.fn()}
				onTabClose={onTabClose}
				onNewTab={vi.fn()}
				onSummarizeAndContinue={vi.fn()}
				onCopyContext={vi.fn()}
				onPublishGist={vi.fn()}
				ghCliAvailable
			/>
		);

		openOverlay('No Logs');
		fireEvent.click(screen.getByText('Rename Tab'));
		expect(onRequestRename).toHaveBeenCalledTimes(1);
		expect(screen.queryByText('10')).not.toBeInTheDocument();
		fireEvent.drop(screen.getByText('Long 2').closest('[data-tab-id]')!, {
			dataTransfer: { getData: vi.fn(() => 'long-tab-10') },
		});
		expect(onTabReorder).not.toHaveBeenCalled();
	});

	it('keeps file-tab non-action and no-overflow paths stable', () => {
		const rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
			callback(0);
			return 0;
		});
		const rectSpy = vi
			.spyOn(HTMLElement.prototype, 'getBoundingClientRect')
			.mockImplementation(function (this: HTMLElement) {
				if (this.classList.contains('overflow-x-auto')) {
					return { left: 0, right: 120, top: 0, bottom: 40, width: 120, height: 40 } as DOMRect;
				}
				if (this.getAttribute('data-tab-id') === 'file-1') {
					return { left: 30, right: 70, top: 0, bottom: 40, width: 40, height: 40 } as DOMRect;
				}
				return { left: 0, right: 40, top: 0, bottom: 40, width: 40, height: 40 } as DOMRect;
			});
		const offsetWidthSpy = vi
			.spyOn(HTMLElement.prototype, 'offsetWidth', 'get')
			.mockReturnValue(20);
		const { container, props, unmount } = createHarness({ activeFileTabId: 'file-1' });
		const readmeTab = screen.getByText('README').closest('[data-tab-id]')!;
		const scrollContainer = container.querySelector('.overflow-x-auto') as HTMLElement;
		Object.defineProperty(scrollContainer, 'scrollWidth', { configurable: true, value: 100 });
		Object.defineProperty(scrollContainer, 'clientWidth', { configurable: true, value: 100 });

		fireEvent.mouseDown(readmeTab, { button: 0 });
		expect(props.onFileTabClose).not.toHaveBeenCalled();
		act(() => {
			vi.runOnlyPendingTimers();
		});
		expect(scrollContainer.scrollLeft).toBe(0);

		fireEvent.mouseEnter(readmeTab);
		unmount();
		act(() => {
			vi.advanceTimersByTime(450);
		});
		offsetWidthSpy.mockRestore();
		rectSpy.mockRestore();
		rafSpy.mockRestore();
	});
});
