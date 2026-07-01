import React, { useEffect, useMemo } from 'react';
import { useSettingsStore } from '../../stores/settingsStore';
import { ThinkingStatusPill } from '../ThinkingStatusPill';
import { QuitWhenIdleIndicator } from '../QuitWhenIdleIndicator';
import { MergeProgressOverlay } from '../MergeProgressOverlay';
import { ExecutionQueueIndicator } from '../ExecutionQueueIndicator';
import { ContextWarningSash } from '../ContextWarningSash';
import { SummarizeProgressOverlay } from '../SummarizeProgressOverlay';
import { WizardInputPanel } from '../InlineWizard';
import { useImageAnnotatorStore } from '../ImageAnnotator/imageAnnotatorStore';
import { useAgentCapabilities, useScrollIntoView } from '../../hooks';
import { filterSlashCommands } from '../../utils/search';
import { InputTextarea } from './components/InputTextarea';
import { NotificationSendControls } from './components/NotificationSendControls';
import { StagedImagesStrip } from './components/StagedImagesStrip';
import { ToolbarControls } from './components/ToolbarControls';
import { useInputAreaAutosize } from './hooks/useInputAreaAutosize';
import { useInputAreaTextChange } from './hooks/useInputAreaTextChange';
import { useModelEffortMenus } from './hooks/useModelEffortMenus';
import { AtMentionPopover } from './overlays/AtMentionPopover';
import { CommandHistoryPopover } from './overlays/CommandHistoryPopover';
import { SlashCommandPopover } from './overlays/SlashCommandPopover';
import { TabCompletionPopover } from './overlays/TabCompletionPopover';
import type { InputAreaProps } from './types';
import { filterCommandHistory, getCurrentCommandHistory } from './utils/commandHistory';

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
		atMentionItems = [],
		atMentionCounts,
		atMentionCategory = 'all',
		setAtMentionCategory,
		selectedAtMentionIndex = 0,
		setSelectedAtMentionIndex,
		thinkingItems = [],
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
		tabShowThinking = 'off',
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
		// Model/Effort quick-change pills
		currentModel,
		currentEffort,
		availableModels = [],
		availableEfforts = [],
		onModelChange,
		onEffortChange,
	} = props;

	const spellCheckEnabled = useSettingsStore((state) => state.spellCheck);
	const openAnnotator = useImageAnnotatorStore((state) => state.openAnnotator);
	const {
		modelMenuOpen,
		setModelMenuOpen,
		modelMenuRef,
		effortMenuOpen,
		setEffortMenuOpen,
		effortMenuRef,
	} = useModelEffortMenus();

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

	// thinkingItems is now passed directly from App.tsx (pre-filtered) for better performance

	const currentCommandHistory = useMemo(
		() => getCurrentCommandHistory(session, isTerminalMode),
		[session, isTerminalMode]
	);

	// Use the slash commands passed from App.tsx (already includes custom + Claude commands)
	// PERF: Memoize both the lowercase conversion and filtered results to avoid
	// recalculating on every render - inputValue changes on every keystroke
	const inputValueLower = useMemo(() => inputValue.toLowerCase(), [inputValue]);
	const filteredSlashCommands = useMemo(() => {
		const query = inputValueLower.replace(/^\//, '');
		return filterSlashCommands(slashCommands, query, isTerminalMode);
	}, [slashCommands, isTerminalMode, inputValueLower]);

	// Reset the highlighted item to the top whenever the query changes or the
	// menu opens. Without this, the index lingers from prior arrow navigation
	// and gets clamped to the (often shorter) filtered list, leaving a non-top
	// item highlighted by default.
	useEffect(() => {
		if (slashCommandOpen) {
			setSelectedSlashCommandIndex(0);
		}
	}, [inputValueLower, slashCommandOpen, setSelectedSlashCommandIndex]);

	// Ensure selectedSlashCommandIndex is valid for the filtered list
	const safeSelectedIndex = Math.min(
		Math.max(0, selectedSlashCommandIndex),
		Math.max(0, filteredSlashCommands.length - 1)
	);

	// Use scroll-into-view hooks for all dropdown lists
	const slashCommandItemRefs = useScrollIntoView<HTMLButtonElement>(
		slashCommandOpen,
		safeSelectedIndex,
		filteredSlashCommands.length
	);
	const tabCompletionItemRefs = useScrollIntoView<HTMLButtonElement>(
		tabCompletionOpen,
		selectedTabCompletionIndex,
		tabCompletionSuggestions.length
	);
	const atMentionItemRefs = useScrollIntoView<HTMLButtonElement>(
		atMentionOpen,
		selectedAtMentionIndex,
		atMentionItems.length
	);

	const filteredCommandHistory = useMemo(
		() => filterCommandHistory(currentCommandHistory, commandHistoryFilter),
		[currentCommandHistory, commandHistoryFilter]
	);

	useInputAreaAutosize({
		inputRef,
		inputValue,
		activeTabId: session.activeTabId,
	});

	const handleTextChange = useInputAreaTextChange({
		isTerminalMode,
		slashCommandOpen,
		atMentionOpen,
		setInputValue,
		setSlashCommandOpen,
		setSelectedSlashCommandIndex,
		setAtMentionOpen,
		setAtMentionFilter,
		setAtMentionStartIndex,
		setSelectedAtMentionIndex,
		setAtMentionCategory,
	});

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
				isInitializing={wizardState.isInitializing ?? false}
				isBusy={wizardState.isWaiting || activeTab?.state === 'busy'}
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
			{/* QuitWhenIdleIndicator - sits above the thinking pill while a deferred quit is armed */}
			<QuitWhenIdleIndicator theme={theme} />

			{/* ThinkingStatusPill - only show in AI mode when there are thinking items or AutoRun */}
			{session.inputMode === 'ai' && (thinkingItems.length > 0 || autoRunState?.isRunning) && (
				<ThinkingStatusPill
					thinkingItems={thinkingItems}
					theme={theme}
					onSessionClick={onSessionClick}
					namedSessions={namedSessions}
					autoRunState={autoRunState}
					activeSessionId={session.id}
					activeTabId={session.activeTabId}
					onStopAutoRun={onStopAutoRun}
					onInterrupt={handleInterrupt}
				/>
			)}

			{/* ExecutionQueueIndicator - show when items are queued in AI mode */}
			{session.inputMode === 'ai' && onOpenQueueBrowser && (
				<ExecutionQueueIndicator
					session={session}
					theme={theme}
					onClick={onOpenQueueBrowser}
					onSwitchTab={onSessionClick}
				/>
			)}

			<StagedImagesStrip
				isVisible={session.inputMode === 'ai'}
				stagedImages={stagedImages}
				theme={theme}
				setLightboxImage={setLightboxImage}
				setStagedImages={setStagedImages}
				openAnnotator={openAnnotator}
			/>

			<SlashCommandPopover
				isOpen={slashCommandOpen}
				commands={filteredSlashCommands}
				inputValueLower={inputValueLower}
				selectedIndex={safeSelectedIndex}
				itemRefs={slashCommandItemRefs}
				theme={theme}
				setInputValue={setInputValue}
				setSlashCommandOpen={setSlashCommandOpen}
				setSelectedSlashCommandIndex={setSelectedSlashCommandIndex}
				inputRef={inputRef}
			/>

			<CommandHistoryPopover
				isOpen={commandHistoryOpen}
				isTerminalMode={isTerminalMode}
				filter={commandHistoryFilter}
				selectedIndex={commandHistorySelectedIndex}
				filteredHistory={filteredCommandHistory}
				theme={theme}
				setFilter={setCommandHistoryFilter}
				setOpen={setCommandHistoryOpen}
				setSelectedIndex={setCommandHistorySelectedIndex}
				setInputValue={setInputValue}
				inputRef={inputRef}
			/>

			<TabCompletionPopover
				isOpen={tabCompletionOpen}
				isTerminalMode={isTerminalMode}
				isGitRepo={session.isGitRepo}
				suggestions={tabCompletionSuggestions}
				selectedIndex={selectedTabCompletionIndex}
				filter={tabCompletionFilter}
				itemRefs={tabCompletionItemRefs}
				theme={theme}
				setInputValue={setInputValue}
				setOpen={setTabCompletionOpen}
				setFilter={setTabCompletionFilter}
				setSelectedIndex={setSelectedTabCompletionIndex}
				inputRef={inputRef}
			/>

			<AtMentionPopover
				isOpen={atMentionOpen}
				isTerminalMode={isTerminalMode}
				items={atMentionItems}
				counts={atMentionCounts}
				category={atMentionCategory}
				setCategory={setAtMentionCategory}
				selectedIndex={selectedAtMentionIndex}
				filter={atMentionFilter}
				startIndex={atMentionStartIndex}
				inputValue={inputValue}
				itemRefs={atMentionItemRefs}
				theme={theme}
				setInputValue={setInputValue}
				setOpen={setAtMentionOpen}
				setFilter={setAtMentionFilter}
				setStartIndex={setAtMentionStartIndex}
				setSelectedIndex={setSelectedAtMentionIndex}
				inputRef={inputRef}
			/>

			<div className="flex min-w-0 gap-3">
				<div className="flex min-w-0 flex-1 flex-col">
					<div
						className="relative flex min-w-0 flex-1 flex-col rounded-lg border bg-opacity-50"
						style={{
							borderColor: showQueueingBorder ? theme.colors.warning : theme.colors.border,
							backgroundColor: showQueueingBorder
								? `${theme.colors.warning}15`
								: theme.colors.bgMain,
						}}
					>
						<InputTextarea
							session={session}
							theme={theme}
							isTerminalMode={isTerminalMode}
							inputValue={inputValue}
							spellCheckEnabled={spellCheckEnabled}
							inputRef={inputRef}
							onInputFocus={onInputFocus}
							onInputBlur={onInputBlur}
							onChange={handleTextChange}
							handleInputKeyDown={handleInputKeyDown}
							handlePaste={handlePaste}
							handleDrop={handleDrop}
						/>

						<ToolbarControls
							session={session}
							theme={theme}
							isTerminalMode={isTerminalMode}
							isReadOnlyMode={isReadOnlyMode}
							canAttachImages={canAttachImages}
							hasReadOnlyCapability={hasCapability('supportsReadOnlyMode')}
							enterToSend={enterToSend}
							setEnterToSend={setEnterToSend}
							setStagedImages={setStagedImages}
							onOpenPromptComposer={onOpenPromptComposer}
							shortcuts={shortcuts}
							showFlashNotification={showFlashNotification}
							tabSaveToHistory={tabSaveToHistory}
							onToggleTabSaveToHistory={onToggleTabSaveToHistory}
							onToggleTabReadOnlyMode={onToggleTabReadOnlyMode}
							tabShowThinking={tabShowThinking}
							onToggleTabShowThinking={onToggleTabShowThinking}
							supportsThinking={supportsThinking}
							currentModel={currentModel}
							currentEffort={currentEffort}
							availableModels={availableModels}
							availableEfforts={availableEfforts}
							onModelChange={onModelChange}
							onEffortChange={onEffortChange}
							modelMenuOpen={modelMenuOpen}
							setModelMenuOpen={setModelMenuOpen}
							modelMenuRef={modelMenuRef}
							effortMenuOpen={effortMenuOpen}
							setEffortMenuOpen={setEffortMenuOpen}
							effortMenuRef={effortMenuRef}
						/>
					</div>
					{/* Context Warning Sash - AI mode only, appears below input when context usage is high */}
					{session.inputMode === 'ai' && contextWarningsEnabled && onSummarizeAndContinue && (
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

				<NotificationSendControls
					theme={theme}
					isTerminalMode={isTerminalMode}
					processInput={processInput}
				/>
			</div>
		</div>
	);
});
