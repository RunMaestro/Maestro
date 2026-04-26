import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { SidebarActions } from '../../../renderer/components/SessionList/SidebarActions';
import { useFeedbackDraftStore } from '../../../renderer/stores/feedbackDraftStore';
import type { Theme, Shortcut } from '../../../renderer/types';

const theme: Theme = {
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
		info: '#3b82f6',
		bgAccentHover: '#6d28d9',
	},
};

const shortcuts = {
	toggleSidebar: { keys: ['Meta', 'b'] },
} as Record<string, Shortcut>;

describe('SidebarActions', () => {
	afterEach(() => {
		useFeedbackDraftStore.getState().reset();
	});

	it('renders feedback button next to new agent when sidebar is open', () => {
		render(
			<SidebarActions
				theme={theme}
				leftSidebarOpen={true}
				hasNoSessions={false}
				shortcuts={shortcuts}
				showUnreadAgentsOnly={false}
				hasUnreadAgents={false}
				addNewSession={vi.fn()}
				openFeedback={vi.fn()}
				setLeftSidebarOpen={vi.fn()}
				toggleShowUnreadAgentsOnly={vi.fn()}
			/>
		);

		expect(screen.getByRole('button', { name: /new agent/i })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: /feedback/i })).toBeInTheDocument();
	});

	it('opens feedback modal from the sidebar button', () => {
		const openFeedback = vi.fn();

		render(
			<SidebarActions
				theme={theme}
				leftSidebarOpen={true}
				hasNoSessions={false}
				shortcuts={shortcuts}
				showUnreadAgentsOnly={false}
				hasUnreadAgents={false}
				addNewSession={vi.fn()}
				openFeedback={openFeedback}
				setLeftSidebarOpen={vi.fn()}
				toggleShowUnreadAgentsOnly={vi.fn()}
			/>
		);

		fireEvent.click(screen.getByRole('button', { name: /feedback/i }));

		expect(openFeedback).toHaveBeenCalledTimes(1);
	});

	it('shows a pencil indicator on the feedback button when a draft is minimized', () => {
		useFeedbackDraftStore.getState().setMinimized(true);

		render(
			<SidebarActions
				theme={theme}
				leftSidebarOpen={true}
				hasNoSessions={false}
				shortcuts={shortcuts}
				showUnreadAgentsOnly={false}
				hasUnreadAgents={false}
				addNewSession={vi.fn()}
				openFeedback={vi.fn()}
				setLeftSidebarOpen={vi.fn()}
				toggleShowUnreadAgentsOnly={vi.fn()}
			/>
		);

		expect(screen.getByLabelText('Feedback draft in progress')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: /feedback/i })).toHaveAttribute(
			'title',
			'Resume feedback draft'
		);
	});
});
