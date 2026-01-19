import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
	ChevronRight,
	ChevronDown,
	ChevronUp,
	ChevronLeft,
	X,
	Activity,
	RefreshCw,
	XCircle,
	Clock,
	Terminal,
	Cpu,
	FolderOpen,
	Hash,
	Play,
} from 'lucide-react';
import type { Session, Group, Theme, GroupChat } from '../types';
import { useLayerStack } from '../contexts/LayerStackContext';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';

interface ProcessMonitorProps {
	theme: Theme;
	sessions: Session[];
	groups: Group[];
	groupChats?: GroupChat[];
	onClose: () => void;
	onNavigateToSession?: (sessionId: string, tabId?: string) => void;
	onNavigateToGroupChat?: (groupChatId: string) => void;
}

interface ActiveProcess {
	sessionId: string;
	toolType: string;
	pid: number;
	cwd: string;
	isTerminal: boolean;
	isBatchMode: boolean;
	startTime?: number;
	command?: string;
	args?: string[];
}

interface ProcessNode {
	id: string;
	type: 'group' | 'session' | 'process' | 'groupchat';
	label: string;
	emoji?: string;
	sessionId?: string;
	processSessionId?: string; // The full process session ID for killing processes (e.g., "abc123-ai-tab1")
	pid?: number;
	processType?:
		| 'ai'
		| 'terminal'
		| 'batch'
		| 'synopsis'
		| 'moderator'
		| 'participant'
		| 'wizard'
		| 'wizard-gen';
	isAlive?: boolean;
	expanded?: boolean;
	children?: ProcessNode[];
	toolType?: string;
	cwd?: string;
	agentSessionId?: string; // UUID octet from the Claude session (for AI processes)
	tabId?: string; // Tab ID for navigation to specific AI tab
	startTime?: number; // Process start timestamp for runtime calculation
	isAutoRun?: boolean; // True for batch processes from Auto Run
	groupChatId?: string; // For group chat processes - links to the group chat
	participantName?: string; // For group chat participant processes
	command?: string; // The command used to spawn this process
	args?: string[]; // The arguments passed to the command
}

// Format runtime in human readable format (e.g., "2m 30s", "1h 5m", "3d 2h")
function formatRuntime(startTime: number): string {
	const elapsed = Date.now() - startTime;
	const seconds = Math.floor(elapsed / 1000);
	const minutes = Math.floor(seconds / 60);
	const hours = Math.floor(minutes / 60);
	const days = Math.floor(hours / 24);

	if (days > 0) {
		const remainingHours = hours % 24;
		return `${days}d ${remainingHours}h`;
	}
	if (hours > 0) {
		const remainingMinutes = minutes % 60;
		return `${hours}h ${remainingMinutes}m`;
	}
	if (minutes > 0) {
		const remainingSeconds = seconds % 60;
		return `${minutes}m ${remainingSeconds}s`;
	}
	return `${seconds}s`;
}

// Interface for the detailed process view
interface ProcessDetailData {
	processSessionId: string;
	pid: number;
	toolType: string;
	cwd: string;
	startTime: number;
	command?: string;
	args?: string[];
	agentSessionId?: string;
	sessionName?: string;
	processType?: string;
	isAutoRun?: boolean;
}

export function ProcessMonitor(props: ProcessMonitorProps) {
	const {
		theme,
		sessions,
		groups,
		groupChats = [],
		onClose,
		onNavigateToSession,
		onNavigateToGroupChat,
	} = props;
	const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set());
	const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
	const [activeProcesses, setActiveProcesses] = useState<ActiveProcess[]>([]);
	const [isLoading, setIsLoading] = useState(true);
	const [isRefreshing, setIsRefreshing] = useState(false);
	const [hasExpandedInitially, setHasExpandedInitially] = useState(false);
	const [killConfirmProcessId, setKillConfirmProcessId] = useState<string | null>(null);
	const [isKilling, setIsKilling] = useState(false);
	const [detailView, setDetailView] = useState<ProcessDetailData | null>(null);
	const containerRef = useRef<HTMLDivElement>(null);
	const selectedNodeRef = useRef<HTMLButtonElement | HTMLDivElement>(null);
	const killConfirmRef = useRef<HTMLDivElement>(null);
	const detailViewRef = useRef<HTMLDivElement>(null);
	const { registerLayer, unregisterLayer, updateLayerHandler } = useLayerStack();
	const layerIdRef = useRef<string>();

	// Fetch active processes from ProcessManager
	const fetchActiveProcesses = useCallback(async (showRefresh = false) => {
		if (showRefresh) {
			setIsRefreshing(true);
		}
		try {
			const processes = await window.maestro.process.getActiveProcesses();
			setActiveProcesses(processes);
		} catch (error) {
			console.error('Failed to fetch active processes:', error);
		} finally {
			setIsLoading(false);
			// Keep refresh spinner visible for at least 500ms for visual feedback
			if (showRefresh) {
				setTimeout(() => setIsRefreshing(false), 500);
			}
		}
	}, []);

	// Kill a process by its session ID
	const killProcess = useCallback(
		async (processSessionId: string) => {
			setIsKilling(true);
			try {
				await window.maestro.process.kill(processSessionId);
				// Refresh the process list after killing
				await fetchActiveProcesses(true);
			} catch (error) {
				console.error('Failed to kill process:', error);
			} finally {
				setIsKilling(false);
				setKillConfirmProcessId(null);
			}
		},
		[fetchActiveProcesses]
	);

	// Focus kill confirmation dialog when it opens
	useEffect(() => {
		if (killConfirmProcessId && killConfirmRef.current) {
			killConfirmRef.current.focus();
		}
	}, [killConfirmProcessId]);

	// Register layer on mount
	useEffect(() => {
		const layerId = registerLayer({
			type: 'modal',
			priority: MODAL_PRIORITIES.PROCESS_MONITOR,
			blocksLowerLayers: true,
			capturesFocus: true,
			focusTrap: 'strict',
			ariaLabel: 'System Processes',
			onEscape: () => {},
		});
		layerIdRef.current = layerId;
		return () => unregisterLayer(layerId);
	}, [registerLayer, unregisterLayer]);

	// Update handler when onClose or detailView changes
	// If in detail view, Escape goes back to list; otherwise closes the modal
	useEffect(() => {
		if (layerIdRef.current) {
			const handleEscape = () => {
				if (detailView) {
					setDetailView(null);
				} else {
					onClose();
				}
			};
			updateLayerHandler(layerIdRef.current, handleEscape);
		}
	}, [onClose, detailView, updateLayerHandler]);

	// Fetch processes on mount and poll for updates
	useEffect(() => {
		fetchActiveProcesses();

		// Poll every 2 seconds to keep process list updated
		const interval = setInterval(fetchActiveProcesses, 2000);
		return () => clearInterval(interval);
	}, [fetchActiveProcesses]);

	useEffect(() => {
		containerRef.current?.focus();
	}, []);

	// Focus detail view when it opens, restore focus to container when it closes
	useEffect(() => {
		if (detailView && detailViewRef.current) {
			detailViewRef.current.focus();
		} else if (!detailView && containerRef.current) {
			// Restore focus to the container when returning from detail view
			containerRef.current.focus();
		}
	}, [detailView]);

	// Scroll selected node into view
	useEffect(() => {
		selectedNodeRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
	}, [selectedNodeId]);

	const toggleNode = (nodeId: string) => {
		setExpandedNodes((prev) => {
			const next = new Set(prev);
			if (next.has(nodeId)) {
				next.delete(nodeId);
			} else {
				next.add(nodeId);
			}
			return next;
		});
	};

	// Collect all expandable node IDs from the tree
	const getAllExpandableNodeIds = (nodes: ProcessNode[]): string[] => {
		const ids: string[] = [];
		const traverse = (nodeList: ProcessNode[]) => {
			nodeList.forEach((node) => {
				if (node.children && node.children.length > 0) {
					ids.push(node.id);
					traverse(node.children);
				}
			});
		};
		traverse(nodes);
		return ids;
	};

	const expandAll = () => {
		const processTree = buildProcessTree();
		const allIds = getAllExpandableNodeIds(processTree);
		setExpandedNodes(new Set(allIds));
	};

	const collapseAll = () => {
		setExpandedNodes(new Set());
	};

	// Parse the base session ID from a process session ID
	// Process session IDs are formatted as:
	// - {baseSessionId}-ai (legacy)
	// - {baseSessionId}-ai-{tabId} (tab-based AI)
	// - {baseSessionId}-terminal
	// - {baseSessionId}-batch-{timestamp}
	// - {baseSessionId}-synopsis-{timestamp}
	const parseBaseSessionId = (processSessionId: string): string => {
		// Check for batch mode pattern: {sessionId}-batch-{timestamp}
		const batchMatch = processSessionId.match(/^(.+)-batch-\d+$/);
		if (batchMatch) {
			return batchMatch[1];
		}
		// Check for synopsis pattern: {sessionId}-synopsis-{timestamp}
		const synopsisMatch = processSessionId.match(/^(.+)-synopsis-\d+$/);
		if (synopsisMatch) {
			return synopsisMatch[1];
		}
		// Check for tab-based AI pattern: {sessionId}-ai-{tabId}
		const aiTabMatch = processSessionId.match(/^(.+)-ai-.+$/);
		if (aiTabMatch) {
			return aiTabMatch[1];
		}
		// Try to match common suffixes
		const suffixes = ['-ai', '-terminal'];
		for (const suffix of suffixes) {
			if (processSessionId.endsWith(suffix)) {
				return processSessionId.slice(0, -suffix.length);
			}
		}
		// Return as-is if no known suffix
		return processSessionId;
	};

	// Determine process type from session ID
	const getProcessType = (
		processSessionId: string
	): 'ai' | 'terminal' | 'batch' | 'synopsis' | 'wizard' | 'wizard-gen' => {
		if (processSessionId.endsWith('-terminal')) return 'terminal';
		if (processSessionId.match(/-batch-\d+$/)) return 'batch';
		if (processSessionId.match(/-synopsis-\d+$/)) return 'synopsis';
		// Wizard document generation: inline-wizard-gen-{timestamp}-{random}
		if (processSessionId.startsWith('inline-wizard-gen-')) return 'wizard-gen';
		// Wizard conversation: inline-wizard-{timestamp}-{random}
		if (processSessionId.startsWith('inline-wizard-')) return 'wizard';
		return 'ai';
	};

	// Extract tab ID from process session ID (format: {sessionId}-ai-{tabId})
	const parseTabId = (processSessionId: string): string | null => {
		const match = processSessionId.match(/-ai-([^-]+)$/);
		return match ? match[1] : null;
	};

	// Build the process tree using real active processes
	const buildProcessTree = (): ProcessNode[] => {
		const tree: ProcessNode[] = [];

		// Group sessions by group
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

		// Map active processes to their base session IDs
		const processesMap = new Map<string, ActiveProcess[]>();
		activeProcesses.forEach((proc) => {
			const baseId = parseBaseSessionId(proc.sessionId);
			const existing = processesMap.get(baseId) || [];
			processesMap.set(baseId, [...existing, proc]);
		});

		// Build session node with active processes
		const buildSessionNode = (session: Session): ProcessNode => {
			const sessionNode: ProcessNode = {
				id: `session-${session.id}`,
				type: 'session',
				label: session.name,
				sessionId: session.id,
				expanded: expandedNodes.has(`session-${session.id}`),
				children: [],
			};

			// Get active processes for this session
			const sessionProcesses = processesMap.get(session.id) || [];

			// Add each active process
			sessionProcesses.forEach((proc) => {
				const processType = getProcessType(proc.sessionId);
				let label: string;
				let isAutoRun = false;
				if (processType === 'terminal') {
					label = 'Terminal Shell';
				} else if (processType === 'batch') {
					label = `AI Agent (${proc.toolType})`;
					isAutoRun = true;
				} else if (processType === 'synopsis') {
					label = `AI Agent (${proc.toolType}) - Synopsis`;
				} else {
					label = `AI Agent (${proc.toolType})`;
				}

				// Get session name for process label
				const sessionName = session.name;

				// Look up Claude session ID from the tab if this is an AI process
				let agentSessionId: string | undefined;
				let tabId: string | undefined;
				if (processType === 'ai' || processType === 'batch' || processType === 'synopsis') {
					tabId = parseTabId(proc.sessionId) || undefined;
					if (session.aiTabs) {
						// First try to find by tab ID
						if (tabId) {
							const tab = session.aiTabs.find((t) => t.id === tabId);
							if (tab?.agentSessionId) {
								agentSessionId = tab.agentSessionId;
							}
						}
						// Fall back to active tab if no tab ID match
						if (!agentSessionId) {
							const activeTab = session.aiTabs.find((t) => t.id === session.activeTabId);
							if (activeTab?.agentSessionId) {
								agentSessionId = activeTab.agentSessionId;
								tabId = activeTab.id;
							}
						}
					}
				}

				sessionNode.children!.push({
					id: `process-${proc.sessionId}`,
					type: 'process',
					label: `${sessionName} - ${label}`,
					pid: proc.pid,
					processType,
					sessionId: session.id,
					processSessionId: proc.sessionId, // Full process session ID for killing
					isAlive: true, // Active processes are always alive
					toolType: proc.toolType,
					cwd: proc.cwd,
					agentSessionId,
					tabId,
					startTime: proc.startTime,
					isAutoRun,
					command: proc.command,
					args: proc.args,
				});
			});

			// Only return session node if it has active processes
			return sessionNode;
		};

		// Add grouped sessions (only include sessions with active processes)
		groups.forEach((group) => {
			const groupSessions = sessionsByGroup.get(group.id) || [];
			const sessionNodes = groupSessions
				.map((session) => buildSessionNode(session))
				.filter((node) => node.children && node.children.length > 0);

			// Only add group if it has sessions with active processes
			if (sessionNodes.length > 0) {
				const groupNode: ProcessNode = {
					id: `group-${group.id}`,
					type: 'group',
					label: group.name,
					emoji: group.emoji,
					expanded: expandedNodes.has(`group-${group.id}`),
					children: sessionNodes,
				};
				tree.push(groupNode);
			}
		});

		// Add ungrouped sessions (root level, only with active processes)
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
					expanded: expandedNodes.has('group-root'),
					children: sessionNodes,
				};
				tree.push(rootNode);
			}
		}

		// Add Group Chat processes
		// Group chat session IDs follow these patterns:
		// - group-chat-{groupChatId}-moderator-{uuid}
		// - group-chat-{groupChatId}-moderator-synthesis-{uuid}
		// - group-chat-{groupChatId}-participant-{name}-{uuid|timestamp}
		const groupChatProcesses = activeProcesses.filter((proc) =>
			proc.sessionId.startsWith('group-chat-')
		);

		if (groupChatProcesses.length > 0 && groupChats.length > 0) {
			// Group processes by group chat ID
			const processesByGroupChat = new Map<string, ActiveProcess[]>();

			groupChatProcesses.forEach((proc) => {
				// Extract group chat ID from session ID
				// Pattern: group-chat-{groupChatId}-moderator-... or group-chat-{groupChatId}-participant-...
				const moderatorMatch = proc.sessionId.match(/^group-chat-(.+?)-(moderator|participant)-/);
				if (moderatorMatch) {
					const groupChatId = moderatorMatch[1];
					const existing = processesByGroupChat.get(groupChatId) || [];
					processesByGroupChat.set(groupChatId, [...existing, proc]);
				}
			});

			// Build group chat nodes
			const groupChatNodes: ProcessNode[] = [];

			groupChats.forEach((groupChat) => {
				const chatProcesses = processesByGroupChat.get(groupChat.id) || [];

				if (chatProcesses.length > 0) {
					const processNodes: ProcessNode[] = chatProcesses.map((proc) => {
						// Determine if this is a moderator or participant process
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
							// Extract participant name from session ID
							// Pattern: group-chat-{id}-participant-{name}-{uuid|timestamp}
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
						};
					});

					groupChatNodes.push({
						id: `groupchat-${groupChat.id}`,
						type: 'groupchat',
						label: groupChat.name,
						emoji: '💬',
						expanded: expandedNodes.has(`groupchat-${groupChat.id}`),
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
					expanded: expandedNodes.has('group-chats-section'),
					children: groupChatNodes,
				};
				tree.push(groupChatsNode);
			}
		}

		// Add Wizard processes
		// Wizard session IDs follow these patterns:
		// - inline-wizard-{timestamp}-{random} (conversation phase)
		// - inline-wizard-gen-{timestamp}-{random} (document generation phase)
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
					processType,
					processSessionId: proc.sessionId,
					isAlive: true,
					toolType: proc.toolType,
					cwd: proc.cwd,
					startTime: proc.startTime,
					command: proc.command,
					args: proc.args,
				};
			});

			const wizardSectionNode: ProcessNode = {
				id: 'wizard-section',
				type: 'group',
				label: 'WIZARD PROCESSES',
				emoji: '🧙',
				expanded: expandedNodes.has('wizard-section'),
				children: wizardNodes,
			};
			tree.push(wizardSectionNode);
		}

		return tree;
	};

	// Expand all nodes by default on initial load

	useEffect(() => {
		if (!isLoading && !hasExpandedInitially) {
			// Build tree and get all expandable node IDs
			const tree = buildProcessTree();
			const allIds = getAllExpandableNodeIds(tree);
			setExpandedNodes(new Set(allIds));
			setHasExpandedInitially(true);
		}
	}, [isLoading, hasExpandedInitially, activeProcesses]);

	// Build flat list of visible nodes for keyboard navigation
	const getVisibleNodes = (nodes: ProcessNode[]): ProcessNode[] => {
		const result: ProcessNode[] = [];
		const traverse = (nodeList: ProcessNode[]) => {
			nodeList.forEach((node) => {
				result.push(node);
				if (node.children && node.children.length > 0 && expandedNodes.has(node.id)) {
					traverse(node.children);
				}
			});
		};
		traverse(nodes);
		return result;
	};

	// Open detail view for a process node
	const openProcessDetail = (node: ProcessNode) => {
		if (!node.processSessionId || !node.pid) return;

		// Find the session name from the label (it's the part before " - ")
		const labelParts = node.label.split(' - ');
		const sessionName = labelParts.length > 1 ? labelParts[0] : node.label;

		setDetailView({
			processSessionId: node.processSessionId,
			pid: node.pid,
			toolType: node.toolType || 'unknown',
			cwd: node.cwd || '',
			startTime: node.startTime || Date.now(),
			command: node.command,
			args: node.args,
			agentSessionId: node.agentSessionId,
			sessionName,
			processType: node.processType,
			isAutoRun: node.isAutoRun,
		});
	};

	// Keyboard navigation handler
	const handleKeyDown = (e: React.KeyboardEvent) => {
		const processTree = buildProcessTree();
		const visibleNodes = getVisibleNodes(processTree);

		if (visibleNodes.length === 0) return;

		const currentIndex = selectedNodeId
			? visibleNodes.findIndex((n) => n.id === selectedNodeId)
			: -1;

		switch (e.key) {
			case 'ArrowDown':
				e.preventDefault();
				if (currentIndex < visibleNodes.length - 1) {
					setSelectedNodeId(visibleNodes[currentIndex + 1].id);
				} else if (currentIndex === -1 && visibleNodes.length > 0) {
					// If nothing selected, select first node
					setSelectedNodeId(visibleNodes[0].id);
				}
				break;

			case 'ArrowUp':
				e.preventDefault();
				if (currentIndex > 0) {
					setSelectedNodeId(visibleNodes[currentIndex - 1].id);
				} else if (currentIndex === -1 && visibleNodes.length > 0) {
					// If nothing selected, select last node
					setSelectedNodeId(visibleNodes[visibleNodes.length - 1].id);
				}
				break;

			case 'ArrowRight':
				e.preventDefault();
				if (selectedNodeId) {
					const selectedNode = visibleNodes.find((n) => n.id === selectedNodeId);
					if (selectedNode && selectedNode.children && selectedNode.children.length > 0) {
						if (!expandedNodes.has(selectedNodeId)) {
							// Expand the node
							setExpandedNodes((prev) => new Set([...prev, selectedNodeId]));
						} else {
							// Already expanded, move to first child
							setSelectedNodeId(selectedNode.children[0].id);
						}
					}
				}
				break;

			case 'ArrowLeft':
				e.preventDefault();
				if (selectedNodeId) {
					const selectedNode = visibleNodes.find((n) => n.id === selectedNodeId);
					if (
						selectedNode &&
						expandedNodes.has(selectedNodeId) &&
						selectedNode.children &&
						selectedNode.children.length > 0
					) {
						// Collapse the node
						setExpandedNodes((prev) => {
							const next = new Set(prev);
							next.delete(selectedNodeId);
							return next;
						});
					} else {
						// Move to parent - find parent by checking which node contains this as a child
						const findParent = (
							nodes: ProcessNode[],
							targetId: string,
							parent: ProcessNode | null = null
						): ProcessNode | null => {
							for (const node of nodes) {
								if (node.id === targetId) return parent;
								if (node.children) {
									const found = findParent(node.children, targetId, node);
									if (found !== null) return found;
								}
							}
							return null;
						};
						const parent = findParent(processTree, selectedNodeId);
						if (parent) {
							setSelectedNodeId(parent.id);
						}
					}
				}
				break;

			case 'Enter':
			case ' ':
				e.preventDefault();
				if (selectedNodeId) {
					const selectedNode = visibleNodes.find((n) => n.id === selectedNodeId);
					if (selectedNode) {
						if (selectedNode.type === 'process' && selectedNode.processSessionId) {
							// Open detail view for process nodes
							openProcessDetail(selectedNode);
						} else if (selectedNode.children && selectedNode.children.length > 0) {
							// Toggle expand/collapse for group/session nodes
							toggleNode(selectedNodeId);
						}
					}
				}
				break;

			case 'r':
			case 'R':
				e.preventDefault();
				fetchActiveProcesses(true);
				break;
		}
	};

	const renderNode = (node: ProcessNode, depth: number = 0): React.ReactNode => {
		const isExpanded = expandedNodes.has(node.id);
		const hasChildren = node.children && node.children.length > 0;
		const paddingLeft = depth * 20 + 16; // 20px per depth level + 16px base
		const isSelected = selectedNodeId === node.id;

		if (node.type === 'group') {
			return (
				<div key={node.id}>
					<button
						ref={isSelected ? (selectedNodeRef as React.RefObject<HTMLButtonElement>) : null}
						onClick={() => {
							setSelectedNodeId(node.id);
							toggleNode(node.id);
						}}
						className="w-full text-left px-4 py-2 flex items-center gap-2 hover:bg-opacity-5"
						style={{
							paddingLeft: `${paddingLeft}px`,
							backgroundColor: isSelected ? `${theme.colors.accent}25` : 'transparent',
							color: theme.colors.textMain,
							outline: isSelected ? `2px solid ${theme.colors.accent}` : 'none',
							outlineOffset: '-2px',
						}}
						onMouseEnter={(e) => {
							if (!isSelected) e.currentTarget.style.backgroundColor = `${theme.colors.accent}15`;
						}}
						onMouseLeave={(e) => {
							if (!isSelected) e.currentTarget.style.backgroundColor = 'transparent';
						}}
					>
						{hasChildren &&
							(isExpanded ? (
								<ChevronDown
									className="w-4 h-4 flex-shrink-0"
									style={{ color: theme.colors.textDim }}
								/>
							) : (
								<ChevronRight
									className="w-4 h-4 flex-shrink-0"
									style={{ color: theme.colors.textDim }}
								/>
							))}
						{!hasChildren && <div className="w-4 h-4 flex-shrink-0" />}
						<span className="mr-2">{node.emoji}</span>
						<span className="font-medium flex-1 truncate">{node.label}</span>
						{hasChildren && (
							<span className="text-xs flex-shrink-0" style={{ color: theme.colors.textDim }}>
								{node.children!.length} {node.children!.length === 1 ? 'session' : 'sessions'}
							</span>
						)}
					</button>
					{isExpanded && hasChildren && (
						<div>{node.children!.map((child) => renderNode(child, depth + 1))}</div>
					)}
				</div>
			);
		}

		if (node.type === 'session') {
			// Count active processes for this session
			const activeCount = node.children?.filter((c) => c.isAlive).length || 0;

			return (
				<div key={node.id}>
					<button
						ref={isSelected ? (selectedNodeRef as React.RefObject<HTMLButtonElement>) : null}
						onClick={() => {
							setSelectedNodeId(node.id);
							toggleNode(node.id);
						}}
						className="w-full text-left px-4 py-2 flex items-center gap-2 hover:bg-opacity-5"
						style={{
							paddingLeft: `${paddingLeft}px`,
							backgroundColor: isSelected ? `${theme.colors.accent}25` : 'transparent',
							color: theme.colors.textMain,
							outline: isSelected ? `2px solid ${theme.colors.accent}` : 'none',
							outlineOffset: '-2px',
						}}
						onMouseEnter={(e) => {
							if (!isSelected) e.currentTarget.style.backgroundColor = `${theme.colors.accent}15`;
						}}
						onMouseLeave={(e) => {
							if (!isSelected) e.currentTarget.style.backgroundColor = 'transparent';
						}}
					>
						{hasChildren &&
							(isExpanded ? (
								<ChevronDown
									className="w-4 h-4 flex-shrink-0"
									style={{ color: theme.colors.textDim }}
								/>
							) : (
								<ChevronRight
									className="w-4 h-4 flex-shrink-0"
									style={{ color: theme.colors.textDim }}
								/>
							))}
						{!hasChildren && <div className="w-4 h-4 flex-shrink-0" />}
						<Activity
							className="w-4 h-4 flex-shrink-0"
							style={{ color: activeCount > 0 ? theme.colors.success : theme.colors.textDim }}
						/>
						<span className="flex-1 truncate">{node.label}</span>
						<span
							className="text-xs flex items-center gap-2 flex-shrink-0"
							style={{ color: theme.colors.textDim }}
						>
							{activeCount > 0 && (
								<span
									className="px-1.5 py-0.5 rounded text-xs"
									style={{
										backgroundColor: `${theme.colors.success}20`,
										color: theme.colors.success,
									}}
								>
									{activeCount} running
								</span>
							)}
							<span>Session: {node.sessionId?.substring(0, 8)}...</span>
						</span>
					</button>
					{isExpanded && hasChildren && (
						<div>{node.children!.map((child) => renderNode(child, depth + 1))}</div>
					)}
				</div>
			);
		}

		if (node.type === 'process') {
			// Determine if this is a group chat process
			const isGroupChatProcess =
				node.processType === 'moderator' || node.processType === 'participant';
			// Determine if this is a wizard process
			const isWizardProcess = node.processType === 'wizard' || node.processType === 'wizard-gen';

			return (
				<div
					ref={isSelected ? (selectedNodeRef as React.RefObject<HTMLDivElement>) : null}
					key={node.id}
					tabIndex={0}
					className="px-4 py-1.5 cursor-pointer group"
					style={{
						paddingLeft: `${paddingLeft}px`,
						color: theme.colors.textMain,
						backgroundColor: isSelected ? `${theme.colors.accent}25` : 'transparent',
						outline: isSelected ? `2px solid ${theme.colors.accent}` : 'none',
						outlineOffset: '-2px',
					}}
					onClick={() => setSelectedNodeId(node.id)}
					onDoubleClick={() => openProcessDetail(node)}
					onMouseEnter={(e) => {
						if (!isSelected) e.currentTarget.style.backgroundColor = `${theme.colors.accent}15`;
					}}
					onMouseLeave={(e) => {
						if (!isSelected) e.currentTarget.style.backgroundColor = 'transparent';
					}}
				>
					{/* First line: status dot, label, badges, kill button */}
					<div className="flex items-center gap-2">
						<div className="w-4 h-4 flex-shrink-0" />
						<div
							className="w-2 h-2 rounded-full flex-shrink-0"
							style={{ backgroundColor: theme.colors.success }}
						/>
						<span className="text-sm flex-1 truncate">{node.label}</span>
						{node.isAutoRun && (
							<span
								className="text-xs font-semibold px-1.5 py-0.5 rounded flex-shrink-0"
								style={{
									backgroundColor: theme.colors.accent + '20',
									color: theme.colors.accent,
								}}
							>
								AUTO
							</span>
						)}
						{/* Group Chat badges */}
						{node.processType === 'moderator' && (
							<span
								className="text-xs font-semibold px-1.5 py-0.5 rounded flex-shrink-0"
								style={{
									backgroundColor: theme.colors.warning + '20',
									color: theme.colors.warning,
								}}
							>
								MODERATOR
							</span>
						)}
						{node.processType === 'participant' && (
							<span
								className="text-xs font-semibold px-1.5 py-0.5 rounded flex-shrink-0"
								style={{
									backgroundColor: theme.colors.accent + '20',
									color: theme.colors.accent,
								}}
							>
								PARTICIPANT
							</span>
						)}
						{/* Wizard badges */}
						{node.processType === 'wizard' && (
							<span
								className="text-xs font-semibold px-1.5 py-0.5 rounded flex-shrink-0"
								style={{
									backgroundColor: '#a855f7' + '20',
									color: '#a855f7',
								}}
							>
								WIZARD
							</span>
						)}
						{node.processType === 'wizard-gen' && (
							<span
								className="text-xs font-semibold px-1.5 py-0.5 rounded flex-shrink-0"
								style={{
									backgroundColor: '#a855f7' + '20',
									color: '#a855f7',
								}}
							>
								GENERATING
							</span>
						)}
						{/* Kill button */}
						{node.processSessionId && (
							<button
								className="p-1 rounded opacity-0 group-hover:opacity-100 hover:bg-opacity-20 transition-opacity"
								style={{ color: theme.colors.error }}
								onClick={(e) => {
									e.stopPropagation();
									setKillConfirmProcessId(node.processSessionId!);
								}}
								onMouseEnter={(e) =>
									(e.currentTarget.style.backgroundColor = `${theme.colors.error}20`)
								}
								onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
								title="Kill process"
							>
								<XCircle className="w-4 h-4" />
							</button>
						)}
					</div>
					{/* Second line: Claude session ID, PID, runtime, status - indented */}
					<div className="flex items-center gap-3 mt-1" style={{ paddingLeft: '24px' }}>
						{node.agentSessionId && node.sessionId && onNavigateToSession && (
							<button
								className="text-xs font-mono hover:underline cursor-pointer"
								style={{ color: theme.colors.accent }}
								onClick={(e) => {
									e.stopPropagation();
									onNavigateToSession(node.sessionId!, node.tabId);
									onClose();
								}}
								title="Click to navigate to this session"
							>
								{node.agentSessionId.substring(0, 8)}...
							</button>
						)}
						{node.agentSessionId && (!node.sessionId || !onNavigateToSession) && (
							<span className="text-xs font-mono" style={{ color: theme.colors.accent }}>
								{node.agentSessionId.substring(0, 8)}...
							</span>
						)}
						{/* For group chat and wizard processes, show tool type */}
						{(isGroupChatProcess || isWizardProcess) && node.toolType && (
							<span className="text-xs font-mono" style={{ color: theme.colors.textDim }}>
								{node.toolType}
							</span>
						)}
						<span className="text-xs font-mono" style={{ color: theme.colors.textDim }}>
							PID: {node.pid}
						</span>
						{node.startTime && (
							<span className="text-xs font-mono" style={{ color: theme.colors.textDim }}>
								{formatRuntime(node.startTime)}
							</span>
						)}
						<span
							className="text-xs px-2 py-0.5 rounded"
							style={{
								backgroundColor: `${theme.colors.success}20`,
								color: theme.colors.success,
							}}
						>
							Running
						</span>
					</div>
				</div>
			);
		}

		// Render group chat node (individual group chat within GROUP CHATS section)
		if (node.type === 'groupchat') {
			const activeCount = node.children?.filter((c) => c.isAlive).length || 0;

			return (
				<div key={node.id}>
					<button
						ref={isSelected ? (selectedNodeRef as React.RefObject<HTMLButtonElement>) : null}
						onClick={() => {
							setSelectedNodeId(node.id);
							toggleNode(node.id);
						}}
						className="w-full text-left px-4 py-2 flex items-center gap-2 hover:bg-opacity-5"
						style={{
							paddingLeft: `${paddingLeft}px`,
							backgroundColor: isSelected ? `${theme.colors.accent}25` : 'transparent',
							color: theme.colors.textMain,
							outline: isSelected ? `2px solid ${theme.colors.accent}` : 'none',
							outlineOffset: '-2px',
						}}
						onMouseEnter={(e) => {
							if (!isSelected) e.currentTarget.style.backgroundColor = `${theme.colors.accent}15`;
						}}
						onMouseLeave={(e) => {
							if (!isSelected) e.currentTarget.style.backgroundColor = 'transparent';
						}}
					>
						{hasChildren &&
							(isExpanded ? (
								<ChevronDown
									className="w-4 h-4 flex-shrink-0"
									style={{ color: theme.colors.textDim }}
								/>
							) : (
								<ChevronRight
									className="w-4 h-4 flex-shrink-0"
									style={{ color: theme.colors.textDim }}
								/>
							))}
						{!hasChildren && <div className="w-4 h-4 flex-shrink-0" />}
						<span className="mr-2">{node.emoji}</span>
						<span className="flex-1 truncate">{node.label}</span>
						<span
							className="text-xs flex items-center gap-2 flex-shrink-0"
							style={{ color: theme.colors.textDim }}
						>
							{activeCount > 0 && (
								<span
									className="px-1.5 py-0.5 rounded text-xs"
									style={{
										backgroundColor: `${theme.colors.success}20`,
										color: theme.colors.success,
									}}
								>
									{activeCount} running
								</span>
							)}
							{node.groupChatId && onNavigateToGroupChat && (
								<button
									className="text-xs hover:underline cursor-pointer"
									style={{ color: theme.colors.accent }}
									onClick={(e) => {
										e.stopPropagation();
										onNavigateToGroupChat(node.groupChatId!);
									}}
									title="Go to group chat"
								>
									Open
								</button>
							)}
						</span>
					</button>
					{isExpanded && hasChildren && (
						<div>{node.children!.map((child) => renderNode(child, depth + 1))}</div>
					)}
				</div>
			);
		}

		return null;
	};

	const processTree = buildProcessTree();
	const totalActiveProcesses = activeProcesses.length;

	// Render the detail view for a selected process
	const renderDetailView = () => {
		if (!detailView) return null;

		const commandLine =
			detailView.command && detailView.args
				? `${detailView.command} ${detailView.args.join(' ')}`
				: detailView.command || 'N/A';

		return (
			<div
				ref={detailViewRef}
				tabIndex={-1}
				className="flex flex-col h-full min-h-0 overflow-hidden outline-none"
			>
				{/* Detail Header */}
				<div
					className="px-6 py-4 border-b flex items-center justify-between"
					style={{ borderColor: theme.colors.border }}
				>
					<div className="flex items-center gap-3">
						<button
							onClick={() => setDetailView(null)}
							className="p-1.5 rounded hover:bg-opacity-10 flex items-center gap-1"
							style={{ color: theme.colors.textDim }}
							onMouseEnter={(e) =>
								(e.currentTarget.style.backgroundColor = `${theme.colors.accent}20`)
							}
							onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
							title="Back (Esc)"
						>
							<ChevronLeft className="w-5 h-5" />
						</button>
						<Cpu className="w-5 h-5" style={{ color: theme.colors.accent }} />
						<h2 className="text-lg font-semibold" style={{ color: theme.colors.textMain }}>
							Process Details
						</h2>
						{detailView.isAutoRun && (
							<span
								className="text-xs font-semibold px-2 py-1 rounded"
								style={{
									backgroundColor: theme.colors.accent + '20',
									color: theme.colors.accent,
								}}
							>
								AUTO RUN
							</span>
						)}
					</div>
					<button
						onClick={onClose}
						className="p-1.5 rounded hover:bg-opacity-10"
						style={{ color: theme.colors.textDim }}
						onMouseEnter={(e) =>
							(e.currentTarget.style.backgroundColor = `${theme.colors.accent}20`)
						}
						onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
						title="Close"
					>
						<X className="w-4 h-4" />
					</button>
				</div>

				{/* Detail Content */}
				<div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin p-6 space-y-6">
					{/* Process Name & Status */}
					<div className="flex items-center gap-3">
						<div
							className="w-3 h-3 rounded-full"
							style={{ backgroundColor: theme.colors.success }}
						/>
						<span className="text-xl font-semibold" style={{ color: theme.colors.textMain }}>
							{detailView.sessionName || 'Process'}
						</span>
						<span
							className="text-xs px-2 py-1 rounded"
							style={{
								backgroundColor: `${theme.colors.success}20`,
								color: theme.colors.success,
							}}
						>
							Running
						</span>
					</div>

					{/* Info Grid */}
					<div className="grid grid-cols-1 gap-4">
						{/* Session ID */}
						<div className="p-4 rounded-lg" style={{ backgroundColor: theme.colors.bgMain }}>
							<div className="flex items-center gap-2 mb-2">
								<Hash className="w-4 h-4" style={{ color: theme.colors.accent }} />
								<span
									className="text-xs font-medium uppercase tracking-wide"
									style={{ color: theme.colors.textDim }}
								>
									Process Session ID
								</span>
							</div>
							<code
								className="text-sm font-mono break-all"
								style={{ color: theme.colors.textMain, userSelect: 'text', cursor: 'text' }}
							>
								{detailView.processSessionId}
							</code>
						</div>

						{/* Agent Session ID (if available) */}
						{detailView.agentSessionId && (
							<div className="p-4 rounded-lg" style={{ backgroundColor: theme.colors.bgMain }}>
								<div className="flex items-center gap-2 mb-2">
									<Activity className="w-4 h-4" style={{ color: theme.colors.accent }} />
									<span
										className="text-xs font-medium uppercase tracking-wide"
										style={{ color: theme.colors.textDim }}
									>
										Agent Session ID
									</span>
								</div>
								<code
									className="text-sm font-mono break-all"
									style={{ color: theme.colors.textMain, userSelect: 'text', cursor: 'text' }}
								>
									{detailView.agentSessionId}
								</code>
							</div>
						)}

						{/* PID & Runtime Row */}
						<div className="grid grid-cols-2 gap-4">
							<div className="p-4 rounded-lg" style={{ backgroundColor: theme.colors.bgMain }}>
								<div className="flex items-center gap-2 mb-2">
									<Terminal className="w-4 h-4" style={{ color: theme.colors.accent }} />
									<span
										className="text-xs font-medium uppercase tracking-wide"
										style={{ color: theme.colors.textDim }}
									>
										PID
									</span>
								</div>
								<code
									className="text-lg font-mono"
									style={{ color: theme.colors.textMain, userSelect: 'text', cursor: 'text' }}
								>
									{detailView.pid}
								</code>
							</div>

							<div className="p-4 rounded-lg" style={{ backgroundColor: theme.colors.bgMain }}>
								<div className="flex items-center gap-2 mb-2">
									<Clock className="w-4 h-4" style={{ color: theme.colors.accent }} />
									<span
										className="text-xs font-medium uppercase tracking-wide"
										style={{ color: theme.colors.textDim }}
									>
										Runtime
									</span>
								</div>
								<span className="text-lg font-mono" style={{ color: theme.colors.textMain }}>
									{formatRuntime(detailView.startTime)}
								</span>
							</div>
						</div>

						{/* Tool Type & Process Type Row */}
						<div className="grid grid-cols-2 gap-4">
							<div className="p-4 rounded-lg" style={{ backgroundColor: theme.colors.bgMain }}>
								<div className="flex items-center gap-2 mb-2">
									<Cpu className="w-4 h-4" style={{ color: theme.colors.accent }} />
									<span
										className="text-xs font-medium uppercase tracking-wide"
										style={{ color: theme.colors.textDim }}
									>
										Tool Type
									</span>
								</div>
								<span className="text-sm" style={{ color: theme.colors.textMain }}>
									{detailView.toolType}
								</span>
							</div>

							{detailView.processType && (
								<div className="p-4 rounded-lg" style={{ backgroundColor: theme.colors.bgMain }}>
									<div className="flex items-center gap-2 mb-2">
										<Activity className="w-4 h-4" style={{ color: theme.colors.accent }} />
										<span
											className="text-xs font-medium uppercase tracking-wide"
											style={{ color: theme.colors.textDim }}
										>
											Process Type
										</span>
									</div>
									<span className="text-sm" style={{ color: theme.colors.textMain }}>
										{detailView.processType}
									</span>
								</div>
							)}
						</div>

						{/* Working Directory */}
						<div className="p-4 rounded-lg" style={{ backgroundColor: theme.colors.bgMain }}>
							<div className="flex items-center gap-2 mb-2">
								<FolderOpen className="w-4 h-4" style={{ color: theme.colors.accent }} />
								<span
									className="text-xs font-medium uppercase tracking-wide"
									style={{ color: theme.colors.textDim }}
								>
									Working Directory
								</span>
							</div>
							<code
								className="text-sm font-mono break-all"
								style={{ color: theme.colors.textMain, userSelect: 'text', cursor: 'text' }}
							>
								{detailView.cwd || 'N/A'}
							</code>
						</div>

						{/* Command Line */}
						<div className="p-4 rounded-lg" style={{ backgroundColor: theme.colors.bgMain }}>
							<div className="flex items-center gap-2 mb-2">
								<Play className="w-4 h-4" style={{ color: theme.colors.accent }} />
								<span
									className="text-xs font-medium uppercase tracking-wide"
									style={{ color: theme.colors.textDim }}
								>
									Command Line
								</span>
							</div>
							<code
								className="text-sm font-mono break-all block whitespace-pre-wrap"
								style={{ color: theme.colors.textMain, userSelect: 'text', cursor: 'text' }}
							>
								{commandLine}
							</code>
						</div>

						{/* Start Time */}
						<div className="p-4 rounded-lg" style={{ backgroundColor: theme.colors.bgMain }}>
							<div className="flex items-center gap-2 mb-2">
								<Clock className="w-4 h-4" style={{ color: theme.colors.accent }} />
								<span
									className="text-xs font-medium uppercase tracking-wide"
									style={{ color: theme.colors.textDim }}
								>
									Started At
								</span>
							</div>
							<span className="text-sm" style={{ color: theme.colors.textMain }}>
								{new Date(detailView.startTime).toLocaleString()}
							</span>
						</div>
					</div>
				</div>

				{/* Detail Footer */}
				<div
					className="px-6 py-3 border-t flex items-center justify-between text-xs"
					style={{
						borderColor: theme.colors.border,
						color: theme.colors.textDim,
					}}
				>
					<span style={{ opacity: 0.7 }}>Press Esc to go back</span>
					<div className="flex items-center gap-2">
						<div
							className="w-2 h-2 rounded-full"
							style={{ backgroundColor: theme.colors.success }}
						/>
						<span>Running</span>
					</div>
				</div>
			</div>
		);
	};

	return (
		<div
			className="fixed inset-0 modal-overlay flex items-center justify-center z-[9999] animate-in fade-in duration-100"
			onClick={onClose}
		>
			<div
				ref={containerRef}
				tabIndex={-1}
				role="dialog"
				aria-modal="true"
				aria-label={detailView ? 'Process Details' : 'System Processes'}
				className="w-[700px] max-h-[80vh] rounded-xl shadow-2xl border overflow-hidden flex flex-col outline-none"
				style={{ backgroundColor: theme.colors.bgActivity, borderColor: theme.colors.border }}
				onClick={(e) => e.stopPropagation()}
				onKeyDown={detailView ? undefined : handleKeyDown}
			>
				{detailView ? (
					renderDetailView()
				) : (
					<>
						{/* Header */}
						<div
							className="px-6 py-4 border-b flex items-center justify-between"
							style={{ borderColor: theme.colors.border }}
						>
							<div className="flex items-center gap-3">
								<Activity className="w-5 h-5" style={{ color: theme.colors.accent }} />
								<h2 className="text-lg font-semibold" style={{ color: theme.colors.textMain }}>
									System Processes
								</h2>
								{totalActiveProcesses > 0 && (
									<span
										className="text-xs px-2 py-1 rounded-full"
										style={{
											backgroundColor: `${theme.colors.success}20`,
											color: theme.colors.success,
										}}
									>
										{totalActiveProcesses} active
									</span>
								)}
							</div>
							<div className="flex items-center gap-1">
								<button
									onClick={() => fetchActiveProcesses(true)}
									className="p-1.5 rounded hover:bg-opacity-10 flex items-center gap-1"
									style={{ color: theme.colors.textDim }}
									onMouseEnter={(e) =>
										(e.currentTarget.style.backgroundColor = `${theme.colors.accent}20`)
									}
									onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
									title="Refresh (R)"
								>
									<RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
								</button>
								<button
									onClick={expandAll}
									className="p-1.5 rounded hover:bg-opacity-10"
									style={{ color: theme.colors.textDim }}
									onMouseEnter={(e) =>
										(e.currentTarget.style.backgroundColor = `${theme.colors.accent}20`)
									}
									onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
									title="Expand all"
								>
									<div className="flex flex-col items-center -space-y-1.5">
										<ChevronUp className="w-4 h-4" />
										<ChevronDown className="w-4 h-4" />
									</div>
								</button>
								<button
									onClick={collapseAll}
									className="p-1.5 rounded hover:bg-opacity-10"
									style={{ color: theme.colors.textDim }}
									onMouseEnter={(e) =>
										(e.currentTarget.style.backgroundColor = `${theme.colors.accent}20`)
									}
									onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
									title="Collapse all"
								>
									<div className="flex flex-col items-center -space-y-1.5">
										<ChevronDown className="w-4 h-4" />
										<ChevronUp className="w-4 h-4" />
									</div>
								</button>
								<button
									onClick={onClose}
									className="p-1.5 rounded hover:bg-opacity-10"
									style={{ color: theme.colors.textDim }}
									onMouseEnter={(e) =>
										(e.currentTarget.style.backgroundColor = `${theme.colors.accent}20`)
									}
									onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
									title="Close (Esc)"
								>
									<X className="w-4 h-4" />
								</button>
							</div>
						</div>

						{/* Process tree */}
						<div className="overflow-y-auto flex-1 scrollbar-thin">
							{isLoading ? (
								<div
									className="px-6 py-8 text-center flex items-center justify-center gap-2"
									style={{ color: theme.colors.textDim }}
								>
									<RefreshCw className="w-4 h-4 animate-spin" />
									Loading processes...
								</div>
							) : processTree.length === 0 ? (
								<div className="px-6 py-8 text-center" style={{ color: theme.colors.textDim }}>
									No running processes
								</div>
							) : (
								<div className="py-2">{processTree.map((node) => renderNode(node, 0))}</div>
							)}
						</div>

						{/* Footer */}
						<div
							className="px-6 py-3 border-t flex items-center justify-between text-xs"
							style={{
								borderColor: theme.colors.border,
								color: theme.colors.textDim,
							}}
						>
							<div className="flex items-center gap-4">
								<span>
									{sessions.length} {sessions.length === 1 ? 'session' : 'sessions'} •{' '}
									{groups.length} {groups.length === 1 ? 'group' : 'groups'}
								</span>
								<span style={{ opacity: 0.7 }}>↑↓ navigate • Enter view details • R refresh</span>
							</div>
							<div className="flex items-center gap-2">
								<div
									className="w-2 h-2 rounded-full"
									style={{ backgroundColor: theme.colors.success }}
								/>
								<span>Running</span>
							</div>
						</div>
					</>
				)}
			</div>

			{/* Kill confirmation modal */}
			{killConfirmProcessId && (
				<div
					className="fixed inset-0 flex items-center justify-center z-[10000]"
					style={{ backgroundColor: 'rgba(0,0,0,0.5)' }}
					onClick={() => setKillConfirmProcessId(null)}
				>
					<div
						ref={killConfirmRef}
						className="p-4 rounded-lg shadow-xl max-w-md mx-4 outline-none"
						style={{ backgroundColor: theme.colors.bgMain }}
						onClick={(e) => e.stopPropagation()}
						tabIndex={-1}
						onKeyDown={(e) => {
							if (e.key === 'Enter' && !isKilling) {
								e.preventDefault();
								killProcess(killConfirmProcessId);
							} else if (e.key === 'Escape') {
								e.preventDefault();
								setKillConfirmProcessId(null);
							}
						}}
					>
						<h3 className="text-lg font-semibold mb-2" style={{ color: theme.colors.textMain }}>
							Kill Process?
						</h3>
						<p className="text-sm mb-4" style={{ color: theme.colors.textDim }}>
							This will forcefully terminate the process. Any unsaved work may be lost.
						</p>
						<div className="flex gap-2 justify-end">
							<button
								onClick={() => setKillConfirmProcessId(null)}
								className="px-3 py-1.5 rounded text-sm"
								style={{ backgroundColor: theme.colors.bgActivity, color: theme.colors.textMain }}
								disabled={isKilling}
							>
								Cancel
							</button>
							<button
								onClick={() => killProcess(killConfirmProcessId)}
								className="px-3 py-1.5 rounded text-sm flex items-center gap-2"
								style={{ backgroundColor: theme.colors.error, color: 'white' }}
								disabled={isKilling}
								autoFocus
							>
								{isKilling ? (
									<>
										<RefreshCw className="w-3 h-3 animate-spin" />
										Killing...
									</>
								) : (
									'Kill Process'
								)}
							</button>
						</div>
					</div>
				</div>
			)}
		</div>
	);
}
