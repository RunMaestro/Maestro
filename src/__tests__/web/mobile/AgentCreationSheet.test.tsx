import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentCreationSheet } from '../../../web/mobile/AgentCreationSheet';

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

const groups = [
	{ id: 'group-1', name: 'Core Team' },
	{ id: 'group-2', name: 'Docs' },
] as any;

function renderSheet(overrides: Partial<Parameters<typeof AgentCreationSheet>[0]> = {}) {
	const props = {
		groups,
		defaultCwd: '/Users/jeff/project',
		createAgent: vi.fn().mockResolvedValue({ sessionId: 'new-session' }),
		onCreated: vi.fn(),
		onClose: vi.fn(),
		...overrides,
	};

	const view = render(<AgentCreationSheet {...props} />);
	return { ...view, props };
}

describe('AgentCreationSheet', () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.clearAllMocks();
	});

	it('creates a selected agent type in a selected group and closes after success', async () => {
		vi.useFakeTimers();
		const { props } = renderSheet();

		fireEvent.click(screen.getByRole('button', { name: 'Select Codex' }));
		fireEvent.change(screen.getByPlaceholderText('Codex'), { target: { value: 'Build Bot' } });
		fireEvent.focus(screen.getByDisplayValue('/Users/jeff/project'));
		fireEvent.change(screen.getByDisplayValue('/Users/jeff/project'), {
			target: { value: '/tmp/maestro' },
		});
		fireEvent.blur(screen.getByDisplayValue('/tmp/maestro'));
		fireEvent.click(screen.getByRole('button', { name: 'Core Team' }));

		await act(async () => {
			fireEvent.click(screen.getByRole('button', { name: 'Create Agent' }));
			await Promise.resolve();
		});

		expect(props.createAgent).toHaveBeenCalledWith('Build Bot', 'codex', '/tmp/maestro', 'group-1');
		expect(props.onCreated).toHaveBeenCalledWith('new-session');
		expect(hapticMocks.triggerHaptic).toHaveBeenCalledWith(hapticMocks.HAPTIC_PATTERNS.send);
		expect(hapticMocks.triggerHaptic).toHaveBeenCalledWith(hapticMocks.HAPTIC_PATTERNS.success);

		act(() => {
			vi.advanceTimersByTime(300);
		});
		expect(props.onClose).toHaveBeenCalledTimes(1);
	});

	it('uses the selected default name and recovers when creation returns null', async () => {
		const createAgent = vi.fn().mockResolvedValue(null);
		renderSheet({ createAgent });

		fireEvent.click(screen.getByRole('button', { name: 'Select Factory Droid' }));
		fireEvent.change(screen.getByDisplayValue('/Users/jeff/project'), { target: { value: '' } });
		expect(screen.getByRole('button', { name: 'Create Agent' })).toBeDisabled();
		expect(createAgent).not.toHaveBeenCalled();

		fireEvent.change(screen.getByPlaceholderText('/path/to/project'), {
			target: { value: '/repo' },
		});

		await act(async () => {
			fireEvent.click(screen.getByRole('button', { name: 'Create Agent' }));
			await Promise.resolve();
		});

		expect(createAgent).toHaveBeenCalledWith('Factory Droid', 'factory-droid', '/repo', undefined);
		expect(screen.getByRole('button', { name: 'Create Agent' })).not.toBeDisabled();
		expect(hapticMocks.triggerHaptic).toHaveBeenCalledWith(hapticMocks.HAPTIC_PATTERNS.error);
	});

	it('closes from the backdrop, Escape, and close button', () => {
		vi.useFakeTimers();
		const { container, props, unmount } = renderSheet();

		fireEvent.click(container.firstElementChild as Element);
		act(() => {
			vi.advanceTimersByTime(300);
		});
		expect(props.onClose).toHaveBeenCalledTimes(1);

		unmount();
		const escape = renderSheet();
		fireEvent.keyDown(document, { key: 'Escape' });
		act(() => {
			vi.advanceTimersByTime(300);
		});
		expect(escape.props.onClose).toHaveBeenCalledTimes(1);

		escape.unmount();
		const closeButton = renderSheet();
		fireEvent.click(screen.getByRole('button', { name: 'Close creation sheet' }));
		act(() => {
			vi.advanceTimersByTime(300);
		});
		expect(closeButton.props.onClose).toHaveBeenCalledTimes(1);
	});
});
