import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { useSettingsStore } from '../../stores/settingsStore';
import {
	useComposerInputStore,
	selectAiComposerValue,
	selectAiCommandMode,
	selectTerminalComposerValue,
} from '../../stores/composerInputStore';
import { ThinkingStatusPill } from '../ThinkingStatusPill';
import { ConcertoCreationPipeline } from '../ConcertoCreationPipeline';
import { CrossAgentResponseIndicator } from '../CrossAgentResponseIndicator';
import { getActiveTab } from '../../utils/tabHelpers';
import { MergeProgressOverlay } from '../MergeProgressOverlay';
import { ExecutionQueueIndicator } from '../ExecutionQueueIndicator';
import { AgentTaskListBar } from '../AgentTaskListBar';
import { ContextWarningSash } from '../ContextWarningSash';
import { SummarizeProgressOverlay } from '../SummarizeProgressOverlay';
import { WizardInputPanel } from '../InlineWizard';
import { useImageAnnotatorStore } from '../ImageAnnotator/imageAnnotatorStore';
import { useAgentCapabilities, useScrollIntoView } from '../../hooks';
import { useComposerVoice } from '../../hooks/voice/useComposerVoice';
import { useThinkingItems } from '../../hooks/session/useThinkingItems';
import { useWindowContextOptional } from '../../contexts/WindowContext';
import { filterSlashCommands } from '../../utils/search';
import { controlledTextDictationTarget } from '../../utils/dictationTargets';
import { InputTextarea } from './components/InputTextarea';
import { useAiTabToolbarBinding } from './hooks/useAiTabToolbarBinding';
import { formatTerminalCwd } from './utils/terminalPath';
import {
	ChatComposerFrame,
	ComposerVoiceSessionButton,
	aiCanAttachImages,
	deriveAiComposerCapabilities,
	useChatComposerFold,
	type ChatComposerToolbarProps,
	type ChatComposerVoice,
} from '../ChatComposer';
import { useAiSendMenu } from './hooks/useAiSendMenu';
import { useInputAreaAutosize } from './hooks/useInputAreaAutosize';
import { useInputAreaTextChange } from './hooks/useInputAreaTextChange';
import { useModelEffortMenus } from './hooks/useModelEffortMenus';
import { AtMentionPopover } from './overlays/AtMentionPopover';
import { CommandHistoryPopover } from './overlays/CommandHistoryPopover';
import { SlashCommandPopover } from './overlays/SlashCommandPopover';
import { TabCompletionPopover } from './overlays/TabCompletionPopover';
import type { InputAreaProps } from './types';
import { filterCommandHistory, getCurrentCommandHistory } from './utils/commandHistory';
import { resolveCommandCwd } from '../../services/shellCommand';
import { CommandModeBar } from './components/CommandModeBar';
import { MentionRoutingBar } from './components/MentionRoutingBar';
import { useMentionRouting } from './hooks/useMentionRouting';
import { AiCommandProposal } from './components/AiCommandProposal';
import { useAiCommandStore, selectAiCommandEntry, aiCommandKey } from '../../stores/aiCommandStore';
import {
	acceptAiCommand,
	dismissAiCommand,
	resolveAiCommandProvenance,
} from '../../services/aiCommand';
import { codifyTurnSettings, projectTabProvider } from '../../utils/providerTabSessions';
import { useComposerModelChoices } from './hooks/useComposerModelChoices';
import { hasStandardApprovalChannel } from '../../../shared/agentMetadata';
import { getSessionSshRemoteId } from '../../utils/sessionHelpers';

/** localStorage key for the phone composer fold (see PhoneComposerHandle). */
export const PHONE_COMPOSER_COLLAPSED_KEY = 'phone.composer.collapsed';

// Stable fallbacks: a fresh `[]` default per render would hand the memoized
// toolbar a new array on every keystroke.
const NO_OPTIONS: string[] = [];

export const InputArea = React.memo(function InputArea(props: InputAreaProps) {
	const {
		session,
		theme,
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
		namedSessions,
		onSessionClick,
		autoRunState,
		onStopAutoRun,
		onOpenQueueBrowser,
		tabReadOnlyMode = false,
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
		onStopWizardTurn,
		// Wizard thinking toggle
		wizardShowThinking = false,
		onToggleWizardShowThinking,
		// Model/Effort quick-change pills
		currentModel,
		currentEffort,
		availableModels = NO_OPTIONS,
		availableEfforts = NO_OPTIONS,
		onModelChange,
		onEffortChange,
		onRefreshModels,
		refreshingModels,
	} = props;

	// Self-source thinking items with a narrow store equality so App/MainPanel
	// are not re-rendered on every streaming log flush.
	const ownsSession = useWindowContextOptional()?.ownsSession;
	const thinkingItems = useThinkingItems(ownsSession);

	const spellCheckEnabled = useSettingsStore((state) => state.spellCheck);
	const encoreFeatures = useSettingsStore((state) => state.encoreFeatures);
	const openAnnotator = useImageAnnotatorStore((state) => state.openAnnotator);
	const {
		modelMenuOpen,
		setModelMenuOpen,
		modelMenuRef,
		effortMenuOpen,
		setEffortMenuOpen,
		effortMenuRef,
	} = useModelEffortMenus();

	// PERF: Memoize activeTab lookup to avoid O(n) search on every render
	const activeTab = useMemo(
		() => session.aiTabs?.find((tab) => tab.id === session.activeTabId),
		[session.aiTabs, session.activeTabId]
	);

	const composerProvider = useMemo(
		() => projectTabProvider(session, activeTab),
		[session, activeTab]
	);
	const { hasCapability } = useAgentCapabilities(
		composerProvider.agent.toolType,
		session.providerTranslationKnowledgeDirectory,
		getSessionSshRemoteId(session)
	);
	const hasStandardCapability =
		hasCapability('supportsStandardPermissionMode') &&
		hasStandardApprovalChannel({
			toolType: composerProvider.agent.toolType,
			harnessControlMode: composerProvider.agent.harnessControlMode,
			codexTransport: composerProvider.agent.codexTransport,
			opencodeServer: encoreFeatures.opencodeServer === true,
			sshEnabled: session.sessionSshRemoteConfig?.enabled === true,
			hasImages: stagedImages.length > 0,
		});

	// Get wizardState from active tab (not session level - wizard state is per-tab)
	const wizardState = activeTab?.wizardState;

	// PERF: Memoize derived state to avoid recalculation on every render
	const isResumingSession = !!activeTab?.agentSessionId;
	const commandMode = useComposerInputStore(selectAiCommandMode);
	// Hide the attach affordance rather than leaving a button that stages an
	// attachment the send path drops on the floor (see aiCanAttachImages).
	const canAttachImages = useMemo(
		() => aiCanAttachImages({ commandMode, isResumingSession, hasCapability }),
		[isResumingSession, hasCapability, commandMode]
	);
	// What the toolbar offers. Memoized on its sources so a keystroke, which
	// re-renders this component, hands the memoized toolbar the same object.
	const composerCapabilities = useMemo(
		() =>
			deriveAiComposerCapabilities({
				inputMode: session.inputMode,
				commandMode,
				isResumingSession,
				hasCapability,
				// The flag says the agent can think; the capability says this tab's
				// provider can stream it.
				supportsThinking: supportsThinking && hasCapability('supportsThinkingDisplay'),
			}),
		[session.inputMode, commandMode, isResumingSession, hasCapability, supportsThinking]
	);

	// The model pill's choices for the tab's provider: Auto where it can act,
	// and the Run on target in place of a named model.
	const modelChoices = useComposerModelChoices(
		composerProvider.agent,
		availableModels,
		currentModel
	);
	const toolbarBinding = useAiTabToolbarBinding(session.id, activeTab);

	// PERF: Memoize mode-related derived state
	// `isReadOnlyMode` stays off the destructure: rc's ToolbarControls reads the
	// read-only state itself rather than taking it as a prop, so main's binding
	// has no consumer here and would only be an unused local.
	const { showQueueingBorder } = useMemo(() => {
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

	// Live composer text. This is the SOLE subscriber to the draft store: a
	// keystroke re-renders only this (memoized) leaf, not App. See
	// useComposerInputStore / CLAUDE-PERFORMANCE.md.
	const inputValue = useComposerInputStore(
		isTerminalMode ? selectTerminalComposerValue : selectAiComposerValue
	);

	// Command mode: the AI composer is holding a shell command line, so it picks
	// up the terminal's CLI affordances (the `$` prefix, the mode bar, and Tab
	// completion over files, dirs, branches, tags, and prior commands). Read from
	// the store rather than sniffed from the text - the `!` is consumed on entry,
	// so the draft looks like any other string.
	const isShellCommandDraft = !isTerminalMode && commandMode === 'shell';
	// AI command mode holds prose, not a command line, so it gets NONE of those
	// shell affordances - completing a branch name into an English sentence is
	// noise, and a `$` in front of "delete the build output" is a lie.
	const isAiCommandDraft = !isTerminalMode && commandMode === 'ai';
	const isShellInput = isTerminalMode || isShellCommandDraft;
	// How the draft's @agent mentions would run if sent now. Plain AI messages
	// only: a command-mode draft is a shell line, not a message to route.
	const mentionRouting = useMentionRouting(
		inputValue,
		session.id,
		session.inputMode === 'ai' && !isTerminalMode && !isShellCommandDraft && !isAiCommandDraft
	);

	// The in-flight suggestion / proposed command for THIS tab, if any. Parked
	// per tab, so switching away and back finds the same card waiting.
	const aiCommandEntry = useAiCommandStore(selectAiCommandEntry(session.id, session.activeTabId));
	const setAiCommandChoice = useAiCommandStore((s) => s.setAiCommandChoice);
	// What the bar advertises. While a request is in flight the entry's stamp
	// wins: settings are codified at send time, so changing the model mid-request
	// applies from the NEXT one, and the bar must not claim otherwise.
	const { turnModel, turnEffort } = useMemo(
		() => codifyTurnSettings(activeTab, session),
		[activeTab, session]
	);
	// Before a request, the bar names whatever the `ai-command` Local Models
	// assignment would ask: the tab's own model by default, or the assigned
	// local model or endpoint.
	const localModelAssignments = useSettingsStore((s) => s.localModelAssignments);
	const localModelEndpoints = useSettingsStore((s) => s.localModelEndpoints);
	const utilitySource = useSettingsStore((s) => s.utilitySource);
	const utilityAgentId = useSettingsStore((s) => s.utilityAgentId);
	const utilityModelId = useSettingsStore((s) => s.utilityModelId);
	const draftProvenance = useMemo(
		() =>
			resolveAiCommandProvenance(
				{ turnModel, turnEffort },
				localModelAssignments,
				localModelEndpoints,
				utilitySource,
				{ utilityAgentId, utilityModelId }
			),
		[
			turnModel,
			turnEffort,
			localModelAssignments,
			localModelEndpoints,
			utilitySource,
			utilityAgentId,
			utilityModelId,
		]
	);
	const aiCommandModel = aiCommandEntry ? aiCommandEntry.model : draftProvenance.model;
	const aiCommandEffort = aiCommandEntry ? aiCommandEntry.effort : draftProvenance.effort;

	// thinkingItems self-sourced via useThinkingItems (narrow store equality)
	// Non-reactive store handles for the change handler below.
	const setAiCommandMode = useMemo(() => useComposerInputStore.getState().setAiCommandMode, []);
	const setMentionRoutingOverride = useMemo(
		() => useComposerInputStore.getState().setMentionRoutingOverride,
		[]
	);
	const getAiValueAtCallTime = useMemo(() => () => useComposerInputStore.getState().aiValue, []);

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
		// PERF: only scan the (potentially large) command list while the popover is
		// actually open. Otherwise this ran filterSlashCommands over every built-in +
		// custom + speckit/openspec + agent command on every single keystroke, even
		// for normal typing that never opens the menu. The consumers of this array
		// (index clamping and SlashCommandPopover, which renders null when closed)
		// are all no-ops when the menu is shut, so returning [] is safe.
		if (!slashCommandOpen) return [];
		const query = inputValueLower.replace(/^\//, '');
		return filterSlashCommands(slashCommands, query, isTerminalMode);
	}, [slashCommands, isTerminalMode, inputValueLower, slashCommandOpen]);

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

	// PERF: shared handoff flag so the keystroke path and the autosize effect don't
	// both reflow the textarea on the same keystroke. onChange sets it and schedules
	// a single deferred (rAF) resize; the effect, which fires synchronously in the
	// commit phase, skips its own (blocking) resize when a keystroke resize is
	// already pending, leaving one reflow per keystroke instead of two. The effect
	// still owns resizing for tab switches and programmatic value changes (draft
	// restore, slash/template insertion) that never fire onChange.
	const keystrokeResizeScheduledRef = useRef(false);

	// Phone: the whole composer folds away behind a slim handle so the transcript
	// gets the screen; the user pulls it up to type. Remembered across reloads,
	// and it starts folded - on a handheld the composer is in the way far more
	// often than it is in use. The handle keeps a busy dot, since Stop lives in
	// the folded thinking pill, and a pencil for an unsent draft. Called here,
	// above the early returns, so the fold survives them like every other hook,
	// and above the autosize, which re-measures the textarea an unfold mounts.
	const composerFold = useChatComposerFold(PHONE_COMPOSER_COLLAPSED_KEY);

	useInputAreaAutosize({
		inputRef,
		inputValue,
		activeTabId: session.activeTabId,
		isFolded: composerFold.isFolded,
		keystrokeResizeScheduledRef,
	});

	const handleTextChange = useInputAreaTextChange({
		isTerminalMode,
		slashCommandOpen,
		atMentionOpen,
		commandMode,
		setCommandMode: setAiCommandMode,
		// Read at call time, not from the `inputValue` closure: onChange fires
		// before setInputValue lands, so the store still holds the pre-edit text -
		// which is exactly what "was the composer empty?" needs to test.
		getPreviousValue: getAiValueAtCallTime,
		keystrokeResizeScheduledRef,
		setInputValue,
		setSlashCommandOpen,
		setSelectedSlashCommandIndex,
		setAtMentionOpen,
		setAtMentionFilter,
		setAtMentionStartIndex,
		setSelectedAtMentionIndex,
		setAtMentionCategory,
	});

	// The composer microphone. With the A Cappella Encore Feature on it opens a
	// voice session bound to this agent; with it off it is the Web Speech
	// dictation this button has always been, unchanged. See `useComposerVoice`.
	// Disabled in terminal mode (the button only renders in AI mode anyway).
	const voice = useComposerVoice({
		session,
		currentValue: inputValue,
		onTranscriptionChange: setInputValue,
		focusRef: inputRef,
		disabled: isTerminalMode,
	});
	// The Web Speech toggle's identity changes on every keystroke (it closes over
	// the live draft value), so wrap it in a stable callback. This keeps the
	// memoized ToolbarControls from re-rendering on each keystroke - it only
	// re-renders when isListening actually flips.
	const voiceToggleRef = useRef(voice.toggle);
	voiceToggleRef.current = voice.toggle;
	const handleToggleVoiceInput = useCallback(() => voiceToggleRef.current(), []);

	// Dictation types into the draft through `setInputValue`, the same setter a
	// restored draft and the Web Speech path use, and never through the
	// textarea's onChange: that handler is where the `!` gesture, the slash
	// popover and the mention picker live, and none of them may fire for words
	// nobody typed. Dictated text therefore never changes the command mode.
	const setInputValueRef = useRef(setInputValue);
	setInputValueRef.current = setInputValue;
	const dictationTarget = useMemo(
		() =>
			controlledTextDictationTarget({
				getElement: () => inputRef.current,
				setValue: (value) => setInputValueRef.current(value),
			}),
		[inputRef]
	);

	const voiceBinding = useMemo<ChatComposerVoice>(
		() => ({
			supported: voice.voiceSupported,
			listening: voice.isListening,
			onToggle: handleToggleVoiceInput,
			handledElsewhere: voice.usesACappella,
		}),
		[voice.voiceSupported, voice.isListening, handleToggleVoiceInput, voice.usesACappella]
	);

	const phoneHandleBusy = thinkingItems.length > 0 || !!autoRunState?.isRunning;
	const phoneHandleHasDraft = inputValue.trim().length > 0 || stagedImages.length > 0;

	const sendMenu = useAiSendMenu(theme, isTerminalMode, processInput);

	// The AI-only toolbar fields. The toolbar is memoized field by field, so this
	// bag's identity does not matter, only that each field is stable.
	const toolbarProps: ChatComposerToolbarProps = {
		isTerminalMode,
		terminalCwd: isTerminalMode ? formatTerminalCwd(session) : undefined,
		// The active tab's provider, so the permission pill reads in its words.
		agentId: composerProvider.agent.toolType,
		hasStandardCapability,
		permissionMode: toolbarBinding.permissionMode,
		onPermissionModeChange: toolbarBinding.onPermissionModeChange,
		onThinkingModeChange: toolbarBinding.onThinkingModeChange,
		tabSaveToHistory,
		onToggleTabSaveToHistory,
		tabShowThinking,
		onToggleTabShowThinking,
		currentModel,
		runOn: modelChoices.runOn,
		autoModelTitle: modelChoices.autoModelTitle,
		currentEffort,
		availableModels: modelChoices.modelOptions,
		availableEfforts,
		onModelChange,
		onEffortChange,
		onRefreshModels,
		refreshingModels,
		modelMenuOpen,
		setModelMenuOpen,
		modelMenuRef,
		effortMenuOpen,
		setEffortMenuOpen,
		effortMenuRef,
	};

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
				onStopTurn={onStopWizardTurn}
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
		<ChatComposerFrame
			theme={theme}
			capabilities={composerCapabilities}
			fold={composerFold}
			isBusy={phoneHandleBusy}
			hasDraft={phoneHandleHasDraft}
			warningBorder={showQueueingBorder}
			// MainPanelContent registers the toast avoid zone around all of InputArea.
			avoidToasts={false}
			raised
			aboveComposer={
				<>
					{/* CrossAgentResponseIndicator - "N agents responding…" while consulted
					    agents stream replies into this tab. Only meaningful in AI mode. */}
					{session.inputMode === 'ai' && (
						<CrossAgentResponseIndicator
							theme={theme}
							sourceSessionId={session.id}
							sourceTabId={getActiveTab(session)?.id}
							onSessionClick={onSessionClick}
							// A message that LEADS with a mention is answered only by the consulted
							// agents, so this agent never goes busy and the thinking pill (the usual
							// home of Stop) never appears - leaving the user with nothing to press
							// while other agents work on their behalf. Carry Stop here in exactly
							// that case, and stay out of the way when the thinking pill is already
							// offering it: both buttons run the same agent-level interrupt, so two
							// of them on screen is just a second copy of one control.
							onInterrupt={
								thinkingItems.length > 0 || autoRunState?.isRunning ? undefined : handleInterrupt
							}
						/>
					)}

					{/* Concerto creation tracks stay separate from the ordinary agent status. */}
					{session.inputMode === 'ai' && thinkingItems.length > 0 && (
						<ConcertoCreationPipeline
							thinkingItems={thinkingItems}
							theme={theme}
							activeSessionId={session.id}
							activeTabId={session.activeTabId}
						/>
					)}

					{/* ThinkingStatusPill - AI mode only. It renders nothing when no work is running: it also
					    watches Auto Runs on OTHER agents, which only it subscribes to. */}
					{session.inputMode === 'ai' && (
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

					{/* AgentTaskListBar - the agent's current checklist, pinned above the
					    composer so it doesn't scroll away with the conversation. */}
					{session.inputMode === 'ai' && <AgentTaskListBar theme={theme} logs={activeTab?.logs} />}
				</>
			}
			overlays={
				<>
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
						isShellInput={isShellInput}
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
				</>
			}
			inputHeader={
				<>
					{(isShellCommandDraft || isAiCommandDraft) && (
						<CommandModeBar
							theme={theme}
							mode={isAiCommandDraft ? 'ai' : 'shell'}
							cwd={resolveCommandCwd(session)}
							remoteName={session.sshRemote?.name}
							isGitRepo={session.isGitRepo}
							model={aiCommandModel}
							effort={aiCommandEffort}
						/>
					)}

					{mentionRouting && (
						<MentionRoutingBar
							theme={theme}
							routing={mentionRouting.routing}
							inferredRouting={mentionRouting.inferredRouting}
							explicit={mentionRouting.explicit}
							agentNames={mentionRouting.agentNames}
							onRoutingChange={setMentionRoutingOverride}
						/>
					)}

					{isAiCommandDraft && aiCommandEntry && (
						<AiCommandProposal
							theme={theme}
							entry={aiCommandEntry}
							onAccept={() => acceptAiCommand(session, aiCommandEntry)}
							onDismiss={() => {
								// Hand the request back so the user can refine it, and put the
								// caret where they can: declining is nearly always "that is not
								// what I meant", not "never mind".
								setInputValue(dismissAiCommand(aiCommandEntry));
								inputRef.current?.focus();
							}}
							onChoose={(choice) =>
								setAiCommandChoice(aiCommandKey(session.id, aiCommandEntry.tabId), choice)
							}
						/>
					)}
				</>
			}
			textarea={
				<InputTextarea
					agentId={session.id}
					agentName={session.name}
					toolType={composerProvider.agent.toolType}
					theme={theme}
					isTerminalMode={isTerminalMode}
					isCommandModeDraft={isShellCommandDraft}
					isAiCommandDraft={isAiCommandDraft}
					awaitingAiCommand={!!aiCommandEntry}
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
			}
			// Context Warning Sash - AI mode only, appears below input when context usage is high
			belowInput={
				session.inputMode === 'ai' &&
				contextWarningsEnabled &&
				onSummarizeAndContinue && (
					<ContextWarningSash
						theme={theme}
						contextUsage={contextUsage}
						yellowThreshold={contextWarningYellowThreshold}
						redThreshold={contextWarningRedThreshold}
						enabled={contextWarningsEnabled}
						onSummarizeClick={onSummarizeAndContinue}
						tabId={session.activeTabId}
					/>
				)
			}
			stagedImages={stagedImages}
			stagedImagesVisible={session.inputMode === 'ai'}
			setStagedImages={setStagedImages}
			draftValue={inputValue}
			onDraftChange={setInputValue}
			setLightboxImage={setLightboxImage}
			openAnnotator={openAnnotator}
			enterToSend={enterToSend}
			setEnterToSend={setEnterToSend}
			voice={voiceBinding}
			dictationTarget={isTerminalMode ? undefined : dictationTarget}
			// The prompt composer is an AI-mode affordance; terminal mode offers none.
			onOpenPromptComposer={session.inputMode === 'ai' ? onOpenPromptComposer : undefined}
			shortcuts={shortcuts}
			showFlashNotification={showFlashNotification}
			toolbarProps={toolbarProps}
			onSend={processInput}
			columnSendTitle={isTerminalMode ? 'Run command (Enter)' : 'Send message'}
			sendMenu={sendMenu}
			// Only when A Cappella owns the microphone. With it off, the button stays
			// the Web Speech dictation one in the toolbar row, which is touch-only -
			// so there is never a second microphone on screen.
			sendColumnExtras={
				!isTerminalMode && voice.usesACappella ? (
					<ComposerVoiceSessionButton
						theme={theme}
						active={voice.isListening}
						onToggle={handleToggleVoiceInput}
						label="Talk to this agent"
						activeLabel="End the voice session"
						testId="composer-voice-button"
					/>
				) : undefined
			}
		/>
	);
});
