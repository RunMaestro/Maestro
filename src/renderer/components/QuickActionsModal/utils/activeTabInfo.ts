import type { Session } from '../../../types';
import type { ActiveTabInfo } from '../types';

export function getActiveTabInfo(
	activeSession: Session | undefined,
	isAiMode?: boolean
): ActiveTabInfo {
	const isTerminalMode = activeSession?.inputMode === 'terminal';
	const hasActiveTab = !!(
		isAiMode ||
		isTerminalMode ||
		activeSession?.activeFileTabId ||
		activeSession?.activeBrowserTabId
	);

	let activeUnifiedIndex = -1;
	if (activeSession) {
		let type: 'ai' | 'file' | 'terminal' | 'browser';
		let id: string | undefined | null;
		if (activeSession.activeBrowserTabId) {
			type = 'browser';
			id = activeSession.activeBrowserTabId;
		} else if (isTerminalMode && activeSession.activeTerminalTabId) {
			type = 'terminal';
			id = activeSession.activeTerminalTabId;
		} else if (activeSession.activeFileTabId) {
			type = 'file';
			id = activeSession.activeFileTabId;
		} else {
			type = 'ai';
			id = activeSession.activeTabId;
		}
		if (id) {
			activeUnifiedIndex = (activeSession.unifiedTabOrder ?? []).findIndex(
				(ref) => ref.type === type && ref.id === id
			);
		}
	}

	return {
		isTerminalMode,
		hasActiveTab,
		activeUnifiedIndex,
		unifiedTabCount: activeSession?.unifiedTabOrder?.length ?? 0,
	};
}
