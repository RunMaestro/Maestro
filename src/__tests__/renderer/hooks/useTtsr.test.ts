/**
 * Phase 3b verification (wiring half): the renderer's side of the TTSR
 * interrupt loop - the abort-pending flag exit handling reads, and the
 * corrective respawn that continues the aborted conversation.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createMockAITab, createMockSession } from '../../helpers';
import { runTtsrCorrectiveTurn } from '../../../renderer/hooks/useTtsr';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { isTtsrAbortPending, useTtsrStore } from '../../../renderer/stores/ttsrStore';
import type { TtsrAbortPendingPayload, TtsrTriggeredPayload } from '../../../shared/ttsr-types';

function makePayload(overrides: Partial<TtsrTriggeredPayload> = {}): TtsrTriggeredPayload {
	return {
		sessionId: 'session-1-ai-tab-1',
		tabId: 'tab-1',
		agentId: 'claude-code',
		rules: [{ name: 'no-console-log', path: '.maestro/rules/no-console-log.md' }],
		injectionPrompt: '<system-interrupt rule="no-console-log">Use the logger.</system-interrupt>',
		mode: 'resume',
		providerSessionId: 'prov-1',
		originalGoal: 'Refactor the auth module',
		contextMode: 'keep',
		...overrides,
	};
}

function makeAbortPending(
	overrides: Partial<TtsrAbortPendingPayload> = {}
): TtsrAbortPendingPayload {
	return {
		sessionId: 'session-1-ai-tab-1',
		tabId: 'tab-1',
		agentId: 'claude-code',
		rules: [{ name: 'no-console-log', path: '.maestro/rules/no-console-log.md' }],
		contextMode: 'keep',
		...overrides,
	};
}

function seedSession() {
	const tab = createMockAITab({ id: 'tab-1', state: 'idle' });
	const session = createMockSession({ id: 'session-1', aiTabs: [tab], activeTabId: 'tab-1' });
	useSessionStore.getState().setSessions([session]);
	return session;
}

function currentTab() {
	return useSessionStore.getState().sessions[0].aiTabs[0];
}

describe('ttsrStore abort-pending flag', () => {
	beforeEach(() => {
		useTtsrStore.setState({ abortPending: {}, lastTriggered: {} });
	});

	it('marks a turn while its abort is in flight', () => {
		expect(isTtsrAbortPending('session-1-ai-tab-1')).toBe(false);
		useTtsrStore.getState().noteAbortPending(makeAbortPending());
		expect(isTtsrAbortPending('session-1-ai-tab-1')).toBe(true);
		// Unrelated turns must keep their normal exit handling.
		expect(isTtsrAbortPending('session-1-ai-tab-2')).toBe(false);
	});

	it('clears the flag once the corrective payload arrives', () => {
		useTtsrStore.getState().noteAbortPending(makeAbortPending());
		useTtsrStore.getState().noteTriggered(makePayload());
		expect(isTtsrAbortPending('session-1-ai-tab-1')).toBe(false);
		expect(useTtsrStore.getState().lastTriggered['session-1-ai-tab-1']?.mode).toBe('resume');
	});
});

describe('runTtsrCorrectiveTurn', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		useTtsrStore.setState({ abortPending: {}, lastTriggered: {} });
		window.maestro.agents.get = vi.fn().mockResolvedValue({
			command: 'claude',
			path: '/usr/local/bin/claude',
			args: ['--print'],
			capabilities: { supportsStreamJsonInput: true },
		});
		window.maestro.process.spawn = vi.fn().mockResolvedValue({ pid: 1, success: true });
	});

	it('spawns the corrective turn on the same process id, resuming the provider session', async () => {
		seedSession();

		await expect(runTtsrCorrectiveTurn(makePayload())).resolves.toBe(true);

		expect(window.maestro.process.spawn).toHaveBeenCalledTimes(1);
		expect(window.maestro.process.spawn).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionId: 'session-1-ai-tab-1',
				agentSessionId: 'prov-1',
				prompt: expect.stringContaining('<system-interrupt'),
			})
		);
	});

	it('puts the tab back to busy and records the interruption in the transcript', async () => {
		seedSession();

		await runTtsrCorrectiveTurn(makePayload());

		const tab = currentTab();
		expect(tab.state).toBe('busy');
		expect(tab.thinkingStartTime).toBeGreaterThan(0);
		expect(tab.logs).toHaveLength(1);
		expect(tab.logs[0].source).toBe('system');
		expect(tab.logs[0].text).toContain('no-console-log');
	});

	it('tells the user the degraded path restarted the turn', async () => {
		seedSession();

		await runTtsrCorrectiveTurn(
			makePayload({ mode: 'fresh', providerSessionId: undefined, agentId: 'grok' })
		);

		expect(window.maestro.process.spawn).toHaveBeenCalledWith(
			expect.objectContaining({ agentSessionId: undefined })
		);
		expect(currentTab().logs[0].text).toContain('cannot resume mid-turn');
	});

	it('drops the corrective turn when the tab is gone', async () => {
		useSessionStore.getState().setSessions([]);

		await expect(runTtsrCorrectiveTurn(makePayload())).resolves.toBe(false);
		expect(window.maestro.process.spawn).not.toHaveBeenCalled();
	});

	it('idles the tab and reports the failure when the respawn cannot spawn', async () => {
		seedSession();
		window.maestro.process.spawn = vi.fn().mockRejectedValue(new Error('spawn failed'));

		await expect(runTtsrCorrectiveTurn(makePayload())).resolves.toBe(false);

		const tab = currentTab();
		expect(tab.state).toBe('idle');
		expect(tab.thinkingStartTime).toBeUndefined();
		expect(tab.logs.at(-1)?.text).toContain('spawn failed');
	});
});
