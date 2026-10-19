/**
 * Tests for services/tabRename: rename one tab of one agent, any kind.
 *
 * The rename modal's handler renames a tab of the active agent; a tab window's
 * owner renames a popped tab of an agent that may not be active (Tab Windows).
 * Both run this, so it must find the tab by the agent it is given.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renameTabInSession } from '../../../renderer/services/tabRename';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import type { BrowserTab } from '../../../shared/browserPage';
import type { Session } from '../../../renderer/types';
import { createMockSession } from '../../helpers/mockSession';
import { createMockAITab, createMockFileTab } from '../../helpers/mockTab';

const updateSessionName = vi.fn().mockResolvedValue(undefined);
const setSessionName = vi.fn().mockResolvedValue(undefined);
const historyUpdateSessionName = vi.fn().mockResolvedValue(undefined);

function agent(): Session {
	return createMockSession({
		id: 'agent-1',
		toolType: 'claude-code',
		projectRoot: '/repo',
		aiTabs: [
			createMockAITab({
				id: 'popped',
				agentSessionId: 'claude-1',
				name: 'Old',
				isGeneratingName: true,
			}),
			createMockAITab({ id: 'home' }),
		],
		filePreviewTabs: [createMockFileTab({ id: 'file-1' })],
		browserTabs: [{ id: 'web-1', url: 'https://x.test', title: 'X' } as BrowserTab],
		activeTabId: 'home',
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	window.maestro = {
		...window.maestro,
		claude: { ...window.maestro?.claude, updateSessionName },
		agentSessions: { ...window.maestro?.agentSessions, setSessionName },
		history: { ...window.maestro?.history, updateSessionName: historyUpdateSessionName },
		logger: { ...window.maestro?.logger, log: vi.fn() },
	} as typeof window.maestro;
	// Another agent is the active one: the rename must not care.
	useSessionStore.setState({
		sessions: [agent(), createMockSession({ id: 'agent-2' })],
		activeSessionId: 'agent-2',
	});
});

function stored(): Session {
	return useSessionStore.getState().sessions.find((s) => s.id === 'agent-1')!;
}

describe('renameTabInSession', () => {
	it('renames an AI tab of the agent it names, saving the name with the provider session and History', () => {
		renameTabInSession('agent-1', 'popped', 'Specs');

		const tab = stored().aiTabs.find((t) => t.id === 'popped')!;
		expect(tab.name).toBe('Specs');
		expect(tab.isGeneratingName).toBe(false);
		expect(updateSessionName).toHaveBeenCalledWith('/repo', 'claude-1', 'Specs');
		expect(historyUpdateSessionName).toHaveBeenCalledWith('claude-1', 'Specs');
	});

	it('clears an AI tab name with an empty value', () => {
		renameTabInSession('agent-1', 'popped', '');
		expect(stored().aiTabs.find((t) => t.id === 'popped')!.name).toBeNull();
	});

	it('locks a file and a browser tab label, and clears it with an empty value', () => {
		renameTabInSession('agent-1', 'file-1', ' notes ');
		renameTabInSession('agent-1', 'web-1', 'Docs');
		expect(stored().filePreviewTabs[0].customName).toBe('notes');
		expect(stored().browserTabs![0].customTitle).toBe('Docs');

		renameTabInSession('agent-1', 'file-1', '  ');
		expect(stored().filePreviewTabs[0].customName).toBeUndefined();
	});

	it('does nothing for an agent that is gone', () => {
		const before = useSessionStore.getState().sessions;
		renameTabInSession('gone', 'popped', 'x');
		expect(useSessionStore.getState().sessions).toBe(before);
	});
});
