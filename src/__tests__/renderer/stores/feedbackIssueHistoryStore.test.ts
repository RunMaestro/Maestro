import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	useFeedbackIssueHistoryStore,
	type SubmittedIssue,
} from '../../../renderer/stores/feedbackIssueHistoryStore';

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
