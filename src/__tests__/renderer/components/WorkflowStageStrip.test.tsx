import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkflowStageStrip } from '../../../renderer/components/GroupChat/WorkflowStageStrip';
import { useGroupChatStore } from '../../../renderer/stores/groupChatStore';
import type { GroupChatWorkflowRun } from '../../../shared/group-chat-workflow-types';
import { mockTheme } from '../../helpers/mockTheme';
import { resetStore } from '../../helpers/resetStores';

const approveWorkflowPlan = vi.fn().mockResolvedValue(undefined);
const cancelWorkflowRun = vi.fn().mockResolvedValue(null);

const stages = [
	{
		id: 'research',
		name: 'Research',
		agents: ['Analyst'],
		mode: 'serial' as const,
		instruction: 'Research the change.',
	},
	{
		id: 'implement',
		name: 'Implement',
		agents: ['Builder'],
		mode: 'serial' as const,
		instruction: 'Implement the change.',
	},
	{
		id: 'verify',
		name: 'Verify',
		agents: ['Reviewer'],
		mode: 'serial' as const,
		instruction: 'Verify the change.',
	},
];

function workflowRun(overrides: Partial<GroupChatWorkflowRun> = {}): GroupChatWorkflowRun {
	return {
		plan: {
			runId: 'run-1',
			title: 'Ship stage progress',
			createdAt: 1,
			stages,
		},
		status: 'awaiting-approval',
		currentStageIndex: 0,
		stageStatuses: {
			research: 'pending',
			implement: 'pending',
			verify: 'pending',
		},
		handoffs: [],
		...overrides,
	};
}

function renderStrip(): ReturnType<typeof render> {
	return render(<WorkflowStageStrip theme={mockTheme} groupChatId="chat-1" />);
}

describe('WorkflowStageStrip', () => {
	beforeEach(() => {
		resetStore(useGroupChatStore);
		vi.clearAllMocks();
		Object.assign(window.maestro, {
			groupChat: {
				approveWorkflowPlan,
				cancelWorkflowRun,
			},
		});
	});

	it('renders null when there is no workflow run', () => {
		const { container } = renderStrip();

		expect(container).toBeEmptyDOMElement();
	});

	it('shows approval actions and calls the matching bridge methods', async () => {
		useGroupChatStore.setState({ workflowRun: workflowRun() });
		renderStrip();

		expect(screen.getByText('Ship stage progress')).toBeInTheDocument();
		expect(screen.getByText('3 stages')).toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: 'Start' }));
		await waitFor(() => expect(approveWorkflowPlan).toHaveBeenCalledWith('chat-1'));

		fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
		await waitFor(() => expect(cancelWorkflowRun).toHaveBeenCalledWith('chat-1'));
	});

	it('shows the current stage and each running-stage pip status', () => {
		useGroupChatStore.setState({
			workflowRun: workflowRun({
				status: 'running',
				currentStageIndex: 1,
				stageStatuses: {
					research: 'complete',
					implement: 'running',
					verify: 'pending',
				},
			}),
		});
		renderStrip();

		expect(screen.getByText('Implement')).toBeInTheDocument();
		expect(screen.getByText('Stage 2 of 3')).toBeInTheDocument();
		expect(screen.getByTestId('workflow-stage-pip-research')).toHaveAttribute(
			'data-status',
			'complete'
		);
		expect(screen.getByTestId('workflow-stage-pip-implement')).toHaveAttribute(
			'data-status',
			'running'
		);
		expect(screen.getByTestId('workflow-stage-pip-verify')).toHaveAttribute(
			'data-status',
			'pending'
		);
	});

	it('renders a failed stage with error styling and the abort reason', () => {
		useGroupChatStore.setState({
			workflowRun: workflowRun({
				status: 'aborted',
				currentStageIndex: 1,
				stageStatuses: {
					research: 'complete',
					implement: 'failed',
					verify: 'skipped',
				},
				abortReason: 'Implementation checks failed',
			}),
		});
		renderStrip();

		const strip = screen.getByTestId('workflow-stage-strip');
		const failureLabel = screen.getByText('Workflow failed at Implement:');
		expect(strip).toHaveAttribute('data-status', 'failed');
		expect(failureLabel).toHaveStyle({ color: mockTheme.colors.error });
		expect(screen.getByText('Implementation checks failed')).toBeInTheDocument();
	});

	it('renders the completed workflow summary', () => {
		useGroupChatStore.setState({
			workflowRun: workflowRun({
				status: 'complete',
				currentStageIndex: 2,
				stageStatuses: {
					research: 'complete',
					implement: 'complete',
					verify: 'complete',
				},
			}),
		});
		renderStrip();

		expect(screen.getByText('Workflow complete:')).toHaveStyle({
			color: mockTheme.colors.success,
		});
		expect(screen.getByText('Ship stage progress · 3 stages finished')).toBeInTheDocument();
	});
});
