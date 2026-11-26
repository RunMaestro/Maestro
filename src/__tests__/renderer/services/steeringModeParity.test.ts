/**
 * P5: the Thought Stream's Steer works the same in every mode. A local and an SSH run take the
 * note from this window's store; a hosted run's host takes it (`steer-auto-run`), and the host's
 * own list then replaces what this window shows, so the panel reads the same.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	answerSteeringCommand,
	cancelSteeringNote,
	refreshHostedSteering,
	steeringBlocker,
	submitSteeringNote,
} from '../../../renderer/services/autoRunSteering';
import { useAutoRunSteeringStore } from '../../../renderer/stores/autoRunSteeringStore';
import { useBatchStore } from '../../../renderer/stores/batchStore';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';
import type { BatchRunState } from '../../../renderer/types';
import { AGENT_MODES, createModeSession, type AgentMode } from '../../helpers/mockSession';
import { MAX_PENDING_STEERING_NOTES } from '../../../shared/autorunSteering';

const SID = 'agent-1';

/** What the host holds, answered to each `steer-auto-run` the way a host answers it. */
let hostPending: Array<{ id: string; text: string; timestamp: number }>;
let hostRefuses: string | null;
let listFails: boolean;
const act = vi.fn(async (_peer: string, _agent: string, action: any) => {
	const input = action.input;
	if (input.action === 'list' && listFails) return { ok: false, error: 'The host is down' };
	if (input.action === 'send') {
		if (hostRefuses) {
			return {
				ok: true,
				result: { kind: 'steer-auto-run', result: { success: false, error: hostRefuses } },
			};
		}
		const note = { id: `host-${hostPending.length + 1}`, text: input.text, timestamp: 7 };
		hostPending.push(note);
		return { ok: true, result: { kind: 'steer-auto-run', result: { success: true, note } } };
	}
	if (input.action === 'cancel') {
		hostPending = hostPending.filter((note) => note.id !== input.noteId);
		return { ok: true, result: { kind: 'steer-auto-run', result: { success: true } } };
	}
	return {
		ok: true,
		result: {
			kind: 'steer-auto-run',
			result: { success: true, steerable: true, pending: hostPending, deliveries: [] },
		},
	};
});

const hostAnswer = act.getMockImplementation()!;

/** The run as each mode's window holds it: a hosted run is the host's, drawn as a mirror. */
function runFor(mode: AgentMode): BatchRunState {
	return { isRunning: true, ...(mode === 'hosted' ? { mirrored: true } : {}) } as BatchRunState;
}

function setUp(mode: AgentMode) {
	useSessionStore.setState({ sessions: [createModeSession(mode, { id: SID })] });
	useBatchStore.setState({ batchRunStates: { [SID]: runFor(mode) } } as never);
	useAutoRunSteeringStore.setState({ notes: {}, delivered: {}, returnedDrafts: {} });
}

/** Wait until every host conversation the service started has answered. */
const settled = () => refreshHostedSteering(SID);

beforeEach(() => {
	hostPending = [];
	hostRefuses = null;
	listFails = false;
	act.mockClear();
	act.mockImplementation(hostAnswer);
	(window as any).maestro = { ...((window as any).maestro || {}), federation: { act } };
	useSettingsStore.setState({ federationHostedAgents: true });
});

afterEach(() => {
	useSessionStore.setState({ sessions: [] });
	useBatchStore.setState({ batchRunStates: {} } as never);
});

describe('Auto Run Steer across modes (P5)', () => {
	async function steerIn(mode: AgentMode) {
		setUp(mode);
		const steerable = steeringBlocker(useBatchStore.getState().batchRunStates[SID], SID) === null;
		const note = submitSteeringNote({
			sessionId: SID,
			text: 'Prefer the fixtures',
			announce: false,
		});
		await settled();
		return {
			steerable,
			accepted: note !== null,
			pending: (useAutoRunSteeringStore.getState().notes[SID] ?? []).map((n) => n.text),
		};
	}

	it('offers Steer and shows the same waiting note in all three modes', async () => {
		const results = [];
		for (const mode of AGENT_MODES) results.push(await steerIn(mode));
		const [local, ssh, hosted] = results;
		expect(local).toEqual({ steerable: true, accepted: true, pending: ['Prefer the fixtures'] });
		expect(ssh).toEqual(local);
		expect(hosted).toEqual(local);
	});

	it("sends a hosted note to the host's run and shows the host's own copy", async () => {
		setUp('hosted');
		submitSteeringNote({ sessionId: SID, text: 'Prefer the fixtures', announce: false });
		await settled();
		expect(act).toHaveBeenCalledWith('box', 'h1', {
			kind: 'steer-auto-run',
			input: { action: 'send', text: 'Prefer the fixtures' },
		});
		expect(useAutoRunSteeringStore.getState().notes[SID]).toEqual([
			{ id: 'host-1', text: 'Prefer the fixtures', timestamp: 7 },
		]);

		cancelSteeringNote(SID, 'host-1');
		await settled();
		expect(act).toHaveBeenCalledWith('box', 'h1', {
			kind: 'steer-auto-run',
			input: { action: 'cancel', noteId: 'host-1' },
		});
		expect(useAutoRunSteeringStore.getState().notes[SID]).toEqual([]);
	});

	it('drops a note the host refused instead of showing it as waiting', async () => {
		setUp('hosted');
		hostRefuses = 'No Auto Run is active on this agent';
		submitSteeringNote({ sessionId: SID, text: 'Too late', announce: false });
		await settled();
		expect(useAutoRunSteeringStore.getState().notes[SID]).toEqual([]);
	});

	it("cancels a note sent moments ago by the host's id, not this window's", async () => {
		setUp('hosted');
		const note = submitSteeringNote({ sessionId: SID, text: 'Never mind', announce: false });
		// Cancelled before the host answered the send: the window still shows its own id.
		cancelSteeringNote(SID, note!.id);
		await settled();
		expect(act).toHaveBeenCalledWith('box', 'h1', {
			kind: 'steer-auto-run',
			input: { action: 'cancel', noteId: 'host-1' },
		});
		expect(hostPending).toEqual([]);
		expect(useAutoRunSteeringStore.getState().notes[SID]).toEqual([]);
	});

	it('drops a refused note even when the host list cannot be read', async () => {
		setUp('hosted');
		hostRefuses = 'No Auto Run is active on this agent';
		listFails = true;
		submitSteeringNote({ sessionId: SID, text: 'Too late', announce: false });
		await settled();
		expect(useAutoRunSteeringStore.getState().notes[SID] ?? []).toEqual([]);
	});

	it("answers a CLI steering verb on a hosted agent with the host's own result", async () => {
		setUp('hosted');
		expect(
			await answerSteeringCommand({ action: 'send', sessionId: SID, text: 'From the CLI' })
		).toEqual({ success: true, note: { id: 'host-1', text: 'From the CLI', timestamp: 7 } });
		hostRefuses = 'The host refused';
		expect(await answerSteeringCommand({ action: 'send', sessionId: SID, text: 'again' })).toEqual({
			success: false,
			error: 'The host refused',
		});
		expect(await answerSteeringCommand({ action: 'list', sessionId: SID })).toMatchObject({
			success: true,
			pending: [{ id: 'host-1', text: 'From the CLI' }],
		});
		// A local agent's verbs are answered here, as before.
		setUp('local');
		expect(await answerSteeringCommand({ action: 'list', sessionId: SID })).toMatchObject({
			success: true,
			steerable: true,
			pending: [],
		});
	});

	it('keeps showing a note the host has not answered while an earlier list lands', async () => {
		setUp('hosted');
		let releaseList!: () => void;
		const held = new Promise<void>((resolve) => {
			releaseList = resolve;
		});
		const answer = act.getMockImplementation()!;
		act.mockImplementationOnce(async (peer: string, agent: string, action: any) => {
			await held;
			return answer(peer, agent, action);
		});
		// A list is in flight when the note is sent; it answers with the host's state before the send.
		const reading = refreshHostedSteering(SID);
		submitSteeringNote({ sessionId: SID, text: 'Sent mid-read', announce: false });
		releaseList();
		await reading;
		expect(useAutoRunSteeringStore.getState().notes[SID]?.map((note) => note.text)).toEqual([
			'Sent mid-read',
		]);
		await settled();
		expect(useAutoRunSteeringStore.getState().notes[SID]).toEqual([
			{ id: 'host-1', text: 'Sent mid-read', timestamp: 7 },
		]);
	});

	it('holds one waiting list read per agent, however many frames ask for one', async () => {
		setUp('hosted');
		const reads = [1, 2, 3, 4, 5].map(() => refreshHostedSteering(SID));
		await Promise.all(reads);
		expect(act).toHaveBeenCalledTimes(1);
	});

	it('still refuses a run another client owns, and sends nothing for a local or SSH run', async () => {
		setUp('ssh');
		useBatchStore.setState({ batchRunStates: { [SID]: runFor('hosted') } } as never);
		expect(steeringBlocker(useBatchStore.getState().batchRunStates[SID], SID)).toMatch(
			/owned by another Maestro client/
		);
		setUp('local');
		submitSteeringNote({ sessionId: SID, text: 'local note', announce: false });
		await settled();
		expect(act).not.toHaveBeenCalled();
	});
});

describe('a note the run never got keeps its text (P9)', () => {
	const returned = () => useAutoRunSteeringStore.getState().returnedDrafts[SID];
	const pending = () => (useAutoRunSteeringStore.getState().notes[SID] ?? []).map((n) => n.text);

	it('keeps the text of a refused note in all three modes', async () => {
		const results = [];
		for (const mode of AGENT_MODES) {
			setUp(mode);
			useAutoRunSteeringStore.setState({ returnedDrafts: {} });
			// Local and SSH refuse at the pending cap (the panel keeps its draft); the host refuses.
			if (mode === 'hosted') hostRefuses = 'No Auto Run is active on this agent';
			else {
				for (let i = 0; i < MAX_PENDING_STEERING_NOTES; i++) {
					useAutoRunSteeringStore.getState().addNote(SID, `earlier ${i}`);
				}
			}
			const before = pending().filter((text) => text === 'Prefer the fixtures');
			const note = submitSteeringNote({
				sessionId: SID,
				text: 'Prefer the fixtures',
				announce: false,
			});
			await settled();
			results.push({
				waiting: pending().filter((text) => text === 'Prefer the fixtures'),
				kept: note === null || returned() === 'Prefer the fixtures',
				before,
			});
			hostRefuses = null;
		}
		const [local, ssh, hosted] = results;
		expect(local).toEqual({ waiting: [], kept: true, before: [] });
		expect(ssh).toEqual(local);
		expect(hosted).toEqual(local);
	});

	it('treats a host out of reach as a refusal: the note is not shown as waiting', async () => {
		setUp('hosted');
		act.mockImplementation(async () => ({
			ok: false,
			error: 'The host is not connected',
			code: 'host-unavailable',
		}));
		submitSteeringNote({ sessionId: SID, text: 'Use the v3 endpoint', announce: false });
		await settled();
		expect(pending()).toEqual([]);
		expect(returned()).toBe('Use the v3 endpoint');
		expect(
			await answerSteeringCommand({ action: 'send', sessionId: SID, text: 'From the CLI' })
		).toEqual({ success: false, error: 'The host is not connected' });
	});

	it('keeps no copy when the host list shows a send of unknown outcome landed', async () => {
		setUp('hosted');
		const answer = act.getMockImplementation()!;
		act.mockImplementationOnce(async (peer: string, agent: string, action: any) => {
			await answer(peer, agent, action);
			return { ok: false, error: 'The connection dropped.', unknown: true };
		});
		submitSteeringNote({ sessionId: SID, text: 'Maybe sent', announce: false });
		await settled();
		expect(pending()).toEqual(['Maybe sent']);
		expect(returned()).toBeUndefined();
	});

	it('stops reading the list from a host that does not know the op', async () => {
		setUp('hosted');
		act.mockImplementation(async () => ({
			ok: false,
			error: 'The host is too old.',
			code: 'unsupported',
		}));
		submitSteeringNote({ sessionId: SID, text: 'Old host', announce: false });
		await settled();
		expect(returned()).toBe('Old host');
		const calls = act.mock.calls.length;
		for (let i = 0; i < 5; i++) await refreshHostedSteering(SID);
		expect(act.mock.calls.length).toBe(calls);
	});
});
