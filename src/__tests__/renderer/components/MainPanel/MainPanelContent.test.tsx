import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen } from '@testing-library/react';
import { MainPanelContent } from '../../../../renderer/components/MainPanel/MainPanelContent';
import type { Session, Theme, AITab, FilePreviewTab } from '../../../../renderer/types';

import { mockTheme } from '../../../helpers/mockTheme';
// Mock stores
vi.mock('../../../../renderer/stores/settingsStore', () => ({
	useSettingsStore: Object.assign(
		vi.fn((selector) =>
			selector({
				fontFamily: 'monospace',
				defaultShell: '/bin/zsh',
				fontSize: 14,
				enterToSendAI: true,
				chatRawTextMode: false,
				userMessageAlignment: 'right',
				shortcuts: {},
				maxOutputLines: 5000,
				browserTabKeepAlive: 'off',
				browserTabKeepAliveLimit: 10,
			})
		),
		{ getState: () => ({ setChatRawTextMode: vi.fn(), setEnterToSendAI: vi.fn() }) }
	),
}));

vi.mock('../../../../renderer/stores/uiStore', () => ({
	useUIStore: Object.assign(
		vi.fn((selector) =>
			selector({ activeFocus: 'main', outputSearchOpen: false, outputSearchQuery: '' })
		),
		{
			getState: () => ({
				setOutputSearchOpen: vi.fn(),
				setOutputSearchQuery: vi.fn(),
				setActiveFocus: vi.fn(),
			}),
		}
	),
}));

// Mock the layer stack context: MainPanelContent reads layerCount to decide
// whether the browser webview should hold keyboard focus. Default to no open
// layers so the browser tab is treated as the focused view; tests flip
// layerState.count to simulate a modal/overlay opening over the tab.
const layerState = vi.hoisted(() => ({ count: 0 }));
vi.mock('../../../../renderer/contexts/LayerStackContext', () => ({
	useLayerStack: () => ({ layerCount: layerState.count }),
}));

// Mock child components
vi.mock('../../../../renderer/components/TerminalOutput', () => ({
	TerminalOutput: React.forwardRef((props: any, ref: any) =>
		React.createElement('div', { 'data-testid': 'terminal-output', ref })
	),
}));

vi.mock('../../../../renderer/components/InputArea', () => ({
	InputArea: (props: any) => React.createElement('div', { 'data-testid': 'input-area' }),
}));

vi.mock('../../../../renderer/components/FilePreview', () => ({
	FilePreview: React.forwardRef((props: any, ref: any) =>
		React.createElement('div', { 'data-testid': 'file-preview', ref })
	),
	FilePreviewHandle: {},
}));

vi.mock('../../../../renderer/components/InlineWizard', () => ({
	WizardConversationView: (props: any) =>
		React.createElement('div', { 'data-testid': 'wizard-conversation' }),
	DocumentGenerationView: (props: any) =>
		React.createElement('div', { 'data-testid': 'document-generation' }),
}));

vi.mock('../../../../renderer/components/MainPanel/BrowserTabView', () => ({
	BrowserTabView: (props: any) =>
		React.createElement('div', {
			'data-testid': 'browser-tab-view',
			'data-active': String(props.isActive),
		}),
}));

vi.mock('../../../../renderer/components/TerminalView', () => {
	const TerminalView = React.forwardRef((props: any, ref: any) =>
		React.createElement('div', {
			'data-testid': `terminal-view-${props.session.id}`,
			ref,
		})
	);
	TerminalView.displayName = 'TerminalView';
	return {
		TerminalView,
		createTabStateChangeHandler: vi.fn(() => vi.fn()),
		createTabPidChangeHandler: vi.fn(() => vi.fn()),
	};
});

function makeSession(overrides: Partial<Session> = {}): Session {
	return {
		id: 'session-1',
		name: 'Test Agent',
		cwd: '/test',
		fullPath: '/test',
		toolType: 'claude-code',
		inputMode: 'ai',
		aiTabs: [{ id: 'tab-1' }],
		activeTabId: 'tab-1',
		terminalTabs: [],
		isGitRepo: false,
		bookmarked: false,
		...overrides,
	} as Session;
}

function makeDefaultProps() {
	return {
		activeSession: makeSession(),
		activeTab: { id: 'tab-1' } as AITab,
		theme: mockTheme,
		activeFileTabId: null as string | null | undefined,
		activeFileTab: null as FilePreviewTab | null | undefined,
		activeBrowserTabId: null as string | null | undefined,
		memoizedFilePreviewFile: null,
		filePreviewCwd: '',
		filePreviewSshRemoteId: undefined,
		filePreviewContainerRef: { current: null } as React.RefObject<HTMLDivElement>,
		filePreviewRef: { current: null } as any,
		handleFilePreviewClose: vi.fn(),
		handleFilePreviewEditModeChange: vi.fn(),
		handleFilePreviewSave: vi.fn(),
		handleFilePreviewEditContentChange: vi.fn(),
		handleFilePreviewScrollPositionChange: vi.fn(),
		handleFilePreviewSearchQueryChange: vi.fn(),
		handleFilePreviewReload: vi.fn(),
		handleBrowserTabUpdate: vi.fn(),
		terminalViewRefs: { current: new Map() } as any,
		mountedTerminalSessionIds: [] as string[],
		mountedTerminalSessionsRef: { current: new Map() } as any,
		terminalSearchOpen: false,
		setTerminalSearchOpen: vi.fn(),
		isMobileLandscape: false,
		activeTabContextUsage: 25,
		contextWarningsEnabled: true,
		contextWarningYellowThreshold: 60,
		contextWarningRedThreshold: 80,
		handleInputFocus: vi.fn(),
		handleSessionClick: vi.fn(),
		isCurrentSessionAutoMode: false,
		currentSessionBatchState: undefined,
		hasCapability: vi.fn(() => true) as any,
		setInputValue: vi.fn(),
		stagedImages: [] as string[],
		setStagedImages: vi.fn(),
		setLightboxImage: vi.fn(),
		commandHistoryOpen: false,
		setCommandHistoryOpen: vi.fn(),
		commandHistoryFilter: '',
		setCommandHistoryFilter: vi.fn(),
		commandHistorySelectedIndex: -1,
		setCommandHistorySelectedIndex: vi.fn(),
		slashCommandOpen: false,
		setSlashCommandOpen: vi.fn(),
		slashCommands: [],
		selectedSlashCommandIndex: -1,
		setSelectedSlashCommandIndex: vi.fn(),
		inputRef: { current: null } as any,
		logsEndRef: { current: null } as any,
		terminalOutputRef: { current: null } as any,
		toggleInputMode: vi.fn(),
		processInput: vi.fn(),
		handleInterrupt: vi.fn(),
		handleInputKeyDown: vi.fn(),
		handlePaste: vi.fn(),
		handleDrop: vi.fn(),
		thinkingItems: [],
	};
}

describe('MainPanelContent', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		layerState.count = 0;
	});

	it('renders TerminalOutput in AI mode', () => {
		render(<MainPanelContent {...makeDefaultProps()} />);
		expect(screen.getByTestId('terminal-output')).toBeInTheDocument();
	});

	it('renders InputArea in AI mode', () => {
		render(<MainPanelContent {...makeDefaultProps()} />);
		expect(screen.getByTestId('input-area')).toBeInTheDocument();
	});

	it('does not mount runtime session details over the ordinary transcript', () => {
		const props = makeDefaultProps();
		props.activeSession = makeSession({
			runtimeFeatures: {
				controls: [],
				tree: [{ id: 'turn-1', label: 'OMP turn' }],
				todos: null,
				subagents: null,
				stats: null,
			},
		});
		render(<MainPanelContent {...props} />);
		expect(screen.queryByRole('dialog', { name: 'Session details' })).not.toBeInTheDocument();
	});

	it('hides InputArea in terminal mode', () => {
		const props = makeDefaultProps();
		props.activeSession = makeSession({ inputMode: 'terminal' });
		render(<MainPanelContent {...props} />);
		expect(screen.queryByTestId('input-area')).not.toBeInTheDocument();
	});

	it('hides InputArea in mobile landscape', () => {
		const props = makeDefaultProps();
		props.isMobileLandscape = true;
		render(<MainPanelContent {...props} />);
		expect(screen.queryByTestId('input-area')).not.toBeInTheDocument();
	});

	it('renders FilePreview when file tab is active', async () => {
		const props = makeDefaultProps();
		props.activeFileTabId = 'file-1';
		props.activeFileTab = {
			id: 'file-1',
			name: 'test',
			extension: '.ts',
			content: 'hello',
			path: '/test/test.ts',
			editMode: false,
		} as FilePreviewTab;
		props.memoizedFilePreviewFile = { name: 'test.ts', content: 'hello', path: '/test/test.ts' };
		render(<MainPanelContent {...props} />);
		// FilePreview is lazy-loaded behind a Suspense boundary, so it resolves
		// asynchronously - await it rather than asserting synchronously.
		expect(await screen.findByTestId('file-preview')).toBeInTheDocument();
	});

	it('renders loading spinner when active file tab is in loading state', () => {
		const props = makeDefaultProps();
		props.activeFileTabId = 'file-1';
		props.activeFileTab = {
			id: 'file-1',
			name: 'test',
			extension: '.ts',
			content: '',
			path: '/test/test.ts',
			editMode: false,
			isLoading: true,
			loadRequestId: 'req-1',
		} as FilePreviewTab;
		render(<MainPanelContent {...props} />);
		expect(screen.getByText(/Loading/)).toBeInTheDocument();
	});

	it('renders BrowserTabView when browser tab is active', () => {
		const browserTab = {
			id: 'browser-1',
			url: 'https://example.com/',
			title: 'Example',
			createdAt: Date.now(),
			canGoBack: false,
			canGoForward: false,
			isLoading: false,
		};
		// Browser tabs live on the session; the keep-alive mount hook reads them from there.
		const session = makeSession({
			browserTabs: [browserTab],
			activeBrowserTabId: 'browser-1',
		});
		const props = makeDefaultProps();
		props.activeSession = session;
		props.activeBrowserTabId = 'browser-1';
		render(<MainPanelContent {...props} />);
		expect(screen.getByTestId('browser-tab-view')).toBeInTheDocument();
		expect(screen.queryByTestId('input-area')).not.toBeInTheDocument();
	});

	it('keeps the active browser tab focus-active when no layer is open', () => {
		const browserTab = {
			id: 'browser-1',
			url: 'https://example.com/',
			title: 'Example',
			createdAt: Date.now(),
			canGoBack: false,
			canGoForward: false,
			isLoading: false,
		};
		const session = makeSession({
			browserTabs: [browserTab],
			activeBrowserTabId: 'browser-1',
		});
		const props = makeDefaultProps();
		props.activeSession = session;
		props.activeBrowserTabId = 'browser-1';
		render(<MainPanelContent {...props} />);
		// No modal/overlay open -> the webview holds keyboard focus.
		expect(screen.getByTestId('browser-tab-view')).toHaveAttribute('data-active', 'true');
	});

	it('releases browser tab keyboard focus when a layer (e.g. Tab Switcher) is open', () => {
		// A modal/overlay layered over the browser tab must blur the guest webview
		// so the modal's own keyboard navigation works (the Tab Switcher bug).
		layerState.count = 1;
		const browserTab = {
			id: 'browser-1',
			url: 'https://example.com/',
			title: 'Example',
			createdAt: Date.now(),
			canGoBack: false,
			canGoForward: false,
			isLoading: false,
		};
		const session = makeSession({
			browserTabs: [browserTab],
			activeBrowserTabId: 'browser-1',
		});
		const props = makeDefaultProps();
		props.activeSession = session;
		props.activeBrowserTabId = 'browser-1';
		render(<MainPanelContent {...props} />);
		expect(screen.getByTestId('browser-tab-view')).toHaveAttribute('data-active', 'false');
	});

	it('renders TerminalView for mounted terminal sessions', () => {
		const session = makeSession({
			inputMode: 'terminal',
			terminalTabs: [{ id: 'term-1', name: 'bash', state: 'idle' }] as any,
		});
		const props = makeDefaultProps();
		props.activeSession = session;
		props.mountedTerminalSessionIds = ['session-1'];
		props.mountedTerminalSessionsRef = {
			current: new Map([['session-1', session]]),
		} as any;
		render(<MainPanelContent {...props} />);
		expect(screen.getByTestId('terminal-view-session-1')).toBeInTheDocument();
	});

	it('renders data-tour attribute on main terminal area', () => {
		const { container } = render(<MainPanelContent {...makeDefaultProps()} />);
		expect(container.querySelector('[data-tour="main-terminal"]')).toBeInTheDocument();
	});

	it('renders data-tour attribute on input area', () => {
		const { container } = render(<MainPanelContent {...makeDefaultProps()} />);
		expect(container.querySelector('[data-tour="input-area"]')).toBeInTheDocument();
	});
});
