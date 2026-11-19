/**
 * Tests for the renderer side of `/btw` side questions: the request carries the
 * tab's own provider session, the card follows the answer, and a reply to a
 * dismissed card does not bring it back.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
	askSideQuestion,
	dismissSideQuestion,
	runRemoteSideQuestion,
} from '../../../renderer/services/sideQuestion';
import { sideQuestionKey, useSideQuestionStore } from '../../../renderer/stores/sideQuestionStore';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import type { Session } from '../../../renderer/types';

const ask = vi.fn();

function makeSession(overrides: Partial<Session> = {}): Session {
	return {
		id: 'agent-1',
		name: 'Builder',
		toolType: 'claude-code',
		cwd: '/repo',
		activeTabId: 'tab-1',
		aiTabs: [{ id: 'tab-1', agentSessionId: 'sess-1', logs: [] }],
		...overrides,
	} as unknown as Session;
}

describe('sideQuestion service', () => {
	beforeEach(() => {
		ask.mockReset();
		(window as unknown as { maestro: unknown }).maestro = {
			...(window as unknown as { maestro?: object }).maestro,
			sideQuestion: { ask },
		};
		useSideQuestionStore.setState({ entries: {} });
	});

	it("asks with the tab's provider session and shows the answer on the tab's card", async () => {
		ask.mockResolvedValue({ success: true, answer: 'src/foo.ts' });

		const outcome = await askSideQuestion({
			session: makeSession(),
			tabId: 'tab-1',
			question: '  which file?  ',
		});

		expect(ask).toHaveBeenCalledWith(
			expect.objectContaining({
				question: 'which file?',
				agentType: 'claude-code',
				cwd: '/repo',
				agentSessionId: 'sess-1',
			})
		);
		expect(outcome).toMatchObject({ success: true, answer: 'src/foo.ts', tabId: 'tab-1' });
		const entry = useSideQuestionStore.getState().entries[sideQuestionKey('agent-1', 'tab-1')];
		expect(entry).toMatchObject({ status: 'answered', answer: 'src/foo.ts' });
	});

	it('drops a reply that lands after the card was dismissed', async () => {
		let resolve!: (value: unknown) => void;
		ask.mockReturnValue(new Promise((r) => (resolve = r)));

		const pending = askSideQuestion({ session: makeSession(), tabId: 'tab-1', question: 'q' });
		dismissSideQuestion('agent-1', 'tab-1');
		resolve({ success: true, answer: 'late' });
		await pending;

		expect(useSideQuestionStore.getState().entries).toEqual({});
	});

	it('fails an empty question without a model call', async () => {
		const outcome = await askSideQuestion({
			session: makeSession(),
			tabId: 'tab-1',
			question: ' ',
		});

		expect(outcome.success).toBe(false);
		expect(ask).not.toHaveBeenCalled();
	});

	it('refuses a CLI side question for an agent that is not Claude Code', async () => {
		useSessionStore.setState({ sessions: [makeSession({ toolType: 'codex' })] } as never);

		const outcome = await runRemoteSideQuestion({ targetSessionId: 'agent-1', question: 'q' });

		expect(outcome.success).toBe(false);
		expect(ask).not.toHaveBeenCalled();
	});

	it("defaults a CLI side question to the agent's active tab", async () => {
		useSessionStore.setState({ sessions: [makeSession()] } as never);
		ask.mockResolvedValue({ success: true, answer: 'yes' });

		const outcome = await runRemoteSideQuestion({ targetSessionId: 'agent-1', question: 'q' });

		expect(outcome).toMatchObject({ success: true, tabId: 'tab-1', agentName: 'Builder' });
	});
});
