/**
 * A turn cut by a lost link, in every mode that has a link (R4).
 *
 * An SSH agent's turn ends on this machine when its link is cut: ssh exits 255, main reports a
 * `network_error` naming the remote, the tab stops Thinking, and the outage dialog is surfaced. A
 * hosted agent's turn runs on its host, and the mirror keeps the host's last report through a
 * disconnect, so the tab used to stay Thinking forever. Now the sync ends it the same way once the
 * outage is confirmed, Stop settles it here when the host cannot be told, and once the host is back
 * the host says how the turn ended: still running, finished, or died (then the message is kept for
 * a retry, as a message the host could not take is). A local agent has no link to lose.
 */

import { act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { syncHostedAgents } from '../../../renderer/services/hostedAgentSync';
import { __resetHostedLinkLossForTests } from '../../../renderer/services/hostedLinkLoss';
import { interruptTurn } from '../../../renderer/services/turnInterrupt';
import { usePeerMirrorStore } from '../../../renderer/stores/peerMirrorStore';
import {
	registerAgentErrorSurfacer,
	registerDispatchDepsProvider,
	useRetryStore,
} from '../../../renderer/stores/retryStore';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';
import { isSshTransportError, useSshOutageStore } from '../../../renderer/stores/sshOutageStore';
import type { AgentError, LogEntry, Session } from '../../../renderer/types';
import { projectHostedSession } from '../../../renderer/utils/hostedSession';
import { classifyRetryableError } from '../../../shared/retryClassification';
import { liveTurnKey } from '../../../shared/maestro-lib/client/live-turn';
import type { PeerMirrorConnection } from '../../../shared/maestro-lib/client/peer-mirror';
import {
	createMirroredPeer,
	replacePeerAgents,
} from '../../../shared/maestro-lib/client/peer-mirror';
import type { SshReachabilityEvent } from '../../../shared/sshConnection';
import { createModeSession, resetStores } from '../../helpers';
import { createMockAITab } from '../../helpers/mockTab';

const toastMock = vi.hoisted(() => vi.fn());
vi.mock('../../../renderer/stores/notificationStore', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../renderer/stores/notificationStore')>()),
	notifyToast: toastMock,
}));

const maestro = window.maestro as unknown as Record<string, unknown>;
const transcript = vi.fn();
const act$ = vi.fn();
const flush = () => act(async () => undefined);

const QUESTION: LogEntry = { id: 'u1', timestamp: 10, source: 'user', text: 'Summarize the docs' };

/** The error main reports for an SSH agent's turn when its link is cut mid-turn. */
const sshTurnError: AgentError = {
	type: 'network_error',
	message: 'Unable to connect to "Box" over SSH. Connection closed.',
	recoverable: true,
	agentId: 'claude-code',
	sessionId: 'row-ai-t1',
	timestamp: 1,
	sshRemoteId: 'r1',
};

const hostOutage: SshReachabilityEvent = {
	remoteId: 'r1',
	remoteName: 'Box',
	reachable: false,
	message: 'The Maestro host on "Box" stopped answering.',
	since: 50,
	cause: 'host',
};

function peerWith(state: 'idle' | 'busy', connection: PeerMirrorConnection) {
	const { peer } = replacePeerAgents(
		createMirroredPeer({ peerId: 'box', remoteId: 'r1', name: 'Box' }),
		[
			{
				id: 'h1',
				name: 'Docs',
				toolType: 'claude-code',
				activeTabId: 't1',
				aiTabs: [{ id: 't1', name: 'Main', agentSessionId: 's1', state }],
			},
		],
		[],
		1
	);
	return { ...peer, connection };
}

/** Replace the host's report without dropping the transcripts read so far. */
function hostReports(state: 'idle' | 'busy', connection: PeerMirrorConnection) {
	usePeerMirrorStore.setState((current) => ({
		enabled: true,
		order: ['box'],
		peers: { ...current.peers, box: peerWith(state, connection) },
	}));
}

function seedHosted(): Session {
	const session = createModeSession('hosted', {
		id: 'row',
		name: 'Docs',
		state: 'busy',
		busySource: 'ai',
		activeTabId: 't1',
		aiTabs: [createMockAITab({ id: 't1', state: 'busy', logs: [QUESTION] })],
		executionQueue: [],
	});
	useSessionStore.setState({ sessions: [session], activeSessionId: session.id });
	return session;
}

const tab = () => useSessionStore.getState().sessions[0].aiTabs[0];
const record = () => useSessionStore.getState().sessions[0];
const raised: Array<{ processSessionId: string; error: AgentError }> = [];

function confirmOutage() {
	useSshOutageStore.getState().applyReachability(hostOutage);
}

describe('a turn cut by a lost link', () => {
	beforeEach(() => {
		resetStores(usePeerMirrorStore, useSessionStore);
		useSshOutageStore.setState({ outages: {} });
		useRetryStore.setState({ retries: {}, outages: {} });
		useSettingsStore.setState({ federationHostedAgents: true });
		__resetHostedLinkLossForTests();
		toastMock.mockReset();
		transcript.mockReset();
		act$.mockReset();
		maestro.federation = { transcript, act: act$ };
		raised.length = 0;
		registerAgentErrorSurfacer((processSessionId, error) =>
			raised.push({ processSessionId, error })
		);
		registerDispatchDepsProvider(() => ({}) as never);
		usePeerMirrorStore.getState().hydrate([peerWith('busy', 'connected')]);
		seedHosted();
		syncHostedAgents();
	});

	afterEach(() => {
		delete maestro.federation;
		registerAgentErrorSurfacer(null);
		registerDispatchDepsProvider(null);
	});

	it('ends with the same retryable connection error an SSH turn gets, naming the remote', () => {
		hostReports('busy', 'reconnecting');
		confirmOutage();
		syncHostedAgents();
		const error = tab().agentError!;
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

	it('stays Thinking while a reconnect is in progress, before the outage is confirmed', () => {
		hostReports('busy', 'reconnecting');
		syncHostedAgents();
		expect(tab().state).toBe('busy');
		expect(tab().agentError).toBeUndefined();
	});

	it('ends the tab once the outage is confirmed: not Thinking, the error, a note, and the dialog surfaced', () => {
		hostReports('busy', 'reconnecting');
		confirmOutage();
		syncHostedAgents();
		expect(tab().state).toBe('idle');
		expect(tab().thinkingStartTime).toBeUndefined();
		expect(tab().agentError?.message).toContain('Lost the connection to the Maestro host on "Box"');
		const note = tab().logs.at(-1)!;
		expect(note).toMatchObject({ source: 'error', agentError: tab().agentError });
		expect(record().state).toBe('error');
		expect(useSshOutageStore.getState().outages.r1.surfaced).toBe(true);

		// Settled: another pass writes nothing.
		const before = record();
		syncHostedAgents();
		expect(record()).toBe(before);
	});

	it('also ends the tab when the mirror gives the connection up', () => {
		hostReports('busy', 'lost');
		syncHostedAgents();
		expect(tab().state).toBe('idle');
		expect(tab().agentError?.source).toBe('host-link');
	});

	it('draws the host turn Thinking again when the host is back and still runs it, with the error cleared', async () => {
		hostReports('busy', 'reconnecting');
		confirmOutage();
		syncHostedAgents();
		expect(tab().state).toBe('idle');

		useSshOutageStore.getState().applyReachability({ ...hostOutage, reachable: true, since: 60 });
		hostReports('busy', 'connected');
		syncHostedAgents();
		expect(tab().state).toBe('busy');
		expect(tab().agentError).toBeUndefined();
		await flush();
		expect(raised).toEqual([]);
	});

	it('shows the answer of a turn that finished while the link was down, and sends nothing again', async () => {
		hostReports('busy', 'reconnecting');
		confirmOutage();
		syncHostedAgents();

		transcript.mockResolvedValue([
			QUESTION,
			{ id: 'a1', timestamp: 20, source: 'ai', text: 'The docs say...' },
		]);
		useSshOutageStore.getState().applyReachability({ ...hostOutage, reachable: true, since: 60 });
		hostReports('idle', 'connected');
		syncHostedAgents();
		await flush();
		syncHostedAgents();
		expect(tab().state).toBe('idle');
		expect(tab().agentError).toBeUndefined();
		expect(tab().logs.some((entry) => entry.id === 'a1')).toBe(true);
		expect(raised).toEqual([]);
	});

	it('keeps the message for a retry when the turn died with the host (no answer after it)', async () => {
		hostReports('busy', 'reconnecting');
		confirmOutage();
		syncHostedAgents();

		transcript.mockResolvedValue([QUESTION]);
		useSshOutageStore.getState().applyReachability({ ...hostOutage, reachable: true, since: 60 });
		hostReports('idle', 'connected');
		syncHostedAgents();
		await flush();
		expect(raised).toHaveLength(1);
		expect(raised[0].processSessionId).toBe('row-ai-t1');
		expect(raised[0].error).toMatchObject({ type: 'network_error', sshRemoteId: 'r1' });
		expect(raised[0].error.message).toContain('stopped before this turn finished');

		// Decided once: the next pass raises nothing more.
		syncHostedAgents();
		await flush();
		expect(raised).toHaveLength(1);
	});

	it('never sends the message again on a failed read, and decides on the next read that lands', async () => {
		hostReports('busy', 'reconnecting');
		confirmOutage();
		syncHostedAgents();

		transcript.mockRejectedValue(new Error('read failed'));
		useSshOutageStore.getState().applyReachability({ ...hostOutage, reachable: true, since: 60 });
		hostReports('idle', 'connected');
		syncHostedAgents();
		await flush();
		const reads = transcript.mock.calls.length;
		syncHostedAgents();
		await flush();
		syncHostedAgents();
		await flush();
		expect(raised).toEqual([]);
		// No read loop against a host that errors.
		expect(transcript).toHaveBeenCalledTimes(reads);

		// The tab's next read (a reconnect marked it stale, or the user opened it) lands.
		const version = usePeerMirrorStore.getState().beginTranscriptRead('box', 'h1', 't1');
		usePeerMirrorStore
			.getState()
			.finishTranscriptRead('box', 'h1', 't1', [QUESTION] as never, version);
		syncHostedAgents();
		await flush();
		expect(raised).toHaveLength(1);
		expect(raised[0].error.message).toContain('stopped before this turn finished');
	});

	it.each(['before', 'after'] as const)(
		'never sends again a turn stopped here while the host could not be told (outage confirmed %s Stop)',
		async (order) => {
			hostReports('busy', 'reconnecting');
			if (order === 'before') {
				confirmOutage();
				syncHostedAgents();
				// Already ended by the outage; Stop has nothing to forward, so mark it as a Stop here.
				hostReports('busy', 'reconnecting');
			}
			syncHostedAgents();
			if (order === 'after') {
				await interruptTurn('row', { tabId: 't1' });
				confirmOutage();
				syncHostedAgents();
			} else {
				const { endHostedTurnsHere } = await import('../../../renderer/services/hostedLinkLoss');
				endHostedTurnsHere('row', ['t1'], 'Box');
			}

			transcript.mockResolvedValue([QUESTION]);
			useSshOutageStore.getState().applyReachability({ ...hostOutage, reachable: true, since: 60 });
			hostReports('idle', 'connected');
			syncHostedAgents();
			await flush();
			syncHostedAgents();
			await flush();
			expect(raised).toEqual([]);
		}
	);

	it('never sends again a stopped turn the host still ran, cut again by a later outage', async () => {
		hostReports('busy', 'reconnecting');
		syncHostedAgents();
		await interruptTurn('row', { tabId: 't1' });

		// Back, and the host still runs the stopped turn: Thinking again.
		transcript.mockResolvedValue([QUESTION]);
		hostReports('busy', 'connected');
		syncHostedAgents();
		await flush();
		expect(tab().state).toBe('busy');

		// The link drops again, the outage is confirmed, and the host comes back idle with no answer.
		hostReports('busy', 'reconnecting');
		confirmOutage();
		syncHostedAgents();
		useSshOutageStore.getState().applyReachability({ ...hostOutage, reachable: true, since: 60 });
		hostReports('idle', 'connected');
		syncHostedAgents();
		await flush();
		syncHostedAgents();
		await flush();
		expect(raised).toEqual([]);
	});

	it('Stop while the host is not connected ends the turn here and says the host was not told', async () => {
		hostReports('busy', 'reconnecting');
		syncHostedAgents();
		expect(tab().state).toBe('busy');

		const result = await interruptTurn('row', { tabId: 't1' });
		expect(result).toMatchObject({ success: true, stoppedTabIds: ['t1'] });
		expect(act$).not.toHaveBeenCalled();
		expect(tab().state).toBe('idle');
		expect(toastMock).toHaveBeenCalledWith(
			expect.objectContaining({ title: 'Stopped here', color: 'orange' })
		);
		// The mirror still says busy; the tab stays ended until the host reports again.
		syncHostedAgents();
		expect(tab().state).toBe('idle');

		// Back, and the host still runs it: Thinking again, and Stop goes to the host.
		hostReports('busy', 'connected');
		syncHostedAgents();
		expect(tab().state).toBe('busy');
	});

	it('Stop with the host connected still goes to the host', async () => {
		act$.mockResolvedValue({ ok: true, result: { kind: 'interrupt' } });
		await interruptTurn('row', { tabId: 't1' });
		expect(act$).toHaveBeenCalledWith('box', 'h1', { kind: 'interrupt', tabId: 't1' });
		expect(toastMock).not.toHaveBeenCalled();
	});
});

describe('projectHostedSession with the link lost', () => {
	const linkLost: AgentError = {
		type: 'network_error',
		source: 'host-link',
		message: 'Lost the connection to the Maestro host on "Box" during this turn.',
		recoverable: true,
		agentId: 'claude-code',
		sshRemoteId: 'r1',
		timestamp: 50,
	};
	const agent = peerWith('busy', 'connected').agents[0];

	it('puts the note after the live entries of the turn, and settles on the second pass', () => {
		const local = createModeSession('hosted', {
			id: 'row',
			activeTabId: 't1',
			aiTabs: [createMockAITab({ id: 't1', state: 'busy', logs: [QUESTION] })],
		});
		const liveTurns = {
			[liveTurnKey('h1', 't1')]: {
				entries: [{ id: 'live1', timestamp: 70, source: 'stdout', text: 'partial' }],
			},
		} as never;
		const once = projectHostedSession(local, { agent, liveTurns, linkLost });
		expect(once.aiTabs[0].logs.map((entry) => entry.id)).toEqual([
			'u1',
			'live1',
			'host-link-50-t1',
		]);
		expect(projectHostedSession(once, { agent, liveTurns, linkLost })).toBe(once);
	});

	it('still draws a live entry that moves on while the note is last', () => {
		const local = createModeSession('hosted', {
			id: 'row',
			activeTabId: 't1',
			aiTabs: [createMockAITab({ id: 't1', state: 'busy', logs: [QUESTION] })],
		});
		const live = (text: string) =>
			({
				[liveTurnKey('h1', 't1')]: {
					entries: [{ id: 'live1', timestamp: 70, source: 'stdout', text }],
				},
			}) as never;
		const once = projectHostedSession(local, { agent, liveTurns: live('partial'), linkLost });
		const twice = projectHostedSession(once, {
			agent,
			liveTurns: live('partial answer'),
			linkLost,
		});
		expect(twice.aiTabs[0].logs.find((entry) => entry.id === 'live1')?.text).toBe('partial answer');
		expect(twice.aiTabs[0].logs.at(-1)?.id).toBe('host-link-50-t1');
	});
});
