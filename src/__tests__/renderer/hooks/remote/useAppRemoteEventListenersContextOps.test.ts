/**
 * Covers `maestro:tabContextOp` in useAppRemoteEventListeners - the renderer
 * side of `maestro-cli tab compact|merge|transfer`. The listener must run the
 * overlay menu's own handlers (handed in from App's hooks) with the resolved
 * source and target, and answer EVERY request exactly once, because the CLI
 * blocks on the reply.
 */
import { renderHook, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useAppRemoteEventListeners } from '../../../../renderer/hooks/remote/useAppRemoteEventListeners';
import { useSessionStore } from '../../../../renderer/stores/sessionStore';
import { REMOTE_MERGE_OPTIONS } from '../../../../renderer/services/tabContextOps';
import { createMockSession } from '../../../helpers/mockSession';
import { createMockAITab } from '../../../helpers/mockTab';
import type { TabContextOpRequest } from '../../../../shared/tabContextOps';

vi.mock('../../../../renderer/utils/sentry', () => ({
	captureException: vi.fn(),
	captureMessage: vi.fn(),
}));

const handlers = {
	summarizeTab: vi.fn(),
	mergeTabContext: vi.fn(),
	transferTabContext: vi.fn(),
};

function setup() {
	renderHook(() =>
		useAppRemoteEventListeners({
			sessionsRef: { current: [] },
			setActiveSessionId: vi.fn(),
			setSessions: vi.fn(),
			setGroups: vi.fn(),
			handleOpenFileTab: vi.fn(),
			refreshFileTree: vi.fn(),
			handleAutoRunRefresh: vi.fn(),
			startBatchRun: vi.fn(),
			stopBatchRun: vi.fn(),
			resumeAfterError: vi.fn(),
			skipCurrentDocument: vi.fn(),
			abortBatchOnError: vi.fn(),
			tabContextOps: handlers,
		} as any)
	);
}

function send(request: TabContextOpRequest) {
	const reply = vi.fn();
	window.dispatchEvent(new CustomEvent('maestro:tabContextOp', { detail: { request, reply } }));
	return reply;
}

beforeEach(() => {
	vi.clearAllMocks();
	handlers.summarizeTab.mockImplementation(async (sessionId: string, tabId: string) => ({
		success: true,
		sessionId,
		tabId,
		newTabId: 'compacted',
	}));
	handlers.mergeTabContext.mockResolvedValue({ success: true });
	handlers.transferTabContext.mockResolvedValue({ success: true, newTabId: 'moved' });
	useSessionStore.setState({
		sessions: ['a', 'b'].map((id) =>
			createMockSession({
				id,
				aiTabs: [createMockAITab({ id: `${id}-t1` }), createMockAITab({ id: `${id}-t2` })],
				activeTabId: `${id}-t1`,
			})
		),
		activeSessionId: 'a',
	});
});

describe('maestro:tabContextOp', () => {
	it('compacts through summarizeTab and replies with the new tab', async () => {
		setup();
		const reply = send({ op: 'compact', sessionId: 'b' });

		await waitFor(() => expect(reply).toHaveBeenCalledTimes(1));
		expect(handlers.summarizeTab).toHaveBeenCalledWith('b', 'b-t1', { background: false });
		expect(reply).toHaveBeenCalledWith({
			success: true,
			sessionId: 'b',
			tabId: 'b-t1',
			newTabId: 'compacted',
		});
	});

	it('merges through mergeTabContext with the explicit source and target tabs', async () => {
		setup();
		const reply = send({
			op: 'merge',
			sessionId: 'a',
			tabId: 'a-t2',
			targetSessionId: 'b',
			targetTabId: 'b-t2',
			background: true,
		});

		await waitFor(() => expect(reply).toHaveBeenCalledTimes(1));
		expect(handlers.mergeTabContext).toHaveBeenCalledWith(
			'a',
			'a-t2',
			'b',
			'b-t2',
			REMOTE_MERGE_OPTIONS,
			{ background: true }
		);
		expect(reply).toHaveBeenCalledWith(
			expect.objectContaining({ success: true, targetTabId: 'b-t2', staged: true })
		);
	});

	it('transfers through transferTabContext and replies with the new tab', async () => {
		setup();
		const reply = send({ op: 'transfer', sessionId: 'a', targetSessionId: 'b' });

		await waitFor(() => expect(reply).toHaveBeenCalledTimes(1));
		expect(handlers.transferTabContext).toHaveBeenCalledWith(
			'a',
			'a-t1',
			'b',
			{ groomContext: false, targetSessionId: 'b' },
			{ background: false }
		);
		expect(reply).toHaveBeenCalledWith(
			expect.objectContaining({ success: true, newTabId: 'moved' })
		);
	});

	it('replies with the failure the handler reports', async () => {
		handlers.transferTabContext.mockResolvedValueOnce({
			success: false,
			error: 'Target session not found',
		});
		setup();
		const reply = send({ op: 'transfer', sessionId: 'a', targetSessionId: 'b' });

		await waitFor(() => expect(reply).toHaveBeenCalledTimes(1));
		expect(reply).toHaveBeenCalledWith(
			expect.objectContaining({ success: false, error: 'Target session not found' })
		);
	});

	it('replies to an unknown agent without calling a handler', async () => {
		setup();
		const reply = send({ op: 'compact', sessionId: 'ghost' });

		await waitFor(() => expect(reply).toHaveBeenCalledTimes(1));
		expect(reply).toHaveBeenCalledWith({ success: false, error: 'Agent not found: ghost' });
		expect(handlers.summarizeTab).not.toHaveBeenCalled();
	});

	it('still replies when a handler throws', async () => {
		handlers.mergeTabContext.mockRejectedValueOnce(new Error('store exploded'));
		setup();
		const reply = send({ op: 'merge', sessionId: 'a', targetSessionId: 'b' });

		await waitFor(() => expect(reply).toHaveBeenCalledTimes(1));
		expect(reply).toHaveBeenCalledWith({
			success: false,
			error: 'store exploded',
			sessionId: 'a',
		});
	});
});
