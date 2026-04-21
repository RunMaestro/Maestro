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
	BrowserTabView: (props: any) => React.createElement('div', { 'data-testid': 'browser-tab-view' }),
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
		filePreviewLoading: null,
		activeFileTabId: null as string | null | undefined,
		activeFileTab: null as FilePreviewTab | null | undefined,
		activeBrowserTabId: null as string | null | undefined,
		activeBrowserTab: null as any,
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
		inputValue: '',
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
	});

	it('renders TerminalOutput in AI mode', () => {
		render(<MainPanelContent {...makeDefaultProps()} />);
		expect(screen.getByTestId('terminal-output')).toBeInTheDocument();
	});

	it('renders InputArea in AI mode', () => {
		render(<MainPanelContent {...makeDefaultProps()} />);
		expect(screen.getByTestId('input-area')).toBeInTheDocument();
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

	it('renders FilePreview when file tab is active', () => {
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
		expect(screen.getByTestId('file-preview')).toBeInTheDocument();
	});

	it('renders loading spinner when file is loading', () => {
		const props = makeDefaultProps();
		props.filePreviewLoading = { name: 'test.ts', path: '/test/test.ts' };
		render(<MainPanelContent {...props} />);
		expect(screen.getByText(/Loading/)).toBeInTheDocument();
	});

	it('renders BrowserTabView when browser tab is active', () => {
		const props = makeDefaultProps();
		props.activeBrowserTabId = 'browser-1';
		props.activeBrowserTab = {
			id: 'browser-1',
			url: 'https://example.com/',
			title: 'Example',
			createdAt: Date.now(),
			canGoBack: false,
			canGoForward: false,
			isLoading: false,
		};
		render(<MainPanelContent {...props} />);
		expect(screen.getByTestId('browser-tab-view')).toBeInTheDocument();
		expect(screen.queryByTestId('input-area')).not.toBeInTheDocument();
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
