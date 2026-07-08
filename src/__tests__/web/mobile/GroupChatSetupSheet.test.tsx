import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GroupChatSetupSheet } from '../../../web/mobile/GroupChatSetupSheet';

const mockColors = {
	bgMain: '#0b0b0d',
	bgSidebar: '#111113',
	bgActivity: '#1c1c1f',
	border: '#27272a',
	textMain: '#e4e4e7',
	textDim: '#a1a1aa',
	accent: '#6366f1',
	accentDim: 'rgba(99, 102, 241, 0.2)',
	accentText: '#a5b4fc',
	success: '#22c55e',
	warning: '#eab308',
	error: '#ef4444',
};

const hapticMocks = vi.hoisted(() => ({
	triggerHaptic: vi.fn(),
	HAPTIC_PATTERNS: {
		tap: [10],
		send: [10, 30, 10],
		success: [10, 50, 20],
		error: [100, 30, 100, 30, 100],
	},
}));

vi.mock('../../../web/components/ThemeProvider', () => ({
	useThemeColors: () => mockColors,
}));

vi.mock('../../../web/mobile/constants', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../../web/mobile/constants')>();
	return {
		...actual,
		...hapticMocks,
	};
});

const sessions = [
	{ id: 'session-1', name: 'Alpha', toolType: 'codex', status: 'idle' },
	{ id: 'session-2', name: 'Beta', toolType: 'claude-code', status: 'idle' },
	{ id: 'session-3', name: 'Gamma', toolType: 'terminal', status: 'idle' },
] as any;

function renderSheet(overrides: Partial<Parameters<typeof GroupChatSetupSheet>[0]> = {}) {
	const props = {
		sessions,
		onStart: vi.fn(),
		onClose: vi.fn(),
		...overrides,
	};

	const view = render(<GroupChatSetupSheet {...props} />);
	return { ...view, props };
}

function participantButton(name: string) {
	return screen.getByText(name).closest('button') as HTMLButtonElement;
}

describe('GroupChatSetupSheet', () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.clearAllMocks();
	});

	it('starts a group chat with a trimmed topic and at least two participants', () => {
		vi.useFakeTimers();
		const { props } = renderSheet();
		const startButton = screen.getByRole('button', { name: 'Start Group Chat' });

		expect(startButton).toBeDisabled();
		fireEvent.change(screen.getByPlaceholderText('What should the agents discuss?'), {
			target: { value: '  Plan release  ' },
		});
		fireEvent.focus(screen.getByPlaceholderText('What should the agents discuss?'));
		fireEvent.blur(screen.getByPlaceholderText('What should the agents discuss?'));

		fireEvent.click(participantButton('Alpha'));
		expect(screen.getByText('1 agent selected — select at least 2')).toBeInTheDocument();
		expect(startButton).toBeDisabled();

		fireEvent.click(participantButton('Beta'));
		expect(screen.getByText('2 agents selected')).toBeInTheDocument();
		expect(startButton).not.toBeDisabled();

		fireEvent.click(participantButton('Alpha'));
		expect(startButton).toBeDisabled();
		fireEvent.click(participantButton('Alpha'));

		fireEvent.click(startButton);

		expect(props.onStart).toHaveBeenCalledWith(
			'Plan release',
			expect.arrayContaining(['session-1', 'session-2'])
		);
		expect(hapticMocks.triggerHaptic).toHaveBeenCalledWith(hapticMocks.HAPTIC_PATTERNS.send);
		act(() => {
			vi.advanceTimersByTime(300);
		});
		expect(props.onClose).toHaveBeenCalledTimes(1);
	});

	it('renders an empty state and closes from the backdrop', () => {
		vi.useFakeTimers();
		const { container, props } = renderSheet({ sessions: [] as any });

		expect(screen.getByText('No agents available')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Start Group Chat' })).toBeDisabled();

		fireEvent.click(container.firstElementChild as Element);
		act(() => {
			vi.advanceTimersByTime(300);
		});
		expect(props.onClose).toHaveBeenCalledTimes(1);
	});

	it('closes from Escape and the close button', () => {
		vi.useFakeTimers();
		const escape = renderSheet();

		fireEvent.keyDown(document, { key: 'Escape' });
		act(() => {
			vi.advanceTimersByTime(300);
		});
		expect(escape.props.onClose).toHaveBeenCalledTimes(1);

		escape.unmount();
		const closeButton = renderSheet();
		fireEvent.click(screen.getByRole('button', { name: 'Close setup sheet' }));
		act(() => {
			vi.advanceTimersByTime(300);
		});
		expect(closeButton.props.onClose).toHaveBeenCalledTimes(1);
	});
});
