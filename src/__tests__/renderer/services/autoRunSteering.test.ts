/**
 * Tests for the operator-facing half of Auto Run steering notes.
 *
 * The store (`autoRunSteeringStore`) owns the two lists and is tested on its
 * own. What lives here is the service the Thought Stream panel calls: parking a
 * note, cancelling one that has not been taken yet, and handing the pending ones
 * to the task about to dispatch.
 *
 * The behaviour this file exists to pin is that NONE of it touches an AI tab.
 * Steering used to write a transcript entry into the agent's chat and flip a
 * badge on it, which is the coupling the feature was pulled out of: an Auto Run
 * note is a property of the run, and the run's surface is the Thought Stream.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
	submitSteeringNote,
	cancelSteeringNote,
	takeSteeringNotesForDispatch,
	recordSteeringResponse,
	clearSteeringNotes,
	clearPendingSteeringNotes,
	runRemoteSteeringCommand,
	steeringBlocker,
} from '../../../renderer/services/autoRunSteering';
import { useBatchStore } from '../../../renderer/stores/batchStore';
import { useAutoRunSteeringStore } from '../../../renderer/stores/autoRunSteeringStore';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { notifyCenterFlash } from '../../../renderer/stores/centerFlashStore';
import { MAX_PENDING_STEERING_NOTES } from '../../../shared/autorunSteering';
import { createMockSession } from '../../helpers/mockSession';
import type { AITab, BatchRunState, LogEntry, Session } from '../../../renderer/types';

vi.mock('../../../renderer/stores/centerFlashStore', () => ({
	notifyCenterFlash: vi.fn(),
}));

const SESSION_ID = 'agent-1';

/** Minimal AI tab: enough to prove the service leaves the transcript alone. */
const tab = (id: string): AITab => ({ id, name: id, logs: [] }) as unknown as AITab;

function seed(tabs: AITab[] = [tab('tab-1')]): void {
	const session = createMockSession({
		id: SESSION_ID,
		aiTabs: tabs,
		activeTabId: tabs[0]?.id,
	} as Partial<Session>);
	useSessionStore.setState({ sessions: [session], activeSessionId: SESSION_ID } as never);
}

/** Every transcript entry in one tab, as it stands in the store right now. */
function logsIn(tabId: string): LogEntry[] {
	const session = useSessionStore.getState().sessions.find((s) => s.id === SESSION_ID);
	return session?.aiTabs.find((t) => t.id === tabId)?.logs ?? [];
}

function pendingCount(): number {
	return (useAutoRunSteeringStore.getState().notes[SESSION_ID] ?? []).length;
}

function deliveredCount(): number {
	return (useAutoRunSteeringStore.getState().delivered[SESSION_ID] ?? []).length;
}

beforeEach(() => {
	vi.clearAllMocks();
	useAutoRunSteeringStore.setState({ notes: {}, delivered: {} });
	useSessionStore.setState({ sessions: [], activeSessionId: null } as never);
	useBatchStore.setState({ batchRunStates: {} } as never);
	seed();
});

/** Put an Auto Run in flight on the agent, as the run loop would. */
function startRun(overrides: Partial<BatchRunState> = {}): void {
	useBatchStore.setState({
		batchRunStates: { [SESSION_ID]: { isRunning: true, ...overrides } },
	} as never);
}

describe('submitSteeringNote', () => {
	it('parks the note and acknowledges it', () => {
		const accepted = submitSteeringNote({
			sessionId: SESSION_ID,
			text: 'Use the v3 endpoint',
		});

		expect(accepted).toMatchObject({ text: 'Use the v3 endpoint' });
		expect(useAutoRunSteeringStore.getState().notes[SESSION_ID]).toHaveLength(1);
		expect(notifyCenterFlash).toHaveBeenCalledWith(
			expect.objectContaining({ message: 'Steering note queued' })
		);
	});

	it('writes nothing into the AI chat transcript', () => {
		submitSteeringNote({ sessionId: SESSION_ID, text: 'Use the v3 endpoint' });

		expect(logsIn('tab-1')).toHaveLength(0);
	});

	it('stores the normalized text so a padded note is not delivered with its whitespace', () => {
		submitSteeringNote({ sessionId: SESSION_ID, text: '  trim me  \n' });

		expect(useAutoRunSteeringStore.getState().notes[SESSION_ID][0].text).toBe('trim me');
	});

	it('rejects an empty note silently - the composer already guards that', () => {
		expect(submitSteeringNote({ sessionId: SESSION_ID, text: '   ' })).toBeNull();

		expect(pendingCount()).toBe(0);
		expect(notifyCenterFlash).not.toHaveBeenCalled();
	});

	it('rejects past the pending cap and says so, since nothing else would show it', () => {
		for (let i = 0; i < MAX_PENDING_STEERING_NOTES; i++) {
			expect(submitSteeringNote({ sessionId: SESSION_ID, text: `note ${i}` })).not.toBeNull();
		}
		vi.mocked(notifyCenterFlash).mockClear();

		expect(submitSteeringNote({ sessionId: SESSION_ID, text: 'one too many' })).toBeNull();
		expect(pendingCount()).toBe(MAX_PENDING_STEERING_NOTES);
		expect(notifyCenterFlash).toHaveBeenCalledWith(
			expect.objectContaining({ message: 'Too many steering notes' })
		);
	});
});

describe('takeSteeringNotesForDispatch', () => {
	it('returns nothing when none are pending', () => {
		expect(takeSteeringNotesForDispatch(SESSION_ID)).toEqual([]);
	});

	it('hands the notes over in order and moves them to the delivered list', () => {
		submitSteeringNote({ sessionId: SESSION_ID, text: 'first' });
		submitSteeringNote({ sessionId: SESSION_ID, text: 'second' });

		const taken = takeSteeringNotesForDispatch(SESSION_ID);

		expect(taken.map((n) => n.text)).toEqual(['first', 'second']);
		expect(pendingCount()).toBe(0);
		expect(deliveredCount()).toBe(2);
	});

	it('hands over only what the prompt block needs - id, text, time', () => {
		submitSteeringNote({ sessionId: SESSION_ID, text: 'note' });

		const [note] = takeSteeringNotesForDispatch(SESSION_ID);

		expect(Object.keys(note).sort()).toEqual(['id', 'text', 'timestamp']);
	});

	it('consumes exactly once so the next task does not get a repeat', () => {
		submitSteeringNote({ sessionId: SESSION_ID, text: 'only once' });

		expect(takeSteeringNotesForDispatch(SESSION_ID)).toHaveLength(1);
		expect(takeSteeringNotesForDispatch(SESSION_ID)).toEqual([]);
	});

	it('leaves a note sent after the take for the NEXT task', () => {
		submitSteeringNote({ sessionId: SESSION_ID, text: 'for this task' });
		takeSteeringNotesForDispatch(SESSION_ID);

		submitSteeringNote({ sessionId: SESSION_ID, text: 'for the next one' });

		expect(takeSteeringNotesForDispatch(SESSION_ID).map((n) => n.text)).toEqual([
			'for the next one',
		]);
	});
});

describe('cancelSteeringNote', () => {
	it('removes the pending note', () => {
		submitSteeringNote({ sessionId: SESSION_ID, text: 'never mind' });
		const noteId = useAutoRunSteeringStore.getState().notes[SESSION_ID][0].id;

		cancelSteeringNote(SESSION_ID, noteId);

		expect(pendingCount()).toBe(0);
	});

	it('leaves the other pending notes alone', () => {
		submitSteeringNote({ sessionId: SESSION_ID, text: 'keep' });
		submitSteeringNote({ sessionId: SESSION_ID, text: 'cancel' });
		const cancelId = useAutoRunSteeringStore.getState().notes[SESSION_ID][1].id;

		cancelSteeringNote(SESSION_ID, cancelId);

		expect(useAutoRunSteeringStore.getState().notes[SESSION_ID].map((n) => n.text)).toEqual([
			'keep',
		]);
	});

	it('is a no-op once the note has been delivered', () => {
		submitSteeringNote({ sessionId: SESSION_ID, text: 'too late' });
		const noteId = useAutoRunSteeringStore.getState().notes[SESSION_ID][0].id;
		takeSteeringNotesForDispatch(SESSION_ID);

		cancelSteeringNote(SESSION_ID, noteId);

		expect(deliveredCount()).toBe(1);
	});
});

describe('clearSteeringNotes', () => {
	it('drops both lists so nothing from a finished run reaches the next one', () => {
		submitSteeringNote({ sessionId: SESSION_ID, text: 'delivered' });
		takeSteeringNotesForDispatch(SESSION_ID);
		submitSteeringNote({ sessionId: SESSION_ID, text: 'stale' });

		clearSteeringNotes(SESSION_ID);

		expect(pendingCount()).toBe(0);
		expect(deliveredCount()).toBe(0);
	});
});

describe('recordSteeringResponse', () => {
	const delivered = () => useAutoRunSteeringStore.getState().delivered[SESSION_ID] ?? [];

	it('brings the task reply back to the notes that task was dispatched with', () => {
		submitSteeringNote({ sessionId: SESSION_ID, text: 'use the v3 endpoint' });
		const taken = takeSteeringNotesForDispatch(SESSION_ID);

		recordSteeringResponse(SESSION_ID, taken, {
			summary: '[steered] Switched to v3.',
			text: '[steered] Switched to v3.\n\nSet aside the v2 instruction in the doc.',
			success: true,
		});

		expect(delivered()[0].response).toMatchObject({
			summary: '[steered] Switched to v3.',
			success: true,
		});
	});

	it('is a no-op for a task that took no notes, which is nearly all of them', () => {
		submitSteeringNote({ sessionId: SESSION_ID, text: 'earlier' });
		takeSteeringNotesForDispatch(SESSION_ID);
		const before = useAutoRunSteeringStore.getState().delivered;

		recordSteeringResponse(SESSION_ID, [], { summary: 's', text: 't', success: true });

		expect(useAutoRunSteeringStore.getState().delivered).toBe(before);
		expect(delivered()[0].response).toBeUndefined();
	});

	it('writes nothing into the AI chat transcript', () => {
		submitSteeringNote({ sessionId: SESSION_ID, text: 'note' });
		const taken = takeSteeringNotesForDispatch(SESSION_ID);

		recordSteeringResponse(SESSION_ID, taken, { summary: 's', text: 't', success: true });

		expect(logsIn('tab-1')).toHaveLength(0);
	});
});

describe('clearPendingSteeringNotes', () => {
	it('drops what no task took and keeps the delivered record for the finished run', () => {
		submitSteeringNote({ sessionId: SESSION_ID, text: 'delivered' });
		takeSteeringNotesForDispatch(SESSION_ID);
		submitSteeringNote({ sessionId: SESSION_ID, text: 'still pending' });

		clearPendingSteeringNotes(SESSION_ID);

		expect(pendingCount()).toBe(0);
		expect(deliveredCount()).toBe(1);
	});
});

describe('submitSteeringNote announce', () => {
	// `--background` lands here. It is the NOTICE that is suppressed, never the
	// note: the note is parked for the next task either way.
	it('parks the note without a flash when asked not to announce', () => {
		const note = submitSteeringNote({ sessionId: SESSION_ID, text: 'quietly', announce: false });

		expect(note).not.toBeNull();
		expect(pendingCount()).toBe(1);
		expect(notifyCenterFlash).not.toHaveBeenCalled();
	});

	it('keeps a refusal quiet too, since the caller is told directly', () => {
		for (let i = 0; i < MAX_PENDING_STEERING_NOTES; i++) {
			submitSteeringNote({ sessionId: SESSION_ID, text: `note ${i}`, announce: false });
		}

		expect(
			submitSteeringNote({ sessionId: SESSION_ID, text: 'one too many', announce: false })
		).toBeNull();
		expect(notifyCenterFlash).not.toHaveBeenCalled();
	});
});

describe('steeringBlocker', () => {
	it('allows a run this client owns', () => {
		expect(steeringBlocker({ isRunning: true } as BatchRunState)).toBeNull();
	});

	it('refuses when nothing is running', () => {
		expect(steeringBlocker(undefined)).toMatch(/No Auto Run is active/);
		expect(steeringBlocker({ isRunning: false } as BatchRunState)).toMatch(/No Auto Run is active/);
	});

	// The notes are renderer state: a mirrored run's loop is in another client
	// and would never read one parked here.
	it('refuses a run owned by another client', () => {
		expect(steeringBlocker({ isRunning: true, mirrored: true } as BatchRunState)).toMatch(
			/another Maestro client/
		);
	});
});

/**
 * The CLI half of the panel's Steer bar. Everything below is what a caller that
 * cannot see the panel is owed: the same gate the button has, an answer for
 * every outcome, and enough back to verify what it did.
 */
describe('runRemoteSteeringCommand', () => {
	describe('send', () => {
		it('parks the note and hands back its id', () => {
			startRun();

			const result = runRemoteSteeringCommand({
				action: 'send',
				sessionId: SESSION_ID,
				text: 'use the v3 endpoint',
			});

			expect(result.success).toBe(true);
			const [parked] = useAutoRunSteeringStore.getState().notes[SESSION_ID];
			expect(result.note).toEqual({
				id: parked.id,
				text: 'use the v3 endpoint',
				timestamp: parked.timestamp,
			});
		});

		it('announces exactly as the click does, unless sent in the background', () => {
			startRun();

			runRemoteSteeringCommand({ action: 'send', sessionId: SESSION_ID, text: 'loud' });
			expect(notifyCenterFlash).toHaveBeenCalledTimes(1);

			runRemoteSteeringCommand({
				action: 'send',
				sessionId: SESSION_ID,
				text: 'quiet',
				background: true,
			});
			expect(notifyCenterFlash).toHaveBeenCalledTimes(1);
			expect(pendingCount()).toBe(2);
		});

		// A note parked with no run would sit there until the next run started
		// and then be wiped by it, never having reached a task.
		it('refuses when no run is in flight, and parks nothing', () => {
			const result = runRemoteSteeringCommand({
				action: 'send',
				sessionId: SESSION_ID,
				text: 'into the void',
			});

			expect(result).toEqual({ success: false, error: 'No Auto Run is active on this agent' });
			expect(pendingCount()).toBe(0);
		});

		it('refuses a run owned by another client', () => {
			startRun({ mirrored: true });

			const result = runRemoteSteeringCommand({
				action: 'send',
				sessionId: SESSION_ID,
				text: 'not mine to steer',
			});

			expect(result.success).toBe(false);
			expect(pendingCount()).toBe(0);
		});

		it('names the pending cap when that is what refused it', () => {
			startRun();
			for (let i = 0; i < MAX_PENDING_STEERING_NOTES; i++) {
				submitSteeringNote({ sessionId: SESSION_ID, text: `note ${i}`, announce: false });
			}

			const result = runRemoteSteeringCommand({
				action: 'send',
				sessionId: SESSION_ID,
				text: 'one too many',
			});

			expect(result.success).toBe(false);
			expect(result.error).toContain(String(MAX_PENDING_STEERING_NOTES));
		});

		it('refuses an empty note', () => {
			startRun();

			expect(
				runRemoteSteeringCommand({ action: 'send', sessionId: SESSION_ID, text: '   ' }).success
			).toBe(false);
		});

		it('writes nothing into the AI chat transcript', () => {
			startRun();
			runRemoteSteeringCommand({ action: 'send', sessionId: SESSION_ID, text: 'note' });

			expect(logsIn('tab-1')).toHaveLength(0);
		});
	});

	describe('list', () => {
		it('reports pending notes, and deliveries grouped with their one reply', () => {
			startRun();
			submitSteeringNote({ sessionId: SESSION_ID, text: 'first', announce: false });
			submitSteeringNote({ sessionId: SESSION_ID, text: 'second', announce: false });
			const taken = takeSteeringNotesForDispatch(SESSION_ID);
			recordSteeringResponse(SESSION_ID, taken, {
				summary: '[steered] did both',
				text: '[steered] did both\n\nDetails.',
				success: true,
			});
			submitSteeringNote({ sessionId: SESSION_ID, text: 'third', announce: false });

			const result = runRemoteSteeringCommand({ action: 'list', sessionId: SESSION_ID });

			expect(result.success).toBe(true);
			expect(result.steerable).toBe(true);
			expect(result.pending?.map((n) => n.text)).toEqual(['third']);
			expect(result.deliveries).toHaveLength(1);
			expect(result.deliveries?.[0].notes.map((n) => n.text)).toEqual(['first', 'second']);
			expect(result.deliveries?.[0].reply).toMatchObject({
				summary: '[steered] did both',
				success: true,
			});
		});

		it('leaves the reply off while the task that took the notes is still running', () => {
			startRun();
			submitSteeringNote({ sessionId: SESSION_ID, text: 'first', announce: false });
			takeSteeringNotesForDispatch(SESSION_ID);

			const result = runRemoteSteeringCommand({ action: 'list', sessionId: SESSION_ID });

			expect(result.deliveries?.[0]).not.toHaveProperty('reply');
		});

		// The reply to a run's last note lands as the run ends, so this is the
		// read a caller comes back for. Refusing it would hide the answer.
		it('still answers after the run has ended, and says it is no longer steerable', () => {
			startRun();
			submitSteeringNote({ sessionId: SESSION_ID, text: 'stop after this doc', announce: false });
			const taken = takeSteeringNotesForDispatch(SESSION_ID);
			recordSteeringResponse(SESSION_ID, taken, {
				summary: '[steered] Halting.',
				text: '[steered] Halting.',
				success: true,
			});
			useBatchStore.setState({ batchRunStates: {} } as never);

			const result = runRemoteSteeringCommand({ action: 'list', sessionId: SESSION_ID });

			expect(result.success).toBe(true);
			expect(result.steerable).toBe(false);
			expect(result.deliveries?.[0].reply?.summary).toBe('[steered] Halting.');
		});

		it('keeps store-only fields off the wire', () => {
			startRun();
			submitSteeringNote({ sessionId: SESSION_ID, text: 'first', announce: false });
			takeSteeringNotesForDispatch(SESSION_ID);

			const result = runRemoteSteeringCommand({ action: 'list', sessionId: SESSION_ID });

			expect(Object.keys(result.deliveries![0].notes[0]).sort()).toEqual([
				'id',
				'text',
				'timestamp',
			]);
		});
	});

	describe('cancel', () => {
		it('takes back a pending note and returns it', () => {
			startRun();
			const note = submitSteeringNote({
				sessionId: SESSION_ID,
				text: 'never mind',
				announce: false,
			})!;

			const result = runRemoteSteeringCommand({
				action: 'cancel',
				sessionId: SESSION_ID,
				noteId: note.id,
			});

			expect(result).toEqual({
				success: true,
				note: { id: note.id, text: 'never mind', timestamp: note.timestamp },
			});
			expect(pendingCount()).toBe(0);
		});

		// "No such note" for a note the caller just listed reads as a bug. It was
		// simply too late, and the answer should say so.
		it('says a task got there first rather than "no such note"', () => {
			startRun();
			const note = submitSteeringNote({ sessionId: SESSION_ID, text: 'gone', announce: false })!;
			takeSteeringNotesForDispatch(SESSION_ID);

			const result = runRemoteSteeringCommand({
				action: 'cancel',
				sessionId: SESSION_ID,
				noteId: note.id,
			});

			expect(result.success).toBe(false);
			expect(result.error).toMatch(/already delivered/);
			expect(deliveredCount()).toBe(1);
		});

		it('refuses an id that names nothing', () => {
			const result = runRemoteSteeringCommand({
				action: 'cancel',
				sessionId: SESSION_ID,
				noteId: 'nope',
			});

			expect(result).toEqual({ success: false, error: 'No pending steering note with id nope' });
		});
	});

	it('refuses a request that names no agent', () => {
		expect(runRemoteSteeringCommand({ action: 'list', sessionId: '' }).success).toBe(false);
	});
});
