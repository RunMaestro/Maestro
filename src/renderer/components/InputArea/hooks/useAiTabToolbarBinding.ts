/**
 * useAiTabToolbarBinding - the composer toolbar's per-tab settings, bound to
 * the AI agent's active tab.
 *
 * The toolbar knows nothing about agents or tabs: it shows a permission mode
 * and hands back the mode or thinking setting the user picked. This hook is the
 * AI side of that contract. It reads the mode off the active tab and writes a
 * pick back through the shared field patches, so the desktop pill and the phone
 * sheet cannot drift on keeping `readOnlyMode` in lockstep with
 * `permissionMode`, or on clearing thinking logs when the mode goes off.
 *
 * The callbacks depend only on the agent and tab ids, so a keystroke (which
 * re-renders InputArea) does not hand the memoized toolbar new identities.
 */

import { useCallback } from 'react';
import type { AITab, ThinkingMode } from '../../../types';
import { resolveTabPermissionMode } from '../../../../shared/agentMetadata';
import { updateSessionWith } from '../../../stores/sessionStore';
import { permissionModeFields, setShowThinkingFields } from '../../../utils/tabHelpers';
import type { PermissionMode } from '../components/ComposerOptionsSheet';

export interface AiTabToolbarBinding {
	permissionMode: PermissionMode;
	onPermissionModeChange: (mode: PermissionMode) => void;
	onThinkingModeChange: (mode: ThinkingMode) => void;
}

export function useAiTabToolbarBinding(
	sessionId: string,
	activeTab: AITab | undefined
): AiTabToolbarBinding {
	const activeTabId = activeTab?.id;

	const onPermissionModeChange = useCallback(
		(mode: PermissionMode) => {
			if (!activeTabId) return;
			updateSessionWith(sessionId, (s) => ({
				...s,
				aiTabs: s.aiTabs.map((t) =>
					t.id === activeTabId ? { ...t, ...permissionModeFields(mode) } : t
				),
			}));
		},
		[sessionId, activeTabId]
	);

	const onThinkingModeChange = useCallback(
		(mode: ThinkingMode) => {
			if (!activeTabId) return;
			updateSessionWith(sessionId, (s) => ({
				...s,
				aiTabs: s.aiTabs.map((t) =>
					t.id === activeTabId ? { ...t, ...setShowThinkingFields(t, mode) } : t
				),
			}));
		},
		[sessionId, activeTabId]
	);

	return {
		permissionMode: resolveTabPermissionMode(activeTab),
		onPermissionModeChange,
		onThinkingModeChange,
	};
}
