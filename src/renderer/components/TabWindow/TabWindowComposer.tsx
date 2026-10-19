/**
 * TabWindowComposer - the composer under an AI tab in a tab window (TW-7).
 *
 * The same `InputArea` an app window shows, with the same keyboard handler
 * (`useInputKeyDown`) and completion lists (`useComposerCompletions`). What
 * differs is where its actions go. A tab window writes no `Session` and starts
 * no process (D1), so every action the owner runs arrives there as an intent
 * (D2): the send itself, Stop, the model, effort, permission, and thinking
 * pills, the Enter-to-send and History toggles, Compact, Steer, and an
 * accepted AI command. What writes nothing the owner keeps stays here: the
 * draft (text, command mode, staged images) and the AI command proposal,
 * which asks the tab's model for a command line from this window.
 *
 * The draft lives in this window while the tab is popped out: the text and
 * mode in this window's composer store, the staged images on its copy of the
 * tab. `useTabWindowDraft` (mounted by `TabWindowRoot`) loads it when the tab
 * shows, keeps it when another tab shows, and writes it back to the owner
 * with the `setDraft` intent. After a send, the cleared draft goes back at
 * once (`flushDraft`).
 *
 * Reduced here (an app-window concern): the inline wizard and the `/history`,
 * `/wizard`, `/skills` built-ins, the Auto Run row of the thinking pill, the
 * queue browser, the Prompt Composer, and the summarize and merge progress
 * overlays. The `@` picker lists files and this agent; other agents are in
 * the owner's store only.
 */

import React, { useCallback, useMemo, useRef } from 'react';
import type { AITab, Session, Theme, ThinkingMode } from '../../types';
import type { TabWindowIntent, TabWindowTabRef } from '../../../shared/tabWindowTypes';
import type { SingleTabType } from '../../../shared/unifiedTabRef';
import { InputProvider, useInputContext } from '../../contexts/InputContext';
import { useSessionStore, updateAiTab } from '../../stores/sessionStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useComposerInputStore } from '../../stores/composerInputStore';
import { getAiCommandEntry, type AiCommandEntry } from '../../stores/aiCommandStore';
import { notifyCenterFlash } from '../../stores/centerFlashStore';
import { useAgentCapabilities } from '../../hooks';
import { useInputKeyDown } from '../../hooks/input/useInputKeyDown';
import { useComposerCompletions } from '../../hooks/input/useComposerCompletions';
import {
	resolveModelEffort,
	useAgentModelEffortOptions,
} from '../../hooks/agent/useAgentModelEffortOptions';
import { useContextWindow } from '../../hooks/mainPanel/useContextWindow';
import { useEventListener } from '../../hooks/utils/useEventListener';
import { requestAiCommand } from '../../services/aiCommand';
import { useAiCommandStore, aiCommandKey } from '../../stores/aiCommandStore';
import {
	sendTabWindowIntent,
	type TabWindowIntentBody,
} from '../../services/tabWindowIntentSender';
import { openLightbox } from '../../services/lightbox';
import {
	CODEX_FOLLOWUP_EVENT,
	resolveCodexFollowup,
	type CodexFollowupRequest,
} from '../../services/codexFollowup';
import { buildSlashCommandList } from '../../slashCommands';
import { buildTabWindowThinkingItems } from '../../utils/thinkingItems';
import { imageFilesIn, readBlobAsDataUrl } from '../../utils/imageData';
import { screenshotReferenceLabel } from '../../utils/stagedImageOrder';
import { APP_WINDOW_ONLY_SLASH_COMMANDS, tabWindowSendRefusal } from '../../utils/tabWindowSend';
import { logger } from '../../utils/logger';
import { InputArea } from '../InputArea';
import { STAGED_IMAGE_MIME } from '../InputArea/components/stagedImageDrag';
import { addStagedImageIfUnique } from '../InputArea/utils/stagedImages';
import { pasteTrimmedText } from '../InputArea/utils/pasteText';

export interface TabWindowComposerProps {
	theme: Theme;
	/** The agent as this window sees it: its active AI tab is `tab`. */
	session: Session;
	/** The AI tab the window shows. */
	tab: AITab;
	/** This window's tabs. */
	tabRefs: TabWindowTabRef[];
	/** The composer textarea (the transcript's Escape returns the caret here). */
	inputRef: React.RefObject<HTMLTextAreaElement>;
	/** Show a tab of this window (a name clicked in the thinking pill). */
	onSelectTab: (type: SingleTabType, id: string) => void;
	/** Send the draft waiting for its typing pause to the owner now (`useTabWindowDraft`). */
	flushDraft: () => void;
}

export function TabWindowComposer(props: TabWindowComposerProps) {
	// The completion dropdowns' state, as an app window keeps it in App.
	return (
		<InputProvider>
			<TabWindowComposerInner {...props} />
		</InputProvider>
	);
}

const EMPTY_IMAGES: string[] = [];

function TabWindowComposerInner({
	theme,
	session,
	tab,
	tabRefs,
	inputRef,
	onSelectTab,
	flushDraft,
}: TabWindowComposerProps) {
	const agentId = session.id;
	const tabId = tab.id;
	const input = useInputContext();
	const shortcuts = useSettingsStore((s) => s.shortcuts);
	const enterToSendAI = useSettingsStore((s) => s.enterToSendAI);
	const customAICommands = useSettingsStore((s) => s.customAICommands);
	const contextWarningsEnabled = useSettingsStore(
		(s) => s.contextManagementSettings.contextWarningsEnabled
	);
	const contextWarningYellowThreshold = useSettingsStore(
		(s) => s.contextManagementSettings.contextWarningYellowThreshold
	);
	const contextWarningRedThreshold = useSettingsStore(
		(s) => s.contextManagementSettings.contextWarningRedThreshold
	);
	const terminalOutputRef = useRef<HTMLDivElement>(null);
	const { hasCapability } = useAgentCapabilities(session.toolType);

	/** Send one intent for the shown tab. */
	const sendIntent = useCallback(
		(intent: TabWindowIntentBody) => {
			sendTabWindowIntent({
				...intent,
				agentId,
				tabRef: { type: 'ai', id: tabId },
			} as TabWindowIntent);
		},
		[agentId, tabId]
	);

	// --- Draft ---
	const setAiValue = useMemo(() => useComposerInputStore.getState().setAiValue, []);
	const setInputValue = useCallback((value: string) => setAiValue(value), [setAiValue]);
	const getInputValue = useCallback(() => useComposerInputStore.getState().aiValue, []);
	const getCommandMode = useCallback(() => useComposerInputStore.getState().aiCommandMode, []);
	const setCommandMode = useMemo(() => useComposerInputStore.getState().setAiCommandMode, []);
	const stagedImages = tab.stagedImages ?? EMPTY_IMAGES;
	const setStagedImages = useCallback(
		(images: string[] | ((prev: string[]) => string[])) => {
			updateAiTab(agentId, tabId, (t) => ({
				...t,
				stagedImages: typeof images === 'function' ? images(t.stagedImages ?? []) : images,
			}));
		},
		[agentId, tabId]
	);
	const showFlashNotification = useCallback(
		(message: string) => notifyCenterFlash({ message, color: 'yellow' }),
		[]
	);

	// --- Send ---
	const processInput = useCallback(
		(
			overrideInputValue?: string,
			options?: { forceParallel?: boolean; steer?: boolean; hold?: boolean }
		) => {
			const live = useSessionStore.getState().sessions.find((s) => s.id === agentId);
			const liveTab = live?.aiTabs.find((t) => t.id === tabId);
			const composer = useComposerInputStore.getState();
			const text = overrideInputValue ?? composer.aiValue;
			const images = liveTab?.stagedImages ?? [];
			const commandMode = composer.aiCommandMode;
			if (!live || (!text.trim() && images.length === 0)) return;

			const refusal = tabWindowSendRefusal(liveTab, text, commandMode, live.toolType);
			if (refusal) {
				notifyCenterFlash({ message: refusal, color: 'yellow' });
				return;
			}
			input.setSlashCommandOpen(false);

			if (commandMode === 'ai') {
				// AI command mode asks the tab's model for a command line, here: the
				// proposal card is this composer's, and nothing runs until the user
				// accepts it (then the owner runs it, `runShellCommand`).
				const request = text.trim();
				setInputValue('');
				if (request && !getAiCommandEntry(agentId, tabId)) {
					requestAiCommand({ session: live, tabId, request }).catch((error) => {
						logger.error('[TabWindow] AI command request failed', undefined, error);
					});
				}
				return;
			}

			sendIntent({
				kind: 'send',
				text,
				images,
				commandMode,
				mentionRoutingOverride: composer.mentionRoutingOverride ?? undefined,
				forceParallel: options?.forceParallel,
				hold: options?.hold,
				steer: options?.steer,
			});
			setInputValue('');
			if (images.length > 0) setStagedImages([]);
			// The owner's copy of the draft must not keep the text it just sent,
			// even for the length of a typing pause (a dock then would bring it back).
			flushDraft();
			if (inputRef.current) inputRef.current.style.height = 'auto';
		},
		[agentId, tabId, input, sendIntent, setInputValue, setStagedImages, flushDraft, inputRef]
	);

	// An accepted proposal runs in the owner, which runs every command for the agent.
	const acceptAiCommand = useCallback(
		(entry: AiCommandEntry) => {
			if (entry.status !== 'proposed' || !entry.command) return;
			useAiCommandStore.getState().clearAiCommand(aiCommandKey(entry.sessionId, entry.tabId));
			sendIntent({ kind: 'runShellCommand', command: entry.command, request: entry.request });
		},
		[sendIntent]
	);

	// --- Keyboard and completions (the app window's own) ---
	const allSlashCommands = useMemo(
		() =>
			buildSlashCommandList({
				toolType: session.toolType,
				customAICommands,
				agentCommands: hasCapability('supportsSlashCommands') ? session.agentCommands : undefined,
				excludeBuiltIns: APP_WINDOW_ONLY_SLASH_COMMANDS,
			}),
		[session.toolType, session.agentCommands, customAICommands, hasCapability]
	);
	const { tabCompletionSuggestions, getTabCompletionSuggestions, atMentionItems, atMentionCounts } =
		useComposerCompletions(agentId, 'ai');
	const { handleInputKeyDown } = useInputKeyDown({
		getInputValue,
		setInputValue: setAiValue,
		tabCompletionSuggestions,
		atMentionItems,
		allSlashCommands,
		// No Files panel to follow the highlighted completion in.
		syncFileTreeToTabCompletion: noop,
		processInput,
		getTabCompletionSuggestions,
		getCommandMode,
		setCommandMode,
		inputRef,
		terminalOutputRef,
		acceptAiCommand: (_session, entry) => acceptAiCommand(entry),
		steerNewest: () => sendIntent({ kind: 'steerNewest' }),
	});

	// --- Paste and drop: read here, staged on this window's draft ---
	const stageImageFiles = useCallback(
		(files: File[]) => {
			for (const file of files) {
				readBlobAsDataUrl(file)
					.then((dataUrl) =>
						setStagedImages((prev) => addStagedImageIfUnique(prev, dataUrl, showFlashNotification))
					)
					.catch((error) => logger.warn('[TabWindow] Could not read an image', undefined, error));
			}
		},
		[setStagedImages, showFlashNotification]
	);
	const refuseImagesInCommandMode = useCallback((): boolean => {
		if (getCommandMode() === 'off') return false;
		notifyCenterFlash({
			message: 'Images are not supported in command mode',
			color: 'yellow',
			detail: 'Press Esc to step back toward the agent',
		});
		return true;
	}, [getCommandMode]);
	const handlePaste = useCallback(
		(e: React.ClipboardEvent<HTMLTextAreaElement>) => {
			const images = imageFilesIn(e.clipboardData);
			if (images.length === 0) {
				pasteTrimmedText(e, setAiValue);
				return;
			}
			e.preventDefault();
			if (refuseImagesInCommandMode()) return;
			stageImageFiles(images);
		},
		[setAiValue, refuseImagesInCommandMode, stageImageFiles]
	);
	const handleDrop = useCallback(
		(e: React.DragEvent<HTMLElement>) => {
			e.preventDefault();
			// A thumbnail dragged out of the staged-image strip inserts its slot
			// reference, as in an app window.
			const stagedImageIndex = e.dataTransfer.getData(STAGED_IMAGE_MIME);
			if (stagedImageIndex !== '') {
				const index = Number(stagedImageIndex);
				if (!Number.isInteger(index) || index < 0 || getCommandMode() !== 'off') return;
				setAiValue((prev) => {
					const label = screenshotReferenceLabel(index);
					if (!prev) return label + ' ';
					return prev + (/\s$/.test(prev) ? '' : ' ') + label + ' ';
				});
				inputRef.current?.focus();
				return;
			}
			const images = imageFilesIn(e.dataTransfer);
			if (images.length === 0 || refuseImagesInCommandMode()) return;
			stageImageFiles(images);
		},
		[getCommandMode, setAiValue, inputRef, refuseImagesInCommandMode, stageImageFiles]
	);

	// --- A Codex follow-up chip in this transcript ---
	useEventListener(CODEX_FOLLOWUP_EVENT, (event) => {
		const resolution = resolveCodexFollowup((event as CustomEvent<CodexFollowupRequest>).detail, {
			activeSessionId: agentId,
			activeTabId: tabId,
		});
		if (resolution.action === 'ignore') return;
		if (resolution.action === 'send') {
			sendIntent({ kind: 'codexFollowup', prompt: resolution.prompt, mode: 'send' });
			return;
		}
		// A prefill is this composer's own draft.
		useComposerInputStore.getState().loadAiDraft(resolution.tabId, resolution.prompt, 'off');
		inputRef.current?.focus();
	});

	// --- Pills and toggles: the owner writes the tab ---
	const { models, efforts, defaultModel, defaultEffort } = useAgentModelEffortOptions(
		session.toolType
	);
	const { model: currentModel, effort: currentEffort } = resolveModelEffort(tab, session, {
		defaultModel,
		defaultEffort,
	});
	const { activeTabContextUsage } = useContextWindow(session, tab);
	const thinkingItems = useMemo(
		() => buildTabWindowThinkingItems(session, tabRefs),
		[session, tabRefs]
	);
	// A name in the thinking pill: a tab of this window shows here; any other is
	// the owner's to show.
	const onSessionClick = useCallback(
		(_sessionId: string, clickedTabId?: string) => {
			if (!clickedTabId) return;
			if (tabRefs.some((ref) => ref.type === 'ai' && ref.id === clickedTabId)) {
				onSelectTab('ai', clickedTabId);
				return;
			}
			sendIntent({ kind: 'focusInOwner', targetTabRef: { type: 'ai', id: clickedTabId } });
		},
		[tabRefs, onSelectTab, sendIntent]
	);

	return (
		<InputArea
			session={session}
			theme={theme}
			setInputValue={setInputValue}
			enterToSend={tab.enterToSend ?? enterToSendAI}
			setEnterToSend={() => sendIntent({ kind: 'toggleEnterToSend' })}
			stagedImages={stagedImages}
			setStagedImages={setStagedImages}
			setLightboxImage={openLightbox}
			commandHistoryOpen={input.commandHistoryOpen}
			setCommandHistoryOpen={input.setCommandHistoryOpen}
			commandHistoryFilter={input.commandHistoryFilter}
			setCommandHistoryFilter={input.setCommandHistoryFilter}
			commandHistorySelectedIndex={input.commandHistorySelectedIndex}
			setCommandHistorySelectedIndex={input.setCommandHistorySelectedIndex}
			slashCommandOpen={input.slashCommandOpen}
			setSlashCommandOpen={input.setSlashCommandOpen}
			slashCommands={allSlashCommands}
			selectedSlashCommandIndex={input.selectedSlashCommandIndex}
			setSelectedSlashCommandIndex={input.setSelectedSlashCommandIndex}
			tabCompletionOpen={input.tabCompletionOpen}
			setTabCompletionOpen={input.setTabCompletionOpen}
			tabCompletionSuggestions={tabCompletionSuggestions}
			selectedTabCompletionIndex={input.selectedTabCompletionIndex}
			setSelectedTabCompletionIndex={input.setSelectedTabCompletionIndex}
			tabCompletionFilter={input.tabCompletionFilter}
			setTabCompletionFilter={input.setTabCompletionFilter}
			atMentionOpen={input.atMentionOpen}
			setAtMentionOpen={input.setAtMentionOpen}
			atMentionFilter={input.atMentionFilter}
			setAtMentionFilter={input.setAtMentionFilter}
			atMentionStartIndex={input.atMentionStartIndex}
			setAtMentionStartIndex={input.setAtMentionStartIndex}
			atMentionItems={atMentionItems}
			atMentionCounts={atMentionCounts}
			atMentionCategory={input.atMentionCategory}
			setAtMentionCategory={input.setAtMentionCategory}
			selectedAtMentionIndex={input.selectedAtMentionIndex}
			setSelectedAtMentionIndex={input.setSelectedAtMentionIndex}
			inputRef={inputRef}
			handleInputKeyDown={handleInputKeyDown}
			handlePaste={handlePaste}
			handleDrop={handleDrop}
			// A tab window shows its agent's AI tabs, never its terminal.
			toggleInputMode={noop}
			processInput={processInput}
			handleInterrupt={() => sendIntent({ kind: 'interrupt' })}
			onInputFocus={noop}
			onSessionClick={onSessionClick}
			tabReadOnlyMode={(tab.readOnlyMode ?? false) || tab.permissionMode === 'readonly'}
			onToggleTabReadOnlyMode={() => sendIntent({ kind: 'toggleReadOnly' })}
			tabSaveToHistory={tab.saveToHistory ?? false}
			onToggleTabSaveToHistory={() => sendIntent({ kind: 'toggleSaveToHistory' })}
			tabShowThinking={tab.showThinking ?? 'off'}
			onToggleTabShowThinking={() => sendIntent({ kind: 'setThinkingMode', mode: 'cycle' })}
			supportsThinking={hasCapability('supportsThinkingDisplay')}
			shortcuts={shortcuts}
			showFlashNotification={showFlashNotification}
			contextUsage={activeTabContextUsage}
			contextWarningsEnabled={contextWarningsEnabled}
			contextWarningYellowThreshold={contextWarningYellowThreshold}
			contextWarningRedThreshold={contextWarningRedThreshold}
			onSummarizeAndContinue={() => {
				sendIntent({ kind: 'summarizeAndContinue' });
				notifyCenterFlash({
					message: 'Compacting in the main window',
					detail: 'The compacted conversation opens there as a new tab.',
					color: 'theme',
				});
			}}
			currentModel={currentModel}
			currentEffort={currentEffort}
			availableModels={models}
			availableEfforts={efforts}
			onModelChange={(model) => sendIntent({ kind: 'setModel', model: model || undefined })}
			onEffortChange={(effort) => sendIntent({ kind: 'setEffort', effort: effort || undefined })}
			thinkingItems={thinkingItems}
			onAcceptAiCommand={acceptAiCommand}
			onPermissionModeChange={(mode) => sendIntent({ kind: 'setPermissionMode', mode })}
			onThinkingModeChange={(mode: ThinkingMode) => sendIntent({ kind: 'setThinkingMode', mode })}
		/>
	);
}

function noop(): void {}
