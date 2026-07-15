import type { Session, Group, GroupChat } from '../../types';
import type { ActiveProcess, ProcessNode, ProcessTypeTag } from './types';

// Parse the base session ID from a process session ID
// Process session IDs are formatted as:
// - {baseSessionId}-ai (legacy)
// - {baseSessionId}-ai-{tabId} (tab-based AI)
// - {baseSessionId}-terminal
// - {baseSessionId}-batch-{timestamp}
// - {baseSessionId}-synopsis-{timestamp}
export function parseBaseSessionId(processSessionId: string): string {
	const batchMatch = processSessionId.match(/^(.+)-batch-\d+$/);
	if (batchMatch) return batchMatch[1];
	const synopsisMatch = processSessionId.match(/^(.+)-synopsis-\d+$/);
	if (synopsisMatch) return synopsisMatch[1];
	const aiTabMatch = processSessionId.match(/^(.+)-ai-.+$/);
	if (aiTabMatch) return aiTabMatch[1];
	const terminalTabMatch = processSessionId.match(/^(.+)-terminal-.+$/);
	if (terminalTabMatch) return terminalTabMatch[1];
	const suffixes = ['-ai', '-terminal'];
	for (const suffix of suffixes) {
		if (processSessionId.endsWith(suffix)) {
			return processSessionId.slice(0, -suffix.length);
		}
	}
	return processSessionId;
}

// Determine process type from session ID
export function getProcessType(
	processSessionId: string
): 'ai' | 'terminal' | 'batch' | 'synopsis' | 'wizard' | 'wizard-gen' | 'cue' {
	if (processSessionId.startsWith('cue-run-')) return 'cue';
	if (processSessionId.endsWith('-terminal') || processSessionId.match(/-terminal-.+$/))
		return 'terminal';
	if (processSessionId.match(/-batch-\d+$/)) return 'batch';
	if (processSessionId.match(/-synopsis-\d+$/)) return 'synopsis';
	if (processSessionId.startsWith('inline-wizard-gen-')) return 'wizard-gen';
	if (processSessionId.startsWith('inline-wizard-')) return 'wizard';
	return 'ai';
}

// Extract tab ID from process session ID
// Format: {sessionId}-ai-{tabId}[-fp-{timestamp}] or {sessionId}-terminal-{tabId}
export function parseTabId(processSessionId: string): string | null {
	const aiMatch = processSessionId.match(/-ai-(.+?)(?:-fp-\d+)?$/);
	if (aiMatch) return aiMatch[1];
	const terminalMatch = processSessionId.match(/-terminal-(.+)$/);
	if (terminalMatch) return terminalMatch[1];
	return null;
}

// Group expandable node IDs by depth tier (only nodes that have children).
// Used by stepwise expand/collapse so each click changes the visible depth by exactly one level.
export function getExpandableIdsByDepth(nodes: ProcessNode[]): string[][] {
	const byDepth: string[][] = [];
	const traverse = (nodeList: ProcessNode[], depth: number) => {
		nodeList.forEach((node) => {
			if (node.children && node.children.length > 0) {
				if (!byDepth[depth]) byDepth[depth] = [];
				byDepth[depth].push(node.id);
				traverse(node.children, depth + 1);
			}
		});
	};
	traverse(nodes, 0);
	return byDepth;
}

// Flat list of currently visible nodes (depth-first, respecting expansion) for keyboard nav.
export function getVisibleNodes(
	nodes: ProcessNode[],
	expandedIds: ReadonlySet<string>
): ProcessNode[] {
	const result: ProcessNode[] = [];
	const traverse = (nodeList: ProcessNode[]) => {
		nodeList.forEach((node) => {
			result.push(node);
			if (node.children && node.children.length > 0 && expandedIds.has(node.id)) {
				traverse(node.children);
			}
		});
	};
	traverse(nodes);
	return result;
}

export interface BuildProcessTreeInput {
	sessions: Session[];
	groups: Group[];
	groupChats: GroupChat[];
	activeProcesses: ActiveProcess[];
}

// Build the process tree using real active processes.
// Pure function - does not read any closure state.
//
// Note: node.expanded was previously stamped from the live expansion Set, but the
// renderer reads `expandedIds.has(node.id)` directly, so the field was never
// consulted. Dropping it lets the tree memo skip expansion as a dependency.
export function buildProcessTree(input: BuildProcessTreeInput): ProcessNode[] {
	const { sessions, groups, groupChats, activeProcesses } = input;
	const tree: ProcessNode[] = [];

	const sessionsByGroup = new Map<string, Session[]>();
	const ungroupedSessions: Session[] = [];

	sessions.forEach((session) => {
		if (session.groupId) {
			const existing = sessionsByGroup.get(session.groupId) || [];
			sessionsByGroup.set(session.groupId, [...existing, session]);
		} else {
			ungroupedSessions.push(session);
		}
	});

	const processesMap = new Map<string, ActiveProcess[]>();
	activeProcesses.forEach((proc) => {
		const baseId = parseBaseSessionId(proc.sessionId);
		const existing = processesMap.get(baseId) || [];
		processesMap.set(baseId, [...existing, proc]);
	});

	const buildSessionNode = (session: Session): ProcessNode => {
		const sshRemote = session.sshRemote
			? { name: session.sshRemote.name, host: session.sshRemote.host }
			: undefined;

		const sessionNode: ProcessNode = {
			id: `session-${session.id}`,
			type: 'session',
			label: session.name,
			sessionId: session.id,
			children: [],
			sshRemote,
		};

		const sessionProcesses = processesMap.get(session.id) || [];

		sessionProcesses.forEach((proc) => {
			const processType = getProcessType(proc.sessionId);
			let label: string;
			let isAutoRun = false;
			if (processType === 'terminal') {
				if (proc.childProcesses && proc.childProcesses.length > 0) {
					const lastChild = proc.childProcesses[proc.childProcesses.length - 1];
					const cmdBasename = lastChild.command.split('/').pop() || lastChild.command;
					label = `Terminal: ${cmdBasename}`;
				} else {
					label = 'Terminal Shell';
				}
			} else if (processType === 'batch') {
				label = `AI Agent (${proc.toolType})`;
				isAutoRun = true;
			} else if (processType === 'synopsis') {
				label = `AI Agent (${proc.toolType}) - Synopsis`;
			} else {
				label = `AI Agent (${proc.toolType})`;
			}

			const sessionName = session.name;

			let agentSessionId: string | undefined;
			let tabId: string | undefined;
			let tabName: string | undefined;
			if (processType === 'terminal') {
				tabId = parseTabId(proc.sessionId) || undefined;
			} else if (processType === 'ai' || processType === 'batch' || processType === 'synopsis') {
				tabId = parseTabId(proc.sessionId) || undefined;
				if (session.aiTabs) {
					if (tabId) {
						const tab = session.aiTabs.find((t) => t.id === tabId);
						if (tab?.agentSessionId) {
							agentSessionId = tab.agentSessionId;
						}
						if (tab?.name) {
							tabName = tab.name;
						}
					}
					if (!agentSessionId) {
						const activeTab = session.aiTabs.find((t) => t.id === session.activeTabId);
						if (activeTab?.agentSessionId) {
							agentSessionId = activeTab.agentSessionId;
							tabId = activeTab.id;
						}
					}
				}
			}

			const displayLabel = tabName
				? `${sessionName} - ${label} - ${tabName}`
				: `${sessionName} - ${label}`;

			const childNodes: ProcessNode[] = [];
			if (processType === 'terminal' && proc.childProcesses && proc.childProcesses.length > 0) {
				proc.childProcesses.forEach((child) => {
					const cmdBasename = child.command.split('/').pop() || child.command;
					childNodes.push({
						id: `child-${proc.sessionId}-${child.pid}`,
						type: 'process',
						label: cmdBasename,
						pid: child.pid,
						processType: 'terminal',
						sessionId: session.id,
						isAlive: true,
						command: child.command,
						sshRemote,
					});
				});
			}

			const processNode: ProcessNode = {
				id: `process-${proc.sessionId}`,
				type: 'process',
				label: displayLabel,
				pid: proc.pid,
				processType,
				sessionId: session.id,
				processSessionId: proc.sessionId,
				isAlive: true,
				toolType: proc.toolType,
				cwd: proc.cwd,
				agentSessionId,
				tabId,
				startTime: proc.startTime,
				isAutoRun,
				command: proc.command,
				args: proc.args,
				sshRemote,
				tabName,
				childProcesses: proc.childProcesses,
				maestroEnvVars: proc.maestroEnvVars,
				sshRemoteCommand: proc.sshRemoteCommand,
				children: childNodes.length > 0 ? childNodes : undefined,
			};

			sessionNode.children!.push(processNode);
		});

		return sessionNode;
	};

	// Grouped sessions
	groups.forEach((group) => {
		const groupSessions = sessionsByGroup.get(group.id) || [];
		const sessionNodes = groupSessions
			.map((session) => buildSessionNode(session))
			.filter((node) => node.children && node.children.length > 0);

		if (sessionNodes.length > 0) {
			const groupNode: ProcessNode = {
				id: `group-${group.id}`,
				type: 'group',
				label: group.name,
				emoji: group.emoji,
				children: sessionNodes,
			};
			tree.push(groupNode);
		}
	});

	// Ungrouped sessions
	if (ungroupedSessions.length > 0) {
		const sessionNodes = ungroupedSessions
			.map((session) => buildSessionNode(session))
			.filter((node) => node.children && node.children.length > 0);

		if (sessionNodes.length > 0) {
			const rootNode: ProcessNode = {
				id: 'group-root',
				type: 'group',
				label: 'UNGROUPED AGENTS',
				emoji: '📁',
				children: sessionNodes,
			};
			tree.push(rootNode);
		}
	}

	// Group chat processes
	// Patterns:
	//   group-chat-{groupChatId}-moderator-{uuid}
	//   group-chat-{groupChatId}-moderator-synthesis-{uuid}
	//   group-chat-{groupChatId}-participant-{name}-{uuid|timestamp}
	const groupChatProcesses = activeProcesses.filter((proc) =>
		proc.sessionId.startsWith('group-chat-')
	);

	if (groupChatProcesses.length > 0 && groupChats.length > 0) {
		const processesByGroupChat = new Map<string, ActiveProcess[]>();

		groupChatProcesses.forEach((proc) => {
			const moderatorMatch = proc.sessionId.match(/^group-chat-(.+?)-(moderator|participant)-/);
			if (moderatorMatch) {
				const groupChatId = moderatorMatch[1];
				const existing = processesByGroupChat.get(groupChatId) || [];
				processesByGroupChat.set(groupChatId, [...existing, proc]);
			}
		});

		const groupChatNodes: ProcessNode[] = [];

		groupChats.forEach((groupChat) => {
			const chatProcesses = processesByGroupChat.get(groupChat.id) || [];

			if (chatProcesses.length > 0) {
				const processNodes: ProcessNode[] = chatProcesses.map((proc) => {
					const isModerator = proc.sessionId.includes('-moderator-');
					const isSynthesis = proc.sessionId.includes('-moderator-synthesis-');

					let label: string;
					let processType: 'moderator' | 'participant';
					let participantName: string | undefined;

					if (isModerator) {
						processType = 'moderator';
						label = isSynthesis ? 'Moderator (Synthesis)' : 'Moderator';
					} else {
						processType = 'participant';
						const participantMatch =
							proc.sessionId.match(/^group-chat-.+-participant-(.+?)-[a-f0-9-]+$/i) ||
							proc.sessionId.match(/^group-chat-.+-participant-(.+?)-\d{13,}$/);
						participantName = participantMatch ? participantMatch[1] : 'Unknown';
						label = participantName;
					}

					return {
						id: `process-${proc.sessionId}`,
						type: 'process' as const,
						label,
						pid: proc.pid,
						processType,
						processSessionId: proc.sessionId,
						isAlive: true,
						toolType: proc.toolType,
						cwd: proc.cwd,
						startTime: proc.startTime,
						groupChatId: groupChat.id,
						participantName,
						command: proc.command,
						args: proc.args,
						maestroEnvVars: proc.maestroEnvVars,
						sshRemoteCommand: proc.sshRemoteCommand,
					};
				});

				groupChatNodes.push({
					id: `groupchat-${groupChat.id}`,
					type: 'groupchat',
					label: groupChat.name,
					emoji: '💬',
					children: processNodes,
					groupChatId: groupChat.id,
				});
			}
		});

		if (groupChatNodes.length > 0) {
			const groupChatsNode: ProcessNode = {
				id: 'group-chats-section',
				type: 'group',
				label: 'GROUP CHATS',
				emoji: '💬',
				children: groupChatNodes,
			};
			tree.push(groupChatsNode);
		}
	}

	// Wizard processes
	// Patterns:
	//   inline-wizard-{timestamp}-{random} (conversation phase)
	//   inline-wizard-gen-{timestamp}-{random} (document generation phase)
	const wizardProcesses = activeProcesses.filter((proc) =>
		proc.sessionId.startsWith('inline-wizard-')
	);

	if (wizardProcesses.length > 0) {
		const wizardNodes: ProcessNode[] = wizardProcesses.map((proc) => {
			const processType = getProcessType(proc.sessionId);
			const isGeneration = processType === 'wizard-gen';
			const label = isGeneration ? 'Playbook Generation' : 'Wizard Conversation';

			return {
				id: `process-${proc.sessionId}`,
				type: 'process' as const,
				label,
				pid: proc.pid,
				processType: processType as ProcessTypeTag,
				processSessionId: proc.sessionId,
				isAlive: true,
				toolType: proc.toolType,
				cwd: proc.cwd,
				startTime: proc.startTime,
				command: proc.command,
				args: proc.args,
				maestroEnvVars: proc.maestroEnvVars,
				sshRemoteCommand: proc.sshRemoteCommand,
			};
		});

		const wizardSectionNode: ProcessNode = {
			id: 'wizard-section',
			type: 'group',
			label: 'WIZARD PROCESSES',
			emoji: '🧙',
			children: wizardNodes,
		};
		tree.push(wizardSectionNode);
	}

	// Cue Run processes
	const cueProcesses = activeProcesses.filter((proc) => proc.isCueRun);

	if (cueProcesses.length > 0) {
		const cueNodes: ProcessNode[] = cueProcesses.map((proc) => ({
			id: `process-${proc.sessionId}`,
			type: 'process' as const,
			label: `${proc.cueSubscriptionName ?? 'Cue Run'} → ${proc.cueSessionName ?? 'Unknown'}`,
			pid: proc.pid,
			processType: 'cue' as const,
			processSessionId: proc.sessionId,
			isAlive: true,
			toolType: proc.toolType,
			cwd: proc.cwd,
			startTime: proc.startTime,
			command: proc.command,
			args: proc.args,
			cueRunId: proc.cueRunId,
			cueSubscriptionName: proc.cueSubscriptionName,
			cueEventType: proc.cueEventType,
			cueSessionName: proc.cueSessionName,
			maestroEnvVars: proc.maestroEnvVars,
			sshRemoteCommand: proc.sshRemoteCommand,
		}));

		const cueSectionNode: ProcessNode = {
			id: 'cue-section',
			type: 'group',
			label: 'CUE RUNS',
			emoji: '⚡',
			children: cueNodes,
			countLabel: 'run',
		};
		tree.push(cueSectionNode);
	}

	return tree;
}

// Find the parent of a node by id (DFS). Returns null if not found.
export function findParentNode(
	nodes: ProcessNode[],
	targetId: string,
	parent: ProcessNode | null = null
): ProcessNode | null {
	for (const node of nodes) {
		if (node.id === targetId) return parent;
		if (node.children) {
			const found = findParentNode(node.children, targetId, node);
			if (found !== null) return found;
		}
	}
	return null;
}
