import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NotificationSettingsSheet } from '../../../web/mobile/NotificationSettingsSheet';
import type { NotificationPreferences } from '../../../web/hooks/useNotifications';

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

const preferences: NotificationPreferences = {
	agentComplete: true,
	agentError: false,
	autoRunComplete: true,
	autoRunTaskComplete: false,
	contextWarning: true,
	soundEnabled: false,
};

function renderSheet(overrides: Partial<Parameters<typeof NotificationSettingsSheet>[0]> = {}) {
	const props = {
		preferences,
		onPreferencesChange: vi.fn(),
		permission: 'default' as const,
		onClose: vi.fn(),
		...overrides,
	};

	const view = render(<NotificationSettingsSheet {...props} />);
	return { ...view, props };
}

describe('NotificationSettingsSheet', () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
		vi.clearAllMocks();
	});

	it('requests permission and toggles event and sound preferences', async () => {
		const requestPermission = vi.fn().mockResolvedValue('granted');
		vi.stubGlobal('Notification', { requestPermission });
		const { props } = renderSheet();

		expect(screen.getByText('Not Set')).toBeInTheDocument();
		await act(async () => {
			fireEvent.click(screen.getByRole('button', { name: 'Enable notifications' }));
			await Promise.resolve();
		});
		expect(requestPermission).toHaveBeenCalledTimes(1);

		fireEvent.click(screen.getByRole('switch', { name: 'Agent Complete' }));
		fireEvent.click(screen.getByRole('switch', { name: 'Agent Error' }));
		fireEvent.click(screen.getByRole('switch', { name: 'Play sound with notifications' }));

		expect(props.onPreferencesChange).toHaveBeenCalledWith({ agentComplete: false });
		expect(props.onPreferencesChange).toHaveBeenCalledWith({ agentError: true });
		expect(props.onPreferencesChange).toHaveBeenCalledWith({ soundEnabled: true });
		expect(hapticMocks.triggerHaptic).toHaveBeenCalledWith(hapticMocks.HAPTIC_PATTERNS.tap);
	});

	it('renders granted and denied permission states', () => {
		const { rerender, props } = renderSheet({ permission: 'granted' });

		expect(screen.getByText('Enabled')).toBeInTheDocument();
		expect(screen.queryByRole('button', { name: 'Enable notifications' })).not.toBeInTheDocument();

		rerender(<NotificationSettingsSheet {...props} permission="denied" />);

		expect(screen.getByText('Blocked')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Enable notifications' })).toBeDisabled();
		expect(screen.getByText('Blocked — Enable in Browser Settings')).toBeInTheDocument();
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
		fireEvent.click(screen.getByRole('button', { name: 'Close notification settings' }));
		act(() => {
			vi.advanceTimersByTime(300);
		});
		expect(closeButton.props.onClose).toHaveBeenCalledTimes(1);
	});
});
