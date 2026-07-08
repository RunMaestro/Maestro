import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ParticipantCard } from '../../renderer/components/ParticipantCard';
import { safeClipboardWrite } from '../../renderer/utils/clipboard';
import { formatTimestamp } from '../../shared/formatters';
import type { GroupChatParticipant, Theme } from '../../renderer/types';

vi.mock('../../renderer/utils/clipboard', () => ({
	safeClipboardWrite: vi.fn(),
}));

const now = new Date('2026-05-13T14:00:00Z').getTime();

const testTheme: Theme = {
	id: 'test-theme',
	name: 'Test Theme',
	mode: 'dark',
	colors: {
		bgMain: '#1e1e1e',
		bgSidebar: '#252526',
		bgActivity: '#333333',
		textMain: '#d4d4d4',
		textDim: '#808080',
		accent: '#007acc',
		accentForeground: '#ffffff',
		border: '#404040',
		error: '#f14c4c',
		warning: '#cca700',
		success: '#89d185',
		info: '#3794ff',
		textInverse: '#000000',
	},
};

type ParticipantCardProps = ComponentProps<typeof ParticipantCard>;

const createParticipant = (
	overrides: Partial<GroupChatParticipant> = {}
): GroupChatParticipant => ({
	name: 'Claude Agent',
	agentId: 'claude-code',
	sessionId: 'process-session',
	agentSessionId: 'abc12345-session-guid',
	addedAt: now - 600000,
	contextUsage: 42,
	...overrides,
});

const createProps = (overrides: Partial<ParticipantCardProps> = {}): ParticipantCardProps => ({
	theme: testTheme,
	participant: createParticipant(),
	state: 'idle',
	...overrides,
});

const renderCard = (overrides: Partial<ParticipantCardProps> = {}) => {
	return render(<ParticipantCard {...createProps(overrides)} />);
};

describe('ParticipantCard', () => {
	beforeEach(() => {
		vi.spyOn(Date, 'now').mockReturnValue(now);
		vi.mocked(safeClipboardWrite).mockResolvedValue(true);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.clearAllMocks();
	});

	it('renders pending participants with default context and no action controls', () => {
		renderCard({
			participant: createParticipant({
				agentSessionId: undefined,
				contextUsage: undefined,
				messageCount: 0,
			}),
			state: 'waiting_input',
		});

		expect(screen.getByText('Claude Agent')).toBeInTheDocument();
		expect(screen.getByTitle('Idle')).toBeInTheDocument();
		expect(screen.getByText('pending')).toBeInTheDocument();
		expect(screen.getByText('claude-code')).toBeInTheDocument();
		expect(screen.getByText('0%')).toBeInTheDocument();
		expect(screen.queryByTitle(/Session:/)).not.toBeInTheDocument();
		expect(screen.queryByRole('button', { name: 'Reset' })).not.toBeInTheDocument();
		expect(screen.queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument();
	});

	it('requires a group chat id before showing group chat action controls', () => {
		renderCard({
			onContextReset: vi.fn(),
			onRemove: vi.fn(),
		});

		expect(screen.queryByRole('button', { name: 'Reset' })).not.toBeInTheDocument();
		expect(screen.queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument();
	});

	it('renders status, SSH, session, activity, context, and cost details', () => {
		renderCard({
			participant: createParticipant({
				sshRemoteName: 'build-box',
				messageCount: 3,
				lastActivity: now - 5 * 60 * 1000,
				contextUsage: 88,
				totalCost: 0.25,
			}),
			state: 'busy',
			color: '#ff00aa',
		});

		expect(screen.getByTitle('Working')).toHaveClass('animate-pulse');
		expect(screen.getByTitle('SSH Remote: build-box')).toBeInTheDocument();
		expect(screen.getByText('build-box')).toBeInTheDocument();
		expect(screen.getByText('ABC12345')).toBeInTheDocument();
		expect(screen.getByTitle('Messages sent')).toHaveTextContent('3');
		expect(screen.getByTitle('Last activity')).toHaveTextContent('5m ago');
		expect(screen.getByText((_, element) => element?.textContent === '88%')).toBeInTheDocument();
		expect(screen.getByTitle('Total cost')).toHaveTextContent('0.25');
	});

	it('renders connecting and error status labels', () => {
		const { rerender } = renderCard({ state: 'connecting' });

		expect(screen.getByTitle('Connecting')).toHaveClass('animate-pulse');

		rerender(<ParticipantCard {...createProps({ state: 'error' })} />);

		expect(screen.getByTitle('Error')).not.toHaveClass('animate-pulse');
	});

	it('formats recent and older activity timestamps', () => {
		const recentParticipant = createParticipant({ lastActivity: now - 30000 });
		const { rerender } = renderCard({ participant: recentParticipant });

		expect(screen.getByTitle('Last activity')).toHaveTextContent('just now');

		const oldTimestamp = now - 2 * 60 * 60 * 1000;
		rerender(
			<ParticipantCard
				{...createProps({
					participant: createParticipant({ lastActivity: oldTimestamp }),
				})}
			/>
		);

		expect(screen.getByTitle('Last activity')).toHaveTextContent(
			formatTimestamp(oldTimestamp, 'time')
		);
	});

	it('copies the agent session id and resets copy feedback', async () => {
		const originalSetTimeout = globalThis.setTimeout;
		let resetCopyFeedback: (() => void) | undefined;
		const timeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation((handler, timeout) => {
			if (timeout === 2000 && typeof handler === 'function') {
				resetCopyFeedback = handler as () => void;
				return 0 as ReturnType<typeof setTimeout>;
			}
			return originalSetTimeout(handler, timeout);
		});
		renderCard();

		fireEvent.click(screen.getByTitle(/Session:/));

		await waitFor(() => {
			expect(safeClipboardWrite).toHaveBeenCalledWith('abc12345-session-guid');
		});
		expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 2000);
		await waitFor(() => expect(screen.getByTestId('check-icon')).toBeInTheDocument());

		act(() => {
			resetCopyFeedback?.();
		});

		expect(screen.queryByTestId('check-icon')).not.toBeInTheDocument();
	});

	it('runs context reset and shows the resetting state while pending', async () => {
		let resolveReset: () => void = () => {};
		const onContextReset = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					resolveReset = resolve;
				})
		);
		renderCard({ groupChatId: 'group-1', onContextReset });

		fireEvent.click(screen.getByRole('button', { name: 'Reset' }));

		expect(onContextReset).toHaveBeenCalledWith('Claude Agent');
		expect(screen.getByText('Resetting...')).toBeInTheDocument();
		expect(screen.queryByRole('button', { name: 'Reset' })).not.toBeInTheDocument();

		await act(async () => {
			resolveReset();
		});

		await waitFor(() => {
			expect(screen.getByRole('button', { name: 'Reset' })).toBeInTheDocument();
		});
	});

	it('confirms, cancels, and runs participant removal', async () => {
		let resolveRemove: () => void = () => {};
		const onRemove = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					resolveRemove = resolve;
				})
		);
		renderCard({ groupChatId: 'group-1', onRemove });

		fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
		expect(screen.getByRole('button', { name: 'Confirm' })).toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
		expect(screen.queryByRole('button', { name: 'Confirm' })).not.toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
		fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

		expect(onRemove).toHaveBeenCalledWith('Claude Agent');
		expect(screen.getByText('Removing...')).toBeInTheDocument();

		await act(async () => {
			resolveRemove();
		});

		await waitFor(() => {
			expect(screen.getByRole('button', { name: 'Remove' })).toBeInTheDocument();
		});
	});

	it('hides an open remove confirmation if group chat actions disappear', () => {
		const { rerender } = renderCard({ groupChatId: 'group-1', onRemove: vi.fn() });

		fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
		expect(screen.getByRole('button', { name: 'Confirm' })).toBeInTheDocument();

		rerender(<ParticipantCard {...createProps({ groupChatId: undefined, onRemove: undefined })} />);

		expect(screen.queryByRole('button', { name: 'Confirm' })).not.toBeInTheDocument();
		expect(screen.queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument();
	});

	it('toggles peek output and displays the empty-output fallback', () => {
		renderCard();

		fireEvent.click(screen.getByRole('button', { name: 'Peek' }));

		expect(screen.getByText('(no live output yet)')).toBeInTheDocument();
		expect(screen.getByTestId('eyeoff-icon')).toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: 'Peek' }));

		expect(screen.queryByText('(no live output yet)')).not.toBeInTheDocument();
		expect(screen.getByTestId('eye-icon')).toBeInTheDocument();
	});

	it('shows short live output and truncates long live output from the end', () => {
		const { rerender } = renderCard({ liveOutput: 'line one\nline two' });

		fireEvent.click(screen.getByRole('button', { name: 'Peek' }));

		expect(screen.getByText(/line one/).textContent).toBe('line one\nline two');

		const longOutput = `start-${'x'.repeat(50050)}TAIL`;
		rerender(<ParticipantCard {...createProps({ liveOutput: longOutput })} />);

		const peek = screen.getByText(/TAIL$/);
		expect(peek).not.toHaveTextContent('start-');
		expect(peek.textContent?.endsWith('TAIL')).toBe(true);
	});
});
