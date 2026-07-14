import '@testing-library/jest-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { AgentApprovalRequest } from '../../../../shared/agent-runtime-features';
import { THEMES } from '../../../constants/themes';
import { AgentApprovals } from '../AgentApprovals';

type ApprovalRequest = AgentApprovalRequest;

const theme = THEMES.dracula;

function approval(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
	return {
		id: 'approval-1',
		sessionId: 'session-1',
		toolType: 'bash',
		title: 'Run command?',
		detail: 'bun test',
		options: [
			{ id: 'deny', label: 'Deny', kind: 'deny' },
			{ id: 'approve', label: 'Approve', kind: 'approve' },
		],
		createdAt: '2026-07-13T12:00:00.000Z',
		...overrides,
	};
}

afterEach(cleanup);

describe('AgentApprovals', () => {
	it('renders only the head of queued OMP-style approvals with detail and choices', () => {
		render(
			<AgentApprovals
				theme={theme}
				approvals={[approval(), approval({ id: 'approval-2', title: 'Second request' })]}
				onRespond={vi.fn()}
			/>
		);

		expect(screen.getByRole('dialog', { name: 'Run command?' })).toHaveAttribute(
			'aria-modal',
			'true'
		);
		expect(screen.getByText('bun test')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Deny' })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument();
		expect(screen.queryByText('Second request')).not.toBeInTheDocument();
	});

	it('responds with the selected custom option for the active request', () => {
		const onRespond = vi.fn();
		render(
			<AgentApprovals
				theme={theme}
				approvals={[
					approval({
						options: [
							{ id: 'option:skip/opaque', label: 'Skip this', kind: 'custom' },
							{ id: 'approve', label: 'Approve', kind: 'approve' },
						],
					}),
				]}
				onRespond={onRespond}
			/>
		);

		fireEvent.click(screen.getByRole('button', { name: 'Skip this' }));
		expect(onRespond).toHaveBeenCalledWith({
			sessionId: 'session-1',
			requestId: 'approval-1',
			optionId: 'option:skip/opaque',
		});
	});

	it('denies the active request with Escape', () => {
		const onRespond = vi.fn();
		render(<AgentApprovals theme={theme} approvals={[approval()]} onRespond={onRespond} />);

		fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
		expect(onRespond).toHaveBeenCalledWith({
			sessionId: 'session-1',
			requestId: 'approval-1',
			optionId: 'deny',
		});
	});

	it('returns no UI while there are no pending approvals', () => {
		const { container } = render(
			<AgentApprovals theme={theme} approvals={[]} onRespond={vi.fn()} />
		);
		expect(container).toBeEmptyDOMElement();
	});
});
