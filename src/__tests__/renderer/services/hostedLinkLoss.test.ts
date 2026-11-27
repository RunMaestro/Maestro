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
 *
 * With Agent Resilience on (R13), the cut turn's message is kept at the cut under the same
 * auto-retry card an SSH turn's gets, drawn once, and the host's answer decides whether it is sent.
 */

import { act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { syncHostedAgents } from '../../../renderer/services/hostedAgentSync';
import {
	__resetHostedLinkLossForTests,
	HOST_REPORT_REQUEST_MS,
	cutHostedTurnTabs,
	hostedCutsKept,
} from '../../../renderer/services/hostedLinkLoss';
import {
	handQueuedItemToHost,
	keepTurnForHost,
	sendTakenItemToHost,
} from '../../../renderer/services/hostedQueuedTurn';
import { interruptTurn } from '../../../renderer/services/turnInterrupt';
import { TURN_CANCELED_NOTE } from '../../../shared/maestro-lib/store/transcript';
import { usePeerMirrorStore } from '../../../renderer/stores/peerMirrorStore';
import {
	getRetryEntry,
	noteDirectDispatch,
	notOnHostText,
	registerAgentErrorSurfacer,
	registerDispatchDepsProvider,
	retryNow,
	scheduleRetryForError,
	stopRetriesForAgent,
	useRetryStore,
} from '../../../renderer/stores/retryStore';
import { parseSessionId } from '../../../renderer/utils/sessionIdParser';
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
	type MirroredPeer,
	replacePeerAgents,
	setPeerConnection,
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
/** A message the user sent on the same tab after QUESTION, and its answer. */
const LATER_MESSAGE: LogEntry = { id: 'u2', timestamp: 30, source: 'user', text: 'And the tests?' };
const LATER_ANSWER: LogEntry = { id: 'a2', timestamp: 40, source: 'ai', text: 'The tests...' };

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

function peerWith(
	state: 'idle' | 'busy',
	connection: PeerMirrorConnection,
	thinkingStartTime?: number
) {
	const { peer } = replacePeerAgents(
		createMirroredPeer({ peerId: 'box', remoteId: 'r1', name: 'Box' }),
		[
			{
				id: 'h1',
				name: 'Docs',
				toolType: 'claude-code',
				activeTabId: 't1',
				aiTabs: [
					{
						id: 't1',
						name: 'Main',
						agentSessionId: 's1',
						state,
						...(thinkingStartTime !== undefined ? { thinkingStartTime } : {}),
					},
				],
			},
		],
		[],
		1
	);
	// As the mirror sets it: a link that is down forgets that the host reported since.
	return setPeerConnection(peer, connection).peer;
}

/**
 * `peer` as the mirror holds it once the link came back and before the host's first report since:
 * connected, still the agents it listed before the link went down (R35).
 */
function reconnectedBeforeReport(peer: MirroredPeer): MirroredPeer {
	return setPeerConnection(setPeerConnection(peer, 'reconnecting').peer, 'connected').peer;
}

/** Replace the host's report without dropping the transcripts read so far. */
function hostReports(
	state: 'idle' | 'busy',
	connection: PeerMirrorConnection,
	thinkingStartTime?: number
) {
	usePeerMirrorStore.setState((current) => ({
		enabled: true,
		order: ['box'],
		peers: { ...current.peers, box: peerWith(state, connection, thinkingStartTime) },
	}));
}

/**
 * A busy hosted record. `resilience` off (the default here) is the cut with no auto-retry to take
 * its message: the tab draws the link error and a note, and the host decides once it is back.
 */
function seedHosted(resilience = false): Session {
	const session = createModeSession('hosted', {
		id: 'row',
		...(resilience ? {} : { retryOnAvailabilityErrors: false }),
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

describe('a turn cut by a lost link (Agent Resilience off: the cut draws its note)', () => {
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

	it('draws one link card for one cut, reworded when the outage is confirmed after the connection was lost (R12)', () => {
		const linkNotes = () => tab().logs.filter((entry) => entry.agentError?.source === 'host-link');
		hostReports('busy', 'lost');
		syncHostedAgents();
		expect(linkNotes()).toHaveLength(1);
		const first = linkNotes()[0];

		confirmOutage();
		syncHostedAgents();
		expect(linkNotes()).toHaveLength(1);
		expect(linkNotes()[0].id).toBe(first.id);
		expect(linkNotes()[0].text).toContain(hostOutage.message);
		expect(tab().agentError?.timestamp).toBe(first.timestamp);

		// Back to "connection lost" only: still the one card.
		useSshOutageStore.getState().applyReachability({ ...hostOutage, reachable: true, since: 60 });
		syncHostedAgents();
		expect(linkNotes()).toHaveLength(1);
		expect(linkNotes()[0].id).toBe(first.id);
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
				// Already ended by the outage: the tab is drawn idle, and Stop still finds its cut turn.
				expect(tab().state).toBe('idle');
			}
			syncHostedAgents();
			const result = await interruptTurn('row', { tabId: 't1' });
			expect(result).toMatchObject({ success: true, wasBusy: true, stoppedTabIds: ['t1'] });
			expect(act$).not.toHaveBeenCalled();
			if (order === 'after') {
				confirmOutage();
				syncHostedAgents();
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
		// The host was not told, so it writes no line: the tab ends on the one a local Stop writes
		// (CodeRabbit on #2154).
		const canceled = () => tab().logs.filter((entry) => entry.text === TURN_CANCELED_NOTE);
		expect(canceled()).toHaveLength(1);
		// The mirror still says busy; the tab stays ended until the host reports again.
		syncHostedAgents();
		expect(tab().state).toBe('idle');
		expect(canceled()).toHaveLength(1);

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

	it('draws a running turn running once the mirror is connected, while the SSH outage is still on record (R11)', async () => {
		// The SSH link drops: the SSH outage is confirmed, and the tab is drawn ended.
		const sshOutage: SshReachabilityEvent = { ...hostOutage, cause: 'ssh', message: 'ssh died' };
		hostReports('busy', 'reconnecting');
		useSshOutageStore.getState().applyReachability(sshOutage);
		syncHostedAgents();
		expect(tab().state).toBe('idle');

		// The mirror reconnects and the host still runs the turn. The SSH outage clears only on its
		// own 30 s re-probe, so it is still on record here.
		transcript.mockResolvedValue([QUESTION]);
		hostReports('busy', 'connected');
		syncHostedAgents();
		expect(useSshOutageStore.getState().outages.r1).toBeDefined();
		expect(tab().state).toBe('busy');
		expect(tab().agentError).toBeUndefined();
		expect(record().state).toBe('busy');

		// Stop goes to the host, as for any running hosted turn: nothing ends here.
		act$.mockResolvedValue({ ok: true, result: { kind: 'interrupt' } });
		await interruptTurn('row', { tabId: 't1' });
		expect(act$).toHaveBeenCalledWith('box', 'h1', { kind: 'interrupt', tabId: 't1' });
		expect(toastMock).not.toHaveBeenCalled();

		// The cut is settled by the host's report: nothing is kept or sent again.
		await flush();
		syncHostedAgents();
		await flush();
		expect(raised).toEqual([]);
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
			'host-link-t1-u1',
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
		expect(twice.aiTabs[0].logs.at(-1)?.id).toBe('host-link-t1-u1');
	});

	it('keeps one note when the turn message lands after the cut was drawn (a late transcript read)', () => {
		const local = createModeSession('hosted', {
			id: 'row',
			activeTabId: 't1',
			aiTabs: [createMockAITab({ id: 't1', state: 'busy', logs: [] })],
		});
		const once = projectHostedSession(local, { agent, linkLost });
		expect(once.aiTabs[0].logs.map((entry) => entry.id)).toEqual(['host-link-t1-50']);

		// A read already in flight lands during the loss, with the turn's message before the note.
		const late = {
			...once,
			aiTabs: [{ ...once.aiTabs[0], logs: [QUESTION, ...once.aiTabs[0].logs] }],
		};
		const twice = projectHostedSession(late, { agent, linkLost });
		const notes = twice.aiTabs[0].logs.filter((entry) => entry.agentError?.source === 'host-link');
		expect(notes.map((entry) => entry.id)).toEqual(['host-link-t1-50']);
	});
});

/** What the agent-error listener does with a retryable error: hand it to Agent Resilience. */
function listenerStandIn(processSessionId: string, error: AgentError) {
	raised.push({ processSessionId, error });
	const parsed = parseSessionId(processSessionId);
	scheduleRetryForError(parsed.baseSessionId, parsed.tabId as string, error);
}

describe('a turn cut by a lost link is kept under the retry card, drawn once (R13)', () => {
	const queue = () => record().executionQueue ?? [];
	const userBubbles = () => tab().logs.filter((entry) => entry.source === 'user');
	const linkNotes = () => tab().logs.filter((entry) => entry.agentError?.source === 'host-link');
	const sends = () => act$.mock.calls.filter(([, , action]) => action.kind === 'send');

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
		registerAgentErrorSurfacer(listenerStandIn);
		registerDispatchDepsProvider(() => ({}) as never);
		usePeerMirrorStore.getState().hydrate([peerWith('busy', 'connected')]);
		seedHosted(true);
		syncHostedAgents();
	});

	afterEach(() => {
		delete maestro.federation;
		registerAgentErrorSurfacer(null);
		registerDispatchDepsProvider(null);
		useRetryStore.setState({ retries: {}, outages: {} });
	});

	/** The link drops mid-turn and the outage is confirmed. */
	function cut() {
		hostReports('busy', 'reconnecting');
		confirmOutage();
		syncHostedAgents();
	}

	/** The host is back and reports the tab `state`, with `entries` in its transcript. */
	async function hostBack(state: 'idle' | 'busy', entries: LogEntry[]) {
		transcript.mockResolvedValue(entries);
		useSshOutageStore.getState().applyReachability({ ...hostOutage, reachable: true, since: 60 });
		hostReports(state, 'connected');
		syncHostedAgents();
		await flush();
		syncHostedAgents();
		await flush();
	}

	it('shows the SSH outcome at the cut: the message under the retry card, once, with no link card', () => {
		const outcomes: Record<string, unknown> = {};
		// SSH: the turn was dispatched here; ssh dies with the link and main reports it.
		const ssh = createModeSession('ssh', {
			id: 'ssh-row',
			name: 'Docs',
			activeTabId: 't1',
			aiTabs: [createMockAITab({ id: 't1', logs: [QUESTION] })],
			executionQueue: [],
		});
		useSessionStore.setState({ sessions: [ssh, ...useSessionStore.getState().sessions] });
		noteDirectDispatch(ssh.id, {
			id: 'q-ssh',
			timestamp: 1,
			tabId: 't1',
			type: 'message',
			text: QUESTION.text,
		});
		listenerStandIn('ssh-row-ai-t1', { ...sshTurnError, sessionId: 'ssh-row-ai-t1' });
		cut();
		for (const id of ['ssh-row', 'row']) {
			const session = useSessionStore.getState().sessions.find((candidate) => candidate.id === id)!;
			const entry = getRetryEntry(id, 't1');
			const outage = entry ? useRetryStore.getState().outages[entry.outageId] : undefined;
			const tab1 = session.aiTabs[0];
			outcomes[id] = {
				state: tab1.state,
				retry: entry?.status,
				cause: outage?.cause,
				queued: (session.executionQueue ?? []).map((item) => item.text),
				bubbles: tab1.logs.filter((log) => log.source === 'user').map((log) => log.text),
				linkCards: tab1.logs.filter((log) => log.agentError?.source === 'host-link').length,
			};
		}
		expect(outcomes.row).toEqual(outcomes['ssh-row']);
		expect(outcomes.row).toEqual({
			state: 'idle',
			retry: 'scheduled',
			cause: 'connection',
			queued: [QUESTION.text],
			bubbles: [QUESTION.text],
			linkCards: 0,
		});
		// The kept message names the host's entry for it, so its resend draws no second bubble.
		expect(useSessionStore.getState().sessions[1].executionQueue?.[0]?.hostEntryId).toBe('u1');
		expect(useSshOutageStore.getState().outages.r1.surfaced).toBe(true);
	});

	it("keeps nothing for a turn whose own message has not reached this tab: never the previous turn's", () => {
		// The host started a turn after QUESTION (timestamp 10), and its message is not drawn here yet.
		hostReports('busy', 'reconnecting', 100);
		confirmOutage();
		syncHostedAgents();
		expect(queue()).toHaveLength(0);
		expect(getRetryEntry('row', 't1')).toBeUndefined();
		// The cut draws its note instead, as when no message can be kept.
		expect(linkNotes()).toHaveLength(1);
	});

	it('keeps the message the running turn answers (not older than the turn)', () => {
		hostReports('busy', 'reconnecting', QUESTION.timestamp);
		confirmOutage();
		syncHostedAgents();
		expect(queue().map((item) => item.hostEntryId)).toEqual(['u1']);
	});

	it('keeps the cut message once, however many passes the sync makes', () => {
		cut();
		syncHostedAgents();
		syncHostedAgents();
		expect(raised).toHaveLength(1);
		expect(queue()).toHaveLength(1);
		expect(linkNotes()).toHaveLength(0);
	});

	it('sends the kept message at once, naming its entry, when the host is back and the turn died', async () => {
		cut();
		act$.mockResolvedValue({ ok: true, result: { kind: 'send', receipt: { status: 'ran' } } });
		await hostBack('idle', [QUESTION]);
		expect(sends()).toHaveLength(1);
		expect(sends()[0][2]).toMatchObject({
			kind: 'send',
			tabId: 't1',
			text: QUESTION.text,
			entryId: 'u1',
		});
		expect(getRetryEntry('row', 't1')).toBeUndefined();
		expect(queue()).toHaveLength(0);
		expect(userBubbles()).toHaveLength(1);
	});

	// Parity R31, as the live pass caught it: a host that died mid-turn and was started again. The
	// mirror says connected while it still holds the host's report from before the cut (the tab
	// busy), and the tab's read lands before the restarted host's first snapshot.
	it('decides from the host report after the reconnect, never the one that drew the cut turn running (R31)', async () => {
		cut();
		act$.mockResolvedValue({ ok: true, result: { kind: 'send', receipt: { status: 'ran' } } });
		transcript.mockResolvedValue([QUESTION]);
		useSshOutageStore.getState().applyReachability({ ...hostOutage, reachable: true, since: 60 });
		usePeerMirrorStore.setState((current) => ({
			peers: { ...current.peers, box: { ...current.peers.box, connection: 'connected' } },
		}));
		syncHostedAgents();
		await flush();
		syncHostedAgents();
		await flush();
		// The read is in, the report is still the old one: nothing is settled, nothing sent.
		expect(sends()).toHaveLength(0);
		expect(getRetryEntry('row', 't1')).toBeDefined();
		expect(queue().map((item) => item.hostEntryId)).toEqual(['u1']);

		// The restarted host's snapshot: the tab is idle. Its turn died with the host: sent once.
		hostReports('idle', 'connected');
		syncHostedAgents();
		await flush();
		syncHostedAgents();
		await flush();
		syncHostedAgents();
		await flush();
		expect(sends()).toHaveLength(1);
		expect(sends()[0][2]).toMatchObject({ kind: 'send', text: QUESTION.text, entryId: 'u1' });
	});

	// Parity R39: a link that comes back without a new report (a resumed attach sends none) would
	// leave the cut waiting for ever, the card hanging: the host is asked for its report.
	it('asks the host for its report when none came within a few seconds of the reconnect (R39)', async () => {
		vi.useFakeTimers();
		try {
			cut();
			act$.mockResolvedValue({ ok: true, result: { kind: 'send', receipt: { status: 'ran' } } });
			transcript.mockResolvedValue([QUESTION]);
			const reconnect = vi.fn(async () => {
				// The host answers with its whole agent list: the tab is idle, the turn died.
				hostReports('idle', 'connected');
				return { ok: true };
			});
			maestro.federation = { transcript, act: act$, reconnect };
			useSshOutageStore.getState().applyReachability({ ...hostOutage, reachable: true, since: 60 });
			usePeerMirrorStore.setState((current) => ({
				peers: { ...current.peers, box: { ...current.peers.box, connection: 'connected' } },
			}));
			syncHostedAgents();
			await flush();
			expect(reconnect).not.toHaveBeenCalled();
			await act(async () => {
				vi.advanceTimersByTime(HOST_REPORT_REQUEST_MS);
			});
			expect(reconnect).toHaveBeenCalledTimes(1);
			expect(reconnect).toHaveBeenCalledWith('box');
			syncHostedAgents();
			await flush();
			syncHostedAgents();
			await flush();
			expect(sends()).toHaveLength(1);
			expect(sends()[0][2]).toMatchObject({ kind: 'send', text: QUESTION.text, entryId: 'u1' });
			// Asked once: no loop against the host.
			await act(async () => {
				vi.advanceTimersByTime(HOST_REPORT_REQUEST_MS * 2);
			});
			expect(reconnect).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it('never sends again a cut turn the host reports running after the reconnect (R31)', async () => {
		cut();
		transcript.mockResolvedValue([QUESTION]);
		useSshOutageStore.getState().applyReachability({ ...hostOutage, reachable: true, since: 60 });
		usePeerMirrorStore.setState((current) => ({
			peers: { ...current.peers, box: { ...current.peers.box, connection: 'connected' } },
		}));
		syncHostedAgents();
		await flush();
		// A fresh report (a desktop host that kept running): the turn runs there.
		hostReports('busy', 'connected');
		syncHostedAgents();
		await flush();
		syncHostedAgents();
		await flush();
		expect(sends()).toHaveLength(0);
		expect(getRetryEntry('row', 't1')).toBeUndefined();
		expect(queue()).toHaveLength(0);
	});

	it('never sends again a cut turn that ended on its own provider error on the host (R31)', async () => {
		cut();
		await hostBack('idle', [
			QUESTION,
			{ id: 'e1', timestamp: 20, source: 'error', text: 'The provider failed.' },
		]);
		expect(sends()).toHaveLength(0);
		expect(queue()).toHaveLength(0);
	});

	// Parity R36: a desktop host writes streamed text into the tab as it arrives, so a crash after
	// some text leaves the message and that text, with no end stamp: a turn the host lost.
	it.each([
		['a desktop host that streamed some text before it died', 'desktop' as const, 1],
		['a headless host too old to stamp (its text is its answer)', 'headless' as const, 0],
	])('reads the end stamp, not the text, on %s (R36)', async (_how, hostKind, sent) => {
		cut();
		act$.mockResolvedValue({ ok: true, result: { kind: 'send', receipt: { status: 'ran' } } });
		transcript.mockResolvedValue([
			QUESTION,
			{ id: 'o1', timestamp: 15, source: 'stdout', text: 'The docs s' },
		]);
		useSshOutageStore.getState().applyReachability({ ...hostOutage, reachable: true, since: 60 });
		usePeerMirrorStore.setState((current) => ({
			peers: { ...current.peers, box: { ...peerWith('idle', 'connected'), hostKind } },
		}));
		syncHostedAgents();
		await flush();
		syncHostedAgents();
		await flush();
		expect(sends()).toHaveLength(sent);
		if (sent) expect(sends()[0][2]).toMatchObject({ kind: 'send', entryId: 'u1' });
	});

	it('never sends again a cut turn the desktop host stamped ended after its streamed text (R36)', async () => {
		cut();
		transcript.mockResolvedValue([
			QUESTION,
			{ id: 'o1', timestamp: 15, source: 'stdout', text: 'The docs say...', turnEnded: true },
		]);
		useSshOutageStore.getState().applyReachability({ ...hostOutage, reachable: true, since: 60 });
		usePeerMirrorStore.setState((current) => ({
			peers: { ...current.peers, box: { ...peerWith('idle', 'connected'), hostKind: 'desktop' } },
		}));
		syncHostedAgents();
		await flush();
		syncHostedAgents();
		await flush();
		expect(sends()).toHaveLength(0);
		expect(queue()).toHaveLength(0);
	});

	// Parity R37: a local turn that ends on a rate limit or an overload is retried by that error's
	// rule. A hosted turn that ended on one while this machine was disconnected is the same.
	const OVERLOADED: LogEntry = {
		id: 'e1',
		timestamp: 20,
		source: 'error',
		text: 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
		turnEnded: true,
	};

	it("retries a cut turn that ended on its own retryable error by that error's rule, into its entry (R37)", async () => {
		cut();
		act$.mockResolvedValue({ ok: true, result: { kind: 'send', receipt: { status: 'ran' } } });
		await hostBack('idle', [QUESTION, OVERLOADED]);
		// Not "already had this message": the retry of the error holds it, counting down.
		expect(sends()).toHaveLength(0);
		expect(getRetryEntry('row', 't1')).toMatchObject({
			status: 'scheduled',
			lastMessage: OVERLOADED.text,
		});
		expect(queue().map((item) => item.hostEntryId)).toEqual(['u1']);
		expect(toastMock).not.toHaveBeenCalledWith(
			expect.objectContaining({ title: 'Not sent again' })
		);
		// The retry fires: sent once, into the same entry, never judged "already ran" again.
		retryNow('row', 't1');
		await flush();
		await flush();
		expect(sends()).toHaveLength(1);
		expect(sends()[0][2]).toMatchObject({ kind: 'send', text: QUESTION.text, entryId: 'u1' });
	});

	it('sends the kept message when only a LATER message of the tab was answered: its own turn died (R23)', async () => {
		cut();
		act$.mockResolvedValue({ ok: true, result: { kind: 'send', receipt: { status: 'ran' } } });
		// The answer a2 is u2's: u1's turn died with the host, so u1 never ran.
		await hostBack('idle', [QUESTION, LATER_MESSAGE, LATER_ANSWER]);
		expect(sends()).toHaveLength(1);
		expect(sends()[0][2]).toMatchObject({ kind: 'send', text: QUESTION.text, entryId: 'u1' });
	});

	it('holds the kept message, unsent, and says the message is gone when the host tab was cleared (R23)', async () => {
		cut();
		const outageId = getRetryEntry('row', 't1')!.outageId;
		await hostBack('idle', []);
		expect(sends()).toHaveLength(0);
		expect(getRetryEntry('row', 't1')).toBeUndefined();
		// Kept for the user to send again, as a new message: it no longer names the host's entry.
		expect(queue()).toEqual([
			expect.objectContaining({ text: QUESTION.text, paused: true, hostEntryId: undefined }),
		]);
		expect(useRetryStore.getState().outages[outageId]).toMatchObject({
			settledByHost: true,
			notOnHost: 'message',
		});
		expect(notOnHostText('message')).toContain('no longer on the host');
	});

	it.each([
		[
			'finished while the link was down',
			'idle' as const,
			[QUESTION, { id: 'a1', timestamp: 20, source: 'ai' as const, text: 'The docs say...' }],
		],
		['is still running on the host', 'busy' as const, [QUESTION]],
	])('never sends the kept message again when the turn %s', async (_how, state, entries) => {
		cut();
		const outageId = getRetryEntry('row', 't1')!.outageId;
		await hostBack(state, entries);
		expect(sends()).toHaveLength(0);
		expect(getRetryEntry('row', 't1')).toBeUndefined();
		expect(queue()).toHaveLength(0);
		expect(useRetryStore.getState().outages[outageId]).toMatchObject({
			status: 'recovered',
			settledByHost: true,
		});
		expect(tab().agentError).toBeUndefined();
	});

	it('a resend that fires before the host has answered waits for it, and is not sent when the host had it', async () => {
		cut();
		// The host is back, but its transcript read has not landed yet.
		let land: (entries: LogEntry[]) => void = () => undefined;
		transcript.mockReturnValue(new Promise<LogEntry[]>((resolve) => (land = resolve)));
		useSshOutageStore.getState().applyReachability({ ...hostOutage, reachable: true, since: 60 });
		hostReports('idle', 'connected');
		syncHostedAgents();
		retryNow('row', 't1');
		await flush();
		expect(sends()).toHaveLength(0);

		land([QUESTION, { id: 'a1', timestamp: 20, source: 'ai', text: 'The docs say...' }]);
		await flush();
		syncHostedAgents();
		await flush();
		expect(sends()).toHaveLength(0);
		expect(getRetryEntry('row', 't1')).toBeUndefined();
		expect(queue()).toHaveLength(0);
	});

	/** The host is back and its transcript read is still out; `land` answers it. */
	function hostBackReadPending() {
		let land: (entries: LogEntry[]) => void = () => undefined;
		transcript.mockReturnValue(new Promise<LogEntry[]>((resolve) => (land = resolve)));
		useSshOutageStore.getState().applyReachability({ ...hostOutage, reachable: true, since: 60 });
		hostReports('idle', 'connected');
		syncHostedAgents();
		return (entries: LogEntry[]) => land(entries);
	}

	it('sends nothing when Stop lands while a resend waits for the host, and parks the message held', async () => {
		cut();
		const land = hostBackReadPending();
		retryNow('row', 't1');
		await flush();
		stopRetriesForAgent('row', 't1');

		// The host says the turn died: the message would go, but the user stopped it.
		land([QUESTION]);
		await flush();
		syncHostedAgents();
		await flush();
		expect(sends()).toHaveLength(0);
		expect(queue().map((item) => [item.text, item.paused === true])).toEqual([
			[QUESTION.text, true],
		]);
		expect(getRetryEntry('row', 't1')).toBeUndefined();
	});

	it('leaves the retry of a message sent after a Stop alone when the host answers the stopped resend', async () => {
		cut();
		const land = hostBackReadPending();
		retryNow('row', 't1');
		await flush();
		stopRetriesForAgent('row', 't1');
		// A new message on the tab is kept under a retry of its own.
		keepTurnForHost(
			'row',
			{ id: 'b1', timestamp: 1, tabId: 't1', type: 'message', text: 'later' },
			'down'
		);
		const later = getRetryEntry('row', 't1')!;

		land([QUESTION, { id: 'a1', timestamp: 20, source: 'ai', text: 'The docs say...' }]);
		await flush();
		syncHostedAgents();
		await flush();
		expect(getRetryEntry('row', 't1')).toMatchObject({
			outageId: later.outageId,
			heldItemId: 'b1',
		});
		expect(queue().map((item) => item.id)).toContain('b1');
		expect(sends()).toHaveLength(0);
	});

	it('sends a message edited while it was kept as its own message, even when the host had the original', async () => {
		cut();
		const edited = 'Summarize the docs, briefly';
		useSessionStore.setState((state) => ({
			sessions: state.sessions.map((session) => ({
				...session,
				executionQueue: (session.executionQueue ?? []).map((item) => ({ ...item, text: edited })),
			})),
		}));
		act$.mockResolvedValue({ ok: true, result: { kind: 'send', receipt: { status: 'ran' } } });
		await hostBack('idle', [
			QUESTION,
			{ id: 'a1', timestamp: 20, source: 'ai', text: 'The docs say...' },
		]);
		expect(sends()).toHaveLength(1);
		expect(sends()[0][2]).toMatchObject({ kind: 'send', text: edited });
		expect(sends()[0][2]).not.toHaveProperty('entryId');
		expect(queue()).toHaveLength(0);
	});

	it('drops the kept copy that waits behind another retry when the host had it, and leaves that retry alone', async () => {
		// An earlier message of this tab already waits for its retry.
		keepTurnForHost(
			'row',
			{ id: 'b1', timestamp: 1, tabId: 't1', type: 'message', text: 'earlier' },
			'down'
		);
		const other = getRetryEntry('row', 't1')!;
		cut();
		expect(queue().map((item) => item.text)).toEqual(['earlier', QUESTION.text]);

		await hostBack('busy', [QUESTION]);
		expect(queue().map((item) => item.text)).toEqual(['earlier']);
		expect(getRetryEntry('row', 't1')).toMatchObject({
			outageId: other.outageId,
			heldItemId: 'b1',
		});
		expect(sends()).toHaveLength(0);
	});

	it('a resend after a failed read starts one read of its own, and sends once it says the turn died (R20)', async () => {
		cut();
		transcript.mockRejectedValueOnce(new Error('read failed'));
		await hostBack('idle', [QUESTION]);
		// The read after the reconnect failed: nothing is sent, the message stays kept.
		expect(sends()).toHaveLength(0);
		const reads = transcript.mock.calls.length;

		act$.mockResolvedValue({ ok: true, result: { kind: 'send', receipt: { status: 'started' } } });
		transcript.mockResolvedValue([QUESTION]);
		retryNow('row', 't1');
		await flush();
		syncHostedAgents();
		await flush();
		expect(transcript.mock.calls.length).toBe(reads + 1);
		expect(sends()).toHaveLength(1);
		expect(sends()[0][2]).toMatchObject({ kind: 'send', entryId: 'u1' });
	});

	it('a resend after a failed read reads once per try, never in a loop, while the host keeps failing (R20)', async () => {
		cut();
		transcript.mockRejectedValueOnce(new Error('read failed'));
		await hostBack('idle', [QUESTION]);
		transcript.mockRejectedValue(new Error('read failed'));
		const reads = transcript.mock.calls.length;
		retryNow('row', 't1');
		await flush();
		await flush();
		syncHostedAgents();
		await flush();
		expect(transcript.mock.calls.length).toBe(reads + 1);
		expect(sends()).toHaveLength(0);
		expect(queue()).toHaveLength(1);
		expect(getRetryEntry('row', 't1')?.status).toBe('scheduled');
	});

	it.each([
		[
			'never sends it when the host had answered it',
			[QUESTION, { id: 'a1', timestamp: 20, source: 'ai' as const, text: 'The docs say...' }],
			0,
		],
		['sends it, naming its entry, when the turn died with the host', [QUESTION], 1],
	])(
		'Force Send on the copy a Stop parked reads the host first: %s (R21)',
		async (_what, entries, sent) => {
			cut();
			// Stop on the cut turn, then on its retry card: the kept copy is parked held.
			await interruptTurn('row', { tabId: 't1' });
			stopRetriesForAgent('row', 't1');
			const parked = queue()[0];
			expect(parked).toMatchObject({ paused: true, hostEntryId: 'u1' });

			act$.mockResolvedValue({
				ok: true,
				result: { kind: 'send', receipt: { status: 'started' } },
			});
			await hostBack('idle', entries);
			expect(sends()).toHaveLength(0);

			// Force Send: the drain takes the copy out of the queue and hands it to the host.
			useSessionStore.setState((state) => ({
				sessions: state.sessions.map((session) => ({ ...session, executionQueue: [] })),
			}));
			await sendTakenItemToHost('row', parked);
			await flush();
			expect(sends()).toHaveLength(sent);
			if (sent) expect(sends()[0][2]).toMatchObject({ kind: 'send', entryId: 'u1' });
			else {
				expect(toastMock).toHaveBeenCalledWith(
					expect.objectContaining({ title: 'Not sent again' })
				);
			}
		}
	);

	it.each([
		[
			'the agent is deleted',
			() => useSessionStore.setState({ sessions: [], activeSessionId: '' }),
			// Nothing is left to keep: no timer at all, the 10 s wait for the fate included.
			() => expect(vi.getTimerCount()).toBe(0),
		],
		[
			'its peer is removed',
			() =>
				usePeerMirrorStore.setState((state) => ({ peers: {}, order: [], enabled: state.enabled })),
			// The resend stops waiting at once and its message stays kept under the card.
			() => expect(getRetryEntry('row', 't1')).toMatchObject({ status: 'scheduled' }),
		],
	])(
		'forgets its cut turns and ends a waiting resend when %s (R22)',
		async (_when, remove, check) => {
			vi.useFakeTimers();
			try {
				cut();
				// The host is back but its read is still out, so a resend waits on the cut's fate.
				hostBackReadPending();
				retryNow('row', 't1');
				await vi.advanceTimersByTimeAsync(0);
				expect(cutHostedTurnTabs('row')).toEqual(['t1']);
				expect(getRetryEntry('row', 't1')?.status).toBe('in-flight');

				remove();
				syncHostedAgents();
				await vi.advanceTimersByTimeAsync(0);
				expect(cutHostedTurnTabs('row')).toEqual([]);
				expect(hostedCutsKept('row')).toBeUndefined();
				expect(sends()).toHaveLength(0);
				check();
			} finally {
				vi.useRealTimers();
			}
		}
	);

	it('a resend while the host is still down stays kept under the same card', async () => {
		cut();
		const outageId = getRetryEntry('row', 't1')!.outageId;
		retryNow('row', 't1');
		await flush();
		expect(sends()).toHaveLength(0);
		expect(getRetryEntry('row', 't1')).toMatchObject({ outageId, status: 'scheduled', attempt: 1 });
		expect(queue()).toHaveLength(1);
	});
});

describe('a kept cut message after the app restarted asks the host how its turn ended (R19)', () => {
	const ANSWER: LogEntry = { id: 'a1', timestamp: 20, source: 'ai', text: 'The docs say...' };
	const queue = () => record().executionQueue ?? [];
	const sends = () => act$.mock.calls.filter(([, , action]) => action.kind === 'send');

	beforeEach(() => {
		resetStores(usePeerMirrorStore, useSessionStore);
		useSshOutageStore.setState({ outages: {} });
		useRetryStore.setState({ retries: {}, outages: {} });
		useSettingsStore.setState({ federationHostedAgents: true });
		// A relaunch: nothing about the cut survives in memory, only the saved queue does.
		__resetHostedLinkLossForTests();
		toastMock.mockReset();
		transcript.mockReset();
		act$.mockReset();
		act$.mockResolvedValue({ ok: true, result: { kind: 'send', receipt: { status: 'started' } } });
		maestro.federation = { transcript, act: act$ };
		registerDispatchDepsProvider(() => ({}) as never);
	});

	afterEach(() => {
		delete maestro.federation;
		registerDispatchDepsProvider(null);
	});

	/** The relaunched state: the host connected with its tab `state`, the kept copy in the queue. */
	function relaunch(state: 'idle' | 'busy', entries: LogEntry[], text = QUESTION.text) {
		usePeerMirrorStore.getState().hydrate([peerWith(state, 'connected')]);
		const session = createModeSession('hosted', {
			id: 'row',
			name: 'Docs',
			activeTabId: 't1',
			aiTabs: [createMockAITab({ id: 't1', logs: entries })],
			executionQueue: [
				{ id: 'k1', timestamp: 1, tabId: 't1', type: 'message', text, hostEntryId: 'u1' },
			],
		});
		useSessionStore.setState({ sessions: [session], activeSessionId: session.id });
		transcript.mockResolvedValue(entries);
	}

	it.each([
		['finished while this app was closed', 'idle' as const, [QUESTION, ANSWER]],
		['is still running on the host', 'busy' as const, [QUESTION]],
	])('never sends the kept message again when its turn %s', async (_how, state, entries) => {
		relaunch(state, entries);
		expect(handQueuedItemToHost('row', 'k1')).toBe(true);
		await flush();
		await flush();
		expect(transcript).toHaveBeenCalledWith('box', 'h1', 't1', expect.anything());
		expect(sends()).toHaveLength(0);
		expect(queue()).toHaveLength(0);
		expect(toastMock).toHaveBeenCalledWith(
			expect.objectContaining({
				message: 'The host already had this message, so it was not sent again.',
			})
		);
	});

	it('sends the kept message, naming its entry, when the turn died with the host', async () => {
		relaunch('idle', [QUESTION]);
		handQueuedItemToHost('row', 'k1');
		await flush();
		await flush();
		expect(sends()).toHaveLength(1);
		expect(sends()[0][2]).toMatchObject({ kind: 'send', text: QUESTION.text, entryId: 'u1' });
	});

	it('keeps the message, unsent, when the host tab cannot be read', async () => {
		relaunch('idle', [QUESTION]);
		transcript.mockRejectedValue(new Error('read failed'));
		handQueuedItemToHost('row', 'k1');
		await flush();
		await flush();
		expect(sends()).toHaveLength(0);
		expect(queue().map((item) => item.hostEntryId)).toEqual(['u1']);
	});

	it('sends the kept message when only a LATER message of the tab was answered (R23)', async () => {
		// Stopped while cut, parked, then u2 went straight to the host and was answered a2.
		relaunch('idle', [QUESTION, LATER_MESSAGE, LATER_ANSWER]);
		handQueuedItemToHost('row', 'k1');
		await flush();
		await flush();
		expect(sends()).toHaveLength(1);
		expect(sends()[0][2]).toMatchObject({ kind: 'send', text: QUESTION.text, entryId: 'u1' });
	});

	it.each([
		['its tab was closed on the host', 'tab' as const],
		['the host tab was cleared', 'message' as const],
	])('holds the kept message, unsent, saying so, when %s (R23)', async (_how, notOnHost) => {
		relaunch('idle', notOnHost === 'tab' ? [QUESTION] : []);
		if (notOnHost === 'tab') {
			const peer = peerWith('idle', 'connected');
			usePeerMirrorStore
				.getState()
				.hydrate([{ ...peer, agents: peer.agents.map((agent) => ({ ...agent, aiTabs: [] })) }]);
		}
		handQueuedItemToHost('row', 'k1');
		await flush();
		await flush();
		expect(sends()).toHaveLength(0);
		expect(queue()).toEqual([
			expect.objectContaining({
				id: 'k1',
				text: QUESTION.text,
				paused: true,
				hostEntryId: undefined,
			}),
		]);
		expect(toastMock).toHaveBeenCalledWith(
			expect.objectContaining({ title: 'Not sent', message: notOnHostText(notOnHost) })
		);
		expect(toastMock).not.toHaveBeenCalledWith(
			expect.objectContaining({
				message: 'The host already had this message, so it was not sent again.',
			})
		);
	});

	// Parity R35: the host crashed mid-turn and the user reloaded the window. The mirror in main
	// still holds the report from before the crash and says connected before the restarted host's
	// snapshot lands.
	it('decides from the restarted host after a reload, never its busy report from before the crash (R35)', async () => {
		relaunch('busy', [QUESTION]);
		usePeerMirrorStore.getState().hydrate([reconnectedBeforeReport(peerWith('busy', 'connected'))]);
		handQueuedItemToHost('row', 'k1');
		await flush();
		await flush();
		expect(sends()).toHaveLength(0);
		expect(toastMock).not.toHaveBeenCalledWith(
			expect.objectContaining({
				message: 'The host already had this message, so it was not sent again.',
			})
		);
		// The restarted host's snapshot: the tab is idle, and its turn died with the host.
		usePeerMirrorStore.getState().applyPush({
			peerId: 'box',
			event: { type: 'peer.agents', agents: peerWith('idle', 'connected').agents, groups: [] },
		});
		await flush();
		await flush();
		expect(sends()).toHaveLength(1);
		expect(sends()[0][2]).toMatchObject({ kind: 'send', text: QUESTION.text, entryId: 'u1' });
	});

	it('never says the tab is gone from an agent list not in yet after a reload (R35)', async () => {
		relaunch('idle', [QUESTION]);
		const before = peerWith('idle', 'connected');
		usePeerMirrorStore.getState().hydrate([reconnectedBeforeReport({ ...before, agents: [] })]);
		handQueuedItemToHost('row', 'k1');
		await flush();
		await flush();
		expect(sends()).toHaveLength(0);
		expect(toastMock).not.toHaveBeenCalledWith(expect.objectContaining({ title: 'Not sent' }));
		usePeerMirrorStore.getState().applyPush({
			peerId: 'box',
			event: { type: 'peer.agents', agents: before.agents, groups: [] },
		});
		await flush();
		await flush();
		expect(sends()).toHaveLength(1);
		expect(sends()[0][2]).toMatchObject({ kind: 'send', text: QUESTION.text, entryId: 'u1' });
		expect(toastMock).not.toHaveBeenCalledWith(expect.objectContaining({ title: 'Not sent' }));
	});

	it('retries a kept message whose turn ended on its own retryable error after a restart (R37)', async () => {
		relaunch('idle', [
			QUESTION,
			{
				id: 'e1',
				timestamp: 20,
				source: 'error',
				text: 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
				turnEnded: true,
			},
		]);
		handQueuedItemToHost('row', 'k1');
		await flush();
		await flush();
		expect(sends()).toHaveLength(0);
		expect(getRetryEntry('row', 't1')).toMatchObject({ status: 'scheduled' });
		expect(queue().map((item) => item.id)).toEqual(['k1']);
		retryNow('row', 't1');
		await flush();
		await flush();
		expect(sends()).toHaveLength(1);
		expect(sends()[0][2]).toMatchObject({ kind: 'send', text: QUESTION.text, entryId: 'u1' });
	});

	it('takes the host saying the message already ran as "already ran"', async () => {
		// The host's own check (`userEntryAnswered()`) answers before this machine's read could.
		relaunch('idle', [QUESTION]);
		act$.mockResolvedValue({ ok: true, result: { kind: 'send', receipt: { status: 'answered' } } });
		handQueuedItemToHost('row', 'k1');
		await flush();
		await flush();
		expect(sends()).toHaveLength(1);
		expect(queue()).toHaveLength(0);
		expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ title: 'Not sent again' }));
	});
});
