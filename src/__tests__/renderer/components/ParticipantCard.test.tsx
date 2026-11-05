import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ParticipantCard } from '../../../renderer/components/ParticipantCard';
import type { GroupChatParticipant } from '../../../shared/group-chat-types';
import { mockTheme } from '../../helpers/mockTheme';

vi.mock('../../../renderer/stores/notificationStore', () => ({ notifyToast: vi.fn() }));
vi.mock('../../../renderer/utils/logger', () => ({ logger: { error: vi.fn() } }));

beforeEach(() => vi.clearAllMocks());
afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

// GroupChatRightPanel uses this same card for its synthetic Moderator participant.
describe.each(['Alice', 'Moderator'])('ParticipantCard context for %s', (name) => {
	const participant: GroupChatParticipant = {
		name,
		agentId: 'grok',
		sessionId: `group-chat-fixture-${name}`,
		addedAt: 0,
		totalCost: 1.25,
	};

	it.each([undefined, -1, -2, -0.5, NaN, Infinity, -Infinity])(
		'shows unavailable context %s without a percentage or gauge fill',
		(contextUsage) => {
			render(
				<ParticipantCard
					theme={mockTheme}
					participant={{ ...participant, contextUsage }}
					state="idle"
				/>
			);
			expect(screen.getByText('Unavailable')).toBeInTheDocument();
			expect(screen.queryByText(/%/)).not.toBeInTheDocument();
			const gauge = screen.getByText('Context').parentElement!.nextElementSibling!;
			expect(gauge).toBeEmptyDOMElement();
			expect(screen.getByTitle('Total cost')).toHaveTextContent('1.25');
			expect(screen.getByRole('button', { name: 'Peek' })).toBeEnabled();
		}
	);

	it.each([0, 37, 85])('keeps measured %s%% and its gauge', (contextUsage) => {
		render(
			<ParticipantCard
				theme={mockTheme}
				participant={{ ...participant, contextUsage }}
				state="idle"
			/>
		);
		expect(screen.getByText(`${contextUsage}%`)).toBeInTheDocument();
		expect(screen.queryByText('Unavailable')).not.toBeInTheDocument();
		const gauge = screen.getByText('Context').parentElement!.nextElementSibling!;
		expect(gauge.childElementCount).toBe(1);
		expect(gauge.firstElementChild).toHaveStyle({ width: `${contextUsage}%` });
		expect(screen.getByTitle('Total cost')).toHaveTextContent('1.25');
	});

	it('clears an old measurement and restores later zero and positive observations', () => {
		const { rerender } = render(
			<ParticipantCard
				theme={mockTheme}
				participant={{ ...participant, contextUsage: 52 }}
				state="busy"
			/>
		);
		expect(screen.getByText('52%')).toBeInTheDocument();

		for (const contextUsage of [-2, -1, 0, 23]) {
			rerender(
				<ParticipantCard
					theme={mockTheme}
					participant={{ ...participant, contextUsage, totalCost: 2.5 }}
					state="idle"
				/>
			);
			expect(screen.queryByText('52%')).not.toBeInTheDocument();
			expect(screen.getByTitle('Total cost')).toHaveTextContent('2.50');
			const gauge = screen.getByText('Context').parentElement!.nextElementSibling!;
			if (contextUsage < 0) {
				expect(screen.getByText('Unavailable')).toBeInTheDocument();
				expect(screen.queryByText(/%/)).not.toBeInTheDocument();
				expect(gauge).toBeEmptyDOMElement();
			} else {
				expect(screen.getByText(`${contextUsage}%`)).toBeInTheDocument();
				expect(screen.queryByText('Unavailable')).not.toBeInTheDocument();
				expect(gauge.firstElementChild).toHaveStyle({ width: `${contextUsage}%` });
			}
		}
	});
});

describe('ParticipantCard controls', () => {
	it.each([0, -2])('keeps participant actions usable with context %s', async (contextUsage) => {
		const onContextReset = vi.fn().mockResolvedValue(undefined);
		const onRemove = vi.fn().mockResolvedValue(true);
		render(
			<ParticipantCard
				theme={mockTheme}
				participant={{
					name: 'Alice',
					agentId: 'grok',
					sessionId: 'group-chat-fixture-Alice',
					agentSessionId: 'abcdef12-3456-7890-abcd-ef1234567890',
					addedAt: 0,
					contextUsage,
					messageCount: 3,
					totalCost: 1.25,
				}}
				state="busy"
				groupChatId="group-chat-fixture"
				onContextReset={onContextReset}
				onRemove={onRemove}
				liveOutput="Synthetic participant output"
			/>
		);
		expect(screen.getByTitle('Working')).toBeInTheDocument();
		expect(screen.getByTitle('Messages sent')).toHaveTextContent('3');
		expect(screen.getByRole('button', { name: 'ABCDEF12' })).toBeEnabled();
		expect(screen.getByTitle('Total cost')).toHaveTextContent('1.25');

		fireEvent.click(screen.getByRole('button', { name: 'Peek' }));
		expect(screen.getByText('Synthetic participant output')).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'Peek' }));
		expect(screen.queryByText('Synthetic participant output')).not.toBeInTheDocument();

		await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Reset' })));
		expect(onContextReset).toHaveBeenCalledExactlyOnceWith('Alice');
		expect(screen.getByRole('button', { name: 'Reset' })).toBeEnabled();

		fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
		expect(onRemove).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
		expect(onRemove).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
		await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Confirm' })));
		expect(onRemove).toHaveBeenCalledExactlyOnceWith('Alice');
		expect(screen.queryByRole('button', { name: 'Confirm' })).not.toBeInTheDocument();
	});
});
