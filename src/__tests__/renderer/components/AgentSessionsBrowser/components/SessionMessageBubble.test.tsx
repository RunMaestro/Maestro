import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SessionMessageBubble } from '../../../../../renderer/components/AgentSessionsBrowser/components/SessionMessageBubble';
import type { SessionMessage } from '../../../../../renderer/hooks/agent/useSessionViewer';

vi.mock('../../../../../renderer/components/ToolCallCard', () => ({
	ToolCallCard: ({ toolUse }: { toolUse: any[] }) => (
		<div data-testid="tool-call-card" data-count={toolUse.length} />
	),
}));

const theme = {
	colors: {
		accent: '#7C3AED',
		bgActivity: '#111',
		textMain: '#fff',
		textDim: '#888',
	},
	mode: 'dark',
} as any;

function makeMsg(overrides: Partial<SessionMessage> = {}): SessionMessage {
	return {
		type: 'assistant',
		content: 'test message',
		timestamp: '2024-01-01T12:00:00Z',
		uuid: 'u1',
		...overrides,
	};
}

describe('SessionMessageBubble', () => {
	it('user messages have justify-end class', () => {
		const { container } = render(
			<SessionMessageBubble message={makeMsg({ type: 'user' })} index={0} theme={theme} />
		);
		expect(container.firstChild as HTMLElement).toHaveProperty('className');
		expect((container.firstChild as HTMLElement).className).toContain('justify-end');
	});

	it('assistant messages have justify-start class', () => {
		const { container } = render(
			<SessionMessageBubble message={makeMsg({ type: 'assistant' })} index={0} theme={theme} />
		);
		expect((container.firstChild as HTMLElement).className).toContain('justify-start');
	});

	it('renders ToolCallCard when toolUse has items', () => {
		render(
			<SessionMessageBubble
				message={makeMsg({ toolUse: [{ name: 'bash' }] })}
				index={0}
				theme={theme}
			/>
		);
		expect(screen.getByTestId('tool-call-card')).toBeTruthy();
	});

	it('renders text content when toolUse is undefined', () => {
		render(
			<SessionMessageBubble
				message={makeMsg({ content: 'hello world', toolUse: undefined })}
				index={0}
				theme={theme}
			/>
		);
		expect(screen.getByText('hello world')).toBeTruthy();
	});

	it('renders text content when toolUse is empty array', () => {
		render(
			<SessionMessageBubble
				message={makeMsg({ content: 'empty tools', toolUse: [] })}
				index={0}
				theme={theme}
			/>
		);
		expect(screen.getByText('empty tools')).toBeTruthy();
	});

	it('shows [No content] fallback when content is empty', () => {
		render(<SessionMessageBubble message={makeMsg({ content: '' })} index={0} theme={theme} />);
		expect(screen.getByText('[No content]')).toBeTruthy();
	});

	it('has whitespace-pre-wrap class on message text', () => {
		const { container } = render(
			<SessionMessageBubble message={makeMsg({ content: 'test' })} index={0} theme={theme} />
		);
		expect(container.innerHTML).toContain('whitespace-pre-wrap');
	});
});
