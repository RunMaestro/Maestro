import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ProcessMonitor } from '../../renderer/components/ProcessMonitor';
import { LayerStackProvider } from '../../renderer/contexts/LayerStackContext';
import { logger } from '../../renderer/utils/logger';
import type { Group, GroupChat, Session, Theme } from '../../renderer/types';

interface ActiveProcess {
	sessionId: string;
	toolType: string;
	pid: number;
	cwd: string;
	isTerminal: boolean;
	isBatchMode: boolean;
	startTime: number;
	command?: string;
	args?: string[];
}

interface ProcessBridge {
	getActiveProcesses: ReturnType<typeof vi.fn<() => Promise<ActiveProcess[]>>>;
	kill: ReturnType<typeof vi.fn<(processSessionId: string) => Promise<void>>>;
}

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

function createSession(overrides: Partial<Session> = {}): Session {
	return {
		id: 'session-1',
		name: 'Agent One',
		toolType: 'claude-code',
		state: 'idle',
		inputMode: 'ai',
		cwd: '/workspace/one',
		projectRoot: '/workspace/one',
		fullPath: '/workspace/one',
		aiPid: 0,
		terminalPid: 0,
		port: 0,
		aiTabs: [
			{
				id: 'tab-1',
				name: 'Main',
				logs: [],
				agentSessionId: 'abcdef12-3456-7890-abcd-ef1234567890',
				isStarred: false,
				state: 'idle',
				inputValue: '',
				stagedImages: [],
				createdAt: 1700000000000,
				saveToHistory: true,
			},
		],
		activeTabId: 'tab-1',
		closedTabHistory: [],
		shellLogs: [],
		executionQueue: [],
		contextUsage: 0,
		workLog: [],
		isGitRepo: false,
		changedFiles: [],
		fileTree: [],
		fileExplorerExpanded: [],
		fileExplorerScrollPos: 0,
		isLive: false,
		activeTimeMs: 0,
		filePreviewTabs: [],
		activeFileTabId: null,
		unifiedTabOrder: [{ type: 'ai', id: 'tab-1' }],
		unifiedClosedTabHistory: [],
		...overrides,
	} as Session;
}

function createGroup(overrides: Partial<Group> = {}): Group {
	return {
		id: 'group-1',
		name: 'Core Group',
		emoji: 'G',
		isExpanded: true,
		...overrides,
	};
}

function createGroupChat(overrides: Partial<GroupChat> = {}): GroupChat {
	return {
		id: 'chat-1',
		name: 'Planning Chat',
		createdAt: 1700000000000,
		moderatorAgentId: 'claude-code',
		moderatorSessionId: 'group-chat-chat-1-moderator',
		participants: [],
		logPath: '/tmp/chat.log',
		imagesDir: '/tmp/images',
		...overrides,
	};
}

function createProcess(overrides: Partial<ActiveProcess> = {}): ActiveProcess {
	return {
		sessionId: 'session-1-ai-tab-1',
		toolType: 'claude-code',
		pid: 4101,
		cwd: '/workspace/one',
		isTerminal: false,
		isBatchMode: false,
		startTime: Date.now() - 90_000,
		command: 'claude',
		args: ['--model', 'sonnet'],
		...overrides,
	};
}

function renderMonitor(
	props: Partial<React.ComponentProps<typeof ProcessMonitor>> = {},
	processes: ActiveProcess[] | ProcessBridge['getActiveProcesses'] = [createProcess()]
) {
	const processBridge = window.maestro.process as unknown as ProcessBridge;
	processBridge.getActiveProcesses = Array.isArray(processes)
		? vi.fn().mockResolvedValue(processes)
		: processes;
	processBridge.kill = vi.fn().mockResolvedValue(undefined);

	const onClose = vi.fn();
	const onNavigateToSession = vi.fn();
	const onNavigateToGroupChat = vi.fn();
	const sessions = [
		createSession({ groupId: 'group-1' }),
		createSession({
			id: 'session-2',
			name: 'Agent Two',
			cwd: '/workspace/two',
			projectRoot: '/workspace/two',
			fullPath: '/workspace/two',
			activeTabId: 'tab-2',
			aiTabs: [
				{
					id: 'tab-2',
					name: 'Shell',
					logs: [],
					agentSessionId: null,
					isStarred: false,
					state: 'idle',
					inputValue: '',
					stagedImages: [],
					createdAt: 1700000000000,
					saveToHistory: true,
				},
			],
			unifiedTabOrder: [{ type: 'ai', id: 'tab-2' }],
		}),
	];

	const result = render(
		<LayerStackProvider>
			<ProcessMonitor
				theme={createTheme()}
				sessions={sessions}
				groups={[createGroup()]}
				groupChats={[createGroupChat()]}
				onClose={onClose}
				onNavigateToSession={onNavigateToSession}
				onNavigateToGroupChat={onNavigateToGroupChat}
				{...props}
			/>
		</LayerStackProvider>
	);

	return {
		...result,
		onClose,
		onNavigateToSession,
		onNavigateToGroupChat,
		processBridge,
	};
}

function invokeReactKeyDown(element: HTMLElement, key: string) {
	const reactPropsKey = Object.keys(element).find((propKey) => propKey.startsWith('__reactProps$'));
	const onKeyDown = reactPropsKey ? (element as any)[reactPropsKey]?.onKeyDown : undefined;

	if (typeof onKeyDown !== 'function') {
		throw new Error('React keydown handler was not found on the target element');
	}

	onKeyDown({
		key,
		preventDefault: vi.fn(),
		stopPropagation: vi.fn(),
		target: element,
		currentTarget: element,
	});
}

describe('ProcessMonitor integration', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		window.localStorage.removeItem('maestro.processMonitor.expandedLevel');
		Element.prototype.scrollIntoView = vi.fn();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('renders active session, group chat, and wizard process sections from the process bridge', async () => {
		const processes = [
			createProcess(),
			createProcess({
				sessionId: 'session-1-batch-1700000000000',
				pid: 4102,
				isBatchMode: true,
				command: 'claude',
				args: ['--resume'],
			}),
			createProcess({
				sessionId: 'session-2-terminal',
				pid: 4201,
				cwd: '/workspace/two',
				isTerminal: true,
				toolType: 'shell',
				command: 'zsh',
				args: ['-l'],
			}),
			createProcess({
				sessionId: 'group-chat-chat-1-moderator-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
				pid: 4301,
			}),
			createProcess({
				sessionId: 'group-chat-chat-1-participant-Ada-1700000000000',
				pid: 4302,
			}),
			createProcess({
				sessionId: 'inline-wizard-1700000000000-abcd',
				pid: 4401,
				command: 'wizard',
			}),
			createProcess({
				sessionId: 'inline-wizard-gen-1700000000000-abcd',
				pid: 4402,
				command: 'wizard-gen',
			}),
		];
		const { onClose, onNavigateToGroupChat, onNavigateToSession } = renderMonitor({}, processes);

		expect(await screen.findByText('7 active')).toBeInTheDocument();
		await waitFor(() => expect(screen.getByText('Core Group')).toBeInTheDocument());
		expect(screen.getByText('Agent One')).toBeInTheDocument();
		expect(screen.getByText('Agent One - AI Agent (claude-code) - Main')).toBeInTheDocument();
		expect(screen.getByText('Agent One - AI Agent (claude-code)')).toBeInTheDocument();
		expect(screen.getByText('AUTO')).toBeInTheDocument();
		expect(screen.getByText('Agent Two - Terminal Shell')).toBeInTheDocument();
		expect(screen.getByText('GROUP CHATS')).toBeInTheDocument();
		expect(screen.getByText('Planning Chat')).toBeInTheDocument();
		expect(screen.getByText('MODERATOR')).toBeInTheDocument();
		expect(screen.getByText('Ada')).toBeInTheDocument();
		expect(screen.getByText('WIZARD PROCESSES')).toBeInTheDocument();
		expect(screen.getByText('Wizard Conversation')).toBeInTheDocument();
		expect(screen.getByText('Playbook Generation')).toBeInTheDocument();

		fireEvent.click(screen.getByText('Open'));
		expect(onNavigateToGroupChat).toHaveBeenCalledWith('chat-1');

		fireEvent.click(screen.getAllByText('abcdef12')[0]);
		expect(onNavigateToSession).toHaveBeenCalledWith('session-1', 'tab-1', 'ai');
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it('opens process details and kills a selected process through the process bridge', async () => {
		const process = createProcess({
			sessionId: 'session-1-ai-tab-1',
			pid: 4101,
			command: 'claude',
			args: ['--model', 'sonnet'],
		});
		const { processBridge } = renderMonitor({}, [process]);

		const processRow = await screen.findByText('Agent One - AI Agent (claude-code) - Main');
		fireEvent.doubleClick(processRow);

		expect(await screen.findByText('Process Details')).toBeInTheDocument();
		expect(screen.getByText('session-1-ai-tab-1')).toBeInTheDocument();
		expect(screen.getByText('claude --model sonnet')).toBeInTheDocument();

		fireEvent.click(screen.getByTitle('Back (Esc)'));
		await screen.findByText('System Processes');

		fireEvent.click(screen.getByTitle('Kill process'));
		expect(await screen.findByText('Kill Process?')).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'Kill Process' }));

		await waitFor(() => expect(processBridge.kill).toHaveBeenCalledWith('session-1-ai-tab-1'));
		await waitFor(() => expect(processBridge.getActiveProcesses).toHaveBeenCalledTimes(2));
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 550));
		});
	});

	it('shows loading, empty, refresh, and fetch-error states from the process bridge', async () => {
		let resolveProcesses: (processes: ActiveProcess[]) => void = () => {};
		const getActiveProcesses = vi.fn(
			() =>
				new Promise<ActiveProcess[]>((resolve) => {
					resolveProcesses = resolve;
				})
		);

		renderMonitor({}, getActiveProcesses);

		expect(screen.getByText('Loading processes...')).toBeInTheDocument();
		await act(async () => {
			resolveProcesses([]);
		});
		expect(await screen.findByText('No running processes')).toBeInTheDocument();

		getActiveProcesses.mockResolvedValueOnce([]);
		fireEvent.click(screen.getByTitle('Refresh (R)'));
		await waitFor(() => expect(getActiveProcesses).toHaveBeenCalledTimes(2));

		const loggerError = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
		renderMonitor({}, vi.fn().mockRejectedValueOnce(new Error('process bridge down')));
		await waitFor(() =>
			expect(loggerError).toHaveBeenCalledWith(
				'Failed to fetch active processes:',
				undefined,
				expect.any(Error)
			)
		);
		loggerError.mockRestore();
	});

	it('supports keyboard navigation, expand/collapse controls, and detail fallbacks', async () => {
		const now = Date.now();
		const processes = [
			createProcess({
				sessionId: 'session-1-ai-tab-1',
				pid: 4101,
				startTime: now - 10_000,
				command: 'claude',
				args: ['--model', 'sonnet'],
			}),
			createProcess({
				sessionId: 'session-1-synopsis-1700000000000',
				pid: 4102,
				cwd: '',
				startTime: now - (2 * 24 * 60 * 60 * 1000 + 3 * 60 * 60 * 1000),
				command: undefined,
				args: undefined,
			}),
			createProcess({
				sessionId: 'session-2-terminal',
				pid: 4201,
				cwd: '/workspace/two',
				isTerminal: true,
				toolType: 'shell',
				startTime: now - (3 * 60 * 60 * 1000 + 5 * 60 * 1000),
				command: 'zsh',
				args: ['-l'],
			}),
		];
		const { processBridge } = renderMonitor({}, processes);

		expect(
			await screen.findByText('Agent One - AI Agent (claude-code) - Main')
		).toBeInTheDocument();
		expect(screen.getByText('10s')).toBeInTheDocument();
		expect(screen.getByText('2d 3h')).toBeInTheDocument();
		expect(screen.getByText('3h 5m')).toBeInTheDocument();

		fireEvent.click(screen.getByTitle('Collapse one level'));
		expect(screen.queryByText('Agent One - AI Agent (claude-code) - Main')).not.toBeInTheDocument();
		fireEvent.click(screen.getByTitle('Expand one level'));
		expect(
			await screen.findByText('Agent One - AI Agent (claude-code) - Main')
		).toBeInTheDocument();

		const dialog = screen.getByRole('dialog', { name: 'System Processes' });
		fireEvent.keyDown(dialog, { key: 'ArrowDown' });
		fireEvent.keyDown(dialog, { key: 'ArrowRight' });
		fireEvent.keyDown(dialog, { key: 'ArrowLeft' });
		fireEvent.keyDown(dialog, { key: 'ArrowUp' });
		fireEvent.keyDown(dialog, { key: 'r' });
		await waitFor(() => expect(processBridge.getActiveProcesses).toHaveBeenCalledTimes(2));

		fireEvent.click(screen.getByTitle('Expand one level'));
		fireEvent.doubleClick(await screen.findByText('Agent One - AI Agent (claude-code) - Synopsis'));
		expect(await screen.findByText('Process Details')).toBeInTheDocument();
		expect(screen.getAllByText('N/A')).toHaveLength(2);
		expect(screen.getByText('synopsis')).toBeInTheDocument();
	});

	it('handles node clicks, hover handlers, detail controls, and modal overlay close', async () => {
		const { onClose } = renderMonitor({}, [createProcess()]);

		expect(
			await screen.findByText('Agent One - AI Agent (claude-code) - Main')
		).toBeInTheDocument();

		const groupButton = screen.getByText('Core Group').closest('button')!;
		fireEvent.mouseEnter(groupButton);
		fireEvent.mouseLeave(groupButton);
		fireEvent.click(groupButton);
		expect(screen.queryByText('Agent One')).not.toBeInTheDocument();
		fireEvent.click(groupButton);

		const sessionButton = screen.getByText('Agent One').closest('[role="button"]')!;
		fireEvent.mouseEnter(sessionButton);
		fireEvent.mouseLeave(sessionButton);
		fireEvent.click(sessionButton);
		expect(screen.queryByText('Agent One - AI Agent (claude-code) - Main')).not.toBeInTheDocument();
		fireEvent.click(sessionButton);

		const processRow = (
			await screen.findByText('Agent One - AI Agent (claude-code) - Main')
		).closest('[tabindex="0"]')!;
		fireEvent.mouseEnter(processRow);
		fireEvent.mouseLeave(processRow);
		fireEvent.click(processRow);

		const killButton = screen.getByTitle('Kill process');
		fireEvent.mouseEnter(killButton);
		fireEvent.mouseLeave(killButton);

		for (const title of ['Refresh (R)', 'Expand one level', 'Collapse one level', 'Close (Esc)']) {
			const button = screen.getByTitle(title);
			fireEvent.mouseEnter(button);
			fireEvent.mouseLeave(button);
		}

		fireEvent.click(screen.getByRole('dialog', { name: 'System Processes' }).parentElement!);
		expect(onClose).toHaveBeenCalledTimes(1);

		fireEvent.doubleClick(processRow);
		expect(await screen.findByText('Process Details')).toBeInTheDocument();

		const backButton = screen.getByTitle('Back (Esc)');
		fireEvent.mouseEnter(backButton);
		fireEvent.mouseLeave(backButton);
		fireEvent.click(backButton);
		await screen.findByText('System Processes');

		const rerenderedProcessRow = (
			await screen.findByText('Agent One - AI Agent (claude-code) - Main')
		).closest('[tabindex="0"]')!;
		fireEvent.doubleClick(rerenderedProcessRow);
		expect(await screen.findByText('Process Details')).toBeInTheDocument();
		const detailCloseButton = screen.getByTitle('Close');
		fireEvent.mouseEnter(detailCloseButton);
		fireEvent.mouseLeave(detailCloseButton);
		fireEvent.click(detailCloseButton);
		expect(onClose).toHaveBeenCalledTimes(2);
	});

	it('handles layer-stack Escape behavior and keyboard selection branches', async () => {
		const { onClose } = renderMonitor({}, [createProcess()]);

		expect(
			await screen.findByText('Agent One - AI Agent (claude-code) - Main')
		).toBeInTheDocument();
		let dialog = screen.getByRole('dialog', { name: 'System Processes' });

		fireEvent.keyDown(window, { key: 'Escape' });
		await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));

		fireEvent.doubleClick(screen.getByText('Agent One - AI Agent (claude-code) - Main'));
		expect(await screen.findByText('Process Details')).toBeInTheDocument();
		fireEvent.keyDown(window, { key: 'Escape' });
		await screen.findByText('System Processes');

		fireEvent.click(screen.getByTitle('Collapse one level'));
		dialog = screen.getByRole('dialog', { name: 'System Processes' });
		fireEvent.keyDown(dialog, { key: 'ArrowUp' });
		await waitFor(() => expect(Element.prototype.scrollIntoView).toHaveBeenCalled());
		fireEvent.keyDown(dialog, { key: 'ArrowLeft' });
		fireEvent.keyDown(dialog, { key: 'ArrowRight' });
		expect(await screen.findByText('Agent One')).toBeInTheDocument();
		fireEvent.keyDown(dialog, { key: 'ArrowRight' });
		fireEvent.keyDown(dialog, { key: 'ArrowRight' });
		expect(
			await screen.findByText('Agent One - AI Agent (claude-code) - Main')
		).toBeInTheDocument();
		fireEvent.keyDown(dialog, { key: 'ArrowRight' });
		fireEvent.keyDown(dialog, { key: 'ArrowLeft' });
		fireEvent.keyDown(dialog, { key: ' ' });
		fireEvent.keyDown(dialog, { key: 'ArrowRight' });
		fireEvent.keyDown(dialog, { key: 'ArrowRight' });
		fireEvent.keyDown(dialog, { key: 'Enter' });
		expect(await screen.findByText('Process Details')).toBeInTheDocument();
	});

	it('ignores keyboard navigation when there are no visible nodes', async () => {
		renderMonitor({}, []);

		expect(await screen.findByText('No running processes')).toBeInTheDocument();
		fireEvent.keyDown(screen.getByRole('dialog', { name: 'System Processes' }), {
			key: 'ArrowDown',
		});
		expect(screen.getByText('No running processes')).toBeInTheDocument();
	});

	it('does not open details for a process row without a valid pid', async () => {
		renderMonitor({}, [createProcess({ pid: 0 })]);

		const processRow = await screen.findByText('Agent One - AI Agent (claude-code) - Main');
		fireEvent.doubleClick(processRow);
		expect(screen.queryByText('Process Details')).not.toBeInTheDocument();
		expect(screen.getByText('PID 0')).toBeInTheDocument();
	});

	it('handles group chat node keyboard paths and kill confirmation keyboard states', async () => {
		let resolveKill: () => void = () => {};
		const killPromise = new Promise<void>((resolve) => {
			resolveKill = resolve;
		});
		const processes = [
			createProcess({
				sessionId: 'group-chat-chat-1-moderator-synthesis-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
				pid: 4301,
				command: 'moderate',
			}),
			createProcess({
				sessionId: 'group-chat-chat-1-participant-NoSuffix',
				pid: 4302,
				command: 'participant',
			}),
		];
		const { onNavigateToGroupChat, processBridge } = renderMonitor({}, processes);
		processBridge.kill.mockReturnValue(killPromise);

		expect(await screen.findByText('GROUP CHATS')).toBeInTheDocument();
		const groupChatNode = screen.getByText('Planning Chat').closest('button')!;
		expect(screen.getByText('Moderator (Synthesis)')).toBeInTheDocument();
		expect(screen.getByText('Unknown')).toBeInTheDocument();

		fireEvent.mouseEnter(groupChatNode);
		fireEvent.mouseLeave(groupChatNode);
		fireEvent.click(groupChatNode);
		expect(screen.queryByText('Moderator (Synthesis)')).not.toBeInTheDocument();
		fireEvent.click(groupChatNode);
		expect(await screen.findByText('Moderator (Synthesis)')).toBeInTheDocument();
		fireEvent.keyDown(groupChatNode, { key: ' ' });

		fireEvent.keyDown(screen.getByText('Open'), { key: 'Enter' });
		fireEvent.click(screen.getByText('Open'));
		expect(onNavigateToGroupChat).toHaveBeenCalledWith('chat-1');
		expect(await screen.findByText('Moderator (Synthesis)')).toBeInTheDocument();

		fireEvent.doubleClick(screen.getByText('Moderator (Synthesis)'));
		expect(await screen.findByText('Process Details')).toBeInTheDocument();
		expect(screen.getByText('moderator')).toBeInTheDocument();
		fireEvent.click(screen.getByTitle('Back (Esc)'));
		await screen.findByText('System Processes');

		fireEvent.click(screen.getAllByTitle('Kill process')[0]);
		const confirmButton = await screen.findByRole('button', { name: 'Kill Process' });
		fireEvent.keyDown(confirmButton, { key: 'Enter' });
		await waitFor(() =>
			expect(processBridge.kill).toHaveBeenCalledWith(
				'group-chat-chat-1-moderator-synthesis-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
			)
		);
		expect(await screen.findByText('Killing...')).toBeInTheDocument();
		await act(async () => {
			resolveKill();
		});
		await waitFor(() => expect(screen.queryByText('Kill Process?')).not.toBeInTheDocument());
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 550));
		});

		fireEvent.click(screen.getAllByTitle('Kill process')[0]);
		expect(await screen.findByText('Kill Process?')).toBeInTheDocument();
		fireEvent.click(screen.getByText('Kill Process?').parentElement!.parentElement!);
		await waitFor(() => expect(screen.queryByText('Kill Process?')).not.toBeInTheDocument());
	});

	it('handles kill confirmation cancel and kill failures', async () => {
		const loggerError = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
		const { processBridge } = renderMonitor({}, [createProcess()]);

		expect(
			await screen.findByText('Agent One - AI Agent (claude-code) - Main')
		).toBeInTheDocument();
		fireEvent.click(screen.getByTitle('Kill process'));
		expect(await screen.findByText('Kill Process?')).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
		await waitFor(() => expect(screen.queryByText('Kill Process?')).not.toBeInTheDocument());

		processBridge.kill.mockRejectedValueOnce(new Error('permission denied'));
		fireEvent.click(screen.getByTitle('Kill process'));
		expect(await screen.findByText('Kill Process?')).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'Kill Process' }));

		await waitFor(() => expect(processBridge.kill).toHaveBeenCalledWith('session-1-ai-tab-1'));
		await waitFor(() =>
			expect(loggerError).toHaveBeenCalledWith(
				'Failed to kill process:',
				undefined,
				expect.any(Error)
			)
		);
		loggerError.mockRestore();
	});

	it('handles sparse session data, non-navigable agent IDs, and detail fallbacks', async () => {
		const sparseSession = createSession({
			id: 'sparse-session',
			name: '',
			groupId: 'group-1',
			activeTabId: 'missing-tab',
			aiTabs: undefined,
			unifiedTabOrder: [],
		} as Partial<Session>);
		const linkedSession = createSession({
			id: 'linked-session',
			name: 'Linked Agent',
			groupId: 'group-1',
			activeTabId: 'linked-tab',
			aiTabs: [
				{
					id: 'linked-tab',
					name: 'Linked',
					logs: [],
					agentSessionId: 'fedcba98-7654-3210-fedc-ba9876543210',
					isStarred: false,
					state: 'idle',
					inputValue: '',
					stagedImages: [],
					createdAt: 1700000000000,
					saveToHistory: true,
				},
			],
			unifiedTabOrder: [{ type: 'ai', id: 'linked-tab' }],
		});
		const noAgentSession = createSession({
			id: 'no-agent-session',
			name: 'No Agent',
			groupId: 'group-1',
			activeTabId: 'no-agent-tab',
			aiTabs: [
				{
					id: 'no-agent-tab',
					name: 'No Agent',
					logs: [],
					agentSessionId: null,
					isStarred: false,
					state: 'idle',
					inputValue: '',
					stagedImages: [],
					createdAt: 1700000000000,
					saveToHistory: true,
				},
			],
			unifiedTabOrder: [{ type: 'ai', id: 'no-agent-tab' }],
		});
		const processes = [
			createProcess({
				sessionId: 'sparse-session-ai-missing-tab',
				pid: 5101,
				toolType: undefined as unknown as string,
				cwd: '',
				startTime: undefined,
				command: undefined,
				args: undefined,
			}),
			createProcess({
				sessionId: 'linked-session-ai-linked-tab',
				pid: 5102,
			}),
			createProcess({
				sessionId: 'no-agent-session-ai-no-agent-tab',
				pid: 5103,
			}),
		];

		renderMonitor(
			{
				sessions: [sparseSession, linkedSession, noAgentSession],
				groups: [createGroup(), createGroup({ id: 'empty-group', name: 'Empty Group' })],
				onNavigateToSession: undefined,
			},
			processes
		);

		expect(
			await screen.findByText('Linked Agent - AI Agent (claude-code) - Linked')
		).toBeInTheDocument();
		expect(screen.getByText('3 sessions • 2 groups')).toBeInTheDocument();
		expect(screen.getByText('fedcba98')).toBeInTheDocument();
		expect(screen.getByText('No Agent - AI Agent (claude-code) - No Agent')).toBeInTheDocument();

		const sparsePid = screen.getByText('PID 5101');
		const sparseRow = sparsePid.closest('[tabindex="0"]')!;
		fireEvent.doubleClick(sparseRow);

		expect(await screen.findByText('Process Details')).toBeInTheDocument();
		expect(screen.getByText('Process')).toBeInTheDocument();
		expect(screen.getByText('unknown')).toBeInTheDocument();
		expect(screen.getAllByText('N/A')).toHaveLength(2);
	});

	it('handles malformed group-chat processes and singular footer copy', async () => {
		renderMonitor(
			{
				sessions: [createSession({ groupId: 'group-1' })],
				groups: [createGroup()],
				groupChats: [createGroupChat(), createGroupChat({ id: 'chat-2', name: 'Empty Chat' })],
			},
			[
				createProcess({
					sessionId: 'group-chat-chat-1-unmatched-role-aaaaaaaa',
					pid: 5201,
				}),
			]
		);

		expect(await screen.findByText('1 active')).toBeInTheDocument();
		expect(screen.getByText('No running processes')).toBeInTheDocument();
		expect(screen.getByText('1 session • 1 group')).toBeInTheDocument();
		expect(screen.queryByText('GROUP CHATS')).not.toBeInTheDocument();
	});

	it('covers selected hover states, keyboard boundaries, and nested group-chat keys', async () => {
		const processes = [
			createProcess(),
			createProcess({
				sessionId: 'session-2-terminal',
				pid: 4201,
				cwd: '/workspace/two',
				isTerminal: true,
				toolType: 'shell',
				command: 'zsh',
				args: ['-l'],
			}),
			createProcess({
				sessionId: 'group-chat-chat-1-moderator-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
				pid: 4301,
			}),
		];

		renderMonitor({}, processes);

		expect(
			await screen.findByText('Agent One - AI Agent (claude-code) - Main')
		).toBeInTheDocument();
		const dialog = screen.getByRole('dialog', { name: 'System Processes' });

		fireEvent.keyDown(dialog, { key: 'ArrowRight' });
		fireEvent.keyDown(dialog, { key: 'ArrowLeft' });
		fireEvent.keyDown(dialog, { key: 'Enter' });

		const groupButton = screen.getByText('Core Group').closest('button')!;
		fireEvent.click(groupButton);
		fireEvent.mouseEnter(groupButton);
		fireEvent.mouseLeave(groupButton);
		fireEvent.keyDown(dialog, { key: 'ArrowUp' });
		fireEvent.click(groupButton);

		const sessionButton = await screen.findByText('Agent One');
		const sessionNode = sessionButton.closest('[role="button"]')!;
		fireEvent.click(sessionNode);
		fireEvent.mouseEnter(sessionNode);
		fireEvent.mouseLeave(sessionNode);
		fireEvent.click(sessionNode);

		const processRow = (
			await screen.findByText('Agent One - AI Agent (claude-code) - Main')
		).closest('[tabindex="0"]')!;
		fireEvent.click(processRow);
		fireEvent.keyDown(dialog, { key: 'ArrowRight' });
		fireEvent.keyDown(dialog, { key: 'ArrowLeft' });
		fireEvent.click(screen.getByTitle('Collapse one level'));
		fireEvent.keyDown(dialog, { key: 'Enter' });
		fireEvent.click(screen.getByTitle('Expand one level'));

		for (let i = 0; i < 12; i += 1) {
			fireEvent.keyDown(dialog, { key: 'ArrowDown' });
		}
		fireEvent.keyDown(dialog, { key: 'ArrowDown' });
		fireEvent.keyDown(dialog, { key: 'ArrowUp' });

		const groupChatNode = screen.getByText('Planning Chat').closest('button')!;
		fireEvent.mouseEnter(groupChatNode);
		fireEvent.mouseLeave(groupChatNode);
		fireEvent.keyDown(dialog, { key: 'ArrowLeft' });
		fireEvent.keyDown(groupChatNode, { key: 'a' });
		const openButton = await screen.findByText('Open');
		fireEvent.keyDown(openButton, { key: 'a' });
		fireEvent.keyDown(openButton, { key: ' ' });
	});

	it('renders Auto Run process details and dismisses kill confirmation with Escape', async () => {
		renderMonitor({}, [
			createProcess({
				sessionId: 'session-1-batch-1700000000000',
				pid: 5301,
				isBatchMode: true,
			}),
		]);

		expect(await screen.findByText('Agent One - AI Agent (claude-code)')).toBeInTheDocument();
		fireEvent.doubleClick(screen.getByText('Agent One - AI Agent (claude-code)'));
		expect(await screen.findByText('AUTO RUN')).toBeInTheDocument();
		fireEvent.click(screen.getByTitle('Back (Esc)'));
		await screen.findByText('System Processes');

		fireEvent.click(screen.getByTitle('Kill process'));
		const confirmDialog = await screen.findByText('Kill Process?');
		const confirmPanel = confirmDialog.parentElement!;
		act(() => invokeReactKeyDown(confirmPanel, 'a'));
		expect(screen.getByText('Kill Process?')).toBeInTheDocument();
		fireEvent.keyDown(window, { key: 'Escape' });
		await waitFor(() => expect(screen.queryByText('Kill Process?')).not.toBeInTheDocument());
	});

	it('invokes the initially registered layer Escape handler before a layer id update', async () => {
		let registeredLayer: { onEscape?: () => void } | undefined;
		const registerLayer = vi.fn((layer: { onEscape?: () => void }) => {
			registeredLayer = layer;
			return undefined as unknown as string;
		});
		const unregisterLayer = vi.fn();
		const updateLayerHandler = vi.fn();

		vi.resetModules();
		vi.doMock('../../renderer/contexts/LayerStackContext', () => ({
			useLayerStack: () => ({
				registerLayer,
				unregisterLayer,
				updateLayerHandler,
			}),
		}));

		let rendered: ReturnType<typeof render> | undefined;

		try {
			const { ProcessMonitor: IsolatedProcessMonitor } =
				await import('../../renderer/components/ProcessMonitor');
			const processBridge = window.maestro.process as unknown as ProcessBridge;
			processBridge.getActiveProcesses = vi.fn().mockResolvedValue([]);
			processBridge.kill = vi.fn().mockResolvedValue(undefined);
			const onClose = vi.fn();

			rendered = render(
				<IsolatedProcessMonitor
					theme={createTheme()}
					sessions={[]}
					groups={[]}
					groupChats={[]}
					onClose={onClose}
				/>
			);

			expect(await screen.findByText('No running processes')).toBeInTheDocument();
			expect(updateLayerHandler).not.toHaveBeenCalled();

			act(() => registeredLayer?.onEscape?.());
			expect(onClose).toHaveBeenCalledOnce();
		} finally {
			rendered?.unmount();
			vi.doUnmock('../../renderer/contexts/LayerStackContext');
			vi.resetModules();
		}
	});
});
