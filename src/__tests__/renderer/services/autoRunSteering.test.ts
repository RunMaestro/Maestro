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
	clearSteeringNotes,
} from '../../../renderer/services/autoRunSteering';
import { useAutoRunSteeringStore } from '../../../renderer/stores/autoRunSteeringStore';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { notifyCenterFlash } from '../../../renderer/stores/centerFlashStore';
import { MAX_PENDING_STEERING_NOTES } from '../../../shared/autorunSteering';
import { createMockSession } from '../../helpers/mockSession';
import type { AITab, LogEntry, Session } from '../../../renderer/types';

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
	seed();
});

describe('submitSteeringNote', () => {
	it('parks the note and acknowledges it', () => {
		const accepted = submitSteeringNote({
			sessionId: SESSION_ID,
			text: 'Use the v3 endpoint',
		});

		expect(accepted).toBe(true);
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
		expect(submitSteeringNote({ sessionId: SESSION_ID, text: '   ' })).toBe(false);

		expect(pendingCount()).toBe(0);
		expect(notifyCenterFlash).not.toHaveBeenCalled();
	});

	it('rejects past the pending cap and says so, since nothing else would show it', () => {
		for (let i = 0; i < MAX_PENDING_STEERING_NOTES; i++) {
			expect(submitSteeringNote({ sessionId: SESSION_ID, text: `note ${i}` })).toBe(true);
		}
		vi.mocked(notifyCenterFlash).mockClear();

		expect(submitSteeringNote({ sessionId: SESSION_ID, text: 'one too many' })).toBe(false);
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
