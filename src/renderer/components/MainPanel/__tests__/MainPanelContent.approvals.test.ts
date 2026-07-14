import { describe, expect, it, vi } from 'vitest';
import { respondToAgentApproval } from '../MainPanelContent';

describe('respondToAgentApproval', () => {
	it('removes a successfully denied approval from pending approvals', async () => {
		const respondApproval = vi.fn().mockResolvedValue(true);
		const removeFromPendingApprovals = vi.fn();
		const showRejectedToast = vi.fn();

		await respondToAgentApproval(
			{ sessionId: 'session-1', requestId: 'approval-1', optionId: 'opaque-deny-option' },
			respondApproval,
			removeFromPendingApprovals,
			showRejectedToast
		);

		expect(respondApproval).toHaveBeenCalledWith('session-1', 'approval-1', 'opaque-deny-option');
		expect(removeFromPendingApprovals).toHaveBeenCalledOnce();
		expect(showRejectedToast).not.toHaveBeenCalled();
	});

	it('shows an error toast when the approval response is rejected', async () => {
		const removeFromPendingApprovals = vi.fn();
		const showRejectedToast = vi.fn();

		await respondToAgentApproval(
			{ sessionId: 'session-1', requestId: 'approval-1', optionId: 'opaque-deny-option' },
			vi.fn().mockResolvedValue(false),
			removeFromPendingApprovals,
			showRejectedToast
		);

		expect(removeFromPendingApprovals).not.toHaveBeenCalled();
		expect(showRejectedToast).toHaveBeenCalledOnce();
	});
});
