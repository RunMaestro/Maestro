import type React from 'react';
import { useEffect, useRef } from 'react';
import {
	Activity,
	ChevronDown,
	ChevronRight,
	ExternalLink,
	RefreshCw,
	XCircle,
} from 'lucide-react';
import type { Session, Theme } from '../../types';
import type { ProcessNode, ProcessMonitorProps } from './types';
import { formatRuntime } from './runtime';

export interface ProcessListViewProps {
	theme: Theme;
	sessions: Session[];
	tree: ProcessNode[];
	isLoading: boolean;
	selectedNodeId: string | null;
	expandedIds: Set<string>;
	onSelectNode: (id: string | null) => void;
	onToggleNode: (id: string) => void;
	onOpenDetail: (node: ProcessNode) => void;
	onRequestKill: (processSessionId: string, cueRunId?: string) => void;
	onCloseModal: () => void;
	onNavigateToSession?: ProcessMonitorProps['onNavigateToSession'];
	onNavigateToGroupChat?: ProcessMonitorProps['onNavigateToGroupChat'];
}

// Renders the scrollable tree body (loading / empty / tree). Owns the
// selectedNodeRef + scroll-into-view side-effect; everything else is pure
// presentation driven by props.
export function ProcessListView(props: ProcessListViewProps) {
	const {
		theme,
		sessions,
		tree,
		isLoading,
		selectedNodeId,
		expandedIds,
		onSelectNode,
		onToggleNode,
		onOpenDetail,
		onRequestKill,
		onCloseModal,
		onNavigateToSession,
		onNavigateToGroupChat,
	} = props;

	const selectedNodeRef = useRef<HTMLButtonElement | HTMLDivElement>(null);

	useEffect(() => {
		selectedNodeRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
	}, [selectedNodeId]);

	const renderNode = (node: ProcessNode, depth = 0, index = 0): React.ReactNode => {
		const isExpanded = expandedIds.has(node.id);
		const hasChildren = !!node.children && node.children.length > 0;
		const paddingLeft = depth * 20 + 16;
		const isSelected = selectedNodeId === node.id;

		if (node.type === 'group') {
			return (
				<div key={node.id}>
					<button
						ref={isSelected ? (selectedNodeRef as React.RefObject<HTMLButtonElement>) : null}
						onClick={() => {
							onSelectNode(node.id);
							onToggleNode(node.id);
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
						<span className="font-medium truncate">{node.label}</span>
						{hasChildren && (
							<span className="text-xs flex-shrink-0" style={{ color: theme.colors.textDim }}>
								{node.children!.length}{' '}
								{node.children!.length === 1
									? (node.countLabel ?? 'session')
									: node.countLabel
										? `${node.countLabel}s`
										: 'sessions'}
							</span>
						)}
					</button>
					{isExpanded && hasChildren && (
						<div>{node.children!.map((child, i) => renderNode(child, depth + 1, i))}</div>
					)}
				</div>
			);
		}

		if (node.type === 'session') {
			const activeCount = node.children?.filter((c) => c.isAlive).length || 0;

			return (
				<div key={node.id}>
					<div
						ref={isSelected ? (selectedNodeRef as React.RefObject<HTMLDivElement>) : null}
						role="button"
						tabIndex={0}
						onClick={() => {
							onSelectNode(node.id);
							onToggleNode(node.id);
						}}
						onKeyDown={(e) => {
							if (e.key === 'Enter' || e.key === ' ') {
								e.preventDefault();
								onSelectNode(node.id);
								onToggleNode(node.id);
							}
						}}
						className="w-full text-left px-4 py-2 flex items-center gap-2 hover:bg-opacity-5 group"
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
						<span className="truncate">{node.label}</span>
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
							{node.sshRemote && (
								<span
									className="px-1.5 py-0.5 rounded text-xs"
									style={{
										backgroundColor: `${theme.colors.accent}20`,
										color: theme.colors.accent,
									}}
									title={`SSH: ${node.sshRemote.name} (${node.sshRemote.host})`}
								>
									SSH: {node.sshRemote.name}
								</span>
							)}
							<span className="font-mono">{node.sessionId?.substring(0, 8)}</span>
						</span>
						{node.sessionId && onNavigateToSession && (
							<button
								className="p-1 rounded opacity-0 group-hover:opacity-100 hover:bg-opacity-20 transition-opacity flex-shrink-0"
								style={{ color: theme.colors.accent }}
								onClick={(e) => {
									e.stopPropagation();
									onNavigateToSession(node.sessionId!);
									onCloseModal();
								}}
								onMouseEnter={(e) =>
									(e.currentTarget.style.backgroundColor = `${theme.colors.accent}20`)
								}
								onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
								title="Jump to agent"
							>
								<ExternalLink className="w-4 h-4" />
							</button>
						)}
					</div>
					{isExpanded && hasChildren && (
						<div>{node.children!.map((child, i) => renderNode(child, depth + 1, i))}</div>
					)}
				</div>
			);
		}

		if (node.type === 'process') {
			const isGroupChatProcess =
				node.processType === 'moderator' || node.processType === 'participant';
			const isWizardProcess = node.processType === 'wizard' || node.processType === 'wizard-gen';
			const isCueProcess = node.processType === 'cue';
			const altBg = index % 2 === 1 ? `${theme.colors.textDim}08` : 'transparent';

			return (
				<div key={node.id}>
					<div
						ref={isSelected ? (selectedNodeRef as React.RefObject<HTMLDivElement>) : null}
						tabIndex={0}
						className="px-4 py-1 cursor-pointer group"
						style={{
							paddingLeft: `${paddingLeft}px`,
							color: theme.colors.textMain,
							backgroundColor: isSelected ? `${theme.colors.accent}25` : altBg,
							outline: isSelected ? `2px solid ${theme.colors.accent}` : 'none',
							outlineOffset: '-2px',
							borderTop: index > 0 ? `1px solid ${theme.colors.border}40` : 'none',
						}}
						onClick={() => {
							onSelectNode(node.id);
							if (hasChildren) onToggleNode(node.id);
						}}
						onDoubleClick={() => onOpenDetail(node)}
						onMouseEnter={(e) => {
							if (!isSelected) e.currentTarget.style.backgroundColor = `${theme.colors.accent}15`;
						}}
						onMouseLeave={(e) => {
							if (!isSelected) e.currentTarget.style.backgroundColor = altBg;
						}}
					>
						<div className="flex items-center gap-2">
							{hasChildren ? (
								isExpanded ? (
									<ChevronDown
										className="w-4 h-4 flex-shrink-0"
										style={{ color: theme.colors.textDim }}
									/>
								) : (
									<ChevronRight
										className="w-4 h-4 flex-shrink-0"
										style={{ color: theme.colors.textDim }}
									/>
								)
							) : (
								<div className="w-4 h-4 flex-shrink-0" />
							)}
							<div
								className="w-2 h-2 rounded-full flex-shrink-0"
								style={{ backgroundColor: theme.colors.success }}
							/>
							<span className="text-sm truncate min-w-0">{node.label}</span>
							{/* Metadata cluster */}
							<div
								className="flex items-center gap-3 flex-shrink-0 text-xs font-mono"
								style={{ color: theme.colors.textDim }}
							>
								{node.agentSessionId && node.sessionId && onNavigateToSession && (
									<button
										className="hover:underline cursor-pointer"
										style={{ color: theme.colors.accent }}
										onClick={(e) => {
											e.stopPropagation();
											onNavigateToSession(node.sessionId!, node.tabId, node.processType);
											onCloseModal();
										}}
										title="Click to navigate to this session"
									>
										{node.agentSessionId.substring(0, 8)}
									</button>
								)}
								{node.agentSessionId && (!node.sessionId || !onNavigateToSession) && (
									<span style={{ color: theme.colors.accent }}>
										{node.agentSessionId.substring(0, 8)}
									</span>
								)}
								{(isGroupChatProcess || isWizardProcess) && node.toolType && (
									<span>{node.toolType}</span>
								)}
								<span>PID {node.pid}</span>
								{node.startTime && <span>{formatRuntime(node.startTime)}</span>}
								{node.sshRemote && (
									<span
										className="px-1.5 py-0.5 rounded"
										style={{
											backgroundColor: `${theme.colors.accent}20`,
											color: theme.colors.accent,
										}}
										title={`SSH: ${node.sshRemote.name} (${node.sshRemote.host})`}
									>
										SSH
									</span>
								)}
							</div>
							{/* Action cluster */}
							<div className="flex items-center gap-2 flex-shrink-0">
								{node.isAutoRun && (
									<span
										className="text-xs font-semibold px-1.5 py-0.5 rounded"
										style={{
											backgroundColor: theme.colors.accent + '20',
											color: theme.colors.accent,
										}}
									>
										AUTO
									</span>
								)}
								{node.processType === 'moderator' && (
									<span
										className="text-xs font-semibold px-1.5 py-0.5 rounded"
										style={{
											backgroundColor: theme.colors.warning + '30',
											color: theme.colors.warning,
											border: `1px solid ${theme.colors.warning}50`,
										}}
									>
										MODERATOR
									</span>
								)}
								{node.processType === 'participant' && (
									<span
										className="text-xs font-semibold px-1.5 py-0.5 rounded"
										style={{
											backgroundColor: theme.colors.success + '30',
											color: theme.colors.success,
											border: `1px solid ${theme.colors.success}50`,
										}}
									>
										PARTICIPANT
									</span>
								)}
								{node.processType === 'wizard' && (
									<span
										className="text-xs font-semibold px-1.5 py-0.5 rounded"
										style={{
											backgroundColor: '#a855f7' + '30',
											color: '#a855f7',
											border: '1px solid #a855f750',
										}}
									>
										WIZARD
									</span>
								)}
								{node.processType === 'wizard-gen' && (
									<span
										className="text-xs font-semibold px-1.5 py-0.5 rounded"
										style={{
											backgroundColor: '#a855f7' + '30',
											color: '#a855f7',
											border: '1px solid #a855f750',
										}}
									>
										GENERATING
									</span>
								)}
								{node.processType === 'cue' && (
									<span
										className="text-xs font-semibold px-1.5 py-0.5 rounded"
										style={{
											backgroundColor: '#06b6d4' + '30',
											color: '#06b6d4',
											border: '1px solid #06b6d450',
										}}
									>
										{node.cueEventType?.replace('.', ' ').toUpperCase() ?? 'CUE'}
									</span>
								)}
								{/* Account badge — show if session has an account assigned */}
								{(() => {
									const sess = sessions.find((s) => s.id === node.agentSessionId);
									if (sess?.accountName) {
										return (
											<span
												className="flex-shrink-0"
												style={{
													fontSize: '9px',
													padding: '1px 5px',
													borderRadius: '3px',
													backgroundColor: `${theme.colors.accent}20`,
													color: theme.colors.accent,
													fontWeight: 500,
												}}
											>
												{sess.accountName}
											</span>
										);
									}
									return null;
								})()}
								{node.sessionId &&
									onNavigateToSession &&
									!isGroupChatProcess &&
									!isWizardProcess &&
									!isCueProcess && (
										<button
											className="p-1 rounded opacity-0 group-hover:opacity-100 hover:bg-opacity-20 transition-opacity"
											style={{ color: theme.colors.accent }}
											onClick={(e) => {
												e.stopPropagation();
												onNavigateToSession(node.sessionId!, node.tabId, node.processType);
												onCloseModal();
											}}
											onMouseEnter={(e) =>
												(e.currentTarget.style.backgroundColor = `${theme.colors.accent}20`)
											}
											onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
											title={node.tabId ? 'Jump to tab' : 'Jump to agent'}
										>
											<ExternalLink className="w-4 h-4" />
										</button>
									)}
								{isGroupChatProcess && node.groupChatId && onNavigateToGroupChat && (
									<button
										className="p-1 rounded opacity-0 group-hover:opacity-100 hover:bg-opacity-20 transition-opacity"
										style={{ color: theme.colors.accent }}
										onClick={(e) => {
											e.stopPropagation();
											onNavigateToGroupChat(node.groupChatId!);
											onCloseModal();
										}}
										onMouseEnter={(e) =>
											(e.currentTarget.style.backgroundColor = `${theme.colors.accent}20`)
										}
										onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
										title="Jump to group chat"
									>
										<ExternalLink className="w-4 h-4" />
									</button>
								)}
								{node.processSessionId && (
									<button
										className="p-1 rounded opacity-0 group-hover:opacity-100 hover:bg-opacity-20 transition-opacity"
										style={{ color: theme.colors.error }}
										onClick={(e) => {
											e.stopPropagation();
											onRequestKill(node.processSessionId!, node.cueRunId);
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
						</div>
					</div>
					{isExpanded && hasChildren && (
						<div>{node.children!.map((child, i) => renderNode(child, depth + 1, i))}</div>
					)}
				</div>
			);
		}

		if (node.type === 'groupchat') {
			const activeCount = node.children?.filter((c) => c.isAlive).length || 0;

			return (
				<div key={node.id}>
					<button
						ref={isSelected ? (selectedNodeRef as React.RefObject<HTMLButtonElement>) : null}
						onClick={() => {
							onSelectNode(node.id);
							onToggleNode(node.id);
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
						<span className="truncate">{node.label}</span>
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
						<div>{node.children!.map((child, i) => renderNode(child, depth + 1, i))}</div>
					)}
				</div>
			);
		}

		return null;
	};

	if (isLoading) {
		return (
			<div
				className="px-6 py-8 text-center flex items-center justify-center gap-2"
				style={{ color: theme.colors.textDim }}
			>
				<RefreshCw className="w-4 h-4 animate-spin" />
				Loading processes...
			</div>
		);
	}

	if (tree.length === 0) {
		return (
			<div className="px-6 py-8 text-center" style={{ color: theme.colors.textDim }}>
				No running processes
			</div>
		);
	}

	return <div className="py-2">{tree.map((node, i) => renderNode(node, 0, i))}</div>;
}
