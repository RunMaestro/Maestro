import { describe, expect, it } from 'vitest';
import {
	buildProcessTree,
	findParentNode,
	getExpandableIdsByDepth,
	getProcessType,
	getVisibleNodes,
	parseBaseSessionId,
	parseTabId,
} from '../../../../renderer/components/ProcessMonitor/processTree';
import type {
	ActiveProcess,
	ProcessNode,
} from '../../../../renderer/components/ProcessMonitor/types';
import type { Group, GroupChat, Session } from '../../../../renderer/types';

const session = (overrides: Partial<Session> = {}): Session =>
	({
		id: 'session-1',
		name: 'Session One',
		toolType: 'claude-code',
		state: 'idle',
		inputMode: 'ai',
		cwd: '/project',
		projectRoot: '/project',
		aiPid: 0,
		terminalPid: 0,
		aiLogs: [],
		shellLogs: [],
		isGitRepo: false,
		fileTree: [],
		fileExplorerExpanded: [],
		aiTabs: [],
		activeTabId: undefined,
		...overrides,
	}) as Session;

const group = (overrides: Partial<Group> = {}): Group =>
	({
		id: 'group-1',
		name: 'My Group',
		emoji: '📦',
		isExpanded: true,
		...overrides,
	}) as Group;

const proc = (overrides: Partial<ActiveProcess>): ActiveProcess => ({
	sessionId: 'session-1-ai-tab-a',
	toolType: 'claude-code',
	pid: 100,
	cwd: '/project',
	isTerminal: false,
	isBatchMode: false,
	startTime: 1_700_000_000_000,
	...overrides,
});

describe('parseBaseSessionId', () => {
	it('strips the -ai-{tabId} tab suffix', () => {
		expect(parseBaseSessionId('abc-ai-tab-1')).toBe('abc');
	});

	it('strips the -terminal-{tabId} tab suffix', () => {
		expect(parseBaseSessionId('abc-terminal-shell-2')).toBe('abc');
	});

	it('strips the -batch-{timestamp} suffix', () => {
		expect(parseBaseSessionId('abc-batch-1700000000000')).toBe('abc');
	});

	it('strips the -synopsis-{timestamp} suffix', () => {
		expect(parseBaseSessionId('abc-synopsis-1700000000000')).toBe('abc');
	});

	it('strips a bare -ai suffix', () => {
		expect(parseBaseSessionId('abc-ai')).toBe('abc');
	});

	it('strips a bare -terminal suffix', () => {
		expect(parseBaseSessionId('abc-terminal')).toBe('abc');
	});

	it('returns input unchanged when no known suffix matches', () => {
		expect(parseBaseSessionId('cue-run-some-uuid')).toBe('cue-run-some-uuid');
	});
});

describe('getProcessType', () => {
	it('detects cue runs by prefix', () => {
		expect(getProcessType('cue-run-x')).toBe('cue');
	});
	it('detects bare terminal', () => {
		expect(getProcessType('abc-terminal')).toBe('terminal');
	});
	it('detects tab-based terminal', () => {
		expect(getProcessType('abc-terminal-tab-1')).toBe('terminal');
	});
	it('detects batch processes by timestamp suffix', () => {
		expect(getProcessType('abc-batch-1700000000000')).toBe('batch');
	});
	it('detects synopsis processes by timestamp suffix', () => {
		expect(getProcessType('abc-synopsis-1700000000000')).toBe('synopsis');
	});
	it('detects wizard generation processes', () => {
		expect(getProcessType('inline-wizard-gen-1700000000000-abc')).toBe('wizard-gen');
	});
	it('detects wizard conversation processes', () => {
		expect(getProcessType('inline-wizard-1700000000000-abc')).toBe('wizard');
	});
	it('falls through to ai', () => {
		expect(getProcessType('abc-ai-tab-1')).toBe('ai');
	});
});

describe('parseTabId', () => {
	it('extracts the tab id from an ai process session', () => {
		expect(parseTabId('abc-ai-tab-1')).toBe('tab-1');
	});

	it('extracts the tab id from a terminal process session', () => {
		expect(parseTabId('abc-terminal-shell-1')).toBe('shell-1');
	});

	it('strips the -fp-{timestamp} variant on ai sessions', () => {
		expect(parseTabId('abc-ai-tab-7-fp-1700000000000')).toBe('tab-7');
	});

	it('returns null for unmatched session ids', () => {
		expect(parseTabId('cue-run-x')).toBeNull();
	});
});

describe('getExpandableIdsByDepth', () => {
	it('groups expandable nodes by depth tier', () => {
		const tree: ProcessNode[] = [
			{
				id: 'root',
				type: 'group',
				label: 'root',
				children: [
					{
						id: 'mid',
						type: 'session',
						label: 'mid',
						children: [{ id: 'leaf', type: 'process', label: 'leaf' }],
					},
				],
			},
		];
		expect(getExpandableIdsByDepth(tree)).toEqual([['root'], ['mid']]);
	});

	it('returns an empty array for an empty tree', () => {
		expect(getExpandableIdsByDepth([])).toEqual([]);
	});

	it('handles deep (4-level) trees by emitting one tier per non-leaf depth', () => {
		const tree: ProcessNode[] = [
			{
				id: 'a',
				type: 'group',
				label: 'a',
				children: [
					{
						id: 'b',
						type: 'group',
						label: 'b',
						children: [
							{
								id: 'c',
								type: 'group',
								label: 'c',
								children: [{ id: 'd', type: 'process', label: 'd' }],
							},
						],
					},
				],
			},
		];
		expect(getExpandableIdsByDepth(tree)).toEqual([['a'], ['b'], ['c']]);
	});
});

describe('getVisibleNodes', () => {
	it('returns only the root nodes when nothing is expanded', () => {
		const tree: ProcessNode[] = [
			{
				id: 'a',
				type: 'group',
				label: 'a',
				children: [{ id: 'b', type: 'process', label: 'b' }],
			},
		];
		expect(getVisibleNodes(tree, new Set()).map((n) => n.id)).toEqual(['a']);
	});

	it('descends into expanded subtrees', () => {
		const tree: ProcessNode[] = [
			{
				id: 'a',
				type: 'group',
				label: 'a',
				children: [{ id: 'b', type: 'process', label: 'b' }],
			},
		];
		expect(getVisibleNodes(tree, new Set(['a'])).map((n) => n.id)).toEqual(['a', 'b']);
	});
});

describe('findParentNode', () => {
	const tree: ProcessNode[] = [
		{
			id: 'a',
			type: 'group',
			label: 'a',
			children: [
				{
					id: 'b',
					type: 'session',
					label: 'b',
					children: [{ id: 'c', type: 'process', label: 'c' }],
				},
			],
		},
	];

	it('returns null for the root', () => {
		expect(findParentNode(tree, 'a')).toBeNull();
	});

	it('returns the immediate parent', () => {
		expect(findParentNode(tree, 'c')?.id).toBe('b');
		expect(findParentNode(tree, 'b')?.id).toBe('a');
	});

	it('returns null for an unknown id', () => {
		expect(findParentNode(tree, 'missing')).toBeNull();
	});
});

describe('buildProcessTree', () => {
	it('returns an empty tree when no processes are running', () => {
		expect(
			buildProcessTree({
				sessions: [session()],
				groups: [],
				groupChats: [],
				activeProcesses: [],
			})
		).toEqual([]);
	});

	it('creates an UNGROUPED AGENTS root for sessions without a group', () => {
		const tree = buildProcessTree({
			sessions: [session()],
			groups: [],
			groupChats: [],
			activeProcesses: [proc({ sessionId: 'session-1-ai-tab-a' })],
		});
		expect(tree).toHaveLength(1);
		expect(tree[0]).toMatchObject({ id: 'group-root', label: 'UNGROUPED AGENTS' });
		expect(tree[0].children).toHaveLength(1);
	});

	it('groups sessions by their groupId', () => {
		const tree = buildProcessTree({
			sessions: [session({ groupId: 'group-1' })],
			groups: [group()],
			groupChats: [],
			activeProcesses: [proc({ sessionId: 'session-1-ai-tab-a' })],
		});
		expect(tree).toHaveLength(1);
		expect(tree[0]).toMatchObject({ id: 'group-group-1', label: 'My Group' });
	});

	it('omits sessions that have no active processes', () => {
		const tree = buildProcessTree({
			sessions: [session(), session({ id: 'session-2', name: 'Quiet' })],
			groups: [],
			groupChats: [],
			activeProcesses: [proc({ sessionId: 'session-1-ai-tab-a' })],
		});
		const ungrouped = tree.find((n) => n.id === 'group-root');
		expect(ungrouped?.children?.map((c) => c.sessionId)).toEqual(['session-1']);
	});

	it('marks batch processes with isAutoRun and labels them as AI Agent', () => {
		const tree = buildProcessTree({
			sessions: [session()],
			groups: [],
			groupChats: [],
			activeProcesses: [proc({ sessionId: 'session-1-batch-1700000000000' })],
		});
		const processNode = tree[0].children![0].children![0];
		expect(processNode.processType).toBe('batch');
		expect(processNode.isAutoRun).toBe(true);
		expect(processNode.label).toContain('AI Agent (claude-code)');
	});

	it('shows terminal child commands and emits child nodes', () => {
		const tree = buildProcessTree({
			sessions: [session()],
			groups: [],
			groupChats: [],
			activeProcesses: [
				proc({
					sessionId: 'session-1-terminal-shell-a',
					childProcesses: [{ pid: 200, command: '/usr/bin/git' }],
				}),
			],
		});
		const processNode = tree[0].children![0].children![0];
		expect(processNode.label).toBe('Session One - Terminal: git');
		expect(processNode.children).toHaveLength(1);
		expect(processNode.children![0].label).toBe('git');
	});

	it('looks up agentSessionId + tabName from the matching ai tab', () => {
		const tree = buildProcessTree({
			sessions: [
				session({
					aiTabs: [
						{
							id: 'tab-a',
							name: 'My Tab',
							logs: [],
							agentSessionId: 'agent-uuid-1234',
							isStarred: false,
							state: 'idle',
						},
					],
					activeTabId: 'tab-a',
				}),
			],
			groups: [],
			groupChats: [],
			activeProcesses: [proc({ sessionId: 'session-1-ai-tab-a' })],
		});
		const processNode = tree[0].children![0].children![0];
		expect(processNode.agentSessionId).toBe('agent-uuid-1234');
		expect(processNode.tabName).toBe('My Tab');
		expect(processNode.label).toContain('My Tab');
	});

	it('propagates SSH metadata onto session and process nodes', () => {
		const tree = buildProcessTree({
			sessions: [
				session({
					sshRemote: { id: 'ssh-1', name: 'prod', host: 'prod.example.com' } as never,
				} as Partial<Session>),
			],
			groups: [],
			groupChats: [],
			activeProcesses: [proc({ sessionId: 'session-1-ai-tab-a' })],
		});
		const sessionNode = tree[0].children![0];
		expect(sessionNode.sshRemote).toEqual({ name: 'prod', host: 'prod.example.com' });
		expect(sessionNode.children![0].sshRemote).toEqual({
			name: 'prod',
			host: 'prod.example.com',
		});
	});

	it('emits a GROUP CHATS section with moderator + participant nodes', () => {
		const groupChat: GroupChat = { id: 'gc-1', name: 'Standup' } as GroupChat;
		const tree = buildProcessTree({
			sessions: [],
			groups: [],
			groupChats: [groupChat],
			activeProcesses: [
				proc({ sessionId: 'group-chat-gc-1-moderator-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }),
				proc({
					sessionId: 'group-chat-gc-1-participant-Bob-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
					pid: 101,
				}),
			],
		});
		expect(tree[0]).toMatchObject({ id: 'group-chats-section', label: 'GROUP CHATS' });
		const chatNode = tree[0].children![0];
		expect(chatNode).toMatchObject({ id: 'groupchat-gc-1', label: 'Standup' });
		const labels = chatNode.children!.map((p) => p.label);
		expect(labels).toContain('Moderator');
		expect(labels).toContain('Bob');
	});

	it('emits a WIZARD PROCESSES section for wizard sessions', () => {
		const tree = buildProcessTree({
			sessions: [],
			groups: [],
			groupChats: [],
			activeProcesses: [
				proc({ sessionId: 'inline-wizard-1700000000000-abc' }),
				proc({ sessionId: 'inline-wizard-gen-1700000000000-def', pid: 102 }),
			],
		});
		expect(tree[0]).toMatchObject({ id: 'wizard-section', label: 'WIZARD PROCESSES' });
		const labels = tree[0].children!.map((c) => c.label);
		expect(labels).toContain('Wizard Conversation');
		expect(labels).toContain('Playbook Generation');
	});

	it('emits a CUE RUNS section with countLabel "run"', () => {
		const tree = buildProcessTree({
			sessions: [],
			groups: [],
			groupChats: [],
			activeProcesses: [
				proc({
					sessionId: 'cue-run-uuid-1',
					isCueRun: true,
					cueRunId: 'uuid-1',
					cueSubscriptionName: 'heartbeat',
					cueSessionName: 'Sentry',
					cueEventType: 'time.heartbeat',
				}),
			],
		});
		expect(tree[0]).toMatchObject({ id: 'cue-section', label: 'CUE RUNS', countLabel: 'run' });
		expect(tree[0].children![0].cueRunId).toBe('uuid-1');
	});

	it('does not stamp node.expanded - that field is intentionally unused', () => {
		const tree = buildProcessTree({
			sessions: [session()],
			groups: [],
			groupChats: [],
			activeProcesses: [proc({ sessionId: 'session-1-ai-tab-a' })],
		});
		expect(tree[0].expanded).toBeUndefined();
		expect(tree[0].children![0].expanded).toBeUndefined();
	});
});
