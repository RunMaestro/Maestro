/**
 * Tests for src/renderer/utils/snoozeTranscriptMirror.ts
 *
 * A snooze can outlive the provider's retention of its transcript, so Maestro
 * keeps its own copy for the duration. The property that matters here is
 * SYMMETRY: whatever is mirrored when the snooze starts has to be released when
 * it ends. A copy taken on the way in that nothing releases on the way out is a
 * mirror held forever, and that is exactly what a parked group used to be -
 * mirrored per AI pane, released only if the entry itself was type `ai`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
	mirrorSnoozedTranscript,
	releaseSnoozedTranscript,
} from '../../../renderer/utils/snoozeTranscriptMirror';
import { createMockSession } from '../../helpers/mockSession';
import { createMockAITab } from '../../helpers/mockTab';
import {
	persistTabStarred,
	snapshotClosedTabTranscript,
} from '../../../renderer/utils/starredSessions';
import type { Session, SnoozedTabEntry } from '../../../renderer/types';

const snapshot = () =>
	window.maestro.agentSessions.snapshotStarredTranscript as ReturnType<typeof vi.fn>;
const release = () =>
	window.maestro.agentSessions.releaseSnoozedTranscript as ReturnType<typeof vi.fn>;

function session(): Session {
	return createMockSession({ projectRoot: '/repo', toolType: 'claude-code' });
}

/** A snooze of one AI tab that has actually run (so it has a transcript). */
function aiEntry(agentSessionId = 'sess-a'): SnoozedTabEntry {
	return {
		type: 'ai',
		tab: createMockAITab({ id: 'a', name: 'Alpha', agentSessionId }),
		id: 'snooze-1',
		unifiedIndex: 0,
		snoozedAt: 0,
		wakeAt: 0,
	} as SnoozedTabEntry;
}

/** A parked group: two AI panes with transcripts, plus a file pane with none. */
function groupEntry(): SnoozedTabEntry {
	return {
		type: 'group',
		id: 'snooze-2',
		unifiedIndex: 0,
		snoozedAt: 0,
		wakeAt: 0,
		group: { id: 'g1', name: 'Review' },
		members: [
			{ type: 'ai', tab: createMockAITab({ id: 'a', agentSessionId: 'sess-a' }) },
			{ type: 'file', tab: { id: 'f1' } },
			{ type: 'ai', tab: createMockAITab({ id: 'b', agentSessionId: 'sess-b' }) },
		],
	} as unknown as SnoozedTabEntry;
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe('mirrorSnoozedTranscript', () => {
	it('takes a copy for a snoozed conversation', () => {
		mirrorSnoozedTranscript(session(), aiEntry());
		expect(snapshot()).toHaveBeenCalledTimes(1);
		expect(snapshot()).toHaveBeenCalledWith('claude-code', '/repo', 'sess-a', 'Alpha', 'snoozed');
	});

	it('takes one copy per AI pane of a parked group', () => {
		mirrorSnoozedTranscript(session(), groupEntry());
		expect(snapshot()).toHaveBeenCalledTimes(2);
		expect(snapshot().mock.calls.map((call) => call[2])).toEqual(['sess-a', 'sess-b']);
	});

	it('does nothing for a kind that has no transcript', () => {
		const fileEntry = { ...aiEntry(), type: 'file', tab: { id: 'f1' } } as SnoozedTabEntry;
		mirrorSnoozedTranscript(session(), fileEntry);
		expect(snapshot()).not.toHaveBeenCalled();
	});

	it('does nothing for a tab that never ran, so has no provider session', () => {
		mirrorSnoozedTranscript(session(), aiEntry(''));
		expect(snapshot()).not.toHaveBeenCalled();
	});
});

describe('releaseSnoozedTranscript', () => {
	it('releases exactly what was mirrored, for both kinds', () => {
		// Symmetry is the whole contract: run both ends and compare the session
		// ids, so a future change that adds a mirror without a release fails here.
		for (const entry of [aiEntry(), groupEntry()]) {
			snapshot().mockClear();
			release().mockClear();

			mirrorSnoozedTranscript(session(), entry);
			releaseSnoozedTranscript(session(), entry);

			expect(release().mock.calls.map((call) => call[2])).toEqual(
				snapshot().mock.calls.map((call) => call[2])
			);
		}
	});

	it('does nothing for a kind that never took a copy', () => {
		const terminalEntry = { ...aiEntry(), type: 'terminal', tab: { id: 't1' } } as SnoozedTabEntry;
		releaseSnoozedTranscript(session(), terminalEntry);
		expect(release()).not.toHaveBeenCalled();
	});
});

describe('Ensemble native transcript ownership', () => {
	beforeEach(() => vi.clearAllMocks());
	it.each([false, true])('mirrors and releases the native owner (pending=%s)', (pending) => {
		const entry = aiEntry();
		if (entry.type !== 'ai') throw new Error('Expected AI snooze');
		entry.tab = createMockAITab({
			agentSessionId: pending ? 'stale-destination' : 'codex-native',
			tabProvider: 'codex',
			pendingTranslation: pending ? 'claude-code' : undefined,
			providerSessions: pending ? { 'claude-code': { agentSessionId: 'source' } } : undefined,
		});
		mirrorSnoozedTranscript(session(), entry);
		releaseSnoozedTranscript(session(), entry);
		const owner = pending ? 'claude-code' : 'codex';
		const id = pending ? 'source' : 'codex-native';
		expect(snapshot()).toHaveBeenCalledWith(owner, '/repo', id, undefined, 'snoozed');
		expect(release()).toHaveBeenCalledWith(owner, '/repo', id);
	});
	it('stars and snapshots a pinned native session under its provider', async () => {
		const tab = createMockAITab({
			agentSessionId: 'codex-native',
			tabProvider: 'codex',
			starred: true,
			name: 'Kept',
		});
		persistTabStarred(session(), tab, true);
		snapshotClosedTabTranscript(session(), tab);
		await Promise.resolve();
		expect(window.maestro.agentSessions.setSessionStarred).toHaveBeenCalledWith(
			'codex',
			'/repo',
			'codex-native',
			true
		);
		expect(window.maestro.claude.updateSessionStarred).not.toHaveBeenCalled();
		expect(snapshot()).toHaveBeenCalledWith('codex', '/repo', 'codex-native', 'Kept');
	});
	it('stars and snapshots the pending source instead of a stale destination', async () => {
		const tab = createMockAITab({
			agentSessionId: 'stale-codex',
			tabProvider: 'codex',
			pendingTranslation: 'claude-code',
			providerSessions: { 'claude-code': { agentSessionId: 'source' } },
			starred: true,
			name: 'Pending',
		});
		persistTabStarred(session(), tab, false);
		snapshotClosedTabTranscript(session(), tab);
		await Promise.resolve();
		expect(window.maestro.claude.updateSessionStarred).toHaveBeenCalledWith(
			'/repo',
			'source',
			false
		);
		expect(snapshot()).toHaveBeenCalledWith('claude-code', '/repo', 'source', 'Pending');
		expect(tab.agentSessionId).toBe('stale-codex');
	});
	it('never mirrors the destination when the pending source has no native ID yet', () => {
		const tab = createMockAITab({
			agentSessionId: 'stale-codex',
			tabProvider: 'codex',
			pendingTranslation: 'claude-code',
			starred: true,
		});
		persistTabStarred(session(), tab, true);
		snapshotClosedTabTranscript(session(), tab);
		expect(snapshot()).not.toHaveBeenCalled();
		expect(window.maestro.agentSessions.setSessionStarred).not.toHaveBeenCalled();
		expect(window.maestro.claude.updateSessionStarred).not.toHaveBeenCalled();
	});
});
