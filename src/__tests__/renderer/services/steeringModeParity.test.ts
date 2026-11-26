/**
 * P5: the Thought Stream's Steer works the same in every mode. A local and an SSH run take the
 * note from this window's store; a hosted run's host takes it (`steer-auto-run`), and the host's
 * own list then replaces what this window shows, so the panel reads the same.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
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

const SID = 'agent-1';

/** What the host holds, answered to each `steer-auto-run` the way a host answers it. */
let hostPending: Array<{ id: string; text: string; timestamp: number }>;
let hostRefuses: string | null;
const act = vi.fn(async (_peer: string, _agent: string, action: any) => {
	const input = action.input;
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

/** The run as each mode's window holds it: a hosted run is the host's, drawn as a mirror. */
function runFor(mode: AgentMode): BatchRunState {
	return { isRunning: true, ...(mode === 'hosted' ? { mirrored: true } : {}) } as BatchRunState;
}

function setUp(mode: AgentMode) {
	useSessionStore.setState({ sessions: [createModeSession(mode, { id: SID })] });
	useBatchStore.setState({ batchRunStates: { [SID]: runFor(mode) } } as never);
	useAutoRunSteeringStore.setState({ notes: {}, delivered: {} });
}

/** Wait until every host conversation the service started has answered. */
const settled = () => refreshHostedSteering(SID);

beforeEach(() => {
	hostPending = [];
	hostRefuses = null;
	act.mockClear();
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
