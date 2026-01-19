import React, { useEffect, useMemo, startTransition } from 'react';
import {
	Terminal,
	Cpu,
	Keyboard,
	ImageIcon,
	X,
	ArrowUp,
	Eye,
	History,
	File,
	Folder,
	GitBranch,
	Tag,
	PenLine,
	Brain,
	Wand2,
} from 'lucide-react';
import type { Session, Theme, BatchRunState, Shortcut } from '../types';
import { formatShortcutKeys } from '../utils/shortcutFormatter';
import type { TabCompletionSuggestion, TabCompletionFilter } from '../hooks';
import type {
	SummarizeProgress,
	SummarizeResult,
	GroomingProgress,
	MergeResult,
} from '../types/contextMerge';
import { ThinkingStatusPill } from './ThinkingStatusPill';
import { MergeProgressOverlay } from './MergeProgressOverlay';
import { ExecutionQueueIndicator } from './ExecutionQueueIndicator';
import { ContextWarningSash } from './ContextWarningSash';
import { SummarizeProgressOverlay } from './SummarizeProgressOverlay';
import { WizardInputPanel } from './InlineWizard';
import { useAgentCapabilities, useScrollIntoView } from '../hooks';
import { getProviderDisplayName } from '../utils/sessionValidation';

interface SlashCommand {
	command: string;
	description: string;
	terminalOnly?: boolean;
	aiOnly?: boolean;
}

interface InputAreaProps {
	session: Session;
	theme: Theme;
	inputValue: string;
	setInputValue: (value: string) => void;
	enterToSend: boolean;
	setEnterToSend: (value: boolean) => void;
	stagedImages: string[];
	setStagedImages: React.Dispatch<React.SetStateAction<string[]>>;
	setLightboxImage: (
		image: string | null,
		contextImages?: string[],
		source?: 'staged' | 'history'
	) => void;
	commandHistoryOpen: boolean;
	setCommandHistoryOpen: (open: boolean) => void;
	commandHistoryFilter: string;
	setCommandHistoryFilter: (filter: string) => void;
	commandHistorySelectedIndex: number;
	setCommandHistorySelectedIndex: (index: number) => void;
	slashCommandOpen: boolean;
	setSlashCommandOpen: (open: boolean) => void;
	slashCommands: SlashCommand[];
	selectedSlashCommandIndex: number;
	setSelectedSlashCommandIndex: (index: number) => void;
	inputRef: React.RefObject<HTMLTextAreaElement>;
	handleInputKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
	handlePaste: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void;
	handleDrop: (e: React.DragEvent<HTMLElement>) => void;
	toggleInputMode: () => void;
	processInput: () => void;
	handleInterrupt: () => void;
	onInputFocus: () => void;
	onInputBlur?: () => void;
	// Auto mode props
	isAutoModeActive?: boolean;
	// Tab completion props
	tabCompletionOpen?: boolean;
	setTabCompletionOpen?: (open: boolean) => void;
	tabCompletionSuggestions?: TabCompletionSuggestion[];
	selectedTabCompletionIndex?: number;
	setSelectedTabCompletionIndex?: (index: number) => void;
	tabCompletionFilter?: TabCompletionFilter;
	setTabCompletionFilter?: (filter: TabCompletionFilter) => void;
	// @ mention completion props (AI mode only)
	atMentionOpen?: boolean;
	setAtMentionOpen?: (open: boolean) => void;
	atMentionFilter?: string;
	setAtMentionFilter?: (filter: string) => void;
	atMentionStartIndex?: number;
	setAtMentionStartIndex?: (index: number) => void;
	atMentionSuggestions?: Array<{
		value: string;
		type: 'file' | 'folder';
		displayText: string;
		fullPath: string;
		source?: 'project' | 'autorun';
	}>;
	selectedAtMentionIndex?: number;
	setSelectedAtMentionIndex?: (index: number) => void;
	// ThinkingStatusPill props - PERF: receive pre-filtered thinkingSessions instead of full sessions
	// This prevents re-renders when unrelated session updates occur (e.g., terminal output)
	thinkingSessions?: Session[];
	namedSessions?: Record<string, string>;
	onSessionClick?: (sessionId: string, tabId?: string) => void;
	autoRunState?: BatchRunState;
	onStopAutoRun?: () => void;
	// ExecutionQueueIndicator props
	onOpenQueueBrowser?: () => void;
	// Read-only mode toggle (per-tab)
	tabReadOnlyMode?: boolean;
	onToggleTabReadOnlyMode?: () => void;
	// Save to History toggle (per-tab)
	tabSaveToHistory?: boolean;
	onToggleTabSaveToHistory?: () => void;
	// Prompt composer modal
	onOpenPromptComposer?: () => void;
	// Shortcuts for displaying keyboard hints
	shortcuts?: Record<string, Shortcut>;
	// Flash notification callback
	showFlashNotification?: (message: string) => void;
	// Show Thinking toggle (per-tab)
	tabShowThinking?: boolean;
	onToggleTabShowThinking?: () => void;
	supportsThinking?: boolean; // From agent capabilities
	// Context warning sash props (Phase 6)
	contextUsage?: number; // 0-100 percentage
	contextWarningsEnabled?: boolean;
	contextWarningYellowThreshold?: number;
	contextWarningRedThreshold?: number;
	onSummarizeAndContinue?: () => void;
	// Summarization progress props (non-blocking, per-tab)
	summarizeProgress?: SummarizeProgress | null;
	summarizeResult?: SummarizeResult | null;
	summarizeStartTime?: number;
	isSummarizing?: boolean;
	onCancelSummarize?: () => void;
	// Merge progress props (non-blocking, per-tab)
	mergeProgress?: GroomingProgress | null;
	mergeResult?: MergeResult | null;
	mergeStartTime?: number;
	isMerging?: boolean;
	mergeSourceName?: string;
	mergeTargetName?: string;
	onCancelMerge?: () => void;
	// Inline wizard mode props
	onExitWizard?: () => void;
	// Wizard thinking toggle
	wizardShowThinking?: boolean;
	onToggleWizardShowThinking?: () => void;
}

export const InputArea = React.memo(function InputArea(props: InputAreaProps) {
	const {
		session,
		theme,
		inputValue,
		setInputValue,
		enterToSend,
		setEnterToSend,
		stagedImages,
		setStagedImages,
		setLightboxImage,
		commandHistoryOpen,
		setCommandHistoryOpen,
		commandHistoryFilter,
		setCommandHistoryFilter,
		commandHistorySelectedIndex,
		setCommandHistorySelectedIndex,
		slashCommandOpen,
		setSlashCommandOpen,
		slashCommands,
		selectedSlashCommandIndex,
		setSelectedSlashCommandIndex,
		inputRef,
		handleInputKeyDown,
		handlePaste,
		handleDrop,
		toggleInputMode,
		processInput,
		handleInterrupt,
		onInputFocus,
		onInputBlur,
		isAutoModeActive = false,
		tabCompletionOpen = false,
		setTabCompletionOpen,
		tabCompletionSuggestions = [],
		selectedTabCompletionIndex = 0,
		setSelectedTabCompletionIndex,
		tabCompletionFilter = 'all',
		setTabCompletionFilter,
		atMentionOpen = false,
		setAtMentionOpen,
		atMentionFilter = '',
		setAtMentionFilter,
		atMentionStartIndex = -1,
		setAtMentionStartIndex,
		atMentionSuggestions = [],
		selectedAtMentionIndex = 0,
		setSelectedAtMentionIndex,
		thinkingSessions = [],
		namedSessions,
		onSessionClick,
		autoRunState,
		onStopAutoRun,
		onOpenQueueBrowser,
		tabReadOnlyMode = false,
		onToggleTabReadOnlyMode,
		tabSaveToHistory = false,
		onToggleTabSaveToHistory,
		onOpenPromptComposer,
		shortcuts,
		showFlashNotification,
		tabShowThinking = false,
		onToggleTabShowThinking,
		supportsThinking = false,
		// Context warning sash props (Phase 6)
		contextUsage = 0,
		contextWarningsEnabled = false,
		contextWarningYellowThreshold = 60,
		contextWarningRedThreshold = 80,
		onSummarizeAndContinue,
		// Summarization progress props
		summarizeProgress,
		summarizeResult,
		summarizeStartTime = 0,
		isSummarizing = false,
		onCancelSummarize,
		// Merge progress props
		mergeProgress,
		mergeResult,
		mergeStartTime = 0,
		isMerging = false,
		mergeSourceName,
		mergeTargetName,
		onCancelMerge,
		// Inline wizard mode props
		onExitWizard,
		// Wizard thinking toggle
		wizardShowThinking = false,
		onToggleWizardShowThinking,
	} = props;

	// Get agent capabilities for conditional feature rendering
	const { hasCapability } = useAgentCapabilities(session.toolType);

	// PERF: Memoize activeTab lookup to avoid O(n) search on every render
	const activeTab = useMemo(
		() => session.aiTabs?.find((tab) => tab.id === session.activeTabId),
		[session.aiTabs, session.activeTabId]
	);

	// Get wizardState from active tab (not session level - wizard state is per-tab)
	const wizardState = activeTab?.wizardState;

	// PERF: Memoize derived state to avoid recalculation on every render
	const isResumingSession = !!activeTab?.agentSessionId;
	const canAttachImages = useMemo(() => {
		// Check if images are supported - depends on whether we're resuming an existing session
		// If the active tab has an agentSessionId, we're resuming and need to check supportsImageInputOnResume
		return isResumingSession
			? hasCapability('supportsImageInputOnResume')
			: hasCapability('supportsImageInput');
	}, [isResumingSession, hasCapability]);

	// PERF: Memoize mode-related derived state
	const { isReadOnlyMode, showQueueingBorder } = useMemo(() => {
		// Check if we're in read-only mode (manual toggle only - Claude will be in plan mode)
		// NOTE: Auto Run no longer forces read-only mode. Instead:
		// - Yellow border shows during Auto Run to indicate queuing will happen for write messages
		// - User can freely toggle read-only mode during Auto Run
		// - If read-only is ON: message sends immediately (parallel read-only operations allowed)
		// - If read-only is OFF: message queues until Auto Run completes (prevents file conflicts)
		const readOnly = tabReadOnlyMode && session.inputMode === 'ai';
		// Check if Auto Run is active - used for yellow border indication (queuing will happen for write messages)
		const autoRunActive = isAutoModeActive && session.inputMode === 'ai';
		// Show yellow border when: read-only mode is on OR Auto Run is active (both indicate special input handling)
		return {
			isReadOnlyMode: readOnly,
			showQueueingBorder: readOnly || autoRunActive,
		};
	}, [tabReadOnlyMode, isAutoModeActive, session.inputMode]);

	// Filter slash commands based on input and current mode
	const isTerminalMode = session.inputMode === 'terminal';

	// thinkingSessions is now passed directly from App.tsx (pre-filtered) for better performance

	// Get the appropriate command history based on current mode
	// Fall back to legacy commandHistory for sessions created before the split
	const legacyHistory: string[] = (session as any).commandHistory || [];
	const shellHistory: string[] = session.shellCommandHistory || [];
	const aiHistory: string[] = session.aiCommandHistory || [];
	const currentCommandHistory: string[] = isTerminalMode
		? shellHistory.length > 0
			? shellHistory
			: legacyHistory
		: aiHistory.length > 0
			? aiHistory
			: legacyHistory;

	// Use the slash commands passed from App.tsx (already includes custom + Claude commands)
	// PERF: Memoize both the lowercase conversion and filtered results to avoid
	// recalculating on every render - inputValue changes on every keystroke
	const inputValueLower = useMemo(() => inputValue.toLowerCase(), [inputValue]);
	const filteredSlashCommands = useMemo(() => {
		return slashCommands.filter((cmd) => {
			// Check if command is only available in terminal mode
			if (cmd.terminalOnly && !isTerminalMode) return false;
			// Check if command is only available in AI mode
			if (cmd.aiOnly && isTerminalMode) return false;
			// Check if command matches input
			return cmd.command.toLowerCase().startsWith(inputValueLower);
		});
	}, [slashCommands, isTerminalMode, inputValueLower]);

	// Ensure selectedSlashCommandIndex is valid for the filtered list
	const safeSelectedIndex = Math.min(
		Math.max(0, selectedSlashCommandIndex),
		Math.max(0, filteredSlashCommands.length - 1)
	);

	// Use scroll-into-view hooks for all dropdown lists
	const slashCommandItemRefs = useScrollIntoView<HTMLDivElement>(
		slashCommandOpen,
		safeSelectedIndex,
		filteredSlashCommands.length
	);
	const tabCompletionItemRefs = useScrollIntoView<HTMLDivElement>(
		tabCompletionOpen,
		selectedTabCompletionIndex,
		tabCompletionSuggestions.length
	);
	const atMentionItemRefs = useScrollIntoView<HTMLDivElement>(
		atMentionOpen,
		selectedAtMentionIndex,
		atMentionSuggestions.length
	);

	// Memoize command history filtering to avoid expensive Set operations on every keystroke
	const commandHistoryFilterLower = commandHistoryFilter.toLowerCase();
	const filteredCommandHistory = useMemo(() => {
		const uniqueHistory = Array.from(new Set(currentCommandHistory));
		return uniqueHistory
			.filter((cmd) => cmd.toLowerCase().includes(commandHistoryFilterLower))
			.reverse()
			.slice(0, 10);
	}, [currentCommandHistory, commandHistoryFilterLower]);

	// Auto-resize textarea when switching tabs
	// This ensures the textarea height matches the content when switching between tabs
	// PERF: Only depend on activeTabId, NOT inputValue - inputValue changes on every keystroke
	// and would cause expensive layout reflow (scrollHeight access) on each character typed
	useEffect(() => {
		if (inputRef.current) {
			inputRef.current.style.height = 'auto';
			inputRef.current.style.height = `${Math.min(inputRef.current.scrollHeight, 112)}px`;
		}
	}, [session.activeTabId, inputRef]);

	// Show summarization progress overlay when active for this tab
	if (isSummarizing && session.inputMode === 'ai' && onCancelSummarize) {
		return (
			<SummarizeProgressOverlay
				theme={theme}
				progress={summarizeProgress || null}
				result={summarizeResult || null}
				onCancel={onCancelSummarize}
				startTime={summarizeStartTime}
			/>
		);
	}

	// Show merge progress overlay when active for this tab
	if (isMerging && session.inputMode === 'ai' && onCancelMerge) {
		return (
			<MergeProgressOverlay
				theme={theme}
				progress={mergeProgress || null}
				result={mergeResult || null}
				sourceName={mergeSourceName}
				targetName={mergeTargetName}
				onCancel={onCancelMerge}
				startTime={mergeStartTime}
			/>
		);
	}

	// Show WizardInputPanel when wizard is active AND in AI mode (wizardState is per-tab)
	// When in terminal mode, show the normal terminal input even if wizard is active
	if (wizardState?.isActive && onExitWizard && session.inputMode === 'ai') {
		return (
			<WizardInputPanel
				session={session}
				theme={theme}
				inputValue={inputValue}
				setInputValue={setInputValue}
				inputRef={inputRef}
				handleInputKeyDown={handleInputKeyDown}
				handlePaste={handlePaste}
				processInput={processInput}
				stagedImages={stagedImages}
				setStagedImages={setStagedImages}
				onOpenPromptComposer={onOpenPromptComposer}
				toggleInputMode={toggleInputMode}
				confidence={wizardState.confidence}
				canAttachImages={canAttachImages}
				isBusy={wizardState.isWaiting || session.state === 'busy'}
				onExitWizard={onExitWizard}
				enterToSend={enterToSend}
				setEnterToSend={setEnterToSend}
				onInputFocus={onInputFocus}
				onInputBlur={onInputBlur}
				showFlashNotification={showFlashNotification}
				setLightboxImage={setLightboxImage}
				showThinking={wizardShowThinking}
				onToggleShowThinking={onToggleWizardShowThinking}
			/>
		);
	}

	return (
		<div
			className="relative p-4 border-t"
			style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgSidebar }}
		>
			{/* ThinkingStatusPill - only show in AI mode when there are thinking sessions or AutoRun */}
			{session.inputMode === 'ai' && (thinkingSessions.length > 0 || autoRunState?.isRunning) && (
				<ThinkingStatusPill
					thinkingSessions={thinkingSessions}
					theme={theme}
					onSessionClick={onSessionClick}
					namedSessions={namedSessions}
					autoRunState={autoRunState}
					activeSessionId={session.id}
					onStopAutoRun={onStopAutoRun}
					onInterrupt={handleInterrupt}
				/>
			)}

			{/* ExecutionQueueIndicator - show when items are queued in AI mode */}
			{session.inputMode === 'ai' && onOpenQueueBrowser && (
				<ExecutionQueueIndicator session={session} theme={theme} onClick={onOpenQueueBrowser} />
			)}

			{/* Only show staged images in AI mode */}
			{session.inputMode === 'ai' && stagedImages.length > 0 && (
				<div className="flex gap-2 mb-3 pb-2 overflow-x-auto overflow-y-visible scrollbar-thin">
					{stagedImages.map((img, idx) => (
						<div key={idx} className="relative group shrink-0">
							<img
								src={img}
								className="h-16 rounded border cursor-pointer hover:opacity-80 transition-opacity"
								style={{
									borderColor: theme.colors.border,
									objectFit: 'contain',
									maxWidth: '200px',
								}}
								onClick={() => setLightboxImage(img, stagedImages, 'staged')}
							/>
							<button
								onClick={(e) => {
									e.stopPropagation();
									setStagedImages((p) => p.filter((_, i) => i !== idx));
								}}
								className="absolute top-0.5 right-0.5 bg-red-500 text-white rounded-full p-1 shadow-md hover:bg-red-600 transition-colors opacity-90 hover:opacity-100"
							>
								<X className="w-3 h-3" />
							</button>
						</div>
					))}
				</div>
			)}

			{/* Slash Command Autocomplete - shows built-in and custom commands for all agents */}
			{slashCommandOpen && filteredSlashCommands.length > 0 && (
				<div
					className="absolute bottom-full left-0 right-0 mb-2 border rounded-lg shadow-2xl overflow-hidden"
					style={{ backgroundColor: theme.colors.bgSidebar, borderColor: theme.colors.border }}
				>
					<div
						className="overflow-y-auto max-h-64 scrollbar-thin"
						style={{ overscrollBehavior: 'contain' }}
					>
						{filteredSlashCommands.map((cmd, idx) => (
							<div
								key={cmd.command}
								ref={(el) => (slashCommandItemRefs.current[idx] = el)}
								className={`px-4 py-3 cursor-pointer transition-colors ${
									idx === safeSelectedIndex ? 'font-semibold' : ''
								}`}
								style={{
									backgroundColor: idx === safeSelectedIndex ? theme.colors.accent : 'transparent',
									color: idx === safeSelectedIndex ? theme.colors.bgMain : theme.colors.textMain,
								}}
								onClick={() => {
									// Single click just selects the item
									setSelectedSlashCommandIndex(idx);
								}}
								onDoubleClick={() => {
									// Double click fills in the command text
									setInputValue(cmd.command);
									setSlashCommandOpen(false);
									inputRef.current?.focus();
								}}
								onMouseEnter={() => setSelectedSlashCommandIndex(idx)}
							>
								<div className="font-mono text-sm">{cmd.command}</div>
								<div className="text-xs opacity-70 mt-0.5">{cmd.description}</div>
							</div>
						))}
					</div>
				</div>
			)}

			{/* Command History Modal */}
			{commandHistoryOpen && (
				<div
					className="absolute bottom-full left-0 right-0 mb-2 border rounded-lg shadow-2xl max-h-64 overflow-hidden"
					style={{ backgroundColor: theme.colors.bgSidebar, borderColor: theme.colors.border }}
				>
					<div className="p-2">
						<input
							autoFocus
							type="text"
							className="w-full bg-transparent outline-none text-sm p-2 border-b"
							style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
							placeholder={isTerminalMode ? 'Filter commands...' : 'Filter messages...'}
							value={commandHistoryFilter}
							onChange={(e) => {
								setCommandHistoryFilter(e.target.value);
								setCommandHistorySelectedIndex(0);
							}}
							onKeyDown={(e) => {
								// Use memoized filteredCommandHistory instead of recalculating
								if (e.key === 'ArrowDown') {
									e.preventDefault();
									setCommandHistorySelectedIndex(
										Math.min(commandHistorySelectedIndex + 1, filteredCommandHistory.length - 1)
									);
								} else if (e.key === 'ArrowUp') {
									e.preventDefault();
									setCommandHistorySelectedIndex(Math.max(commandHistorySelectedIndex - 1, 0));
								} else if (e.key === 'Enter') {
									e.preventDefault();
									if (filteredCommandHistory[commandHistorySelectedIndex]) {
										setInputValue(filteredCommandHistory[commandHistorySelectedIndex]);
										setCommandHistoryOpen(false);
										setCommandHistoryFilter('');
										setTimeout(() => inputRef.current?.focus(), 0);
									}
								} else if (e.key === 'Escape') {
									e.preventDefault();
									e.stopPropagation();
									setCommandHistoryOpen(false);
									setCommandHistoryFilter('');
									setTimeout(() => inputRef.current?.focus(), 0);
								}
							}}
						/>
					</div>
					<div className="max-h-48 overflow-y-auto scrollbar-thin">
						{filteredCommandHistory.slice(0, 5).map((cmd, idx) => {
							const isSelected = idx === commandHistorySelectedIndex;
							const isMostRecent = idx === 0;

							return (
								<div
									key={idx}
									className={`px-3 py-2 cursor-pointer text-sm font-mono ${isSelected ? 'ring-1 ring-inset' : ''} ${isMostRecent ? 'font-semibold' : ''}`}
									style={
										{
											backgroundColor: isSelected
												? theme.colors.bgActivity
												: isMostRecent
													? theme.colors.accent + '15'
													: 'transparent',
											'--tw-ring-color': theme.colors.accent,
											color: theme.colors.textMain,
											borderLeft: isMostRecent ? `2px solid ${theme.colors.accent}` : 'none',
										} as React.CSSProperties
									}
									onClick={() => {
										setInputValue(cmd);
										setCommandHistoryOpen(false);
										setCommandHistoryFilter('');
										inputRef.current?.focus();
									}}
									onMouseEnter={() => setCommandHistorySelectedIndex(idx)}
								>
									{cmd}
								</div>
							);
						})}
						{filteredCommandHistory.length === 0 && (
							<div className="px-3 py-4 text-center text-sm opacity-50">
								{isTerminalMode ? 'No matching commands' : 'No matching messages'}
							</div>
						)}
					</div>
				</div>
			)}

			{/* Tab Completion Dropdown - Terminal mode only */}
			{tabCompletionOpen && isTerminalMode && (
				<div
					className="absolute bottom-full left-0 right-0 mb-2 border rounded-lg shadow-2xl max-h-64 overflow-hidden"
					style={{ backgroundColor: theme.colors.bgSidebar, borderColor: theme.colors.border }}
				>
					<div
						className="px-3 py-2 border-b flex items-center justify-between"
						style={{ borderColor: theme.colors.border }}
					>
						<span className="text-xs opacity-60" style={{ color: theme.colors.textDim }}>
							Tab Completion
						</span>
						{/* Filter buttons - only show in git repos */}
						{session.isGitRepo && setTabCompletionFilter && (
							<div className="flex gap-1">
								{(['all', 'history', 'branch', 'tag', 'file'] as const).map((filterType) => {
									const isActive = tabCompletionFilter === filterType;
									const Icon =
										filterType === 'history'
											? History
											: filterType === 'branch'
												? GitBranch
												: filterType === 'tag'
													? Tag
													: filterType === 'file'
														? File
														: null;
									const label =
										filterType === 'all'
											? 'All'
											: filterType === 'history'
												? 'History'
												: filterType === 'branch'
													? 'Branches'
													: filterType === 'tag'
														? 'Tags'
														: 'Files';
									return (
										<button
											key={filterType}
											onClick={(e) => {
												e.stopPropagation();
												setTabCompletionFilter(filterType);
												setSelectedTabCompletionIndex?.(0);
											}}
											className={`px-2 py-0.5 text-[10px] rounded flex items-center gap-1 transition-colors ${
												isActive ? 'font-medium' : 'opacity-60 hover:opacity-100'
											}`}
											style={{
												backgroundColor: isActive ? theme.colors.accent + '30' : 'transparent',
												color: isActive ? theme.colors.accent : theme.colors.textDim,
												border: isActive
													? `1px solid ${theme.colors.accent}50`
													: '1px solid transparent',
											}}
										>
											{Icon && <Icon className="w-3 h-3" />}
											{label}
										</button>
									);
								})}
							</div>
						)}
					</div>
					<div className="overflow-y-auto max-h-56 scrollbar-thin">
						{tabCompletionSuggestions.length > 0 ? (
							tabCompletionSuggestions.map((suggestion, idx) => {
								const isSelected = idx === selectedTabCompletionIndex;
								const IconComponent =
									suggestion.type === 'history'
										? History
										: suggestion.type === 'branch'
											? GitBranch
											: suggestion.type === 'tag'
												? Tag
												: suggestion.type === 'folder'
													? Folder
													: File;
								const typeLabel = suggestion.type;

								return (
									<div
										key={`${suggestion.type}-${suggestion.value}`}
										ref={(el) => (tabCompletionItemRefs.current[idx] = el)}
										className={`px-3 py-2 cursor-pointer text-sm font-mono flex items-center gap-2 ${isSelected ? 'ring-1 ring-inset' : ''}`}
										style={
											{
												backgroundColor: isSelected ? theme.colors.bgActivity : 'transparent',
												'--tw-ring-color': theme.colors.accent,
												color: theme.colors.textMain,
											} as React.CSSProperties
										}
										onClick={() => {
											setInputValue(suggestion.value);
											setTabCompletionOpen?.(false);
											inputRef.current?.focus();
										}}
										onMouseEnter={() => setSelectedTabCompletionIndex?.(idx)}
									>
										<IconComponent
											className="w-3.5 h-3.5 flex-shrink-0"
											style={{
												color:
													suggestion.type === 'history'
														? theme.colors.accent
														: suggestion.type === 'branch'
															? theme.colors.success
															: suggestion.type === 'tag'
																? theme.colors.accentText
																: suggestion.type === 'folder'
																	? theme.colors.warning
																	: theme.colors.textDim,
											}}
										/>
										<span className="flex-1 truncate">{suggestion.displayText}</span>
										<span className="text-[10px] opacity-40 flex-shrink-0">{typeLabel}</span>
									</div>
								);
							})
						) : (
							<div
								className="px-3 py-4 text-center text-sm opacity-50"
								style={{ color: theme.colors.textDim }}
							>
								No matching{' '}
								{tabCompletionFilter === 'all'
									? 'suggestions'
									: tabCompletionFilter === 'history'
										? 'history'
										: tabCompletionFilter === 'branch'
											? 'branches'
											: tabCompletionFilter === 'tag'
												? 'tags'
												: 'files'}
							</div>
						)}
					</div>
				</div>
			)}

			{/* @ Mention Dropdown (AI mode file picker) */}
			{atMentionOpen && !isTerminalMode && atMentionSuggestions.length > 0 && (
				<div
					className="absolute bottom-full left-4 right-4 mb-1 rounded-lg border shadow-lg overflow-hidden z-50"
					style={{ backgroundColor: theme.colors.bgSidebar, borderColor: theme.colors.border }}
				>
					<div
						className="px-3 py-2 border-b text-xs font-medium"
						style={{ borderColor: theme.colors.border, color: theme.colors.textDim }}
					>
						Files{' '}
						{atMentionFilter && <span className="opacity-50">matching "{atMentionFilter}"</span>}
					</div>
					<div className="overflow-y-auto max-h-56 scrollbar-thin">
						{atMentionSuggestions.map((suggestion, idx) => {
							const isSelected = idx === selectedAtMentionIndex;
							const IconComponent = suggestion.type === 'folder' ? Folder : File;

							return (
								<div
									key={`${suggestion.type}-${suggestion.value}`}
									ref={(el) => (atMentionItemRefs.current[idx] = el)}
									className={`px-3 py-2 cursor-pointer text-sm font-mono flex items-center gap-2 ${isSelected ? 'ring-1 ring-inset' : ''}`}
									style={
										{
											backgroundColor: isSelected ? theme.colors.bgActivity : 'transparent',
											'--tw-ring-color': theme.colors.accent,
											color: theme.colors.textMain,
										} as React.CSSProperties
									}
									onClick={() => {
										// Replace @filter with @path
										const beforeAt = inputValue.substring(0, atMentionStartIndex);
										const afterFilter = inputValue.substring(
											atMentionStartIndex + 1 + atMentionFilter.length
										);
										setInputValue(beforeAt + '@' + suggestion.value + ' ' + afterFilter);
										setAtMentionOpen?.(false);
										setAtMentionFilter?.('');
										setAtMentionStartIndex?.(-1);
										inputRef.current?.focus();
									}}
									onMouseEnter={() => setSelectedAtMentionIndex?.(idx)}
								>
									<IconComponent
										className="w-3.5 h-3.5 flex-shrink-0"
										style={{
											color:
												suggestion.type === 'folder' ? theme.colors.warning : theme.colors.textDim,
										}}
									/>
									<span className="flex-1 truncate">{suggestion.fullPath}</span>
									{suggestion.source === 'autorun' && (
										<span
											className="text-[9px] px-1 py-0.5 rounded flex-shrink-0"
											style={{
												backgroundColor: `${theme.colors.accent}30`,
												color: theme.colors.accent,
											}}
										>
											Auto Run
										</span>
									)}
									<span className="text-[10px] opacity-40 flex-shrink-0">{suggestion.type}</span>
								</div>
							);
						})}
					</div>
				</div>
			)}

			<div className="flex gap-3">
				<div className="flex-1 flex flex-col">
					<div
						className="flex-1 relative border rounded-lg bg-opacity-50 flex flex-col"
						style={{
							borderColor: showQueueingBorder ? theme.colors.warning : theme.colors.border,
							backgroundColor: showQueueingBorder
								? `${theme.colors.warning}15`
								: theme.colors.bgMain,
						}}
					>
						<div className="flex items-start">
							{/* Terminal mode prefix */}
							{isTerminalMode && (
								<span
									className="text-sm font-mono font-bold select-none pl-3 pt-3"
									style={{ color: theme.colors.accent }}
								>
									$
								</span>
							)}
							<textarea
								ref={inputRef}
								className={`flex-1 bg-transparent text-sm outline-none ${isTerminalMode ? 'pl-1.5' : 'pl-3'} pt-3 pr-3 resize-none min-h-[2.5rem] scrollbar-thin`}
								style={{ color: theme.colors.textMain, maxHeight: '7rem' }}
								placeholder={
									isTerminalMode
										? 'Run shell command...'
										: `Talking to ${session.name} powered by ${getProviderDisplayName(session.toolType)}`
								}
								value={inputValue}
								onFocus={onInputFocus}
								onBlur={onInputBlur}
								onChange={(e) => {
									const value = e.target.value;
									const cursorPosition = e.target.selectionStart || 0;

									// CRITICAL: Update input value immediately for responsive typing
									setInputValue(value);

									// PERFORMANCE: Use startTransition for non-urgent UI updates
									// This allows React to interrupt these updates if more keystrokes come in
									startTransition(() => {
										// Show slash command autocomplete when typing /
										// Close when there's a space or newline (user is adding arguments or multiline content)
										if (value.startsWith('/') && !value.includes(' ') && !value.includes('\n')) {
											if (!slashCommandOpen) {
												setSelectedSlashCommandIndex(0);
											}
											setSlashCommandOpen(true);
										} else {
											setSlashCommandOpen(false);
										}

										// @ mention file completion (AI mode only)
										if (
											!isTerminalMode &&
											setAtMentionOpen &&
											setAtMentionFilter &&
											setAtMentionStartIndex &&
											setSelectedAtMentionIndex
										) {
											const textBeforeCursor = value.substring(0, cursorPosition);
											const lastAtPos = textBeforeCursor.lastIndexOf('@');

											if (lastAtPos === -1) {
												setAtMentionOpen(false);
											} else {
												const isValidTrigger = lastAtPos === 0 || /\s/.test(value[lastAtPos - 1]);
												const textAfterAt = value.substring(lastAtPos + 1, cursorPosition);
												const hasSpaceAfterAt = textAfterAt.includes(' ');

												if (isValidTrigger && !hasSpaceAfterAt) {
													setAtMentionOpen(true);
													setAtMentionFilter(textAfterAt);
													setAtMentionStartIndex(lastAtPos);
													setSelectedAtMentionIndex(0);
												} else {
													setAtMentionOpen(false);
												}
											}
										}
									});

									// PERFORMANCE: Auto-grow logic deferred to next animation frame
									// This prevents layout thrashing from blocking the keystroke handling
									const textarea = e.target;
									requestAnimationFrame(() => {
										textarea.style.height = 'auto';
										textarea.style.height = `${Math.min(textarea.scrollHeight, 112)}px`;
									});
								}}
								onKeyDown={handleInputKeyDown}
								onPaste={handlePaste}
								onDrop={(e) => {
									e.stopPropagation();
									handleDrop(e);
								}}
								onDragOver={(e) => e.preventDefault()}
								rows={1}
							/>
						</div>

						<div className="flex justify-between items-center px-2 pb-2 pt-1">
							<div className="flex gap-1 items-center">
								{session.inputMode === 'terminal' && (
									<div
										className="text-xs font-mono opacity-60 px-2"
										style={{ color: theme.colors.textDim }}
									>
										{/* For SSH sessions, show hostname:remoteCwd; for local sessions, show shellCwd */}
										{(() => {
											const isRemote = !!(
												session.sshRemoteId || session.sessionSshRemoteConfig?.enabled
											);
											const path = isRemote
												? session.remoteCwd ||
													session.sessionSshRemoteConfig?.workingDirOverride ||
													session.cwd
												: session.shellCwd || session.cwd;
											const displayPath =
												path?.replace(/^\/Users\/[^\/]+/, '~').replace(/^\/home\/[^\/]+/, '~') ||
												'~';
											// For SSH sessions, prefix with hostname (uppercase)
											if (isRemote && session.sshRemote?.name) {
												return `${session.sshRemote.name.toUpperCase()}:${displayPath}`;
											}
											return displayPath;
										})()}
									</div>
								)}
								{session.inputMode === 'ai' && onOpenPromptComposer && (
									<button
										onClick={onOpenPromptComposer}
										className="p-1 hover:bg-white/10 rounded opacity-50 hover:opacity-100"
										title={`Open Prompt Composer${shortcuts?.openPromptComposer ? ` (${formatShortcutKeys(shortcuts.openPromptComposer.keys)})` : ''}`}
									>
										<PenLine className="w-4 h-4" />
									</button>
								)}
								{session.inputMode === 'ai' && canAttachImages && (
									<button
										onClick={() => document.getElementById('image-file-input')?.click()}
										className="p-1 hover:bg-white/10 rounded opacity-50 hover:opacity-100"
										title="Attach Image"
									>
										<ImageIcon className="w-4 h-4" />
									</button>
								)}
								<input
									id="image-file-input"
									type="file"
									accept="image/*"
									multiple
									className="hidden"
									onChange={(e) => {
										const files = Array.from(e.target.files || []);
										files.forEach((file) => {
											const reader = new FileReader();
											reader.onload = (event) => {
												if (event.target?.result) {
													const imageData = event.target!.result as string;
													setStagedImages((prev) => {
														if (prev.includes(imageData)) {
															showFlashNotification?.('Duplicate image ignored');
															return prev;
														}
														return [...prev, imageData];
													});
												}
											};
											reader.readAsDataURL(file);
										});
										e.target.value = '';
									}}
								/>
							</div>

							<div className="flex items-center gap-2">
								{/* Save to History toggle - AI mode only */}
								{session.inputMode === 'ai' && onToggleTabSaveToHistory && (
									<button
										onClick={onToggleTabSaveToHistory}
										className={`flex items-center gap-1.5 text-[10px] px-2 py-1 rounded-full cursor-pointer transition-all ${
											tabSaveToHistory ? '' : 'opacity-40 hover:opacity-70'
										}`}
										style={{
											backgroundColor: tabSaveToHistory
												? `${theme.colors.accent}25`
												: 'transparent',
											color: tabSaveToHistory ? theme.colors.accent : theme.colors.textDim,
											border: tabSaveToHistory
												? `1px solid ${theme.colors.accent}50`
												: '1px solid transparent',
										}}
										title="Save to History (Cmd+S) - Synopsis added after each completion"
									>
										<History className="w-3 h-3" />
										<span>History</span>
									</button>
								)}
								{/* Read-only mode toggle - AI mode only, if agent supports it */}
								{/* User can freely toggle read-only during Auto Run */}
								{session.inputMode === 'ai' &&
									onToggleTabReadOnlyMode &&
									hasCapability('supportsReadOnlyMode') && (
										<button
											onClick={onToggleTabReadOnlyMode}
											className={`flex items-center gap-1.5 text-[10px] px-2 py-1 rounded-full cursor-pointer transition-all ${
												isReadOnlyMode ? '' : 'opacity-40 hover:opacity-70'
											}`}
											style={{
												backgroundColor: isReadOnlyMode
													? `${theme.colors.warning}25`
													: 'transparent',
												color: isReadOnlyMode ? theme.colors.warning : theme.colors.textDim,
												border: isReadOnlyMode
													? `1px solid ${theme.colors.warning}50`
													: '1px solid transparent',
											}}
											title="Toggle read-only mode (agent won't modify files)"
										>
											<Eye className="w-3 h-3" />
											<span>Read-only</span>
										</button>
									)}
								{/* Show Thinking toggle - AI mode only, for agents that support it */}
								{session.inputMode === 'ai' && supportsThinking && onToggleTabShowThinking && (
									<button
										onClick={onToggleTabShowThinking}
										className={`flex items-center gap-1.5 text-[10px] px-2 py-1 rounded-full cursor-pointer transition-all ${
											tabShowThinking ? '' : 'opacity-40 hover:opacity-70'
										}`}
										style={{
											backgroundColor: tabShowThinking
												? `${theme.colors.accentText}25`
												: 'transparent',
											color: tabShowThinking ? theme.colors.accentText : theme.colors.textDim,
											border: tabShowThinking
												? `1px solid ${theme.colors.accentText}50`
												: '1px solid transparent',
										}}
										title="Show Thinking - Stream AI reasoning in real-time"
									>
										<Brain className="w-3 h-3" />
										<span>Thinking</span>
									</button>
								)}
								<button
									onClick={() => setEnterToSend(!enterToSend)}
									className="flex items-center gap-1 text-[10px] opacity-50 hover:opacity-100 px-2 py-1 rounded hover:bg-white/5"
									title={enterToSend ? 'Switch to Meta+Enter to send' : 'Switch to Enter to send'}
								>
									<Keyboard className="w-3 h-3" />
									{enterToSend ? 'Enter' : '⌘ + Enter'}
								</button>
							</div>
						</div>
					</div>
					{/* Context Warning Sash - AI mode only, appears below input when context usage is high */}
					{session.inputMode === 'ai' && onSummarizeAndContinue && (
						<ContextWarningSash
							theme={theme}
							contextUsage={contextUsage}
							yellowThreshold={contextWarningYellowThreshold}
							redThreshold={contextWarningRedThreshold}
							enabled={contextWarningsEnabled}
							onSummarizeClick={onSummarizeAndContinue}
							tabId={session.activeTabId}
						/>
					)}
				</div>

				{/* Mode Toggle & Send/Interrupt Button - Right Side */}
				<div className="flex flex-col gap-2">
					<button
						type="button"
						onClick={toggleInputMode}
						className="p-2 rounded-lg border transition-all"
						style={{
							backgroundColor: theme.colors.bgMain,
							borderColor: theme.colors.border,
							color: theme.colors.textDim,
						}}
						title="Toggle Mode (Cmd+J)"
					>
						{session.inputMode === 'terminal' ? (
							<Terminal className="w-4 h-4" />
						) : wizardState?.isActive ? (
							<Wand2 className="w-4 h-4" style={{ color: theme.colors.accent }} />
						) : (
							<Cpu className="w-4 h-4" />
						)}
					</button>
					{/* Send button - always visible. Stop button is now in ThinkingStatusPill */}
					<button
						type="button"
						onClick={() => processInput()}
						className="p-2 rounded-md shadow-sm transition-all hover:opacity-90 cursor-pointer"
						style={{
							backgroundColor: theme.colors.accent,
							color: theme.colors.accentForeground,
						}}
						title={session.inputMode === 'terminal' ? 'Run command (Enter)' : 'Send message'}
					>
						<ArrowUp className="w-4 h-4" />
					</button>
				</div>
			</div>
		</div>
	);
});
