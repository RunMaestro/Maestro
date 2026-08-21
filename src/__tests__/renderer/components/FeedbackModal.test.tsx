import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import { FeedbackModal } from '../../../renderer/components/FeedbackModal';
import { useFeedbackDraftStore } from '../../../renderer/stores/feedbackDraftStore';
import { LayerStackProvider } from '../../../renderer/contexts/LayerStackContext';
import { mockTheme } from '../../helpers/mockTheme';

// The chat view spawns an agent and probes gh on mount; none of that is what
// these tests are about. They cover the modal's exit contract: closing must
// never destroy a conversation that is still running.
vi.mock('../../../renderer/components/FeedbackChatView', () => ({
	FeedbackChatView: () => <div data-testid="feedback-chat-view" />,
}));

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

describe('FeedbackModal', () => {
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

		fireEvent.click(screen.getByLabelText('Discard feedback'));
		expect(screen.getByText('Discard Feedback?')).toBeTruthy();
		expect(onClose).not.toHaveBeenCalled();

		fireEvent.click(screen.getByText('Discard'));
		expect(onClose).toHaveBeenCalled();
	});
});
