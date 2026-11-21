// Source: src/__tests__/renderer/stores/coworkingApprovalStore.test.ts
// Source: src/__tests__/renderer/stores/feedbackIssueHistoryStore.test.ts
// Source: src/__tests__/renderer/stores/feedbackDraftStore.test.ts
// Source: src/__tests__/renderer/stores/snoozeHistoryStore.test.ts
import { describe as describeSourceSuite } from 'vitest';
import { describe } from 'vitest';
import { it } from 'vitest';
import { expect } from 'vitest';
import { beforeEach } from 'vitest';
import { afterEach } from 'vitest';
import { vi } from 'vitest';
import { requestCoworkingApproval } from '../../../renderer/stores/coworkingApprovalStore';
import { useCoworkingApprovalStore } from '../../../renderer/stores/coworkingApprovalStore';
import { useFeedbackIssueHistoryStore } from '../../../renderer/stores/feedbackIssueHistoryStore';
import type { SubmittedIssue } from '../../../renderer/stores/feedbackIssueHistoryStore';
import { useFeedbackDraftStore } from '../../../renderer/stores/feedbackDraftStore';
import type { FeedbackDraft } from '../../../renderer/stores/feedbackDraftStore';
import { useSnoozeHistoryStore } from '../../../renderer/stores/snoozeHistoryStore';
import { sanitizeSnoozeHistory } from '../../../renderer/stores/snoozeHistoryStore';
import { recordSnoozeResolution } from '../../../renderer/stores/snoozeHistoryStore';
import { MAX_SNOOZE_HISTORY } from '../../../renderer/stores/snoozeHistoryStore';
import { SNOOZE_HISTORY_SETTINGS_KEY } from '../../../renderer/stores/snoozeHistoryStore';
import type { SnoozeHistoryInput } from '../../../renderer/stores/snoozeHistoryStore';
import type { SnoozeHistoryEntry } from '../../../renderer/types';
describeSourceSuite('coworkingApprovalStore', () => {
	const INPUT = { agentId: 'a', sessionId: 's', title: 't', message: 'm' };

	describe('requestCoworkingApproval auto-decline timeout', () => {
		beforeEach(() => {
			useCoworkingApprovalStore.setState({ queue: [] });
			vi.useFakeTimers();
		});

		afterEach(() => {
			vi.useRealTimers();
		});

		it('auto-declines and dismisses the dialog exactly at the deadline', async () => {
			const p = requestCoworkingApproval(INPUT, 1000);
			let settled: boolean | undefined;
			void p.then((v) => {
				settled = v;
			});

			// Armed but undecided: request is queued, promise still pending.
			expect(useCoworkingApprovalStore.getState().queue).toHaveLength(1);
			expect(vi.getTimerCount()).toBe(1);

			// Just shy of the deadline: nothing has fired.
			vi.advanceTimersByTime(999);
			await Promise.resolve();
			expect(settled).toBeUndefined();
			expect(useCoworkingApprovalStore.getState().queue).toHaveLength(1);

			// Crossing 1000ms auto-declines and dismisses the dialog.
			vi.advanceTimersByTime(1);
			await expect(p).resolves.toBe(false);
			expect(settled).toBe(false);
			expect(useCoworkingApprovalStore.getState().queue).toHaveLength(0);
		});

		it('a decision before the deadline cancels the timer and resolves exactly once', async () => {
			const p = requestCoworkingApproval(INPUT, 1000);
			const resolutions: boolean[] = [];
			void p.then((v) => resolutions.push(v));

			expect(vi.getTimerCount()).toBe(1);

			const id = useCoworkingApprovalStore.getState().queue[0].id;
			useCoworkingApprovalStore.getState().settle(id, true);
			await expect(p).resolves.toBe(true);

			// The user's decision must have cleared the pending auto-decline timer.
			expect(vi.getTimerCount()).toBe(0);
			expect(useCoworkingApprovalStore.getState().queue).toHaveLength(0);

			// Advancing past the original deadline neither throws nor re-resolves.
			expect(() => vi.advanceTimersByTime(5000)).not.toThrow();
			await Promise.resolve();
			expect(resolutions).toEqual([true]);
			expect(useCoworkingApprovalStore.getState().queue).toHaveLength(0);
		});

		it('never auto-declines when no timeoutMs is supplied', async () => {
			const p = requestCoworkingApproval(INPUT);
			let settled: boolean | undefined;
			void p.then((v) => {
				settled = v;
			});

			// No timer armed at all.
			expect(vi.getTimerCount()).toBe(0);

			vi.advanceTimersByTime(10 * 60 * 1000);
			await Promise.resolve();

			expect(settled).toBeUndefined();
			expect(useCoworkingApprovalStore.getState().queue).toHaveLength(1);
		});

		it('does not arm a timer for a non-positive timeoutMs', async () => {
			const p = requestCoworkingApproval(INPUT, 0);
			let settled: boolean | undefined;
			void p.then((v) => {
				settled = v;
			});

			expect(vi.getTimerCount()).toBe(0);

			vi.advanceTimersByTime(10 * 60 * 1000);
			await Promise.resolve();

			expect(settled).toBeUndefined();
			expect(useCoworkingApprovalStore.getState().queue).toHaveLength(1);
		});
	});
});
describeSourceSuite('feedbackIssueHistoryStore', () => {
	const makeIssue = (overrides: Partial<SubmittedIssue> = {}): SubmittedIssue => ({
		number: 101,
		url: 'https://github.com/RunMaestro/Maestro/issues/101',
		title: 'Feedback modal crashes',
		category: 'bug_report',
		submittedAt: 1,
		state: 'open',
		lastCheckedAt: 1,
		...overrides,
	});

	describe('feedbackIssueHistoryStore', () => {
		beforeEach(() => {
			vi.clearAllMocks();
			useFeedbackIssueHistoryStore.setState({ issues: [], isRefreshing: false });
			window.maestro.feedback.issues.list.mockResolvedValue({ issues: [] });
			window.maestro.feedback.issues.delete.mockResolvedValue({});
			window.maestro.feedback.issues.refreshStates.mockResolvedValue({ issues: [] });
		});

		it('loadIssues populates the list from the IPC bridge', async () => {
			const issue = makeIssue();
			window.maestro.feedback.issues.list.mockResolvedValue({ issues: [issue] });

			await useFeedbackIssueHistoryStore.getState().loadIssues();

			expect(window.maestro.feedback.issues.list).toHaveBeenCalled();
			expect(useFeedbackIssueHistoryStore.getState().issues).toEqual([issue]);
		});

		it('loadIssues keeps the existing list when the read fails', async () => {
			const cached = [makeIssue()];
			useFeedbackIssueHistoryStore.setState({ issues: cached });
			window.maestro.feedback.issues.list.mockRejectedValue(new Error('offline'));

			await useFeedbackIssueHistoryStore.getState().loadIssues();

			expect(useFeedbackIssueHistoryStore.getState().issues).toEqual(cached);
		});

		it('refreshStates swaps in refreshed states and toggles isRefreshing', async () => {
			const refreshed = [makeIssue({ state: 'closed', lastCheckedAt: 5 })];
			let seenDuringRefresh = false;
			window.maestro.feedback.issues.refreshStates.mockImplementation(async () => {
				seenDuringRefresh = useFeedbackIssueHistoryStore.getState().isRefreshing;
				return { issues: refreshed };
			});

			await useFeedbackIssueHistoryStore.getState().refreshStates();

			expect(seenDuringRefresh).toBe(true);
			expect(useFeedbackIssueHistoryStore.getState().issues).toEqual(refreshed);
			expect(useFeedbackIssueHistoryStore.getState().isRefreshing).toBe(false);
		});

		it('refreshStates keeps the cached list and clears the flag on failure', async () => {
			const cached = [makeIssue()];
			useFeedbackIssueHistoryStore.setState({ issues: cached });
			window.maestro.feedback.issues.refreshStates.mockRejectedValue(new Error('gh missing'));

			await useFeedbackIssueHistoryStore.getState().refreshStates();

			expect(useFeedbackIssueHistoryStore.getState().issues).toEqual(cached);
			expect(useFeedbackIssueHistoryStore.getState().isRefreshing).toBe(false);
		});

		it('deleteIssue removes via IPC then reloads', async () => {
			window.maestro.feedback.issues.list.mockResolvedValue({ issues: [] });

			await useFeedbackIssueHistoryStore.getState().deleteIssue(101);

			expect(window.maestro.feedback.issues.delete).toHaveBeenCalledWith(101);
			expect(window.maestro.feedback.issues.list).toHaveBeenCalled();
			expect(useFeedbackIssueHistoryStore.getState().issues).toEqual([]);
		});
	});
});
describeSourceSuite('feedbackDraftStore', () => {
	const makeDraft = (overrides: Partial<FeedbackDraft> = {}): FeedbackDraft => ({
		id: 'd1',
		suggestedName: 'Draft one',
		category: 'bug_report',
		summary: '',
		confidence: 0,
		agentType: 'claude-code',
		messages: [],
		attachments: [],
		inputDraft: '',
		includeDebugPackage: false,
		createdAt: 1,
		updatedAt: 1,
		...overrides,
	});

	describe('feedbackDraftStore', () => {
		beforeEach(() => {
			vi.clearAllMocks();
			useFeedbackDraftStore.setState({
				isMinimized: false,
				hasDraft: false,
				drafts: [],
				resumeDraftId: null,
				activeDraftId: null,
				activeDraft: null,
				saveError: null,
			});
			window.maestro.feedback.drafts.list.mockResolvedValue({ drafts: [] });
			window.maestro.feedback.drafts.save.mockImplementation((draft: FeedbackDraft) =>
				Promise.resolve({ draft })
			);
			window.maestro.feedback.drafts.delete.mockResolvedValue({});
		});

		it('loadDrafts populates the drafts list from the IPC bridge', async () => {
			const draft = makeDraft();
			window.maestro.feedback.drafts.list.mockResolvedValue({ drafts: [draft] });

			await useFeedbackDraftStore.getState().loadDrafts();

			expect(window.maestro.feedback.drafts.list).toHaveBeenCalled();
			expect(useFeedbackDraftStore.getState().drafts).toEqual([draft]);
		});

		it('saveDraft persists, refreshes the list, and tracks the active id', async () => {
			const draft = makeDraft({ id: 'saved-1' });
			window.maestro.feedback.drafts.save.mockResolvedValue({ draft });
			window.maestro.feedback.drafts.list.mockResolvedValue({ drafts: [draft] });

			const id = await useFeedbackDraftStore.getState().saveDraft(draft);

			expect(window.maestro.feedback.drafts.save).toHaveBeenCalledWith(draft);
			expect(window.maestro.feedback.drafts.list).toHaveBeenCalled();
			expect(id).toBe('saved-1');
			expect(useFeedbackDraftStore.getState().activeDraftId).toBe('saved-1');
			expect(useFeedbackDraftStore.getState().drafts).toEqual([draft]);
		});

		it('deleteDraft removes via IPC, refreshes, and clears a matching active id', async () => {
			useFeedbackDraftStore.setState({ activeDraftId: 'd1' });
			window.maestro.feedback.drafts.list.mockResolvedValue({ drafts: [] });

			await useFeedbackDraftStore.getState().deleteDraft('d1');

			expect(window.maestro.feedback.drafts.delete).toHaveBeenCalledWith('d1');
			expect(window.maestro.feedback.drafts.list).toHaveBeenCalled();
			expect(useFeedbackDraftStore.getState().drafts).toEqual([]);
			expect(useFeedbackDraftStore.getState().activeDraftId).toBeNull();
		});

		it('reset clears the ephemeral session flags but preserves the persisted drafts', () => {
			const drafts = [makeDraft()];
			useFeedbackDraftStore.setState({
				isMinimized: true,
				hasDraft: true,
				drafts,
				activeDraftId: 'd1',
				activeDraft: drafts[0],
				resumeDraftId: 'd1',
			});

			useFeedbackDraftStore.getState().reset();

			const state = useFeedbackDraftStore.getState();
			expect(state.isMinimized).toBe(false);
			expect(state.hasDraft).toBe(false);
			expect(state.activeDraftId).toBeNull();
			expect(state.activeDraft).toBeNull();
			expect(state.resumeDraftId).toBeNull();
			// The persisted drafts list must survive a reset so it stays resumable.
			expect(state.drafts).toEqual(drafts);
		});

		it('saveActiveDraft writes out whatever the open editor holds', async () => {
			const snapshot = makeDraft({ id: '', inputDraft: 'half-written report' });
			useFeedbackDraftStore.setState({ activeDraft: snapshot });
			window.maestro.feedback.drafts.save.mockResolvedValue({ draft: makeDraft({ id: 'quit-1' }) });

			const id = await useFeedbackDraftStore.getState().saveActiveDraft();

			expect(id).toBe('quit-1');
			expect(window.maestro.feedback.drafts.save).toHaveBeenCalledWith(
				expect.objectContaining({ inputDraft: 'half-written report' })
			);
		});

		it('saveActiveDraft is a no-op when the editor is empty', async () => {
			useFeedbackDraftStore.setState({ activeDraft: null });

			const id = await useFeedbackDraftStore.getState().saveActiveDraft();

			expect(id).toBeNull();
			expect(window.maestro.feedback.drafts.save).not.toHaveBeenCalled();
		});

		it('saveDraft surfaces a failure as null and records a saveError', async () => {
			window.maestro.feedback.drafts.save.mockRejectedValue(new Error('disk full'));

			const id = await useFeedbackDraftStore.getState().saveDraft(makeDraft());

			expect(id).toBeNull();
			expect(useFeedbackDraftStore.getState().saveError).toBeTruthy();
		});

		it('saveDraft patches the live snapshot id so later saves upsert instead of duplicating', async () => {
			const snapshot = makeDraft({ id: '' });
			useFeedbackDraftStore.setState({ activeDraft: snapshot, saveError: 'stale error' });
			window.maestro.feedback.drafts.save.mockResolvedValue({
				draft: makeDraft({ id: 'minted-1' }),
			});

			const id = await useFeedbackDraftStore.getState().saveDraft(snapshot);

			expect(id).toBe('minted-1');
			const state = useFeedbackDraftStore.getState();
			expect(state.activeDraftId).toBe('minted-1');
			expect(state.activeDraft?.id).toBe('minted-1');
			expect(state.saveError).toBeNull();
		});

		it('dedupes concurrent first-saves of a new draft into a single draft row', async () => {
			// Mirror the main-process handler: an empty id mints a fresh UUID per
			// call, while an existing id upserts the matching row in place.
			const persisted: FeedbackDraft[] = [];
			let mintCounter = 0;
			window.maestro.feedback.drafts.save.mockImplementation(async (incoming: FeedbackDraft) => {
				const id = incoming.id || `minted-${++mintCounter}`;
				const existing = persisted.findIndex((d) => d.id === id);
				const saved = { ...incoming, id };
				if (existing >= 0) persisted[existing] = saved;
				else persisted.push(saved);
				return { draft: saved };
			});
			window.maestro.feedback.drafts.list.mockImplementation(async () => ({
				drafts: [...persisted],
			}));

			// Both saves fire before the first resolves, so both serialize an empty id.
			const { saveDraft } = useFeedbackDraftStore.getState();
			const newDraft = makeDraft({ id: '' });
			const [id1, id2] = await Promise.all([saveDraft(newDraft), saveDraft(newDraft)]);

			// Exactly one row is created and both calls resolve to the same minted id.
			expect(mintCounter).toBe(1);
			expect(persisted).toHaveLength(1);
			expect(id1).toBe('minted-1');
			expect(id2).toBe('minted-1');
			expect(useFeedbackDraftStore.getState().activeDraftId).toBe('minted-1');
		});
	});
});
describeSourceSuite('snoozeHistoryStore', () => {
	/** A resolution input with sensible defaults. */
	function input(overrides: Partial<SnoozeHistoryInput> = {}): SnoozeHistoryInput {
		return {
			label: 'Robinhood Access Check',
			sessionId: 's1',
			sessionName: 'Pedsidian',
			tabId: 'tab-1',
			note: 'check if access came through',
			snoozedAt: 1000,
			wakeAt: 2000,
			resolvedAt: 2000,
			resolution: 'woke',
			...overrides,
		};
	}

	const settingsSet = window.maestro.settings.set as ReturnType<typeof vi.fn>;

	describe('snoozeHistoryStore', () => {
		beforeEach(() => {
			useSnoozeHistoryStore.setState({ entries: [] });
			settingsSet.mockClear();
		});

		it('records a resolution newest-first and stamps an id', () => {
			const first = recordSnoozeResolution(input({ label: 'First', resolvedAt: 1 }));
			const second = recordSnoozeResolution(input({ label: 'Second', resolvedAt: 2 }));

			const { entries } = useSnoozeHistoryStore.getState();
			expect(entries.map((e) => e.label)).toEqual(['Second', 'First']);
			expect(first.id).toBeTruthy();
			expect(second.id).not.toBe(first.id);
		});

		it('keeps the note, which is the point of the log', () => {
			recordSnoozeResolution(input({ note: 'ship the migration' }));
			expect(useSnoozeHistoryStore.getState().entries[0].note).toBe('ship the migration');
		});

		it('persists through the settings bridge on every write', () => {
			recordSnoozeResolution(input());
			expect(settingsSet).toHaveBeenCalledWith(SNOOZE_HISTORY_SETTINGS_KEY, expect.any(Array));
		});

		it('caps the log and drops the oldest entry on overflow', () => {
			for (let i = 0; i < MAX_SNOOZE_HISTORY + 10; i++) {
				recordSnoozeResolution(input({ label: `entry-${i}`, resolvedAt: i }));
			}

			const { entries } = useSnoozeHistoryStore.getState();
			expect(entries).toHaveLength(MAX_SNOOZE_HISTORY);
			// Newest survives, oldest is gone.
			expect(entries[0].label).toBe(`entry-${MAX_SNOOZE_HISTORY + 9}`);
			expect(entries.some((e) => e.label === 'entry-0')).toBe(false);
		});

		it('records all three resolution kinds', () => {
			recordSnoozeResolution(input({ resolution: 'woke' }));
			recordSnoozeResolution(input({ resolution: 'unsnoozed' }));
			recordSnoozeResolution(input({ resolution: 'dismissed' }));

			const kinds = useSnoozeHistoryStore.getState().entries.map((e) => e.resolution);
			expect(kinds).toEqual(['dismissed', 'unsnoozed', 'woke']);
		});

		it('clears the log and persists the empty state', () => {
			recordSnoozeResolution(input());
			useSnoozeHistoryStore.getState().clearHistory();

			expect(useSnoozeHistoryStore.getState().entries).toEqual([]);
			expect(settingsSet).toHaveBeenLastCalledWith(SNOOZE_HISTORY_SETTINGS_KEY, []);
		});
	});

	describe('sanitizeSnoozeHistory', () => {
		const valid: SnoozeHistoryEntry = {
			id: 'h1',
			label: 'Valid',
			sessionId: 's1',
			sessionName: 'Agent',
			tabId: 't1',
			note: 'a note',
			snoozedAt: 1,
			wakeAt: 2,
			resolvedAt: 3,
			resolution: 'woke',
		};

		it('returns an empty list for non-array input', () => {
			expect(sanitizeSnoozeHistory(undefined)).toEqual([]);
			expect(sanitizeSnoozeHistory(null)).toEqual([]);
			expect(sanitizeSnoozeHistory('nope')).toEqual([]);
			expect(sanitizeSnoozeHistory({})).toEqual([]);
		});

		it('keeps valid entries intact', () => {
			expect(sanitizeSnoozeHistory([valid])).toEqual([valid]);
		});

		it('drops entries missing required fields rather than rendering blanks', () => {
			const result = sanitizeSnoozeHistory([
				valid,
				null,
				'string',
				{ ...valid, label: undefined },
				{ ...valid, resolvedAt: 'soon' },
				{ ...valid, resolution: 'exploded' },
			]);
			expect(result).toHaveLength(1);
			expect(result[0].label).toBe('Valid');
		});

		it('backfills optional fields that a hand-edited file may omit', () => {
			const [entry] = sanitizeSnoozeHistory([
				{ label: 'Sparse', resolvedAt: 5, resolution: 'dismissed' },
			]);
			expect(entry.id).toBeTruthy();
			expect(entry.sessionId).toBe('');
			expect(entry.snoozedAt).toBe(0);
			expect(entry.note).toBeUndefined();
		});

		it('sorts newest-first and re-applies the cap', () => {
			const many = Array.from({ length: MAX_SNOOZE_HISTORY + 5 }, (_, i) => ({
				...valid,
				id: `h${i}`,
				resolvedAt: i,
			}));

			const result = sanitizeSnoozeHistory(many);
			expect(result).toHaveLength(MAX_SNOOZE_HISTORY);
			expect(result[0].resolvedAt).toBe(MAX_SNOOZE_HISTORY + 4);
			expect(result[0].resolvedAt).toBeGreaterThan(result[1].resolvedAt);
		});
	});
});
