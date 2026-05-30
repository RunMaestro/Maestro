/**
 * usePromptComposerHandlers — extracted from App.tsx
 *
 * Provides stable callbacks for the Prompt Composer modal:
 *   - Submit/send to AI or group chat
 *   - Toggle save-to-history, read-only mode, thinking mode, enter-to-send
 *
 * Reads from: sessionStore, groupChatStore, settingsStore
 */

import { useCallback } from 'react';
import type { ThinkingMode } from '../../types';
import { useSessionStore, selectActiveSession } from '../../stores/sessionStore';
import { useGroupChatStore } from '../../stores/groupChatStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { getActiveTab } from '../../utils/tabHelpers';

// ============================================================================
// Dependencies interface
// ============================================================================

export interface UsePromptComposerHandlersDeps {
	/** Send a message to the active group chat */
	handleSendGroupChatMessage: (message: string, images?: string[], readOnlyMode?: boolean) => void;
	/** Process input for AI submission */
	processInput: (value?: string) => void;
	/** Set the main input value */
	setInputValue: (value: string) => void;
}

// ============================================================================
// Return type
// ============================================================================

export interface UsePromptComposerHandlersReturn {
	/** Submit content (sets input value or group chat draft) */
	handlePromptComposerSubmit: (value: string) => void;
	/** Send content (triggers AI or group chat send) */
	handlePromptComposerSend: (value: string) => void;
	/** Toggle save-to-history for the active tab */
	handlePromptToggleTabSaveToHistory: () => void;
	/** Toggle read-only mode for active tab or group chat */
	handlePromptToggleTabReadOnlyMode: () => void;
	/** Cycle thinking mode for the active tab (off → on → sticky → off) */
	handlePromptToggleTabShowThinking: () => void;
	/** Toggle enter-to-send setting */
	handlePromptToggleEnterToSend: () => void;
}

// ============================================================================
// Hook implementation
// ============================================================================

export function usePromptComposerHandlers(
	deps: UsePromptComposerHandlersDeps
): UsePromptComposerHandlersReturn {
	const { handleSendGroupChatMessage, processInput, setInputValue } = deps;

	// --- Reactive subscriptions ---
	const activeSession = useSessionStore(selectActiveSession);
	const activeGroupChatId = useGroupChatStore((s) => s.activeGroupChatId);
	const groupChatStagedImages = useGroupChatStore((s) => s.groupChatStagedImages);
	const groupChatReadOnlyMode = useGroupChatStore((s) => s.groupChatReadOnlyMode);

	// --- Store actions (stable via getState) ---
	const { setSessions } = useSessionStore.getState();
	const { setGroupChats, setGroupChatStagedImages, setGroupChatReadOnlyMode } =
		useGroupChatStore.getState();

	// --- Settings ---
	const enterToSendAIExpanded = useSettingsStore((s) => s.enterToSendAIExpanded);
	const { setEnterToSendAIExpanded } = useSettingsStore.getState();

	const handlePromptComposerSubmit = useCallback(
		(value: string) => {
			if (activeGroupChatId) {
				// Update group chat draft
				setGroupChats((prev) =>
					prev.map((c) => (c.id === activeGroupChatId ? { ...c, draftMessage: value } : c))
				);
			} else {
				setInputValue(value);
			}
		},
		[activeGroupChatId, setInputValue]
	);

	const handlePromptComposerSend = useCallback(
		(value: string) => {
			if (activeGroupChatId) {
				// Send to group chat
				handleSendGroupChatMessage(
					value,
					groupChatStagedImages.length > 0 ? groupChatStagedImages : undefined,
					groupChatReadOnlyMode
				);
				setGroupChatStagedImages([]);
				// Clear draft
				setGroupChats((prev) =>
					prev.map((c) => (c.id === activeGroupChatId ? { ...c, draftMessage: '' } : c))
				);
			} else {
				// Set the input value and trigger send
				setInputValue(value);
				// Use setTimeout to ensure state updates before processing
				setTimeout(() => processInput(value), 0);
			}
		},
		[
			activeGroupChatId,
			groupChatStagedImages,
			groupChatReadOnlyMode,
			handleSendGroupChatMessage,
			processInput,
		]
	);

	const handlePromptToggleTabSaveToHistory = useCallback(() => {
		if (!activeSession) return;
		const activeTab = getActiveTab(activeSession);
		if (!activeTab) return;
		setSessions((prev) =>
			prev.map((s) => {
				if (s.id !== activeSession.id) return s;
				return {
					...s,
					aiTabs: s.aiTabs.map((tab) =>
						tab.id === activeTab.id ? { ...tab, saveToHistory: !tab.saveToHistory } : tab
					),
				};
			})
		);
	}, [activeSession]);

	const handlePromptToggleTabReadOnlyMode = useCallback(() => {
		if (activeGroupChatId) {
			setGroupChatReadOnlyMode((prev: boolean) => !prev);
		} else {
			if (!activeSession) return;
			const activeTab = getActiveTab(activeSession);
			if (!activeTab) return;
			setSessions((prev) =>
				prev.map((s) => {
					if (s.id !== activeSession.id) return s;
					return {
						...s,
						aiTabs: s.aiTabs.map((tab) =>
							tab.id === activeTab.id ? { ...tab, readOnlyMode: !tab.readOnlyMode } : tab
						),
					};
				})
			);
		}
	}, [activeGroupChatId, activeSession]);

	const handlePromptToggleTabShowThinking = useCallback(() => {
		if (!activeSession) return;
		const activeTab = getActiveTab(activeSession);
		if (!activeTab) return;
		// Cycle through: off -> on -> sticky -> off
		const cycleThinkingMode = (current: ThinkingMode | undefined): ThinkingMode => {
			if (!current || current === 'off') return 'on';
			if (current === 'on') return 'sticky';
			return 'off';
		};
		setSessions((prev) =>
			prev.map((s) => {
				if (s.id !== activeSession.id) return s;
				return {
					...s,
					aiTabs: s.aiTabs.map((tab) => {
						if (tab.id !== activeTab.id) return tab;
						const newMode = cycleThinkingMode(tab.showThinking);
						// When turning OFF, clear thinking logs
						if (newMode === 'off') {
							return {
								...tab,
								showThinking: 'off',
								logs: tab.logs.filter((log) => log.source !== 'thinking'),
							};
						}
						return { ...tab, showThinking: newMode };
					}),
				};
			})
		);
	}, [activeSession]);

	const handlePromptToggleEnterToSend = useCallback(
		() => setEnterToSendAIExpanded(!enterToSendAIExpanded),
		[enterToSendAIExpanded]
	);

	return {
		handlePromptComposerSubmit,
		handlePromptComposerSend,
		handlePromptToggleTabSaveToHistory,
		handlePromptToggleTabReadOnlyMode,
		handlePromptToggleTabShowThinking,
		handlePromptToggleEnterToSend,
	};
}
