// Source: src/__tests__/renderer/components/FeedbackModal.test.tsx
// Source: src/__tests__/renderer/components/FeedbackModalExit.test.tsx
import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';
import { cleanup, render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import * as React from 'react';
import { FeedbackModal } from '../../../renderer/components/FeedbackModal';
import {
	useFeedbackDraftStore,
	type FeedbackDraft,
} from '../../../renderer/stores/feedbackDraftStore';
import { type Theme } from '../../../renderer/types';
import { LayerStackProvider } from '../../../renderer/contexts/LayerStackContext';
import { mockTheme } from '../../helpers/mockTheme';
// Count editor mounts without starting the feedback agent.
const mockChat = { mountCount: 0 };
vi.mock('../../../renderer/components/FeedbackChatView', () => ({
	FeedbackChatView: () => {
		React.useEffect(() => {
			mockChat.mountCount += 1;
		}, []);
		return <div data-testid="chat-view" />;
	},
}));
vi.mock('../../../renderer/components/FeedbackDraftsList', () => ({
	FeedbackDraftsList: ({
		drafts,
		onResume,
	}: {
		drafts: FeedbackDraft[];
		onResume: (id: string) => void;
	}) => (
		<div>
			{drafts.map((d) => (
				<button key={d.id} aria-label={`resume-${d.id}`} onClick={() => onResume(d.id)}>
					{d.suggestedName}
				</button>
			))}
		</div>
	),
}));
describe('FeedbackModal', () => {
	const theme = {
		id: 'test-dark',
		name: 'Test Dark',
		mode: 'dark',
		colors: {
			bgMain: '#101322',
			bgSidebar: '#14192d',
			bgActivity: '#1b2140',
			textMain: '#f5f7ff',
			textDim: '#8d96b8',
			accent: '#8b5cf6',
			accentForeground: '#ffffff',
			border: '#2a3154',
			success: '#22c55e',
			warning: '#f59e0b',
			error: '#ef4444',
		},
	} as Theme;

	function makeDraft(id: string): FeedbackDraft {
		return {
			id,
			suggestedName: `Draft ${id}`,
			category: 'general_feedback',
			summary: '',
			confidence: 0,
			agentType: 'claude-code',
			messages: [],
			attachments: [],
			inputDraft: '',
			includeDebugPackage: false,
			createdAt: 1000,
			updatedAt: 1000,
		};
	}

	function renderModal() {
		return render(
			<LayerStackProvider>
				<FeedbackModal theme={theme} sessions={[]} onClose={vi.fn()} onSwitchToSession={vi.fn()} />
			</LayerStackProvider>
		);
	}

	const initialDraftState = useFeedbackDraftStore.getInitialState();
	const mockState = {
		saveDraft: vi.fn(),
		requestResume: vi.fn(initialDraftState.requestResume),
		loadDrafts: vi.fn().mockResolvedValue(undefined),
	};
	describe('FeedbackModal draft resume', () => {
		afterEach(() => {
			cleanup();
			useFeedbackDraftStore.setState(initialDraftState, true);
		});
		beforeEach(() => {
			vi.clearAllMocks();
			mockChat.mountCount = 0;
			useFeedbackDraftStore.setState(
				{
					...initialDraftState,
					saveDraft: mockState.saveDraft,
					requestResume: mockState.requestResume,
					loadDrafts: mockState.loadDrafts,
				},
				true
			);
			mockState.saveDraft.mockResolvedValue('saved-id');
		});

		it('has no separate Minimize button (X already parks a draft)', () => {
			renderModal();
			expect(screen.queryByLabelText('Minimize feedback')).toBeNull();
			expect(screen.getByLabelText('Close modal')).toBeTruthy();
		});

		it('reopening the already-active draft is a no-op (no remount, no save, no resume)', async () => {
			useFeedbackDraftStore.setState({
				drafts: [makeDraft('draft-1'), makeDraft('draft-2')],
				activeDraftId: 'draft-1',
				activeDraft: makeDraft('draft-1'),
			});

			renderModal();
			expect(mockChat.mountCount).toBe(1);

			await act(async () => {
				fireEvent.click(screen.getByLabelText('View saved drafts'));
			});
			await act(async () => {
				fireEvent.click(screen.getByLabelText('resume-draft-1'));
			});

			// The live editor must be left untouched: clicking the active draft must
			// not rebuild it from the persisted copy (which would drop unsaved edits).
			expect(mockChat.mountCount).toBe(1);
			expect(mockState.requestResume).not.toHaveBeenCalled();
			expect(mockState.saveDraft).not.toHaveBeenCalled();
		});

		it('switching to a different draft saves the current one then remounts the editor', async () => {
			useFeedbackDraftStore.setState({
				drafts: [makeDraft('draft-1'), makeDraft('draft-2')],
				activeDraftId: 'draft-1',
				activeDraft: makeDraft('draft-1'),
			});
			mockState.saveDraft.mockResolvedValue('draft-1');

			renderModal();
			expect(mockChat.mountCount).toBe(1);

			await act(async () => {
				fireEvent.click(screen.getByLabelText('View saved drafts'));
			});
			await act(async () => {
				fireEvent.click(screen.getByLabelText('resume-draft-2'));
			});

			expect(mockState.saveDraft).toHaveBeenCalledTimes(1);
			expect(mockState.requestResume).toHaveBeenCalledWith('draft-2');
			await waitFor(() => expect(mockChat.mountCount).toBe(2));
		});
	});
});
describe('FeedbackModalExit', () => {
	// The chat view spawns an agent and probes gh on mount; none of that is what
	// these tests are about. They cover the modal's exit contract: closing must
	// never destroy a conversation that is still running.
	//
	function renderModal(onClose = vi.fn()) {
		render(
			<LayerStackProvider>
				<FeedbackModal
					theme={mockTheme}
					sessions={[]}
					onClose={onClose}
					onSwitchToSession={vi.fn()}
				/>
			</LayerStackProvider>
		);
		return onClose;
	}

	/** Mark the conversation as having work in progress. */
	function withDraft() {
		act(() => {
			useFeedbackDraftStore.getState().setHasDraft(true);
		});
	}

	describe('FeedbackModal exit contract', () => {
		beforeEach(() => {
			vi.clearAllMocks();
			act(() => {
				useFeedbackDraftStore.getState().reset();
			});
		});

		it('closes outright when there is nothing in progress', () => {
			const onClose = renderModal();

			fireEvent.click(screen.getByLabelText('Close modal'));

			expect(onClose).toHaveBeenCalled();
		});

		it('parks the conversation instead of unmounting it when a draft is in flight', () => {
			const onClose = renderModal();
			withDraft();

			fireEvent.click(screen.getByLabelText('Close modal'));

			// Unmounting kills the agent process and drops the in-flight reply, so
			// closing must not call onClose while there is work to preserve.
			expect(onClose).not.toHaveBeenCalled();
		});

		it('offers discard only when there is something to discard', () => {
			renderModal();
			expect(screen.queryByLabelText('Discard feedback')).toBeNull();

			withDraft();
			expect(screen.getByLabelText('Discard feedback')).toBeTruthy();
		});

		it('requires confirmation before discarding, then tears the conversation down', () => {
			const onClose = renderModal();
			withDraft();

			// The confirm offers three ways out (Save & Close / Discard / Keep
			// editing), so it is titled for the choice rather than for one branch.
			fireEvent.click(screen.getByLabelText('Discard feedback'));
			expect(screen.getByText('Save this draft?')).toBeTruthy();
			expect(onClose).not.toHaveBeenCalled();

			fireEvent.click(screen.getByText('Discard'));
			expect(onClose).toHaveBeenCalled();
		});
	});
});
