import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import {
	getTerminalScrollSnapshot,
	TerminalOutput,
} from '../../renderer/components/TerminalOutput';
import { LayerStackProvider } from '../../renderer/contexts/LayerStackContext';
import { useCenterFlashStore } from '../../renderer/stores/centerFlashStore';
import { useSettingsStore } from '../../renderer/stores/settingsStore';
import { safeClipboardWrite } from '../../renderer/utils/clipboard';
import type { AgentError, AITab, LogEntry, Session, Theme } from '../../renderer/types';

const clipboardMocks = vi.hoisted(() => ({
	safeClipboardWrite: vi.fn(),
	safeClipboardWriteBlob: vi.fn(),
}));

vi.mock('../../renderer/utils/clipboard', () => clipboardMocks);

vi.mock('react-syntax-highlighter', () => ({
	Prism: ({ children }: { children: string }) => (
		<pre data-testid="syntax-highlighter">{children}</pre>
	),
}));

vi.mock('react-syntax-highlighter/dist/esm/styles/prism', () => ({
	vscDarkPlus: {},
	vs: {},
}));

vi.mock('../../renderer/components/MermaidRenderer', () => ({
	MermaidRenderer: ({ chart }: { chart: string }) => (
		<div data-testid="mermaid-renderer">{chart}</div>
	),
}));

const originalScrollBy = Element.prototype.scrollBy;
const originalScrollTo = Element.prototype.scrollTo;
let originalWriteFile: typeof window.maestro.fs.writeFile | undefined;

function createTheme(): Theme {
	return {
		id: 'dracula',
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
			accentText: '#bfdbfe',
			accentForeground: '#ffffff',
			border: '#374151',
			success: '#16a34a',
			warning: '#f59e0b',
			error: '#dc2626',
		},
	};
}

function createLog(overrides: Partial<LogEntry> = {}): LogEntry {
	return {
		id: overrides.id ?? `log-${Math.random().toString(36).slice(2)}`,
		source: overrides.source ?? 'ai',
		text: overrides.text ?? 'Default log text',
		timestamp: overrides.timestamp ?? 1_700_000_000_000,
		...overrides,
	};
}

function createTab(overrides: Partial<AITab> = {}): AITab {
	return {
		id: 'tab-1',
		agentSessionId: 'agent-session-1',
		name: 'Planning',
		starred: false,
		logs: [],
		inputValue: '',
		stagedImages: [],
		createdAt: 1_700_000_000_000,
		state: 'idle',
		saveToHistory: true,
		...overrides,
	};
}

function createSession(overrides: Partial<Session> = {}): Session {
	const tab = createTab(
		overrides.aiTabs?.[0] ??
			(overrides.inputMode === 'terminal' && overrides.shellLogs
				? { logs: overrides.shellLogs }
				: undefined)
	);

	return {
		id: 'session-1',
		name: 'Integration Session',
		toolType: 'claude-code',
		state: 'idle',
		cwd: '/workspace/project',
		fullPath: '/workspace/project',
		projectRoot: '/workspace/project',
		createdAt: 1_700_000_000_000,
		aiLogs: [],
		shellLogs: [],
		workLog: [],
		contextUsage: 0,
		inputMode: 'ai',
		aiPid: 0,
		terminalPid: 0,
		port: 0,
		isLive: false,
		changedFiles: [],
		isGitRepo: true,
		fileTree: [],
		fileExplorerExpanded: [],
		fileExplorerScrollPos: 0,
		executionQueue: [],
		activeTimeMs: 0,
		aiTabs: [tab],
		activeTabId: tab.id,
		closedTabHistory: [],
		filePreviewTabs: [],
		activeFileTabId: null,
		unifiedTabOrder: [{ type: 'ai', id: tab.id }],
		unifiedClosedTabHistory: [],
		...overrides,
	} as Session;
}

function renderTerminal(overrides: Partial<React.ComponentProps<typeof TerminalOutput>> = {}) {
	const props = {
		session: createSession(),
		theme: createTheme(),
		fontFamily: 'Menlo, monospace',
		activeFocus: 'main' as const,
		outputSearchOpen: false,
		outputSearchQuery: '',
		setOutputSearchOpen: vi.fn(),
		setOutputSearchQuery: vi.fn(),
		setActiveFocus: vi.fn(),
		setLightboxImage: vi.fn(),
		inputRef: React.createRef<HTMLTextAreaElement>(),
		logsEndRef: React.createRef<HTMLDivElement>(),
		maxOutputLines: 50,
		markdownEditMode: false,
		setMarkdownEditMode: vi.fn(),
		...overrides,
	};

	const result = render(
		<LayerStackProvider>
			<TerminalOutput {...props} />
		</LayerStackProvider>
	);

	return { ...result, props };
}

function setScrollGeometry(
	element: HTMLElement,
	geometry: { scrollTop: number; scrollHeight: number; clientHeight: number }
) {
	Object.defineProperties(element, {
		scrollTop: { configurable: true, writable: true, value: geometry.scrollTop },
		scrollHeight: { configurable: true, value: geometry.scrollHeight },
		clientHeight: { configurable: true, value: geometry.clientHeight },
	});
}

describe('TerminalOutput integration', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		useCenterFlashStore.getState().setActive(null);
		originalWriteFile = window.maestro.fs.writeFile;
		vi.mocked(safeClipboardWrite).mockResolvedValue(true);
		Element.prototype.scrollBy = vi.fn();
		Element.prototype.scrollTo = vi.fn();
		useSettingsStore.setState({
			bionifyReadingMode: false,
			bionifyIntensity: 1,
			bionifyAlgorithm: '- 0 1 1 2 0.4',
		});
		window.maestro.fs.writeFile = vi.fn().mockResolvedValue({ success: true });
	});

	afterEach(() => {
		cleanup();
		if (originalScrollBy) {
			Element.prototype.scrollBy = originalScrollBy;
		} else {
			delete (Element.prototype as Partial<Element>).scrollBy;
		}
		if (originalScrollTo) {
			Element.prototype.scrollTo = originalScrollTo;
		} else {
			delete (Element.prototype as Partial<Element>).scrollTo;
		}
		if (originalWriteFile) {
			window.maestro.fs.writeFile = originalWriteFile;
		} else {
			delete (window.maestro.fs as Partial<typeof window.maestro.fs>).writeFile;
		}
		vi.restoreAllMocks();
	});

	it('computes scroll snapshots', () => {
		expect(getTerminalScrollSnapshot(null)).toBeNull();
		expect(
			getTerminalScrollSnapshot({ scrollTop: 455, scrollHeight: 1000, clientHeight: 500 })
		).toEqual({ scrollTop: 455, atBottom: true });
		expect(
			getTerminalScrollSnapshot({ scrollTop: 20, scrollHeight: 1000, clientHeight: 500 })
		).toEqual({ scrollTop: 20, atBottom: false });
	});

	it('routes AI log actions through callbacks, clipboard, queue rendering, and save modal state', async () => {
		const image = 'data:image/png;base64,aW1hZ2U=';
		const session = createSession({
			aiTabs: [
				createTab({
					logs: [
						createLog({
							id: 'user-1',
							source: 'user',
							text: 'Review this file',
							images: [image],
							delivered: true,
						}),
						createLog({
							id: 'ai-1',
							source: 'ai',
							text: 'Done with **result**',
						}),
					],
				}),
			],
			executionQueue: [
				{
					id: 'queued-1',
					tabId: 'tab-1',
					type: 'message',
					text: 'Queued follow-up',
					timestamp: 1_700_000_000_500,
				},
			],
		});
		const onDeleteLog = vi.fn(() => 0);
		const onReplayMessage = vi.fn();
		const setLightboxImage = vi.fn();
		const setMarkdownEditMode = vi.fn();

		renderTerminal({
			session,
			outputSearchOpen: true,
			onDeleteLog,
			onReplayMessage,
			setLightboxImage,
			setMarkdownEditMode,
			onFileSaved: vi.fn(),
		});

		expect(
			screen.getByPlaceholderText('Search output... (Enter: next, Shift+Enter: prev)')
		).toBeInTheDocument();
		expect(screen.getByText('QUEUED (1)')).toBeInTheDocument();
		expect(screen.getByText('Queued follow-up')).toBeInTheDocument();

		fireEvent.click(screen.getByAltText('Terminal output image 1'));
		expect(setLightboxImage).toHaveBeenCalledWith(image, [image], 'history');

		fireEvent.click(screen.getByTitle('Replay message'));
		expect(onReplayMessage).toHaveBeenCalledWith('Review this file', [image]);

		fireEvent.click(screen.getAllByTitle('Copy to clipboard')[0]);
		await waitFor(() => expect(safeClipboardWrite).toHaveBeenCalledWith('Review this file'));
		await waitFor(() => {
			expect(useCenterFlashStore.getState().active?.message).toBe('Copied to Clipboard');
		});

		fireEvent.click(screen.getAllByTitle(/Show plain text/)[0]);
		expect(setMarkdownEditMode).toHaveBeenCalledWith(true);

		fireEvent.click(screen.getByTitle('Delete message and response'));
		fireEvent.click(screen.getByRole('button', { name: 'No' }));
		expect(onDeleteLog).not.toHaveBeenCalled();
		fireEvent.click(screen.getByTitle('Delete message and response'));
		fireEvent.click(screen.getByRole('button', { name: 'Yes' }));
		expect(onDeleteLog).toHaveBeenCalledWith('user-1');
		await new Promise((resolve) => setTimeout(resolve, 60));

		fireEvent.click(screen.getByTitle('Save to file'));
		expect(screen.getByText('Save Markdown')).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
		expect(screen.queryByText('Save Markdown')).not.toBeInTheDocument();
	});

	it('does not show copied notification when clipboard write fails', async () => {
		vi.mocked(safeClipboardWrite).mockResolvedValue(false);
		renderTerminal({
			session: createSession({
				aiTabs: [
					createTab({
						logs: [createLog({ id: 'copy-fail-user', source: 'user', text: 'copy failure' })],
					}),
				],
			}),
		});

		fireEvent.click(screen.getByTitle('Copy to clipboard'));
		await waitFor(() => expect(safeClipboardWrite).toHaveBeenCalledWith('copy failure'));
		expect(screen.queryByText('Copied to Clipboard')).not.toBeInTheDocument();
	});

	it('renders structured error, thinking, and tool logs with callback wiring', () => {
		const agentError: AgentError = {
			type: 'agent_crashed',
			message: 'Agent crashed',
			recoverable: true,
			agentId: 'claude-code',
			sessionId: 'session-1',
			timestamp: 1_700_000_000_000,
			parsedJson: { code: 'crashed' },
		};
		const onShowErrorDetails = vi.fn();
		const session = createSession({
			aiTabs: [
				createTab({
					logs: [
						createLog({ id: 'user-1', source: 'user', text: 'Run diagnostics' }),
						createLog({
							id: 'error-1',
							source: 'error',
							text: 'Agent crashed before responding',
							agentError,
						}),
						createLog({ id: 'thinking-1', source: 'thinking', text: 'Inspecting logs' }),
						createLog({
							id: 'tool-running',
							source: 'tool',
							text: 'Glob',
							metadata: {
								toolState: {
									status: 'running',
									input: { pattern: 'src/**/*.tsx' },
								},
							},
						}),
						createLog({
							id: 'tool-1',
							source: 'tool',
							text: 'Bash',
							metadata: {
								toolState: {
									status: 'completed',
									input: { command: ['npm', 'run', 'test:integration'] },
								},
							},
						}),
						createLog({
							id: 'tool-string-command',
							source: 'tool',
							text: 'Bash',
							metadata: {
								toolState: {
									status: 'completed',
									input: { command: 'npm test' },
								},
							},
						}),
						createLog({
							id: 'tool-todos',
							source: 'tool',
							text: 'TodoWrite',
							metadata: {
								toolState: {
									status: 'completed',
									input: {
										todos: [
											{ content: 'Done task', status: 'completed' },
											{
												content: 'Current task',
												activeForm: 'Reviewing coverage',
												status: 'in_progress',
											},
										],
									},
								},
							},
						}),
						createLog({
							id: 'tool-empty-todos',
							source: 'tool',
							text: 'TodoWrite',
							metadata: {
								toolState: {
									status: 'completed',
									input: { todos: [{ status: 'pending' }] },
								},
							},
						}),
						createLog({
							id: 'tool-content',
							source: 'tool',
							text: 'Write',
							metadata: {
								toolState: {
									status: 'completed',
									input: {
										command: [1],
										content: 'x'.repeat(120),
									},
								},
							},
						}),
						createLog({
							id: 'tool-null-content',
							source: 'tool',
							text: 'Write',
							metadata: {
								toolState: {
									status: 'completed',
									input: { content: 42 },
								},
							},
						}),
					],
				}),
			],
		});

		renderTerminal({ session, onShowErrorDetails });

		expect(screen.getByText('Error')).toBeInTheDocument();
		expect(screen.getByText('Agent crashed before responding')).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: /View Details/i }));
		expect(onShowErrorDetails).toHaveBeenCalledWith(agentError);
		expect(screen.getByText('thinking')).toBeInTheDocument();
		expect(screen.getByText('Inspecting logs')).toBeInTheDocument();
		expect(screen.getByText('Glob')).toBeInTheDocument();
		expect(screen.getByText('src/**/*.tsx')).toBeInTheDocument();
		expect(screen.getAllByText('Bash')).toHaveLength(2);
		expect(screen.getByText('npm run test:integration')).toBeInTheDocument();
		expect(screen.getByText('npm test')).toBeInTheDocument();
		expect(screen.getAllByText('TodoWrite')).toHaveLength(2);
		expect(screen.getByText('Reviewing coverage (1/2)')).toBeInTheDocument();
		expect(screen.getByText('1 tasks')).toBeInTheDocument();
		expect(screen.getByText((content) => content.includes('x'.repeat(120)))).toBeInTheDocument();
	});

	it('renders tool detail fallback fields and raw thinking text in markdown edit mode', () => {
		const session = createSession({
			aiTabs: [
				createTab({
					logs: [
						createLog({ id: 'thinking-raw', source: 'thinking', text: '**raw thinking**' }),
						createLog({
							id: 'tool-file-path',
							source: 'tool',
							text: 'Read',
							metadata: { toolState: { status: 'completed', input: { file_path: 'src/a.ts' } } },
						}),
						createLog({
							id: 'tool-filePath',
							source: 'tool',
							text: 'Read',
							metadata: { toolState: { status: 'completed', input: { filePath: 'src/b.ts' } } },
						}),
						createLog({
							id: 'tool-query',
							source: 'tool',
							text: 'Search',
							metadata: { toolState: { status: 'completed', input: { query: 'needle query' } } },
						}),
						createLog({
							id: 'tool-description',
							source: 'tool',
							text: 'Task',
							metadata: {
								toolState: { status: 'completed', input: { description: 'task description' } },
							},
						}),
						createLog({
							id: 'tool-prompt',
							source: 'tool',
							text: 'Task',
							metadata: { toolState: { status: 'completed', input: { prompt: 'task prompt' } } },
						}),
						createLog({
							id: 'tool-task-id',
							source: 'tool',
							text: 'TaskOutput',
							metadata: { toolState: { status: 'completed', input: { task_id: 'task-42' } } },
						}),
						createLog({
							id: 'tool-path',
							source: 'tool',
							text: 'Open',
							metadata: { toolState: { status: 'completed', input: { path: '/tmp/file.txt' } } },
						}),
						createLog({
							id: 'tool-cmd',
							source: 'tool',
							text: 'Shell',
							metadata: { toolState: { status: 'completed', input: { cmd: 'pnpm test' } } },
						}),
						createLog({
							id: 'tool-code',
							source: 'tool',
							text: 'Eval',
							metadata: { toolState: { status: 'completed', input: { code: 'return 1' } } },
						}),
						createLog({
							id: 'tool-short-content',
							source: 'tool',
							text: 'Write',
							metadata: { toolState: { status: 'completed', input: { content: 'short content' } } },
						}),
						createLog({ id: 'tool-no-input', source: 'tool', text: 'NoInput' }),
					],
				}),
			],
		});

		renderTerminal({ session, markdownEditMode: true });

		expect(screen.getByText('**raw thinking**')).toBeInTheDocument();
		for (const detail of [
			'src/a.ts',
			'src/b.ts',
			'needle query',
			'task description',
			'task prompt',
			'task-42',
			'/tmp/file.txt',
			'pnpm test',
			'return 1',
			'short content',
		]) {
			expect(screen.getByText(detail)).toBeInTheDocument();
		}
		expect(screen.getByText('NoInput')).toBeInTheDocument();
	});

	it('handles terminal mode search UI, local filters, collapse controls, keyboard scrolling, and scroll callbacks', async () => {
		const focusInput = vi.fn();
		const inputRef = {
			current: { focus: focusInput } as unknown as HTMLTextAreaElement,
		};
		const setOutputSearchOpen = vi.fn();
		const setOutputSearchQuery = vi.fn();
		const setActiveFocus = vi.fn();
		const onAtBottomChange = vi.fn();
		const onScrollPositionChange = vi.fn();
		const session = createSession({
			inputMode: 'terminal',
			shellLogs: [
				createLog({ id: 'orphan-out', source: 'stdout', text: 'orphan needle output' }),
				createLog({
					id: 'today-user',
					source: 'user',
					text: 'needle command',
					timestamp: Date.now(),
				}),
				createLog({ id: 'cmd-1', source: 'user', text: 'npm test' }),
				createLog({
					id: 'out-1',
					source: 'stdout',
					text: 'npm test\r\nline one\nneedle beta\nline three\nline four',
				}),
				createLog({ id: 'cmd-2', source: 'user', text: 'echo needle' }),
				createLog({ id: 'out-2', source: 'stdout', text: 'echo needle\nneedle result' }),
				createLog({ id: 'cmd-3', source: 'user', text: 'printf carriage' }),
				createLog({ id: 'out-3', source: 'stdout', text: 'printf carriage\rcarriage result' }),
				createLog({ id: 'empty-stderr', source: 'stderr', text: '' }),
				createLog({ id: 'err-1', source: 'stderr', text: 'stderr needle failure' }),
			],
		});

		const { container } = renderTerminal({
			session,
			outputSearchOpen: true,
			outputSearchQuery: 'needle',
			maxOutputLines: 3,
			inputRef,
			setOutputSearchOpen,
			setOutputSearchQuery,
			setActiveFocus,
			onAtBottomChange,
			onScrollPositionChange,
		});

		const outputSearchInput = screen.getByPlaceholderText(
			'Search output... (Enter: next, Shift+Enter: prev)'
		);
		expect(outputSearchInput).toBeInTheDocument();
		fireEvent.change(outputSearchInput, { target: { value: 'needle result' } });
		expect(setOutputSearchQuery).toHaveBeenCalledWith('needle result');
		fireEvent.keyDown(window, { key: 'Escape' });
		expect(setOutputSearchOpen).toHaveBeenCalledWith(false);
		expect(setOutputSearchQuery).toHaveBeenCalledWith('');
		setOutputSearchOpen.mockClear();
		const showAllButton = screen.getByRole('button', { name: /Show all \d+ lines/i });
		expect(showAllButton).toBeInTheDocument();
		const scrollContainer = container.querySelector('.overflow-y-auto') as HTMLElement;
		const expandableLogItem = showAllButton.closest('[data-log-index]') as HTMLElement;
		vi.spyOn(expandableLogItem, 'getBoundingClientRect').mockReturnValue({
			bottom: 500,
		} as DOMRect);
		vi.spyOn(scrollContainer, 'getBoundingClientRect').mockReturnValue({
			bottom: 300,
		} as DOMRect);
		fireEvent.click(showAllButton);
		await waitFor(() =>
			expect(Element.prototype.scrollBy).toHaveBeenCalledWith({
				top: 220,
				behavior: 'smooth',
			})
		);
		const showLessButton = screen.getByText('Show less');
		expect(showLessButton).toBeInTheDocument();
		fireEvent.click(showLessButton);
		expect(screen.getByRole('button', { name: /Show all \d+ lines/i })).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: /Show all \d+ lines/i }));
		const expandedOutput = container.querySelector<HTMLElement>('div[style*="max-height: 600px"]');
		expect(expandedOutput).toBeTruthy();
		setScrollGeometry(expandedOutput as HTMLElement, {
			scrollTop: 50,
			scrollHeight: 500,
			clientHeight: 100,
		});
		const wheelEvent = new WheelEvent('wheel', { deltaY: -1, bubbles: true });
		const stopPropagation = vi.spyOn(wheelEvent, 'stopPropagation');
		fireEvent(expandedOutput as HTMLElement, wheelEvent);
		expect(stopPropagation).toHaveBeenCalled();

		const region = screen.getByRole('region', { name: 'Terminal output' });
		fireEvent.keyDown(region, { key: 'f', ctrlKey: true });
		expect(setOutputSearchOpen).not.toHaveBeenCalled();

		fireEvent.keyDown(region, { key: 'ArrowDown' });
		expect(Element.prototype.scrollBy).toHaveBeenCalledWith({ top: 100 });
		fireEvent.keyDown(region, { key: 'ArrowUp' });
		expect(Element.prototype.scrollBy).toHaveBeenCalledWith({ top: -100 });
		fireEvent.keyDown(region, { key: 'ArrowUp', altKey: true });
		expect(Element.prototype.scrollBy).toHaveBeenCalledWith({ top: -400 });
		fireEvent.keyDown(region, { key: 'ArrowDown', altKey: true });
		expect(Element.prototype.scrollBy).toHaveBeenCalledWith({ top: 400 });
		fireEvent.keyDown(region, { key: 'ArrowUp', ctrlKey: true });
		expect(Element.prototype.scrollTo).toHaveBeenCalledWith({ top: 0 });
		fireEvent.keyDown(region, { key: 'ArrowDown', ctrlKey: true });
		expect(Element.prototype.scrollTo).toHaveBeenCalled();

		setScrollGeometry(scrollContainer, { scrollTop: 0, scrollHeight: 1000, clientHeight: 100 });
		fireEvent.scroll(scrollContainer);
		expect(onAtBottomChange).toHaveBeenCalledWith(false);
		setScrollGeometry(scrollContainer, { scrollTop: 900, scrollHeight: 1000, clientHeight: 100 });
		fireEvent.scroll(scrollContainer);
		await waitFor(() => expect(onAtBottomChange).toHaveBeenCalledWith(true));
		await waitFor(() => expect(onScrollPositionChange).toHaveBeenCalledWith(900));

		cleanup();
		setOutputSearchOpen.mockClear();
		setActiveFocus.mockClear();
		focusInput.mockClear();

		const closedSearch = renderTerminal({
			session,
			inputRef,
			setOutputSearchOpen,
			setActiveFocus,
		});
		const closedRegion = screen.getByRole('region', { name: 'Terminal output' });
		fireEvent.keyDown(closedRegion, { key: 'f', metaKey: true });
		expect(setOutputSearchOpen).toHaveBeenCalledWith(true);
		fireEvent.keyDown(closedRegion, { key: 'Escape' });
		expect(focusInput).toHaveBeenCalled();
		expect(setActiveFocus).toHaveBeenCalledWith('main');
		closedSearch.unmount();
	});

	it('covers search escape registration and light search highlight styles', async () => {
		const setOutputSearchOpen = vi.fn();
		const setOutputSearchQuery = vi.fn();
		const lightTheme: Theme = {
			...createTheme(),
			mode: 'light',
		};
		const session = createSession({
			inputMode: 'terminal',
			shellLogs: [
				createLog({ id: 'cmd-1', source: 'user', text: 'run light search' }),
				createLog({ id: 'out-1', source: 'stdout', text: 'run light search\nlight match' }),
			],
		});

		renderTerminal({
			session,
			theme: lightTheme,
			outputSearchOpen: true,
			outputSearchQuery: 'light',
			setOutputSearchOpen,
			setOutputSearchQuery,
		});

		await waitFor(() =>
			expect(
				screen.getByPlaceholderText('Search output... (Enter: next, Shift+Enter: prev)')
			).toBeInTheDocument()
		);
		expect(screen.getByText(/light match/)).toBeInTheDocument();
		expect(document.querySelector('style')?.textContent).toContain('color: #fff');
		await new Promise((resolve) => setTimeout(resolve, 0));
		fireEvent.keyDown(window, { key: 'Escape' });
		await waitFor(() => expect(setOutputSearchOpen).toHaveBeenCalledWith(false));
		expect(setOutputSearchQuery).toHaveBeenCalledWith('');
	});

	it('tracks AI auto-scroll, unread read-state, and pending scroll-save cleanup', async () => {
		const onAtBottomChange = vi.fn();
		const onScrollPositionChange = vi.fn();
		const requestAnimationFrameSpy = vi
			.spyOn(window, 'requestAnimationFrame')
			.mockImplementation((callback) => {
				callback(0);
				return 1;
			});
		const tabOne = createTab({
			id: 'tab-1',
			logs: [createLog({ id: 'ai-1', source: 'ai', text: 'first response' })],
		});
		const tabTwo = createTab({
			id: 'tab-2',
			logs: [createLog({ id: 'ai-2', source: 'ai', text: 'second tab response' })],
		});
		const makeSession = (activeTabId: string, tabOneLogs: LogEntry[] = tabOne.logs): Session =>
			createSession({
				inputMode: 'ai',
				activeTabId,
				aiTabs: [{ ...tabOne, logs: tabOneLogs }, tabTwo],
			});

		const rendered = renderTerminal({
			session: makeSession('tab-1'),
			autoScrollAiMode: true,
			onAtBottomChange,
			onScrollPositionChange,
		});
		const scrollContainer = rendered.container.querySelector('.overflow-y-auto') as HTMLElement;

		setScrollGeometry(scrollContainer, { scrollTop: 0, scrollHeight: 1000, clientHeight: 100 });
		fireEvent.scroll(scrollContainer);
		await waitFor(() => expect(onAtBottomChange).toHaveBeenCalledWith(false));
		await new Promise((resolve) => setTimeout(resolve, 40));
		fireEvent.scroll(scrollContainer);
		await waitFor(() => expect(scrollContainer.style.overflowAnchor).toBe('none'));

		setScrollGeometry(scrollContainer, { scrollTop: 900, scrollHeight: 1000, clientHeight: 100 });
		fireEvent.scroll(scrollContainer);
		await waitFor(() => expect(onAtBottomChange).toHaveBeenCalledWith(true));

		const rerenderWithSession = (session: Session) =>
			rendered.rerender(
				<LayerStackProvider>
					<TerminalOutput
						{...rendered.props}
						session={session}
						autoScrollAiMode={true}
						onAtBottomChange={onAtBottomChange}
						onScrollPositionChange={onScrollPositionChange}
					/>
				</LayerStackProvider>
			);

		rerenderWithSession(makeSession('tab-2'));
		expect(screen.getByText('second tab response')).toBeInTheDocument();
		rerenderWithSession(
			makeSession('tab-1', [
				...tabOne.logs,
				createLog({ id: 'user-1', source: 'user', text: 'Follow up' }),
				createLog({ id: 'ai-3', source: 'ai', text: 'unread response' }),
			])
		);
		expect(screen.getByText(/unread response/)).toBeInTheDocument();
		rerenderWithSession(makeSession('tab-2'));
		expect(screen.getByText('second tab response')).toBeInTheDocument();

		setScrollGeometry(scrollContainer, { scrollTop: 900, scrollHeight: 1000, clientHeight: 100 });
		rerenderWithSession(
			makeSession('tab-1', [
				...tabOne.logs,
				createLog({ id: 'user-2', source: 'user', text: 'At bottom' }),
				createLog({ id: 'ai-4', source: 'ai', text: 'bottom response' }),
			])
		);
		expect(screen.getByText(/bottom response/)).toBeInTheDocument();
		setScrollGeometry(scrollContainer, { scrollTop: 900, scrollHeight: 1000, clientHeight: 100 });
		rerenderWithSession(
			makeSession('tab-1', [
				...tabOne.logs,
				createLog({ id: 'user-2', source: 'user', text: 'At bottom' }),
				createLog({ id: 'ai-4', source: 'ai', text: 'bottom response' }),
				createLog({ id: 'user-4', source: 'user', text: 'Still at bottom' }),
				createLog({ id: 'ai-6', source: 'ai', text: 'read response' }),
			])
		);
		expect(screen.getByText(/read response/)).toBeInTheDocument();
		setScrollGeometry(scrollContainer, { scrollTop: 0, scrollHeight: 1000, clientHeight: 100 });
		rerenderWithSession(
			makeSession('tab-1', [
				...tabOne.logs,
				createLog({ id: 'user-2', source: 'user', text: 'At bottom' }),
				createLog({ id: 'ai-4', source: 'ai', text: 'bottom response' }),
				createLog({ id: 'user-3', source: 'user', text: 'Away from bottom' }),
				createLog({ id: 'ai-5', source: 'ai', text: 'away response' }),
				createLog({ id: 'user-5', source: 'user', text: 'Still away' }),
				createLog({ id: 'ai-7', source: 'ai', text: 'unread while away' }),
			])
		);
		expect(screen.getByText(/unread while away/)).toBeInTheDocument();
		fireEvent.scroll(scrollContainer);
		rendered.unmount();
		requestAnimationFrameSpy.mockRestore();
	});

	it('keeps read-state updates safe when AI mode has no active tab id', () => {
		const requestAnimationFrameSpy = vi
			.spyOn(window, 'requestAnimationFrame')
			.mockImplementation((callback) => {
				callback(0);
				return 1;
			});
		const baseTab = createTab({
			id: 'tab-without-active-id',
			logs: [createLog({ id: 'ai-no-active-1', source: 'ai', text: 'first no active' })],
		});
		const rendered = renderTerminal({
			session: createSession({
				inputMode: 'ai',
				activeTabId: null,
				aiTabs: [baseTab],
			}),
			autoScrollAiMode: true,
		});
		const scrollContainer = rendered.container.querySelector('.overflow-y-auto') as HTMLElement;
		setScrollGeometry(scrollContainer, { scrollTop: 900, scrollHeight: 1000, clientHeight: 100 });
		fireEvent.scroll(scrollContainer);

		rendered.rerender(
			<LayerStackProvider>
				<TerminalOutput
					{...rendered.props}
					session={createSession({
						inputMode: 'ai',
						activeTabId: null,
						aiTabs: [
							{
								...baseTab,
								logs: [
									...baseTab.logs,
									createLog({
										id: 'ai-no-active-2',
										source: 'ai',
										text: 'second no active',
									}),
								],
							},
						],
					})}
					autoScrollAiMode={true}
				/>
			</LayerStackProvider>
		);

		expect(screen.getByText(/second no active/)).toBeInTheDocument();
		requestAnimationFrameSpy.mockRestore();
	});

	it('restores saved scroll position', async () => {
		const session = createSession({
			inputMode: 'terminal',
			state: 'busy',
			busySource: 'terminal',
			statusMessage: 'Running command...',
			thinkingStartTime: Date.now() - 65_000,
			shellLogs: [createLog({ id: 'cmd-1', source: 'user', text: 'npm run build' })],
		});

		const rendered = renderTerminal({
			session,
			initialScrollTop: 500,
		});
		const { container } = rendered;

		const scrollContainer = container.querySelector('.overflow-y-auto') as HTMLElement;
		setScrollGeometry(scrollContainer, { scrollTop: 0, scrollHeight: 1000, clientHeight: 300 });
		await waitFor(() => expect(scrollContainer.scrollTop).toBe(500));

		rendered.unmount();
	});

	it('does not crash if saved scroll restoration fires after unmount', () => {
		let restoreCallback: FrameRequestCallback | undefined;
		const requestAnimationFrameSpy = vi
			.spyOn(window, 'requestAnimationFrame')
			.mockImplementation((callback) => {
				restoreCallback = callback;
				return 1;
			});

		const rendered = renderTerminal({
			session: createSession({ inputMode: 'terminal' }),
			initialScrollTop: 500,
		});
		rendered.unmount();

		expect(() => restoreCallback?.(0)).not.toThrow();
		requestAnimationFrameSpy.mockRestore();
	});

	it('renders markdown edit mode, AI command cards, and collapsed AI markdown branches', async () => {
		const setMarkdownEditMode = vi.fn();
		const session = createSession({
			inputMode: 'ai',
			aiTabs: [
				createTab({
					logs: [
						createLog({
							id: 'plain-ai',
							source: 'ai',
							text: '# Raw title\n\n- item',
						}),
						createLog({
							id: 'command-ai',
							source: 'user',
							text: 'command output',
							aiCommand: {
								command: '/review',
								description: 'Review the current diff',
							},
						}),
						createLog({
							id: 'collapsed-ai',
							source: 'ai',
							text: 'line one\nline two\nline three',
						}),
					],
				}),
			],
		});

		renderTerminal({
			session,
			markdownEditMode: true,
			setMarkdownEditMode,
			maxOutputLines: 2,
		});

		expect(screen.getByText('# Raw title')).toBeInTheDocument();
		expect(screen.getByText('/review:')).toBeInTheDocument();
		expect(screen.getByText('Review the current diff')).toBeInTheDocument();
		const formattedButtons = screen.getAllByTitle(/Show formatted/);
		expect(formattedButtons.length).toBeGreaterThan(0);
		fireEvent.click(formattedButtons[0]);
		expect(setMarkdownEditMode).toHaveBeenCalledWith(false);
		expect(screen.getAllByRole('button', { name: /Show all 3 lines/i }).length).toBeGreaterThan(0);
	});

	it('expands AI command, formatted markdown, and raw markdown collapsed branches', async () => {
		const formattedSession = createSession({
			inputMode: 'ai',
			aiTabs: [
				createTab({
					logs: [
						createLog({
							id: 'formatted-ai',
							source: 'ai',
							text: '## Formatted title\nline two\nline three',
						}),
					],
				}),
			],
		});

		const formatted = renderTerminal({ session: formattedSession, maxOutputLines: 1 });
		fireEvent.click(screen.getByRole('button', { name: /Show all 3 lines/i }));
		expect(screen.getByText('Formatted title')).toBeInTheDocument();
		formatted.unmount();

		const rawSession = createSession({
			inputMode: 'ai',
			aiTabs: [
				createTab({
					logs: [
						createLog({
							id: 'raw-ai',
							source: 'ai',
							text: '## Raw title\nline two\nline three',
						}),
					],
				}),
			],
		});

		const raw = renderTerminal({ session: rawSession, markdownEditMode: true, maxOutputLines: 1 });
		fireEvent.click(screen.getByRole('button', { name: /Show all 3 lines/i }));
		expect(screen.getByText(/## Raw title/)).toBeInTheDocument();
		raw.unmount();

		const rawSingle = renderTerminal({
			session: createSession({
				inputMode: 'ai',
				aiTabs: [
					createTab({
						logs: [createLog({ id: 'raw-single-ai', source: 'ai', text: '`inline raw`' })],
					}),
				],
			}),
			markdownEditMode: true,
		});
		expect(screen.getByText('`inline raw`')).toBeInTheDocument();
		rawSingle.unmount();

		const commandSession = createSession({
			inputMode: 'ai',
			aiTabs: [
				createTab({
					logs: [
						createLog({
							id: 'ai-command-expanded',
							source: 'ai',
							text: 'line one\nline two\nline three',
							aiCommand: {
								command: '/explain',
								description: 'Explain the result',
							},
						}),
					],
				}),
			],
		});

		renderTerminal({ session: commandSession, maxOutputLines: 1 });
		fireEvent.click(screen.getByRole('button', { name: /Show all 3 lines/i }));
		expect(screen.getByText('/explain:')).toBeInTheDocument();
		expect(screen.getByText('Explain the result')).toBeInTheDocument();
	});

	it('expands terminal output without search highlighting and captures downward wheel scrolling', async () => {
		const session = createSession({
			inputMode: 'terminal',
			shellLogs: [
				createLog({ id: 'cmd-plain', source: 'user', text: 'printf plain' }),
				createLog({
					id: 'out-plain',
					source: 'stdout',
					text: 'printf plain\rplain line one\nplain line two\nplain line three',
				}),
				createLog({ id: 'cmd-no-delimiter', source: 'user', text: 'no delimiter' }),
				createLog({ id: 'out-no-delimiter', source: 'stdout', text: 'no delimiterattached' }),
			],
		});

		const { container } = renderTerminal({ session, maxOutputLines: 1 });
		const showAllButton = screen.getByRole('button', { name: /Show all 3 lines/i });
		const scrollContainer = container.querySelector('.overflow-y-auto') as HTMLElement;
		const expandableLogItem = showAllButton.closest('[data-log-index]') as HTMLElement;
		vi.spyOn(expandableLogItem, 'getBoundingClientRect').mockReturnValue({
			bottom: 200,
		} as DOMRect);
		vi.spyOn(scrollContainer, 'getBoundingClientRect').mockReturnValue({
			bottom: 300,
		} as DOMRect);

		fireEvent.click(showAllButton);
		await new Promise((resolve) => setTimeout(resolve, 70));
		expect(Element.prototype.scrollBy).not.toHaveBeenCalledWith({
			top: expect.any(Number),
			behavior: 'smooth',
		});
		setScrollGeometry(scrollContainer, { scrollTop: 30, scrollHeight: 500, clientHeight: 100 });
		fireEvent.scroll(scrollContainer);

		const expandedOutput = container.querySelector<HTMLElement>('div[style*="max-height: 600px"]');
		expect(expandedOutput).toBeTruthy();
		setScrollGeometry(expandedOutput as HTMLElement, {
			scrollTop: 50,
			scrollHeight: 500,
			clientHeight: 100,
		});
		const wheelEvent = new WheelEvent('wheel', { deltaY: 1, bubbles: true });
		const stopPropagation = vi.spyOn(wheelEvent, 'stopPropagation');
		fireEvent(expandedOutput as HTMLElement, wheelEvent);
		expect(stopPropagation).toHaveBeenCalled();
	});

	it('expands terminal user output without parent scroll capture at boundaries', async () => {
		const session = createSession({
			inputMode: 'terminal',
			shellLogs: [
				createLog({
					id: 'user-terminal-multiline',
					source: 'user',
					text: 'first command line\nsecond command line\nthird command line',
				}),
			],
		});

		const { container } = renderTerminal({ session, maxOutputLines: 1 });
		const showAllButton = screen.getByRole('button', { name: /Show all 3 lines/i });
		const scrollContainer = container.querySelector('.overflow-y-auto') as HTMLElement;
		const expandableLogItem = showAllButton.closest('[data-log-index]') as HTMLElement;
		vi.spyOn(expandableLogItem, 'getBoundingClientRect').mockReturnValue({
			bottom: 200,
		} as DOMRect);
		vi.spyOn(scrollContainer, 'getBoundingClientRect').mockReturnValue({
			bottom: 300,
		} as DOMRect);

		fireEvent.click(showAllButton);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(Element.prototype.scrollBy).not.toHaveBeenCalledWith({
			top: expect.any(Number),
			behavior: 'smooth',
		});
		const expandedOutput = container.querySelector<HTMLElement>('div[style*="max-height: 600px"]');
		expect(expandedOutput).toBeTruthy();
		setScrollGeometry(expandedOutput as HTMLElement, {
			scrollTop: 0,
			scrollHeight: 500,
			clientHeight: 100,
		});
		const wheelEvent = new WheelEvent('wheel', { deltaY: -1, bubbles: true });
		const stopPropagation = vi.spyOn(wheelEvent, 'stopPropagation');
		fireEvent(expandedOutput as HTMLElement, wheelEvent);
		expect(stopPropagation).not.toHaveBeenCalled();
	});

	it('renders queued fallbacks plus remote save modal state', async () => {
		renderTerminal({
			session: createSession({
				inputMode: 'ai',
				activeTabId: null,
				aiTabs: [],
				executionQueue: [
					{
						id: 'queued-no-tabs',
						tabId: 'missing-tab',
						type: 'message',
						text: 'Queued without tabs',
						timestamp: 1_700_000_000_050,
					},
				],
			}),
		});
		expect(screen.getByText('Queued without tabs')).toBeInTheDocument();
		cleanup();

		const session = createSession({
			inputMode: 'ai',
			activeTabId: null,
			aiTabs: [createTab({ id: 'tab-1', logs: [createLog({ id: 'ai-1', text: 'Save me' })] })],
			cwd: '',
			sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-1' },
			executionQueue: [
				{
					id: 'queued-without-active-tab',
					tabId: 'other-tab',
					type: 'message',
					text: 'Visible queued fallback',
					timestamp: 1_700_000_000_100,
				},
			],
		});

		renderTerminal({
			session,
			cwd: '/override/cwd',
			onFileSaved: vi.fn(),
		});

		expect(screen.getByText('Visible queued fallback')).toBeInTheDocument();
		fireEvent.click(screen.getByTitle('Save to file'));
		expect(screen.getByText('Save Markdown')).toBeInTheDocument();
		cleanup();

		renderTerminal({
			session: createSession({
				inputMode: 'ai',
				cwd: '',
				sessionSshRemoteConfig: { enabled: true, remoteId: null },
				aiTabs: [
					createTab({ id: 'tab-1', logs: [createLog({ id: 'ai-2', text: 'Save empty cwd' })] }),
				],
			}),
			onFileSaved: vi.fn(),
		});
		fireEvent.click(screen.getByTitle('Save to file'));
		expect(screen.getByText('Save Markdown')).toBeInTheDocument();
	});
});
