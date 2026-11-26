/**
 * Cmd+Shift+T (and `maestro-cli tab reopen`) on a local, an SSH, or a hosted agent (row G5). A
 * local or SSH agent's closed AI tab comes back here with its conversation; a hosted agent's comes
 * back on its host (`reopen-tab`), which continues that conversation, and shows here as that host
 * tab. A closed file tab is this machine's in every mode and reopens here.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTabStore } from '../../../renderer/stores/tabStore';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';
import { runRemoteClosedTabCommand } from '../../../renderer/services/closedTabCommands';
import { AGENT_MODES, createModeSession, resetStores, type AgentMode } from '../../helpers';
import { createMockAITab } from '../../helpers/mockTab';
import type { ClosedTabEntry } from '../../../renderer/types';

const maestro = window.maestro as unknown as Record<string, unknown>;
const act$ = vi.fn();
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function seed(mode: AgentMode, closed: ClosedTabEntry[]) {
	const session = createModeSession(mode, {
		id: 'row',
		name: 'Docs',
		activeTabId: 'main',
		aiTabs: [createMockAITab({ id: 'main' })],
		unifiedTabOrder: [{ type: 'ai', id: 'main' }],
		unifiedClosedTabHistory: closed,
	});
	useSessionStore.setState({ sessions: [session], activeSessionId: session.id });
}

const closedAi = (): ClosedTabEntry => ({
	type: 'ai',
	tab: createMockAITab({ id: 'other', agentSessionId: 's-1', name: 'Other' }),
	unifiedIndex: 1,
	closedAt: 1,
});

const row = () => useSessionStore.getState().sessions[0];

describe('G5: reopening a closed tab on a local, SSH, or hosted agent', () => {
	beforeEach(() => {
		resetStores(useSessionStore);
		useSettingsStore.setState({ federationHostedAgents: true } as never);
		act$
			.mockReset()
			.mockResolvedValue({ ok: true, result: { kind: 'reopen-tab', tabId: 'other' } });
		maestro.federation = { act: act$ };
	});
	afterEach(() => {
		delete maestro.federation;
	});

	it('brings the closed conversation back as an open tab and empties the stack, in every mode', async () => {
		const outcomes: { open: boolean; stack: number }[] = [];
		for (const mode of AGENT_MODES) {
			seed(mode, [closedAi()]);
			useTabStore.getState().reopenClosedTab();
			await flush();
			const reopened = row().aiTabs.find((tab) => tab.id !== 'main');
			outcomes.push({ open: !!reopened, stack: row().unifiedClosedTabHistory?.length ?? 0 });
			if (mode === 'hosted') {
				// The host reopens its own tab, so the conversation continues where it runs.
				expect(act$).toHaveBeenCalledWith('box', 'h1', { kind: 'reopen-tab', tabId: 'other' });
				expect(reopened?.id).toBe('other');
			} else {
				expect(act$).not.toHaveBeenCalled();
				expect(reopened?.agentSessionId).toBe('s-1');
			}
			act$.mockClear();
		}
		expect(outcomes).toEqual([
			{ open: true, stack: 0 },
			{ open: true, stack: 0 },
			{ open: true, stack: 0 },
		]);
	});

	it('brings back the unsent draft and staged images with the tab, in every mode', async () => {
		for (const mode of AGENT_MODES) {
			const entry = closedAi();
			(entry.tab as { inputValue: string; stagedImages: string[] }).inputValue = 'half typed';
			(entry.tab as { inputValue: string; stagedImages: string[] }).stagedImages = ['data:img'];
			seed(mode, [entry]);
			useTabStore.getState().reopenClosedTab();
			await flush();
			const reopened = row().aiTabs.find((tab) => tab.id !== 'main');
			expect(reopened?.inputValue).toBe('half typed');
			expect(reopened?.stagedImages).toEqual(['data:img']);
		}
	});

	it('hosted: with nothing closed from this machine, reopens the host stack newest AI tab', async () => {
		seed('hosted', []);
		act$.mockImplementation(async (_peer: string, _agent: string, action: { kind: string }) =>
			action.kind === 'closed-tabs'
				? {
						ok: true,
						result: {
							kind: 'closed-tabs',
							closedTabs: [{ index: 0, type: 'ai', label: 'X', tabId: 'host-x', closedAt: 1 }],
						},
					}
				: { ok: true, result: { kind: 'reopen-tab', tabId: 'host-x' } }
		);
		useTabStore.getState().reopenClosedTab();
		await flush();
		await flush();
		expect(act$).toHaveBeenCalledWith('box', 'h1', { kind: 'reopen-tab', tabId: 'host-x' });
		expect(row().aiTabs.some((tab) => tab.id === 'host-x')).toBe(true);

		act$.mockClear();
		const viaCli = await runRemoteClosedTabCommand({
			action: 'reopen',
			sessionId: 'row',
			tabId: 'host',
			background: true,
		});
		expect(viaCli).toMatchObject({ success: true, tabId: 'host-x', tabType: 'ai' });
	});

	it.each(['local', 'ssh'] as const)(
		'%s: with nothing closed, Cmd+Shift+T asks no host',
		async (mode) => {
			seed(mode, []);
			useTabStore.getState().reopenClosedTab();
			await flush();
			expect(act$).not.toHaveBeenCalled();
		}
	);

	it('keeps the entry and says nothing changed when the host cannot reopen it', async () => {
		seed('hosted', [closedAi()]);
		act$.mockResolvedValue({ ok: false, error: 'There is no closed tab to reopen.' });
		useTabStore.getState().reopenClosedTab();
		await flush();
		expect(row().aiTabs.map((tab) => tab.id)).toEqual(['main']);
		expect(row().unifiedClosedTabHistory).toHaveLength(1);
	});

	it.each(AGENT_MODES)('%s: a closed file tab reopens here', async (mode) => {
		seed(mode, [
			{
				type: 'file',
				tab: {
					id: 'f1',
					path: '/p/a.md',
					name: 'a',
					extension: '.md',
					content: '',
					scrollTop: 0,
					searchQuery: '',
					editMode: false,
					editContent: undefined,
					createdAt: 1,
					lastModified: 1,
				} as never,
				unifiedIndex: 1,
				closedAt: 1,
			},
		]);
		useTabStore.getState().reopenClosedTab();
		await flush();
		expect(act$).not.toHaveBeenCalled();
		expect(row().filePreviewTabs.map((tab) => tab.path)).toEqual(['/p/a.md']);
	});

	it.each(AGENT_MODES)(
		'%s: `maestro-cli tab reopen` reopens where the conversation runs',
		async (mode) => {
			seed(mode, [closedAi()]);
			const result = await runRemoteClosedTabCommand({
				action: 'reopen',
				sessionId: 'row',
				index: 0,
				background: true,
			});
			expect(result).toMatchObject({ success: true, tabType: 'ai' });
			expect(row().aiTabs.some((tab) => tab.id === result.tabId)).toBe(true);
			expect(row().activeTabId).toBe('main');
			expect(act$).toHaveBeenCalledTimes(mode === 'hosted' ? 1 : 0);
		}
	);
});
