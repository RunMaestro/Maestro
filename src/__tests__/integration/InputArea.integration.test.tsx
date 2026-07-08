import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React, { useRef, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { InputArea } from '../../renderer/components/InputArea';
import { LayerStackProvider } from '../../renderer/contexts/LayerStackContext';
import {
	clearCapabilitiesCache,
	setCapabilitiesCache,
	type AgentCapabilities,
} from '../../renderer/hooks/agent/useAgentCapabilities';
import { useSettingsStore } from '../../renderer/stores/settingsStore';
import type { Session, Theme } from '../../renderer/types';

const theme: Theme = {
	id: 'integration-dark',
	name: 'Integration Dark',
	mode: 'dark',
	colors: {
		bgMain: '#111111',
		bgSidebar: '#20242b',
		bgActivity: '#181b20',
		border: '#3f3f46',
		textMain: '#f4f4f5',
		textDim: '#a1a1aa',
		accent: '#4f8cff',
		accentDim: '#1d4ed8',
		accentText: '#22d3ee',
		accentForeground: '#ffffff',
		success: '#22c55e',
		warning: '#f59e0b',
		error: '#ef4444',
	},
};

const fullCapabilities: AgentCapabilities = {
	supportsResume: true,
	supportsReadOnlyMode: true,
	supportsJsonOutput: true,
	supportsSessionId: true,
	supportsImageInput: true,
	supportsImageInputOnResume: true,
	supportsSlashCommands: true,
	supportsSessionStorage: true,
	supportsCostTracking: true,
	supportsUsageStats: true,
	supportsBatchMode: true,
	requiresPromptToStart: false,
	supportsStreaming: true,
	supportsResultMessages: true,
	supportsModelSelection: false,
	supportsStreamJsonInput: true,
	supportsThinkingDisplay: true,
	supportsContextMerge: true,
	supportsContextExport: true,
	supportsWizard: true,
	supportsGroupChatModeration: true,
	usesJsonLineOutput: false,
	usesCombinedContextWindow: true,
};

function session(overrides: Partial<Session> & { wizardState?: unknown } = {}): Session {
	const { wizardState, ...sessionOverrides } = overrides;
	const aiTabs = [
		{
			id: 'tab-1',
			agentSessionId: null,
			name: 'Working tab',
			starred: false,
			logs: [],
			inputValue: '',
			stagedImages: [],
			createdAt: 1000,
			state: 'idle',
			hasUnread: false,
			isAtBottom: true,
			saveToHistory: true,
			showThinking: 'off',
			readOnlyMode: false,
			...(wizardState ? { wizardState } : {}),
		},
	];

	return {
		id: 'session-1',
		name: 'Integration Agent',
		toolType: 'claude-code',
		state: 'idle',
		inputMode: 'ai',
		cwd: '/Users/test/project',
		fullPath: '/Users/test/project',
		projectRoot: '/Users/test/project',
		createdAt: 1000,
		aiPid: 0,
		terminalPid: 0,
		port: 0,
		isLive: false,
		aiLogs: [],
		shellLogs: [],
		workLog: [],
		contextUsage: 0,
		usageStats: { inputTokens: 0, outputTokens: 0, totalCost: 0 },
		agentSessionId: null,
		isGitRepo: false,
		fileTree: [],
		fileExplorerExpanded: [],
		fileExplorerScrollPos: 0,
		executionQueue: [],
		activeTimeMs: 0,
		aiTabs,
		activeTabId: 'tab-1',
		closedTabHistory: [],
		filePreviewTabs: [],
		activeFileTabId: null,
		unifiedTabOrder: [{ type: 'ai', id: 'tab-1' }],
		unifiedClosedTabHistory: [],
		shellCommandHistory: [],
		aiCommandHistory: [],
		shellCwd: '/Users/test/project',
		...sessionOverrides,
	} as Session;
}

interface HarnessProps {
	session?: Session;
	initialInput?: string;
	initialImages?: string[];
	initialCommandHistoryOpen?: boolean;
	initialTabCompletionOpen?: boolean;
	props?: Partial<React.ComponentProps<typeof InputArea>>;
}

function InputHarness({
	session: activeSession = session(),
	initialInput = '',
	initialImages = [],
	initialCommandHistoryOpen = false,
	initialTabCompletionOpen = false,
	props = {},
}: HarnessProps) {
	const inputRef = useRef<HTMLTextAreaElement>(null);
	const [inputValue, setInputValue] = useState(initialInput);
	const [stagedImages, setStagedImages] = useState(initialImages);
	const [enterToSend, setEnterToSend] = useState(true);
	const [commandHistoryOpen, setCommandHistoryOpen] = useState(initialCommandHistoryOpen);
	const [commandHistoryFilter, setCommandHistoryFilter] = useState('');
	const [commandHistorySelectedIndex, setCommandHistorySelectedIndex] = useState(0);
	const [slashCommandOpen, setSlashCommandOpen] = useState(false);
	const [selectedSlashCommandIndex, setSelectedSlashCommandIndex] = useState(0);
	const [tabCompletionOpen, setTabCompletionOpen] = useState(initialTabCompletionOpen);
	const [tabCompletionFilter, setTabCompletionFilter] = useState<
		'all' | 'history' | 'branch' | 'tag' | 'file'
	>('all');
	const [selectedTabCompletionIndex, setSelectedTabCompletionIndex] = useState(0);
	const [atMentionOpen, setAtMentionOpen] = useState(false);
	const [atMentionFilter, setAtMentionFilter] = useState('');
	const [atMentionStartIndex, setAtMentionStartIndex] = useState(-1);
	const [selectedAtMentionIndex, setSelectedAtMentionIndex] = useState(0);

	return (
		<InputArea
			session={activeSession}
			theme={theme}
			inputValue={inputValue}
			setInputValue={setInputValue}
			enterToSend={enterToSend}
			setEnterToSend={setEnterToSend}
			stagedImages={stagedImages}
			setStagedImages={setStagedImages}
			setLightboxImage={vi.fn()}
			commandHistoryOpen={commandHistoryOpen}
			setCommandHistoryOpen={setCommandHistoryOpen}
			commandHistoryFilter={commandHistoryFilter}
			setCommandHistoryFilter={setCommandHistoryFilter}
			commandHistorySelectedIndex={commandHistorySelectedIndex}
			setCommandHistorySelectedIndex={setCommandHistorySelectedIndex}
			slashCommandOpen={slashCommandOpen}
			setSlashCommandOpen={setSlashCommandOpen}
			slashCommands={[
				{ command: '/clear', description: 'Clear chat history' },
				{ command: '/help', description: 'Show help', aiOnly: true },
				{ command: '/cd', description: 'Change directory', terminalOnly: true },
			]}
			selectedSlashCommandIndex={selectedSlashCommandIndex}
			setSelectedSlashCommandIndex={setSelectedSlashCommandIndex}
			tabCompletionOpen={tabCompletionOpen}
			setTabCompletionOpen={setTabCompletionOpen}
			tabCompletionSuggestions={[
				{ type: 'branch', value: 'feature/login', displayText: 'feature/login' },
				{ type: 'file', value: 'src/main.ts', displayText: 'src/main.ts' },
			]}
			selectedTabCompletionIndex={selectedTabCompletionIndex}
			setSelectedTabCompletionIndex={setSelectedTabCompletionIndex}
			tabCompletionFilter={tabCompletionFilter}
			setTabCompletionFilter={setTabCompletionFilter}
			atMentionOpen={atMentionOpen}
			setAtMentionOpen={setAtMentionOpen}
			atMentionFilter={atMentionFilter}
			setAtMentionFilter={setAtMentionFilter}
			atMentionStartIndex={atMentionStartIndex}
			setAtMentionStartIndex={setAtMentionStartIndex}
			atMentionSuggestions={[
				{
					value: 'docs/readme.md',
					type: 'file',
					displayText: 'readme.md',
					fullPath: '/repo/docs/readme.md',
					source: 'project',
				},
			]}
			selectedAtMentionIndex={selectedAtMentionIndex}
			setSelectedAtMentionIndex={setSelectedAtMentionIndex}
			inputRef={inputRef}
			handleInputKeyDown={vi.fn()}
			handlePaste={vi.fn()}
			handleDrop={vi.fn()}
			toggleInputMode={vi.fn()}
			processInput={vi.fn()}
			handleInterrupt={vi.fn()}
			onInputFocus={vi.fn()}
			onInputBlur={vi.fn()}
			{...props}
		/>
	);
}

function renderInput(props: HarnessProps = {}) {
	return render(
		<LayerStackProvider>
			<InputHarness {...props} />
		</LayerStackProvider>
	);
}

function textbox() {
	return screen.getByRole('textbox') as HTMLTextAreaElement;
}

class MockFileReader {
	onload: ((event: ProgressEvent<FileReader>) => void) | null = null;

	readAsDataURL(file: Blob) {
		this.onload?.({
			target: { result: `data:${file.type || 'image/png'};base64,aW50ZWdyYXRpb24=` },
		} as ProgressEvent<FileReader>);
	}
}

describe('InputArea integration', () => {
	const originalFileReader = globalThis.FileReader;
	const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
	const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;

	beforeEach(() => {
		clearCapabilitiesCache();
		setCapabilitiesCache('claude-code', fullCapabilities);
		vi.clearAllMocks();
		vi.mocked(window.maestro.agents.getCapabilities).mockResolvedValue(fullCapabilities);
		useSettingsStore.setState({
			spellCheck: true,
			contextManagementSettings: {
				contextWarningsEnabled: true,
				contextWarningYellowThreshold: 60,
				contextWarningRedThreshold: 80,
			},
		});
		globalThis.FileReader = MockFileReader as unknown as typeof FileReader;
		globalThis.requestAnimationFrame = (callback: FrameRequestCallback) => {
			callback(0);
			return 1;
		};
		globalThis.cancelAnimationFrame = vi.fn();
	});

	afterEach(() => {
		cleanup();
		vi.restoreAllMocks();
		clearCapabilitiesCache();
		globalThis.FileReader = originalFileReader;
		globalThis.requestAnimationFrame = originalRequestAnimationFrame;
		globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
	});

	it('drives AI-mode completions, image staging, context warning, and footer actions', async () => {
		const setLightboxImage = vi.fn();
		const onOpenPromptComposer = vi.fn();
		const onToggleTabSaveToHistory = vi.fn();
		const onToggleTabReadOnlyMode = vi.fn();
		const onToggleTabShowThinking = vi.fn();
		const onSummarizeAndContinue = vi.fn();
		const processInput = vi.fn();
		const showFlashNotification = vi.fn();

		const { container } = renderInput({
			initialImages: ['data:image/png;base64,existing'],
			props: {
				setLightboxImage,
				onOpenPromptComposer,
				onToggleTabSaveToHistory,
				onToggleTabReadOnlyMode,
				onToggleTabShowThinking,
				onSummarizeAndContinue,
				processInput,
				showFlashNotification,
				contextUsage: 85,
				contextWarningsEnabled: true,
				contextWarningYellowThreshold: 60,
				contextWarningRedThreshold: 80,
				tabSaveToHistory: true,
				tabReadOnlyMode: true,
				supportsThinking: true,
				tabShowThinking: 'on',
			},
		});

		expect(
			screen.getByPlaceholderText(/Talking to Integration Agent powered by Claude Code/)
		).toBeInTheDocument();
		await waitFor(() => expect(screen.getByTitle('Attach Image')).toBeInTheDocument());
		expect(screen.getByAltText('Staged image 1')).toBeInTheDocument();
		fireEvent.click(screen.getByAltText('Staged image 1').closest('button') as HTMLButtonElement);
		expect(setLightboxImage).toHaveBeenCalledWith(
			'data:image/png;base64,existing',
			['data:image/png;base64,existing'],
			'staged'
		);
		fireEvent.click(screen.getByRole('button', { name: 'Remove image 1' }));
		expect(screen.queryByAltText('Staged image 1')).not.toBeInTheDocument();

		fireEvent.change(textbox(), { target: { value: '/h', selectionStart: 2 } });
		const helpCommand = await screen.findByRole('button', { name: /show help/i });
		fireEvent.mouseEnter(helpCommand);
		fireEvent.click(helpCommand);
		fireEvent.doubleClick(helpCommand);
		expect(textbox()).toHaveValue('/help');

		fireEvent.change(textbox(), { target: { value: 'Review @doc', selectionStart: 11 } });
		await waitFor(() => expect(screen.getByText('/repo/docs/readme.md')).toBeInTheDocument());
		fireEvent.mouseEnter(screen.getByText('/repo/docs/readme.md'));
		fireEvent.click(screen.getByText('/repo/docs/readme.md'));
		expect(textbox()).toHaveValue('Review @docs/readme.md ');
		fireEvent.change(textbox(), { target: { value: 'Review @doc now', selectionStart: 15 } });
		expect(screen.queryByText('/repo/docs/readme.md')).not.toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: /compact & continue/i }));
		expect(onSummarizeAndContinue).toHaveBeenCalledTimes(1);

		fireEvent.click(screen.getByTitle('Open Prompt Composer'));
		fireEvent.click(screen.getByTitle(/Save to History/));
		fireEvent.click(screen.getByTitle(/plan mode/i));
		fireEvent.click(screen.getByTitle('Thinking (temporary) - Click for sticky mode'));
		fireEvent.click(screen.getByTitle('Switch to Ctrl+Enter to send'));
		fireEvent.click(screen.getByTitle('Send message'));

		expect(onOpenPromptComposer).toHaveBeenCalledTimes(1);
		expect(onToggleTabSaveToHistory).toHaveBeenCalledTimes(1);
		expect(onToggleTabReadOnlyMode).toHaveBeenCalledTimes(1);
		expect(onToggleTabShowThinking).toHaveBeenCalledTimes(1);
		expect(processInput).toHaveBeenCalledTimes(1);
		expect(screen.getByTitle('Switch to Enter to send')).toBeInTheDocument();

		const fileInput = container.querySelector('#image-file-input') as HTMLInputElement;
		fireEvent.change(fileInput, {
			target: { files: [new File(['image'], 'screen.png', { type: 'image/png' })] },
		});
		expect(await screen.findByAltText('Staged image 1')).toBeInTheDocument();
		fireEvent.click(screen.getByTitle('Attach Image'));

		fireEvent.change(fileInput, {
			target: { files: [new File(['image'], 'screen.png', { type: 'image/png' })] },
		});
		expect(showFlashNotification).toHaveBeenCalledWith('Duplicate image ignored');
	});

	it('routes terminal history and tab-completion interactions without AI-only controls', () => {
		const handleDrop = vi.fn();
		renderInput({
			session: session({
				inputMode: 'terminal',
				isGitRepo: true,
				shellCwd: '/Users/test/project/src',
				shellCommandHistory: ['npm test', 'git status'],
			}),
			initialCommandHistoryOpen: true,
			initialTabCompletionOpen: true,
			props: { handleDrop },
		});

		expect(screen.getByText('$')).toBeInTheDocument();
		expect(screen.getByText('~/project/src')).toBeInTheDocument();
		expect(screen.queryByTitle('Attach Image')).not.toBeInTheDocument();
		expect(screen.queryByTitle('Open Prompt Composer')).not.toBeInTheDocument();

		const historyFilter = screen.getByPlaceholderText('Filter commands...');
		fireEvent.keyDown(historyFilter, { key: 'ArrowDown' });
		fireEvent.keyDown(historyFilter, { key: 'ArrowUp' });
		fireEvent.change(historyFilter, { target: { value: 'git' } });
		expect(screen.getByText('git status')).toBeInTheDocument();
		fireEvent.mouseEnter(screen.getByText('git status'));
		fireEvent.keyDown(historyFilter, { key: 'Enter' });
		expect(textbox()).toHaveValue('git status');

		fireEvent.click(screen.getByRole('button', { name: /Branches/i }));
		fireEvent.mouseEnter(screen.getByText('feature/login'));
		fireEvent.click(screen.getByText('feature/login'));
		expect(textbox()).toHaveValue('feature/login');

		fireEvent.drop(textbox(), { dataTransfer: { files: [] } });
		fireEvent.dragOver(textbox());
		expect(handleDrop).toHaveBeenCalled();
	});

	it('selects command history items by click', () => {
		renderInput({
			session: session({
				inputMode: 'terminal',
				shellCommandHistory: ['npm test', 'git status'],
			}),
			initialCommandHistoryOpen: true,
		});

		fireEvent.click(screen.getByText('npm test'));
		expect(textbox()).toHaveValue('npm test');
		expect(screen.queryByPlaceholderText('Filter commands...')).not.toBeInTheDocument();
	});

	it('covers command history escape, tab-completion empty states, remote cwd, and terminal send', () => {
		const processInput = vi.fn();
		const { rerender } = render(
			<LayerStackProvider>
				<InputHarness
					session={session({
						inputMode: 'terminal',
						isGitRepo: true,
						shellCwd: undefined,
						cwd: '/home/test/remote-project',
						sshRemoteId: 'ssh-1',
						sshRemote: { id: 'ssh-1', name: 'buildbox', host: 'buildbox.local' } as any,
						remoteCwd: '/home/test/remote-project',
						shellCommandHistory: ['npm test'],
					})}
					initialCommandHistoryOpen
					initialTabCompletionOpen
					props={{
						processInput,
						tabCompletionSuggestions: [],
					}}
				/>
			</LayerStackProvider>
		);

		expect(screen.getByText('BUILDBOX:~/remote-project')).toBeInTheDocument();
		const historyFilter = screen.getByPlaceholderText('Filter commands...');
		fireEvent.keyDown(historyFilter, { key: 'Escape' });
		expect(screen.queryByPlaceholderText('Filter commands...')).not.toBeInTheDocument();

		expect(screen.getByText('No matching suggestions')).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: /History/i }));
		expect(screen.getByText('No matching history')).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: /Branches/i }));
		expect(screen.getByText('No matching branches')).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: /Tags/i }));
		expect(screen.getByText('No matching tags')).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: /Files/i }));
		expect(screen.getByText('No matching files')).toBeInTheDocument();

		fireEvent.click(screen.getByTitle('Run command (Enter)'));
		expect(processInput).toHaveBeenCalledTimes(1);

		rerender(
			<LayerStackProvider>
				<InputHarness
					session={session({
						inputMode: 'terminal',
						isGitRepo: true,
						shellCwd: undefined,
						cwd: undefined,
						sshRemoteId: 'ssh-1',
						sshRemote: undefined,
						sessionSshRemoteConfig: {
							enabled: true,
							remoteId: 'ssh-1',
							workingDirOverride: undefined,
						} as any,
					})}
					initialTabCompletionOpen
					props={{ tabCompletionSuggestions: [] }}
				/>
			</LayerStackProvider>
		);
		expect(screen.getByText('~')).toBeInTheDocument();
	});

	it('renders summarization, merge, and wizard inline modes with their cancel paths', async () => {
		const onCancelSummarize = vi.fn();
		renderInput({
			props: {
				isSummarizing: true,
				onCancelSummarize,
				summarizeStartTime: Date.now() - 5000,
				summarizeProgress: { stage: 'summarizing', progress: 50, message: 'Compacting' },
				summarizeResult: null,
			},
		});

		expect(screen.getByText('Summarize with AI')).toBeInTheDocument();
		fireEvent.click(screen.getByTitle('Cancel'));
		fireEvent.click(screen.getByText('Yes'));
		expect(onCancelSummarize).toHaveBeenCalledTimes(1);

		cleanup();

		const onCancelMerge = vi.fn();
		renderInput({
			props: {
				isMerging: true,
				onCancelMerge,
				mergeStartTime: Date.now() - 4000,
				mergeProgress: { stage: 'grooming', progress: 60, message: 'Grooming' },
				mergeResult: null,
				mergeSourceName: 'Research',
				mergeTargetName: 'Implementation',
			},
		});

		expect(screen.getByText('Merging "Research" into "Implementation"...')).toBeInTheDocument();
		fireEvent.click(screen.getByTitle('Cancel'));
		fireEvent.click(screen.getByText('Cancel'));
		expect(onCancelMerge).toHaveBeenCalledTimes(1);

		cleanup();

		const onExitWizard = vi.fn();
		renderInput({
			session: session({
				wizardState: { isActive: true, isWaiting: false, confidence: 72 },
			}),
			props: {
				onExitWizard,
				onOpenPromptComposer: vi.fn(),
				onToggleWizardShowThinking: vi.fn(),
			},
		});

		await waitFor(() =>
			expect(screen.getByPlaceholderText('Tell the wizard about your project...')).toHaveFocus()
		);
		fireEvent.change(textbox(), { target: { value: 'Draft wizard answer' } });
		fireEvent.keyDown(textbox(), { key: 'Escape' });
		fireEvent.click(screen.getByRole('button', { name: 'Exit' }));
		expect(onExitWizard).toHaveBeenCalledTimes(1);
	});

	it('renders AI history empty states, shortcut titles, inactive toggles, and resume image capability', async () => {
		setCapabilitiesCache('claude-code', {
			...fullCapabilities,
			supportsImageInputOnResume: false,
		});
		renderInput({
			session: session({
				aiCommandHistory: ['Summarize the plan', 'Review the diff'],
				aiTabs: [
					{
						id: 'tab-1',
						agentSessionId: 'resumed-agent-session',
						name: 'Working tab',
						starred: false,
						logs: [],
						inputValue: '',
						stagedImages: [],
						createdAt: 1000,
						state: 'idle',
						hasUnread: false,
						isAtBottom: true,
						saveToHistory: false,
						showThinking: 'off',
						readOnlyMode: false,
					},
				],
			}),
			initialCommandHistoryOpen: true,
			props: {
				onOpenPromptComposer: vi.fn(),
				shortcuts: {
					openPromptComposer: { keys: ['Meta', 'p'], description: 'Open composer' },
				},
				onToggleTabSaveToHistory: vi.fn(),
				onToggleTabReadOnlyMode: vi.fn(),
				onToggleTabShowThinking: vi.fn(),
				tabSaveToHistory: false,
				tabReadOnlyMode: false,
				supportsThinking: true,
				tabShowThinking: 'sticky',
			},
		});

		expect(screen.queryByTitle('Attach Image')).not.toBeInTheDocument();
		expect(screen.getByTitle(/Open Prompt Composer \((⌘ P|Ctrl\+P)\)/)).toBeInTheDocument();
		expect(screen.getByTitle(/Save to History/)).toHaveClass('opacity-40');
		expect(screen.getByTitle(/plan mode/i)).toHaveClass('opacity-40');
		expect(screen.getByTitle('Thinking (sticky) - Click to turn off')).toBeInTheDocument();
		expect(screen.getByTestId('pin-icon')).toBeInTheDocument();

		const historyFilter = screen.getByPlaceholderText('Filter messages...');
		fireEvent.change(historyFilter, { target: { value: 'missing' } });
		expect(screen.getByText('No matching messages')).toBeInTheDocument();
		fireEvent.keyDown(historyFilter, { key: 'Tab' });
		fireEvent.keyDown(historyFilter, { key: 'Enter' });
		fireEvent.keyDown(historyFilter, { key: 'Escape' });
		expect(screen.queryByPlaceholderText('Filter messages...')).not.toBeInTheDocument();
	});

	it('uses legacy histories and terminal cwd fallbacks when split histories are absent', () => {
		renderInput({
			session: session({
				inputMode: 'terminal',
				shellCommandHistory: undefined,
				aiCommandHistory: undefined,
				shellCwd: undefined,
				cwd: '/Users/test/project/fallback',
				commandHistory: ['legacy command'],
			} as Partial<Session> as Session),
			initialCommandHistoryOpen: true,
			props: { isAutoModeActive: true },
		});

		expect(screen.getByText('~/project/fallback')).toBeInTheDocument();
		expect(screen.getByText('legacy command')).toBeInTheDocument();
		fireEvent.click(screen.getByText('legacy command'));
		expect(textbox()).toHaveValue('legacy command');

		cleanup();

		renderInput({
			session: session({
				inputMode: 'terminal',
				shellCommandHistory: undefined,
				aiCommandHistory: undefined,
				commandHistory: ['legacy command'],
			} as Partial<Session> as Session),
			initialCommandHistoryOpen: true,
		});
		fireEvent.change(screen.getByPlaceholderText('Filter commands...'), {
			target: { value: 'missing' },
		});
		expect(screen.getByText('No matching commands')).toBeInTheDocument();
	});

	it('renders slash, tab, and mention completion alternate item types and fallback handlers', async () => {
		renderInput({
			initialTabCompletionOpen: true,
			props: {
				atMentionSuggestions: [
					{
						value: 'docs/readme.md',
						type: 'file',
						displayText: 'readme.md',
						fullPath: '/repo/docs/readme.md',
						source: 'project',
					},
					{
						value: 'src/components',
						type: 'folder',
						displayText: 'components',
						fullPath: '/repo/src/components',
						source: 'autorun',
					},
				],
				selectedAtMentionIndex: 1,
			},
		});

		fireEvent.change(textbox(), { target: { value: '/' } });
		await waitFor(() => expect(screen.getByText('/clear')).toBeInTheDocument());
		expect(screen.getByText('/help')).toBeInTheDocument();
		fireEvent.change(textbox(), { target: { value: '/h' } });
		await waitFor(() => expect(screen.queryByText('/clear')).not.toBeInTheDocument());

		fireEvent.change(textbox(), { target: { value: 'Use @' } });
		await waitFor(() => expect(screen.getByText('/repo/src/components')).toBeInTheDocument());
		expect(screen.getByText('Auto Run')).toBeInTheDocument();
		fireEvent.mouseEnter(screen.getByText('/repo/src/components'));
		fireEvent.click(screen.getByText('/repo/src/components'));
		expect(textbox()).toHaveValue('Use @src/components ');

		cleanup();

		renderInput({
			session: session({ inputMode: 'terminal', isGitRepo: true }),
			initialTabCompletionOpen: true,
			props: {
				tabCompletionSuggestions: [
					{ type: 'history', value: 'npm run lint', displayText: 'npm run lint' },
					{ type: 'tag', value: 'v1.2.3', displayText: 'v1.2.3' },
					{ type: 'folder', value: 'src/components', displayText: 'src/components' },
				],
				selectedTabCompletionIndex: 1,
			},
		});

		expect(screen.getByText('npm run lint')).toBeInTheDocument();
		expect(screen.getByText('v1.2.3')).toBeInTheDocument();
		expect(screen.getByText('src/components')).toBeInTheDocument();
		fireEvent.mouseEnter(screen.getByText('src/components'));
		fireEvent.click(screen.getByText('src/components'));
		expect(textbox()).toHaveValue('src/components');
	});

	it('handles optional completion callbacks, empty uploads, and missing reader results', async () => {
		const OriginalReader = globalThis.FileReader;
		class EmptyResultReader {
			onload: ((event: ProgressEvent<FileReader>) => void) | null = null;

			readAsDataURL() {
				this.onload?.({ target: { result: '' } } as ProgressEvent<FileReader>);
			}
		}
		globalThis.FileReader = EmptyResultReader as unknown as typeof FileReader;

		const { container } = renderInput({
			session: session({
				wizardState: { isActive: true, isWaiting: false, confidence: 90 },
			}),
			props: {
				setAtMentionOpen: undefined,
				setAtMentionFilter: undefined,
				setAtMentionStartIndex: undefined,
				setSelectedAtMentionIndex: undefined,
				onOpenPromptComposer: vi.fn(),
			},
		});

		fireEvent.change(textbox(), { target: { value: 'literal@mention', selectionStart: 0 } });
		expect(screen.queryByText('/repo/docs/readme.md')).not.toBeInTheDocument();

		const fileInput = container.querySelector('#image-file-input') as HTMLInputElement;
		fireEvent.change(fileInput, { target: { files: [] } });
		fireEvent.change(fileInput, { target: { files: null } });
		expect(screen.queryByAltText('Staged image 1')).not.toBeInTheDocument();
		fireEvent.change(fileInput, {
			target: { files: [new File(['image'], 'empty.png', { type: 'image/png' })] },
		});
		expect(screen.queryByAltText('Staged image 1')).not.toBeInTheDocument();

		globalThis.FileReader = OriginalReader;
	});

	it('renders progress fallbacks, autorun queue state, and off thinking styling', () => {
		const onCancelSummarize = vi.fn();
		renderInput({
			props: {
				isSummarizing: true,
				onCancelSummarize,
				summarizeProgress: undefined,
				summarizeResult: undefined,
			},
		});
		expect(screen.getByText('Summarize with AI')).toBeInTheDocument();

		cleanup();

		const onCancelMerge = vi.fn();
		renderInput({
			props: {
				isMerging: true,
				onCancelMerge,
				mergeProgress: undefined,
				mergeResult: undefined,
				mergeSourceName: 'Source',
				mergeTargetName: 'Target',
			},
		});
		expect(screen.getByText('Merging "Source" into "Target"...')).toBeInTheDocument();

		cleanup();

		const onOpenQueueBrowser = vi.fn();
		renderInput({
			session: session({
				executionQueue: [
					{
						id: 'queue-1',
						type: 'message',
						content: 'queued message',
						tabId: 'tab-1',
						tabName: 'Working tab',
					},
				] as any,
			}),
			props: {
				isAutoModeActive: true,
				autoRunState: {
					isRunning: true,
					isStopping: false,
					documents: ['plan.md'],
					lockedDocuments: [],
					currentDocumentIndex: 0,
					currentDocTasksTotal: 1,
					currentDocTasksCompleted: 0,
					totalTasksAcrossAllDocs: 1,
					completedTasksAcrossAllDocs: 0,
					loopEnabled: false,
					loopIteration: 0,
					folderPath: '/repo',
					worktreeActive: false,
					totalTasks: 1,
					completedTasks: 0,
					currentTaskIndex: 0,
					originalContent: '',
					sessionIds: [],
				},
				onOpenQueueBrowser,
				supportsThinking: true,
				tabShowThinking: 'off',
				onToggleTabShowThinking: vi.fn(),
			},
		});

		fireEvent.click(screen.getByRole('button', { name: /item queued/ }));
		expect(onOpenQueueBrowser).toHaveBeenCalledTimes(1);
		expect(screen.getByTitle('Show Thinking - Click to stream AI reasoning')).toHaveClass(
			'opacity-40'
		);
	});
});
