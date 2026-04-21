import React, { useRef } from 'react';
import {
	Wand2,
	ExternalLink,
	Columns,
	Copy,
	GitBranch,
	ArrowUp,
	ArrowDown,
	FileEdit,
	List,
	GitPullRequest,
	Settings2,
	Server,
	Bookmark,
	Brain,
} from 'lucide-react';
import { GhostIconButton } from '../ui/GhostIconButton';
import { Spinner } from '../ui/Spinner';
import { formatShortcutKeys } from '../../utils/shortcutFormatter';
import { remoteUrlToBrowserUrl } from '../../../shared/gitUtils';
import { GitStatusWidget } from '../GitStatusWidget';
import { useHoverTooltip } from '../../hooks';
import { useSettingsStore } from '../../stores/settingsStore';
import { useUIStore } from '../../stores/uiStore';
import type { Session, Theme, BatchRunState, AITab } from '../../types';
import type { AgentCapabilities } from '../../hooks/agent/useAgentCapabilities';
import { openUrl } from '../../utils/openUrl';

export interface MainPanelHeaderProps {
	activeSession: Session;
	activeTab: AITab | null;
	theme: Theme;
	gitInfo: {
		branch: string;
		remote: string;
		ahead: number;
		behind: number;
		uncommittedChanges: number;
	} | null;
	sshRemoteName: string | null;
	activeTabContextWindow: number;
	activeTabContextTokens: number;
	activeTabContextUsage: number;
	isCurrentSessionAutoMode: boolean;
	isCurrentSessionStopping: boolean;
	currentSessionBatchState: BatchRunState | null | undefined;
	isWorktreeChild: boolean | undefined;
	activeFileTabId: string | null | undefined;
	refreshGitStatus: () => Promise<void>;
	handleViewGitDiff: () => Promise<void>;
	copyToClipboard: (text: string, message?: string) => Promise<void>;
	getContextColor: (usage: number, theme: Theme) => string;
	setGitLogOpen?: (open: boolean) => void;
	setAgentSessionsOpen: (open: boolean) => void;
	setMemoryViewerOpen: (open: boolean) => void;
	setActiveAgentSessionId: (id: string | null) => void;
	onStopBatchRun?: (sessionId?: string) => void;
	onOpenWorktreeConfig?: () => void;
	onOpenCreatePR?: () => void;
	hasCapability: (cap: keyof AgentCapabilities) => boolean;
}

export const MainPanelHeader = React.memo(function MainPanelHeader({
	activeSession,
	activeTab,
	theme,
	gitInfo,
	sshRemoteName,
	activeTabContextWindow,
	activeTabContextTokens,
	activeTabContextUsage,
	isCurrentSessionAutoMode,
	isCurrentSessionStopping,
	currentSessionBatchState,
	isWorktreeChild,
	activeFileTabId,
	refreshGitStatus,
	handleViewGitDiff,
	copyToClipboard,
	getContextColor,
	setGitLogOpen,
	setAgentSessionsOpen,
	setMemoryViewerOpen,
	setActiveAgentSessionId,
	onStopBatchRun,
	onOpenWorktreeConfig,
	onOpenCreatePR,
	hasCapability,
}: MainPanelHeaderProps) {
	const shortcuts = useSettingsStore((s) => s.shortcuts);
	const rightPanelOpen = useUIStore((s) => s.rightPanelOpen);

	const headerRef = useRef<HTMLDivElement>(null);
	const gitTooltip = useHoverTooltip(150);
	const contextTooltip = useHoverTooltip(150);

	return (
		<div
			ref={headerRef}
			className={`header-container h-16 border-b flex items-center justify-between px-6 shrink-0 relative z-20 ${isCurrentSessionAutoMode ? 'header-auto-mode' : ''}`}
			style={{
				borderColor: theme.colors.border,
				backgroundColor: theme.colors.bgSidebar,
			}}
			data-tour="header-controls"
		>
			<div className="flex items-center gap-4 min-w-0 overflow-hidden">
				<div className="flex items-center gap-2 text-sm font-medium min-w-0 overflow-hidden">
					{/* Session name - hidden at narrow widths via CSS container query */}
					<span className="header-session-name truncate">{activeSession.name}</span>
					{activeSession.bookmarked && (
						<Bookmark
							className="w-3.5 h-3.5 shrink-0"
							style={{ color: theme.colors.accent }}
							fill={theme.colors.accent}
							data-testid="bookmark-icon"
						/>
					)}
					<div
						className="relative shrink-0"
						onMouseEnter={
							activeSession.isGitRepo ? gitTooltip.triggerHandlers.onMouseEnter : undefined
						}
						onMouseLeave={gitTooltip.triggerHandlers.onMouseLeave}
						onFocus={activeSession.isGitRepo ? gitTooltip.triggerHandlers.onMouseEnter : undefined}
						onBlur={gitTooltip.triggerHandlers.onMouseLeave}
					>
						{/* SSH Host Pill - show SSH remote name when running remotely (replaces GIT/LOCAL badge) */}
						{activeSession.sessionSshRemoteConfig?.enabled && sshRemoteName ? (
							<button
								className={`flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border border-purple-500/30 text-purple-500 bg-purple-500/10 max-w-[120px] outline-none ${
									activeSession.isGitRepo ? 'cursor-pointer hover:bg-purple-500/20' : ''
								}`}
								title={`SSH Remote: ${sshRemoteName}${activeSession.isGitRepo && gitInfo?.branch ? ` (${gitInfo.branch})` : ''}`}
								onClick={(e) => {
									e.stopPropagation();
									if (activeSession.isGitRepo) {
										refreshGitStatus(); // Refresh git info immediately on click
										setGitLogOpen?.(true);
									}
								}}
							>
								<Server className="w-3 h-3 shrink-0" />
								<span className="truncate uppercase">{sshRemoteName}</span>
							</button>
						) : (
							<button
								className={`flex items-center gap-1.5 text-xs px-2 py-0.5 rounded-full border cursor-pointer outline-none ${
									activeSession.isGitRepo
										? 'border-orange-500/30 text-orange-500 bg-orange-500/10 hover:bg-orange-500/20'
										: 'border-blue-500/30 text-blue-500 bg-blue-500/10'
								}`}
								onClick={(e) => {
									e.stopPropagation();
									if (activeSession.isGitRepo) {
										refreshGitStatus(); // Refresh git info immediately on click
										setGitLogOpen?.(true);
									}
								}}
								title={activeSession.isGitRepo && gitInfo?.branch ? gitInfo.branch : undefined}
							>
								{activeSession.isGitRepo ? (
									<>
										<GitBranch className="w-3 h-3 shrink-0" />
										{/* Hide branch name text at narrow widths via CSS container query */}
										<span className="header-git-branch-text truncate">
											{gitInfo?.branch || 'GIT'}
										</span>
									</>
								) : (
									'LOCAL'
								)}
							</button>
						)}
						{activeSession.isGitRepo && gitTooltip.isOpen && gitInfo && (
							<>
								{/* Invisible bridge to prevent hover gap */}
								<div
									className="absolute left-0 right-0 h-3 pointer-events-auto"
									style={{ top: '100%' }}
									{...gitTooltip.contentHandlers}
								/>
								<div
									className="absolute top-full left-0 pt-2 w-96 z-50 pointer-events-auto"
									{...gitTooltip.contentHandlers}
								>
									<div
										className="rounded shadow-xl"
										style={{
											backgroundColor: theme.colors.bgSidebar,
											border: `1px solid ${theme.colors.border}`,
										}}
									>
										{/* Branch / Origin / Status */}
										<div
											className="p-3 space-y-2 border-b"
											style={{ borderColor: theme.colors.border }}
										>
											{/* Branch row */}
											<div className="flex items-center gap-2">
												<span
													className="text-[10px] uppercase font-bold w-14 shrink-0"
													style={{ color: theme.colors.textDim }}
												>
													Branch
												</span>
												<GitBranch className="w-3.5 h-3.5 text-orange-500 shrink-0" />
												<span
													className="text-xs font-mono font-medium truncate"
													style={{ color: theme.colors.textMain }}
												>
													{gitInfo.branch}
												</span>
												<div className="flex items-center gap-1.5 ml-auto shrink-0">
													{gitInfo.ahead > 0 && (
														<span className="flex items-center gap-0.5 text-xs text-green-500">
															<ArrowUp className="w-3 h-3" />
															{gitInfo.ahead}
														</span>
													)}
													{gitInfo.behind > 0 && (
														<span className="flex items-center gap-0.5 text-xs text-red-500">
															<ArrowDown className="w-3 h-3" />
															{gitInfo.behind}
														</span>
													)}
													<GhostIconButton
														onClick={(e) => {
															e.stopPropagation();
															copyToClipboard(
																gitInfo.branch,
																`"${gitInfo.branch}" copied to clipboard`
															);
														}}
														title="Copy branch name"
														ariaLabel="Copy branch name"
													>
														<Copy className="w-3 h-3" style={{ color: theme.colors.textDim }} />
													</GhostIconButton>
												</div>
											</div>

											{/* Origin row */}
											{gitInfo.remote && (
												<div className="flex items-center gap-2">
													<span
														className="text-[10px] uppercase font-bold w-14 shrink-0"
														style={{ color: theme.colors.textDim }}
													>
														Origin
													</span>
													<ExternalLink
														className="w-3 h-3 shrink-0"
														style={{ color: theme.colors.textDim }}
													/>
													<button
														onClick={(e) => {
															e.stopPropagation();
															const url = remoteUrlToBrowserUrl(gitInfo.remote);
															if (url) openUrl(url);
														}}
														className="text-xs font-mono truncate hover:underline text-left"
														style={{ color: theme.colors.textMain }}
														title={`Open ${gitInfo.remote}`}
													>
														{gitInfo.remote.replace(/^https?:\/\//, '').replace(/\.git$/, '')}
													</button>
													<button
														onClick={(e) => {
															e.stopPropagation();
															copyToClipboard(gitInfo.remote);
														}}
														className="p-1 rounded hover:bg-white/10 transition-colors ml-auto shrink-0"
														title="Copy remote URL"
													>
														<Copy className="w-3 h-3" style={{ color: theme.colors.textDim }} />
													</button>
												</div>
											)}

											{/* Status row */}
											<div className="flex items-center gap-2">
												<span
													className="text-[10px] uppercase font-bold w-14 shrink-0"
													style={{ color: theme.colors.textDim }}
												>
													Status
												</span>
												{gitInfo.uncommittedChanges > 0 ? (
													<span
														className="flex items-center gap-1.5 text-xs"
														style={{ color: theme.colors.textMain }}
													>
														<FileEdit className="w-3 h-3 text-orange-500" />
														{gitInfo.uncommittedChanges} uncommitted{' '}
														{gitInfo.uncommittedChanges === 1 ? 'change' : 'changes'}
													</span>
												) : (
													<span className="flex items-center gap-1.5 text-xs text-green-500">
														Working tree clean
													</span>
												)}
											</div>
										</div>

										{/* Worktree Actions */}
										<div className="p-2 space-y-1">
											{/* Configure Worktrees - only for parent sessions (not worktree children) */}
											{!isWorktreeChild && onOpenWorktreeConfig && (
												<button
													onClick={(e) => {
														e.stopPropagation();
														onOpenWorktreeConfig();
														gitTooltip.close();
													}}
													className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded text-xs hover:bg-white/10 transition-colors"
													style={{ color: theme.colors.textDim }}
												>
													<Settings2
														className="w-3.5 h-3.5"
														style={{ color: theme.colors.textDim }}
													/>
													Configure Worktrees
												</button>
											)}
											{/* Create PR - only for worktree children */}
											{isWorktreeChild && onOpenCreatePR && (
												<button
													onClick={(e) => {
														e.stopPropagation();
														onOpenCreatePR();
														gitTooltip.close();
													}}
													className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded text-xs hover:bg-white/10 transition-colors"
													style={{ color: theme.colors.textDim }}
												>
													<GitPullRequest
														className="w-3.5 h-3.5"
														style={{ color: theme.colors.textDim }}
													/>
													Create Pull Request
												</button>
											)}
										</div>
									</div>
								</div>
							</>
						)}
					</div>
				</div>

				{/* Git Status Widget - compact mode handled via CSS container queries */}
				<GitStatusWidget
					sessionId={activeSession.id}
					isGitRepo={activeSession.isGitRepo}
					theme={theme}
					onViewDiff={handleViewGitDiff}
					onViewLog={() => setGitLogOpen?.(true)}
				/>
			</div>

			{/* Center: AUTO Mode Indicator - only show for current session */}
			{isCurrentSessionAutoMode && (
				<button
					onClick={() => {
						if (isCurrentSessionStopping) return;
						// Call onStopBatchRun with the active session's ID to stop THIS session's batch
						onStopBatchRun?.(activeSession.id);
					}}
					disabled={isCurrentSessionStopping}
					className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg font-bold text-xs transition-all shrink-0 ${isCurrentSessionStopping ? 'cursor-not-allowed' : 'hover:opacity-90 cursor-pointer'}`}
					style={{
						backgroundColor: isCurrentSessionStopping ? theme.colors.warning : theme.colors.error,
						color: isCurrentSessionStopping ? theme.colors.bgMain : 'white',
						pointerEvents: isCurrentSessionStopping ? 'none' : 'auto',
					}}
					title={
						isCurrentSessionStopping ? 'Stopping after current task...' : 'Click to stop auto-run'
					}
				>
					{isCurrentSessionStopping ? <Spinner size={16} /> : <Wand2 className="w-4 h-4" />}
					<span className="uppercase tracking-wider">
						{isCurrentSessionStopping ? 'Stopping' : 'Auto'}
					</span>
					{/* Hide progress count when stopping - spinner is sufficient */}
					{currentSessionBatchState && !isCurrentSessionStopping && (
						<span className="text-[10px] opacity-80">
							{currentSessionBatchState.completedTasks}/{currentSessionBatchState.totalTasks}
						</span>
					)}
					{currentSessionBatchState?.worktreeActive && (
						<span title={`Worktree: ${currentSessionBatchState.worktreeBranch || 'active'}`}>
							<GitBranch className="w-3.5 h-3.5 ml-0.5" />
						</span>
					)}
				</button>
			)}

			<div className="flex items-center gap-3 justify-end shrink-0">
				{/* Session UUID Pill - click to copy full UUID, hidden at narrow widths via CSS container query */}
				{/* Hide when file preview tab is focused - session stats are only relevant for AI tabs */}
				{activeSession.inputMode === 'ai' &&
					!activeFileTabId &&
					activeTab?.agentSessionId &&
					hasCapability('supportsSessionId') && (
						<button
							className="header-uuid-pill text-[10px] font-mono font-bold px-2 py-0.5 rounded-full border transition-colors hover:opacity-80"
							style={{
								backgroundColor: theme.colors.accent + '20',
								color: theme.colors.accent,
								borderColor: theme.colors.accent + '30',
							}}
							title={
								activeTab.name
									? `${activeTab.name}\nClick to copy: ${activeTab.agentSessionId}`
									: `Click to copy: ${activeTab.agentSessionId}`
							}
							onClick={(e) => {
								e.stopPropagation();
								copyToClipboard(activeTab.agentSessionId!, 'Session ID Copied to Clipboard');
							}}
						>
							{activeTab.agentSessionId.split('-')[0].toUpperCase()}
						</button>
					)}

				{/* Cost Tracker - styled as pill, hidden at narrow widths via CSS container query */}
				{/* Hide when file preview tab is focused - cost tracking is only relevant for AI tabs */}
				{activeSession.inputMode === 'ai' &&
					!activeFileTabId &&
					(activeTab?.agentSessionId || activeTab?.usageStats) &&
					hasCapability('supportsCostTracking') && (
						<span className="header-cost-widget text-xs font-mono font-bold px-2 py-0.5 rounded-full border border-green-500/30 text-green-500 bg-green-500/10">
							${(activeTab?.usageStats?.totalCostUsd ?? 0).toFixed(2)}
						</span>
					)}

				{/* Context Window Widget with Tooltip - only show when context window is configured and agent supports usage stats */}
				{/* Hide when file preview tab is focused - context usage is only relevant for AI tabs */}
				{activeSession.inputMode === 'ai' &&
					!activeFileTabId &&
					(activeTab?.agentSessionId || activeTab?.usageStats) &&
					hasCapability('supportsUsageStats') &&
					activeTabContextWindow > 0 && (
						<div
							className="header-context-widget flex flex-col items-end mr-2 relative cursor-pointer"
							{...contextTooltip.triggerHandlers}
						>
							{/* Full label shown at wide widths, compact label shown at narrow widths via CSS */}
							<span
								className="header-context-label-full text-[10px] font-bold uppercase"
								style={{ color: theme.colors.textDim }}
							>
								Context Window
							</span>
							<span
								className="header-context-label-compact text-[10px] font-bold uppercase hidden"
								style={{ color: theme.colors.textDim }}
								aria-hidden="true"
							>
								Context
							</span>
							{/* Gauge width controlled via CSS container query */}
							<div
								className="header-context-gauge w-24 h-1.5 rounded-full mt-1 overflow-hidden"
								style={{ backgroundColor: theme.colors.border }}
							>
								<div
									className="h-full transition-all duration-500 ease-out"
									style={{
										width: `${activeTabContextUsage}%`,
										backgroundColor: getContextColor(activeTabContextUsage, theme),
									}}
								/>
							</div>

							{/* Context Window Tooltip */}
							{contextTooltip.isOpen && activeSession.inputMode === 'ai' && (
								<>
									{/* Invisible bridge to prevent hover gap */}
									<div
										className="absolute left-0 right-0 h-3 pointer-events-auto"
										style={{ top: '100%' }}
										{...contextTooltip.contentHandlers}
									/>
									<div
										className="absolute top-full right-0 pt-2 w-64 z-50 pointer-events-auto"
										{...contextTooltip.contentHandlers}
									>
										<div
											className="border rounded-lg p-3 shadow-xl"
											style={{
												backgroundColor: theme.colors.bgSidebar,
												borderColor: theme.colors.border,
											}}
										>
											<div
												className="text-[10px] uppercase font-bold mb-3"
												style={{ color: theme.colors.textDim }}
											>
												Context Details
											</div>

											<div className="space-y-2">
												<div className="flex justify-between items-center">
													<span className="text-xs" style={{ color: theme.colors.textDim }}>
														Input Tokens
													</span>
													<span
														className="text-xs font-mono"
														style={{ color: theme.colors.textMain }}
													>
														{(activeTab?.usageStats?.inputTokens ?? 0).toLocaleString('en-US')}
													</span>
												</div>
												<div className="flex justify-between items-center">
													<span className="text-xs" style={{ color: theme.colors.textDim }}>
														Output Tokens
													</span>
													<span
														className="text-xs font-mono"
														style={{ color: theme.colors.textMain }}
													>
														{(activeTab?.usageStats?.outputTokens ?? 0).toLocaleString('en-US')}
													</span>
												</div>
												{/* Reasoning tokens - only shown for agents that report them (e.g., Codex o3/o4-mini) */}
												{(activeTab?.usageStats?.reasoningTokens ?? 0) > 0 && (
													<div className="flex justify-between items-center">
														<span className="text-xs" style={{ color: theme.colors.textDim }}>
															Reasoning Tokens
															<span className="ml-1 text-[10px] opacity-60">(in output)</span>
														</span>
														<span
															className="text-xs font-mono"
															style={{ color: theme.colors.textMain }}
														>
															{(activeTab?.usageStats?.reasoningTokens ?? 0).toLocaleString(
																'en-US'
															)}
														</span>
													</div>
												)}
												<div className="flex justify-between items-center">
													<span className="text-xs" style={{ color: theme.colors.textDim }}>
														Cache Read
													</span>
													<span
														className="text-xs font-mono"
														style={{ color: theme.colors.textMain }}
													>
														{(activeTab?.usageStats?.cacheReadInputTokens ?? 0).toLocaleString(
															'en-US'
														)}
													</span>
												</div>
												<div className="flex justify-between items-center">
													<span className="text-xs" style={{ color: theme.colors.textDim }}>
														Cache Write
													</span>
													<span
														className="text-xs font-mono"
														style={{ color: theme.colors.textMain }}
													>
														{(activeTab?.usageStats?.cacheCreationInputTokens ?? 0).toLocaleString(
															'en-US'
														)}
													</span>
												</div>

												{/* Context usage section - only shown when contextWindow is configured */}
												{activeTabContextWindow > 0 && (
													<div
														className="border-t pt-2 mt-2"
														style={{ borderColor: theme.colors.border }}
													>
														<div className="flex justify-between items-center">
															<span
																className="text-xs font-bold"
																style={{ color: theme.colors.textDim }}
															>
																Context Tokens
															</span>
															<span
																className="text-xs font-mono font-bold"
																style={{ color: theme.colors.accent }}
															>
																{activeTabContextTokens.toLocaleString('en-US')}
															</span>
														</div>
														<div className="flex justify-between items-center mt-1">
															<span
																className="text-xs font-bold"
																style={{ color: theme.colors.textDim }}
															>
																Context Size
															</span>
															<span
																className="text-xs font-mono font-bold"
																style={{ color: theme.colors.textMain }}
															>
																{activeTabContextWindow.toLocaleString('en-US')}
															</span>
														</div>
														<div className="flex justify-between items-center mt-1">
															<span
																className="text-xs font-bold"
																style={{ color: theme.colors.textDim }}
															>
																Usage
															</span>
															<span
																className="text-xs font-mono font-bold"
																style={{
																	color: getContextColor(activeTabContextUsage, theme),
																}}
															>
																{activeTabContextUsage}%
															</span>
														</div>
													</div>
												)}
											</div>
										</div>
									</div>
								</>
							)}
						</div>
					)}

				{/* Memory Viewer Button - only show if agent maintains per-project memory */}
				{hasCapability('supportsProjectMemory') && (
					<button
						onClick={() => setMemoryViewerOpen(true)}
						className="p-2 rounded hover:bg-white/5"
						title={`Memory Viewer (${shortcuts.openMemoryViewer ? formatShortcutKeys(shortcuts.openMemoryViewer.keys) : formatShortcutKeys(['Meta', 'Shift', 'm'])})`}
						data-tour="memory-viewer-button"
					>
						<Brain className="w-4 h-4" style={{ color: theme.colors.textDim }} />
					</button>
				)}

				{/* Agent Sessions Button - only show if agent supports session storage */}
				{hasCapability('supportsSessionStorage') && (
					<button
						onClick={() => {
							setActiveAgentSessionId(null);
							setAgentSessionsOpen(true);
						}}
						className="p-2 rounded hover:bg-white/5"
						title={`Agent Sessions (${shortcuts.agentSessions ? formatShortcutKeys(shortcuts.agentSessions.keys) : formatShortcutKeys(['Meta', 'Shift', 'l'])})`}
						data-tour="agent-sessions-button"
					>
						<List className="w-4 h-4" style={{ color: theme.colors.textDim }} />
					</button>
				)}

				{!rightPanelOpen && (
					<button
						onClick={() => useUIStore.getState().setRightPanelOpen(true)}
						className="p-2 rounded hover:bg-white/5"
						title={`Show right panel (${formatShortcutKeys(shortcuts.toggleRightPanel.keys)})`}
					>
						<Columns className="w-4 h-4" />
					</button>
				)}
			</div>
		</div>
	);
});
