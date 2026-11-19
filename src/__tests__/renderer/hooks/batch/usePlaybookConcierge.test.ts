/**
 * usePlaybookConcierge: the agent speaks first, not-ready replies count as
 * questions, the interview ends on ready or at the question cap, a failed
 * turn can be retried, and unmounting ends the conversation.
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const service = vi.hoisted(() => ({
	loadPlaybookConciergePrompt: vi.fn(),
	startPlaybookConcierge: vi.fn(),
	sendPlaybookConciergeMessage: vi.fn(),
	endPlaybookConcierge: vi.fn(),
}));

vi.mock('../../../../renderer/services/playbookConcierge', async (importActual) => {
	const actual =
		await importActual<typeof import('../../../../renderer/services/playbookConcierge')>();
	return { ...actual, ...service };
});

import { usePlaybookConcierge } from '../../../../renderer/hooks/batch/usePlaybookConcierge';
import {
	CONCIERGE_KICKOFF_MESSAGE,
	type PlaybookConciergeContext,
} from '../../../../renderer/services/playbookConcierge';

const AGENT = { agentType: 'claude-code' as const, directoryPath: '/repo', projectName: 'Repo' };
const CONTEXT: PlaybookConciergeContext = {
	title: 'Review',
	specs: [],
	facts: null,
	stored: {},
	factProposals: {},
	open: ['TEST_COMMAND'],
	questionCap: 2,
};
const CONVERSATION = { session: { sessionId: 'c1' }, specs: [], open: new Set(), questionCap: 2 };

function reply(ready: boolean, parameters: unknown[] = [], message = 'Which command?') {
	return {
		success: true,
		response: { confidence: ready ? 90 : 40, ready, message, parameters },
	};
}

function renderConcierge(onFinish = vi.fn()) {
	const hook = renderHook(() => usePlaybookConcierge({ agent: AGENT, context: CONTEXT, onFinish }));
	return { ...hook, onFinish };
}

describe('usePlaybookConcierge', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		service.loadPlaybookConciergePrompt.mockResolvedValue('TEMPLATE');
		service.startPlaybookConcierge.mockReturnValue(CONVERSATION);
		service.endPlaybookConcierge.mockResolvedValue(undefined);
	});

	it('opens with the hidden kickoff, so the agent speaks first', async () => {
		service.sendPlaybookConciergeMessage.mockResolvedValue(reply(false));
		const { result } = renderConcierge();

		await waitFor(() => expect(result.current.messages).toHaveLength(1));
		expect(service.startPlaybookConcierge).toHaveBeenCalledWith(AGENT, 'TEMPLATE', CONTEXT);
		expect(service.sendPlaybookConciergeMessage).toHaveBeenCalledWith(
			CONVERSATION,
			CONCIERGE_KICKOFF_MESSAGE,
			[]
		);
		// The kickoff is not in the transcript; the agent's question is.
		expect(result.current.messages[0]).toMatchObject({
			role: 'assistant',
			content: 'Which command?',
		});
		expect(result.current.questionsAsked).toBe(1);
	});

	it('ends at the question cap even when the agent never says ready', async () => {
		const proposal = { name: 'TEST_COMMAND', value: 'npm test', source: 'asked', confidence: 80 };
		service.sendPlaybookConciergeMessage
			.mockResolvedValueOnce(reply(false))
			.mockResolvedValueOnce(reply(false, [proposal], 'Anything else?'));
		const { result, onFinish } = renderConcierge();
		await waitFor(() => expect(result.current.questionsAsked).toBe(1));

		act(() => result.current.send('npm test'));
		await waitFor(() => expect(onFinish).toHaveBeenCalledTimes(1));
		expect(onFinish).toHaveBeenCalledWith([proposal]);
		expect(result.current.questionsAsked).toBe(2);

		// The history sent with the reply is the transcript before it.
		const [, message, history] = service.sendPlaybookConciergeMessage.mock.calls[1];
		expect(message).toBe('npm test');
		expect(history.map((m: { role: string }) => m.role)).toEqual(['assistant']);

		// Over: further replies are ignored.
		act(() => result.current.send('more'));
		expect(service.sendPlaybookConciergeMessage).toHaveBeenCalledTimes(2);
	});

	it('ends as soon as the agent is ready, without counting that reply as a question', async () => {
		const proposal = {
			name: 'TEST_COMMAND',
			value: 'npm test',
			source: 'detected',
			confidence: 95,
		};
		service.sendPlaybookConciergeMessage.mockResolvedValueOnce(reply(true, [proposal], 'Ready.'));
		const { result, onFinish } = renderConcierge();

		await waitFor(() => expect(onFinish).toHaveBeenCalledWith([proposal]));
		expect(result.current.questionsAsked).toBe(0);
		expect(result.current.proposals).toEqual([proposal]);
	});

	it('shows a failed turn and retries it with the same message', async () => {
		service.sendPlaybookConciergeMessage
			.mockResolvedValueOnce({ success: false, error: 'Agent exited with code 1' })
			.mockResolvedValueOnce(reply(false));
		const { result } = renderConcierge();

		await waitFor(() => expect(result.current.error).toBe('Agent exited with code 1'));
		act(() => result.current.retry());
		await waitFor(() => expect(result.current.messages).toHaveLength(1));
		expect(result.current.error).toBeNull();
		expect(service.sendPlaybookConciergeMessage.mock.calls[1][1]).toBe(CONCIERGE_KICKOFF_MESSAGE);
	});

	it('ends the conversation on unmount', async () => {
		service.sendPlaybookConciergeMessage.mockResolvedValue(reply(false));
		const { result, unmount } = renderConcierge();
		await waitFor(() => expect(result.current.messages).toHaveLength(1));

		unmount();
		expect(service.endPlaybookConcierge).toHaveBeenCalledWith(CONVERSATION);
	});
});
