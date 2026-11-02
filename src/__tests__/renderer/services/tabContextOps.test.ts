/**
 * runRemoteTabContextOp - the renderer end of `maestro-cli tab compact|merge|
 * transfer`. It resolves what the overlay menu resolves by having the tab on
 * screen (default tabs, the modals' target rules), then calls the menu's own
 * handler, which these tests stand in for.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
	REMOTE_MERGE_OPTIONS,
	runRemoteTabContextOp,
	type TabContextOpHandlers,
} from '../../../renderer/services/tabContextOps';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';
import { DORMANT_PIANOLA_MESSAGE } from '../../../shared/agentVisibility';
import { createMockSession } from '../../helpers/mockSession';
import { createMockAITab } from '../../helpers/mockTab';
import type { Session } from '../../../renderer/types';

function agent(id: string, overrides: Partial<Session> = {}): Session {
	return createMockSession({
		id,
		aiTabs: [createMockAITab({ id: `${id}-t1` }), createMockAITab({ id: `${id}-t2` })],
		activeTabId: `${id}-t1`,
		...overrides,
	});
}

let handlers: {
	summarizeTab: ReturnType<typeof vi.fn>;
	mergeTabContext: ReturnType<typeof vi.fn>;
	transferTabContext: ReturnType<typeof vi.fn>;
};
const run = (request: Parameters<typeof runRemoteTabContextOp>[0]) =>
	runRemoteTabContextOp(request, handlers as unknown as TabContextOpHandlers);

beforeEach(() => {
	handlers = {
		summarizeTab: vi.fn(async (sessionId: string, tabId: string) => ({
			success: true,
			sessionId,
			tabId,
			newTabId: 'compacted',
		})),
		mergeTabContext: vi.fn().mockResolvedValue({ success: true }),
		transferTabContext: vi.fn().mockResolvedValue({ success: true, newTabId: 'moved' }),
	};
	useSettingsStore.setState({ encoreFeatures: { ...useSettingsStore.getState().encoreFeatures } });
	useSessionStore.setState({
		sessions: [agent('a'), agent('b'), agent('shell', { toolType: 'terminal' })],
		activeSessionId: 'a',
	});
});

describe('compact', () => {
	it('defaults to the active AI tab', async () => {
		const result = await run({ op: 'compact', sessionId: 'a' });

		expect(handlers.summarizeTab).toHaveBeenCalledWith('a', 'a-t1', { background: false });
		expect(result).toEqual({ success: true, sessionId: 'a', tabId: 'a-t1', newTabId: 'compacted' });
	});

	it('takes an explicit tab and the background bit', async () => {
		await run({ op: 'compact', sessionId: 'b', tabId: 'b-t2', background: true });

		expect(handlers.summarizeTab).toHaveBeenCalledWith('b', 'b-t2', { background: true });
	});

	it('passes the handler failure through', async () => {
		handlers.summarizeTab.mockResolvedValueOnce({ success: false, error: 'Context too small' });

		const result = await run({ op: 'compact', sessionId: 'a' });

		expect(result).toEqual({
			success: false,
			error: 'Context too small',
			sessionId: 'a',
			tabId: 'a-t1',
		});
	});

	it('refuses an unknown agent without calling the handler', async () => {
		const result = await run({ op: 'compact', sessionId: 'ghost' });

		expect(result).toEqual({ success: false, error: 'Agent not found: ghost' });
		expect(handlers.summarizeTab).not.toHaveBeenCalled();
	});

	it('refuses a tab the agent does not have', async () => {
		const result = await run({ op: 'compact', sessionId: 'a', tabId: 'b-t1' });

		expect(result).toMatchObject({ success: false, error: 'Tab b-t1 is not an AI tab of agent a' });
		expect(handlers.summarizeTab).not.toHaveBeenCalled();
	});

	it('refuses a dormant Pianola agent', async () => {
		useSessionStore.setState({ sessions: [agent('p', { isPianola: true } as Partial<Session>)] });
		useSettingsStore.setState({
			encoreFeatures: { ...useSettingsStore.getState().encoreFeatures, pianola: false },
		});

		const result = await run({ op: 'compact', sessionId: 'p' });

		expect(result).toEqual({ success: false, error: DORMANT_PIANOLA_MESSAGE });
		expect(handlers.summarizeTab).not.toHaveBeenCalled();
	});
});

describe('merge', () => {
	it("merges verbatim into the target's active tab by default", async () => {
		const result = await run({ op: 'merge', sessionId: 'a', targetSessionId: 'b' });

		expect(handlers.mergeTabContext).toHaveBeenCalledWith(
			'a',
			'a-t1',
			'b',
			'b-t1',
			REMOTE_MERGE_OPTIONS,
			{ background: false }
		);
		expect(REMOTE_MERGE_OPTIONS.groomContext).toBe(false);
		expect(result).toEqual({
			success: true,
			sessionId: 'a',
			tabId: 'a-t1',
			targetSessionId: 'b',
			targetTabId: 'b-t1',
		});
	});

	it('allows another tab of the same agent', async () => {
		const result = await run({
			op: 'merge',
			sessionId: 'a',
			targetSessionId: 'a',
			targetTabId: 'a-t2',
		});

		expect(result.success).toBe(true);
		expect(handlers.mergeTabContext).toHaveBeenCalledWith(
			'a',
			'a-t1',
			'a',
			'a-t2',
			REMOTE_MERGE_OPTIONS,
			{ background: false }
		);
	});

	it('refuses a merge of a tab into itself', async () => {
		const result = await run({ op: 'merge', sessionId: 'a', targetSessionId: 'a' });

		expect(result).toMatchObject({ success: false, error: 'Cannot merge a tab into itself' });
		expect(handlers.mergeTabContext).not.toHaveBeenCalled();
	});

	it('reports a background merge into an off-screen tab as staged', async () => {
		const result = await run({
			op: 'merge',
			sessionId: 'a',
			targetSessionId: 'b',
			background: true,
		});

		expect(result).toMatchObject({ success: true, targetTabId: 'b-t1', staged: true });
	});

	it('does not call a background merge into the tab on screen staged', async () => {
		useSessionStore.setState({ activeSessionId: 'b' });

		const result = await run({
			op: 'merge',
			sessionId: 'a',
			targetSessionId: 'b',
			background: true,
		});

		expect(result.staged).toBeUndefined();
	});

	it('refuses a terminal target and an unknown target', async () => {
		await expect(
			run({ op: 'merge', sessionId: 'a', targetSessionId: 'shell' })
		).resolves.toMatchObject({
			success: false,
			error: 'Agent shell is a terminal and has no AI tabs',
		});
		await expect(
			run({ op: 'merge', sessionId: 'a', targetSessionId: 'ghost' })
		).resolves.toMatchObject({ success: false, error: 'Agent not found: ghost' });
		expect(handlers.mergeTabContext).not.toHaveBeenCalled();
	});

	it('maps a merge failure to the reply', async () => {
		handlers.mergeTabContext.mockResolvedValueOnce({ success: false, error: 'Merge busy' });

		const result = await run({ op: 'merge', sessionId: 'a', targetSessionId: 'b' });

		expect(result).toEqual({ success: false, error: 'Merge busy', sessionId: 'a', tabId: 'a-t1' });
	});
});

describe('transfer', () => {
	it('sends the raw transcript and reports the new tab', async () => {
		const result = await run({
			op: 'transfer',
			sessionId: 'a',
			tabId: 'a-t2',
			targetSessionId: 'b',
			background: true,
		});

		expect(handlers.transferTabContext).toHaveBeenCalledWith(
			'a',
			'a-t2',
			'b',
			{ groomContext: false, targetSessionId: 'b' },
			{ background: true }
		);
		expect(result).toEqual({
			success: true,
			sessionId: 'a',
			tabId: 'a-t2',
			targetSessionId: 'b',
			newTabId: 'moved',
		});
	});

	it('reports a queued transfer', async () => {
		handlers.transferTabContext.mockResolvedValueOnce({
			success: true,
			newTabId: 'm',
			queued: true,
		});

		const result = await run({ op: 'transfer', sessionId: 'a', targetSessionId: 'b' });

		expect(result).toMatchObject({ success: true, queued: true });
	});

	it('refuses the source agent as its own target', async () => {
		const result = await run({ op: 'transfer', sessionId: 'a', targetSessionId: 'a' });

		expect(result).toMatchObject({
			success: false,
			error: 'Source and target agents must be different',
		});
		expect(handlers.transferTabContext).not.toHaveBeenCalled();
	});

	it('refuses a missing target', async () => {
		const result = await run({ op: 'transfer', sessionId: 'a' });

		expect(result).toMatchObject({ success: false, error: 'Missing target agent' });
	});
});
