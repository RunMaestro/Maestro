/**
 * A message sent while the link is down is kept, in every mode that has a link.
 *
 * An SSH agent's turn fails on this machine: ssh exits 255 and main reports a `network_error`
 * naming the remote, which the agent-error listener hands to Agent Resilience (the auto-retry
 * card, the backoff, the message parked at the head of its tab's queue). A hosted agent's send is
 * refused before anything runs when its host is not connected; `keepTurnForHost()` raises that
 * refusal as the same error through the same listener, so the same retry follows. A send whose
 * receipt was lost is never kept: the host may have run it, and a retry could run it twice.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	handQueuedItemToHost,
	keepTurnForHost,
	sendTakenItemToHost,
} from '../../../renderer/services/hostedQueuedTurn';
import { usePeerMirrorStore } from '../../../renderer/stores/peerMirrorStore';
import {
	getRetryEntry,
	noteDirectDispatch,
	registerAgentErrorSurfacer,
	registerDispatchDepsProvider,
	scheduleRetryForError,
	useRetryStore,
} from '../../../renderer/stores/retryStore';
import { isSshTransportError } from '../../../renderer/stores/sshOutageStore';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';
import { useNotificationStore } from '../../../renderer/stores/notificationStore';
import type { AgentError, QueuedItem } from '../../../renderer/types';
import { parseSessionId } from '../../../renderer/utils/sessionIdParser';
import { classifyRetryableError } from '../../../shared/retryClassification';
import {
	createMirroredPeer,
	replacePeerAgents,
} from '../../../shared/maestro-lib/client/peer-mirror';
import { createModeSession, resetStores, type AgentMode } from '../../helpers';
import { createMockAITab } from '../../helpers/mockTab';

const maestro = window.maestro as unknown as Record<string, unknown>;
const act$ = vi.fn();
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const UNAVAILABLE = {
	ok: false,
	code: 'host-unavailable',
	error: 'Not connected to peer "box" (lost). Nothing was sent.',
};

/** What the agent-error listener does with a retryable error: hand it to Agent Resilience. */
const raised: Array<{ processSessionId: string; error: AgentError }> = [];
function listenerStandIn(processSessionId: string, error: AgentError) {
	raised.push({ processSessionId, error });
	const parsed = parseSessionId(processSessionId);
	scheduleRetryForError(parsed.baseSessionId, parsed.tabId as string, error);
}

function hydrateHost() {
	const { peer } = replacePeerAgents(
		createMirroredPeer({ peerId: 'box', remoteId: 'r1', name: 'Box' }),
		[{ id: 'h1', name: 'Docs', toolType: 'claude-code', aiTabs: [{ id: 't1' }] }],
		[],
		1
	);
	usePeerMirrorStore.getState().hydrate([{ ...peer, connection: 'connected' }]);
}

function seed(mode: AgentMode) {
	const session = createModeSession(mode, {
		id: 'row',
		name: 'Docs',
		state: 'idle',
		activeTabId: 't1',
		aiTabs: [createMockAITab({ id: 't1' })],
		executionQueue: [],
	});
	useSessionStore.setState({ sessions: [session], activeSessionId: session.id });
	return session;
}

const queue = () => useSessionStore.getState().sessions[0].executionQueue ?? [];
const message = (id: string, text: string): QueuedItem => ({
	id,
	timestamp: 1,
	tabId: 't1',
	type: 'message',
	text,
});

/** The error main reports for an SSH agent's turn when ssh cannot reach its remote. */
const sshTurnError: AgentError = {
	type: 'network_error',
	message: 'Unable to connect to "Box" over SSH. Connection refused.',
	recoverable: true,
	agentId: 'claude-code',
	sessionId: 'row-ai-t1',
	timestamp: 1,
	sshRemoteId: 'r1',
};

describe('a message sent while the link is down is kept for a retry', () => {
	beforeEach(() => {
		resetStores(usePeerMirrorStore, useSessionStore);
		useRetryStore.setState({ retries: {}, outages: {} });
		useNotificationStore.setState({ toasts: [] });
		useSettingsStore.setState({ federationHostedAgents: true });
		act$.mockReset();
		maestro.federation = { act: act$ };
		raised.length = 0;
		registerAgentErrorSurfacer(listenerStandIn);
		registerDispatchDepsProvider(() => ({}) as never);
		hydrateHost();
	});

	afterEach(() => {
		delete maestro.federation;
		registerAgentErrorSurfacer(null);
		registerDispatchDepsProvider(null);
		useRetryStore.setState({ retries: {}, outages: {} });
	});

	it('raises the same retryable connection error for an SSH and a hosted agent', () => {
		const hosted = seed('hosted');
		expect(keepTurnForHost(hosted.id, message('m1', 'hello'), UNAVAILABLE.error)).toBe(true);
		const [{ processSessionId, error }] = raised;

		expect(processSessionId).toBe('row-ai-t1');
		for (const candidate of [sshTurnError, error]) {
			expect(classifyRetryableError(candidate)).toBe('availability');
			expect(isSshTransportError(candidate)).toBe(true);
		}
		expect(error).toMatchObject({
			type: sshTurnError.type,
			recoverable: sshTurnError.recoverable,
			sshRemoteId: sshTurnError.sshRemoteId,
		});
	});

	it('parks the refused message at the head of its tab queue under one auto-retry, as SSH does', () => {
		const outcomes: Record<string, unknown> = {};
		for (const mode of ['ssh', 'hosted'] as const) {
			useRetryStore.setState({ retries: {}, outages: {} });
			const session = seed(mode);
			const item = message('m1', 'hello');
			if (mode === 'ssh') {
				// The SSH turn was dispatched here, then ssh failed and main reported it.
				noteDirectDispatch(session.id, item);
				listenerStandIn('row-ai-t1', sshTurnError);
			} else {
				keepTurnForHost(session.id, item, UNAVAILABLE.error);
			}
			const entry = getRetryEntry(session.id, 't1');
			outcomes[mode] = {
				strategy: entry?.strategy,
				status: entry?.status,
				attempt: entry?.attempt,
				held: entry?.heldItemId,
				queue: queue().map((queued) => [queued.id, queued.text, queued.paused === true]),
			};
		}
		expect(outcomes.hosted).toEqual(outcomes.ssh);
		expect(outcomes.hosted).toMatchObject({
			strategy: 'availability',
			status: 'scheduled',
			attempt: 0,
			held: 'm1',
			queue: [['m1', 'hello', false]],
		});
		expect(useNotificationStore.getState().toasts).toHaveLength(0);
	});

	it('a queued item the host refuses as not connected is kept for a retry, not held paused', async () => {
		const session = seed('hosted');
		act$.mockResolvedValue(UNAVAILABLE);
		useSessionStore.setState({
			sessions: [{ ...session, executionQueue: [message('q1', 'wake up')] }],
		});

		expect(handQueuedItemToHost(session.id, 'q1')).toBe(true);
		await flush();

		expect(getRetryEntry(session.id, 't1')).toMatchObject({
			heldItemId: 'q1',
			status: 'scheduled',
		});
		expect(queue().map((queued) => [queued.id, queued.paused === true])).toEqual([['q1', false]]);
		// The listener reports it; the refusal's own red toast is not raised on top.
		expect(useNotificationStore.getState().toasts).toHaveLength(0);
	});

	it('ends the outage as recovered when the host takes the resend', async () => {
		const session = seed('hosted');
		keepTurnForHost(session.id, message('m1', 'hello'), UNAVAILABLE.error);
		const entry = getRetryEntry(session.id, 't1')!;
		// The retry fired: the resend is on its way.
		useRetryStore.getState().setEntry(entry.key, { ...entry, status: 'in-flight' });
		act$.mockResolvedValue({ ok: true, result: { kind: 'send', receipt: { status: 'started' } } });

		await sendTakenItemToHost(session.id, message('m1', 'hello'));
		await flush();

		expect(getRetryEntry(session.id, 't1')).toBeUndefined();
		expect(useRetryStore.getState().outages[entry.outageId]?.status).toBe('recovered');
		expect(act$.mock.calls.filter(([, , action]) => action?.kind === 'send')).toHaveLength(1);
	});

	it('a resend refused again continues the same outage with the next backoff step', async () => {
		const session = seed('hosted');
		keepTurnForHost(session.id, message('m1', 'hello'), UNAVAILABLE.error);
		const entry = getRetryEntry(session.id, 't1')!;
		useRetryStore.getState().setEntry(entry.key, { ...entry, status: 'in-flight' });
		act$.mockResolvedValue(UNAVAILABLE);

		await sendTakenItemToHost(session.id, message('m1', 'hello'));
		await flush();

		expect(getRetryEntry(session.id, 't1')).toMatchObject({
			outageId: entry.outageId,
			attempt: 1,
			status: 'scheduled',
		});
	});

	it('never retries a send whose receipt was lost: the host may have run it', async () => {
		const session = seed('hosted');
		act$.mockResolvedValue({
			ok: false,
			code: 'timeout',
			unknown: true,
			error: 'The host did not answer.',
		});
		useSessionStore.setState({
			sessions: [{ ...session, executionQueue: [message('q1', 'wake up')] }],
		});

		handQueuedItemToHost(session.id, 'q1');
		await flush();

		expect(getRetryEntry(session.id, 't1')).toBeUndefined();
		expect(raised).toHaveLength(0);
		expect(queue().map((queued) => [queued.id, queued.paused === true])).toEqual([['q1', true]]);
		expect(useNotificationStore.getState().toasts[0]?.message).toContain('may have taken it');
	});

	it('a second message of the same tab waits behind the kept one, in order, and is not sent', async () => {
		const session = seed('hosted');
		keepTurnForHost(session.id, message('m1', 'first'), UNAVAILABLE.error);
		expect(keepTurnForHost(session.id, message('m2', 'second'), UNAVAILABLE.error)).toBe(true);

		expect(queue().map((queued) => queued.id)).toEqual(['m1', 'm2']);
		expect(getRetryEntry(session.id, 't1')?.heldItemId).toBe('m1');

		// A queued item for that tab is not handed over ahead of the kept message either.
		useSessionStore.setState({
			sessions: [
				{
					...useSessionStore.getState().sessions[0],
					executionQueue: [...queue(), message('q3', 'third')],
				},
			],
		});
		expect(handQueuedItemToHost(session.id, 'q3')).toBe(false);
		expect(act$).not.toHaveBeenCalled();
	});
});
