import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	useFeedbackDraftStore,
	type FeedbackDraft,
} from '../../../renderer/stores/feedbackDraftStore';

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

	it('saveDraft surfaces a failure as null and records a saveError', async () => {
		window.maestro.feedback.drafts.save.mockRejectedValue(new Error('disk full'));

		const id = await useFeedbackDraftStore.getState().saveDraft(makeDraft());

		expect(id).toBeNull();
		expect(useFeedbackDraftStore.getState().saveError).toBeTruthy();
	});

	it('saveDraft patches the live snapshot id so later saves upsert instead of duplicating', async () => {
		const snapshot = makeDraft({ id: '' });
		useFeedbackDraftStore.setState({ activeDraft: snapshot, saveError: 'stale error' });
		window.maestro.feedback.drafts.save.mockResolvedValue({ draft: makeDraft({ id: 'minted-1' }) });

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
