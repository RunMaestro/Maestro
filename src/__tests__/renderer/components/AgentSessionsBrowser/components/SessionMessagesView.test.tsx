import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SessionMessagesView } from '../../../../../renderer/components/AgentSessionsBrowser/components/SessionMessagesView';
import type { SessionMessage } from '../../../../../renderer/hooks/agent/useSessionViewer';

vi.mock(
	'../../../../../renderer/components/AgentSessionsBrowser/components/SessionMessageBubble',
	() => ({
		SessionMessageBubble: ({ message }: { message: SessionMessage }) => (
			<div data-testid="message-bubble" data-id={message.uuid} />
		),
	})
);

vi.mock('../../../../../renderer/components/ui/Spinner', () => ({
	Spinner: () => <div data-testid="spinner" />,
}));

const theme = {
	colors: { textDim: '#888', accent: '#7C3AED' },
} as any;

function makeMsg(uuid: string): SessionMessage {
	return {
		type: 'user',
		content: 'hello',
		timestamp: '2024-01-01T00:00:00Z',
		uuid,
	};
}

function defaultProps(overrides: any = {}) {
	return {
		messages: [],
		messagesLoading: false,
		hasMoreMessages: false,
		theme,
		messagesContainerRef: { current: null } as any,
		onScroll: vi.fn(),
		onKeyDown: vi.fn(),
		handleLoadMore: vi.fn(),
		...overrides,
	};
}

describe('SessionMessagesView', () => {
	it('renders container with role=region and aria-label', () => {
		render(<SessionMessagesView {...defaultProps()} />);
		expect(screen.getByRole('region', { name: 'Session messages' })).toBeTruthy();
	});

	it('has tabIndex=0 on container', () => {
		render(<SessionMessagesView {...defaultProps()} />);
		const region = screen.getByRole('region');
		expect(region.getAttribute('tabindex')).toBe('0');
	});

	it('shows Load more button when hasMoreMessages and not loading', () => {
		render(
			<SessionMessagesView {...defaultProps({ hasMoreMessages: true, messagesLoading: false })} />
		);
		expect(screen.getByText('Load earlier messages...')).toBeTruthy();
	});

	it('shows spinner instead of Load more button when messagesLoading', () => {
		render(
			<SessionMessagesView {...defaultProps({ hasMoreMessages: true, messagesLoading: true })} />
		);
		expect(screen.queryByText('Load earlier messages...')).toBeNull();
	});

	it('calls handleLoadMore when Load more button is clicked', () => {
		const handleLoadMore = vi.fn();
		render(
			<SessionMessagesView
				{...defaultProps({ hasMoreMessages: true, messagesLoading: false, handleLoadMore })}
			/>
		);
		fireEvent.click(screen.getByText('Load earlier messages...'));
		expect(handleLoadMore).toHaveBeenCalled();
	});

	it('renders one bubble per message', () => {
		const messages = [makeMsg('u1'), makeMsg('u2'), makeMsg('u3')];
		render(<SessionMessagesView {...defaultProps({ messages })} />);
		expect(screen.getAllByTestId('message-bubble')).toHaveLength(3);
	});

	it('shows spinner when messages empty and messagesLoading', () => {
		render(<SessionMessagesView {...defaultProps({ messages: [], messagesLoading: true })} />);
		expect(screen.getByTestId('spinner')).toBeTruthy();
	});

	it('forwards onScroll handler', () => {
		const onScroll = vi.fn();
		render(<SessionMessagesView {...defaultProps({ onScroll })} />);
		const region = screen.getByRole('region');
		fireEvent.scroll(region);
		expect(onScroll).toHaveBeenCalled();
	});

	it('forwards onKeyDown handler', () => {
		const onKeyDown = vi.fn();
		render(<SessionMessagesView {...defaultProps({ onKeyDown })} />);
		const region = screen.getByRole('region');
		fireEvent.keyDown(region, { key: 'Escape' });
		expect(onKeyDown).toHaveBeenCalled();
	});
});
