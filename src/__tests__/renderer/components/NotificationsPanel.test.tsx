import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const loggerMock = vi.hoisted(() => ({
	info: vi.fn(),
	error: vi.fn(),
}));

vi.mock('../../../renderer/utils/logger', () => ({
	logger: loggerMock,
}));

import { NotificationsPanel } from '../../../renderer/components/NotificationsPanel';
import type { Theme } from '../../../renderer/types';

const theme: Theme = {
	id: 'test',
	name: 'Test',
	mode: 'dark',
	colors: {
		bgMain: '#000000',
		bgSidebar: '#111111',
		bgActivity: '#222222',
		border: '#333333',
		textMain: '#ffffff',
		textDim: '#cccccc',
		textFaint: '#999999',
		accent: '#4f46e5',
		accentForeground: '#ffffff',
		buttonBg: '#222222',
		buttonHover: '#333333',
		headerBg: '#111111',
		scrollbarTrack: '#111111',
		scrollbarThumb: '#444444',
		success: '#22c55e',
		warning: '#f59e0b',
		error: '#ef4444',
	},
};

const notificationMocks = {
	show: vi.fn(),
	speak: vi.fn(),
	stopSpeak: vi.fn(),
	onCommandCompleted: vi.fn(),
};

let completionCallbacks: Array<(id: number) => void> = [];

function renderPanel(overrides = {}) {
	return render(
		<NotificationsPanel
			osNotificationsEnabled={true}
			setOsNotificationsEnabled={vi.fn()}
			audioFeedbackEnabled={true}
			setAudioFeedbackEnabled={vi.fn()}
			audioFeedbackCommand="say"
			setAudioFeedbackCommand={vi.fn()}
			toastDuration={5}
			setToastDuration={vi.fn()}
			toastWidth="small"
			setToastWidth={vi.fn()}
			idleNotificationEnabled={false}
			setIdleNotificationEnabled={vi.fn()}
			idleNotificationCommand="say Maestro is idle"
			setIdleNotificationCommand={vi.fn()}
			theme={theme}
			{...overrides}
		/>
	);
}

function customTestButton() {
	return screen.getAllByRole('button', { name: 'Test' })[0];
}

describe('NotificationsPanel', () => {
	beforeEach(() => {
		completionCallbacks = [];
		notificationMocks.show.mockReset();
		notificationMocks.speak.mockReset();
		notificationMocks.stopSpeak.mockReset();
		notificationMocks.onCommandCompleted.mockReset();
		notificationMocks.speak.mockResolvedValue({ success: true, notificationId: 42 });
		notificationMocks.onCommandCompleted.mockImplementation((callback: (id: number) => void) => {
			completionCallbacks.push(callback);
			return vi.fn();
		});
		loggerMock.info.mockClear();
		loggerMock.error.mockClear();
		(window as any).maestro = {
			notification: notificationMocks,
		};
	});

	afterEach(() => {
		cleanup();
		vi.useRealTimers();
		(window as any).maestro = undefined;
	});

	it('shows OS notifications and updates the command input', () => {
		const setAudioFeedbackCommand = vi.fn();
		renderPanel({ setAudioFeedbackCommand });

		fireEvent.click(screen.getByRole('button', { name: 'Test Notification' }));
		fireEvent.change(screen.getByPlaceholderText('say'), { target: { value: 'say -v Alex' } });

		expect(notificationMocks.show).toHaveBeenCalledWith(
			'Maestro',
			'Test notification - notifications are working!'
		);
		expect(setAudioFeedbackCommand).toHaveBeenCalledWith('say -v Alex');
	});

	it('keeps the stop control until the matching notification command completes', async () => {
		renderPanel();

		fireEvent.click(customTestButton());

		expect(await screen.findByRole('button', { name: 'Stop' })).toBeInTheDocument();
		expect(completionCallbacks).toHaveLength(1);

		act(() => {
			completionCallbacks[0](41);
		});

		expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument();

		act(() => {
			completionCallbacks[0](42);
		});

		expect(await screen.findByRole('button', { name: 'Success' })).toBeInTheDocument();
		expect(loggerMock.info).toHaveBeenCalledWith(
			'[Notification] Command completed, id:',
			undefined,
			42
		);
	});

	it('stops a running notification command and returns to the idle test state', async () => {
		renderPanel();

		fireEvent.click(customTestButton());
		fireEvent.click(await screen.findByRole('button', { name: 'Stop' }));

		await waitFor(() => {
			expect(notificationMocks.stopSpeak).toHaveBeenCalledWith(42);
		});
		expect(customTestButton()).toBeInTheDocument();
	});

	it('still resets the running state when stopping the command fails', async () => {
		const stopError = new Error('stop failed');
		notificationMocks.stopSpeak.mockRejectedValueOnce(stopError);
		renderPanel();

		fireEvent.click(customTestButton());
		fireEvent.click(await screen.findByRole('button', { name: 'Stop' }));

		await waitFor(() => {
			expect(notificationMocks.stopSpeak).toHaveBeenCalledWith(42);
		});
		expect(loggerMock.error).toHaveBeenCalledWith(
			'[Notification] Stop error:',
			undefined,
			stopError
		);
		expect(customTestButton()).toBeInTheDocument();
	});

	it('shows the command error returned by the notification bridge', async () => {
		notificationMocks.speak.mockResolvedValueOnce({ success: false, error: 'bad command' });
		renderPanel();

		fireEvent.click(customTestButton());

		expect(await screen.findByRole('button', { name: 'Failed' })).toBeInTheDocument();
		expect(screen.getByText('bad command')).toBeInTheDocument();
	});

	it('falls back when a failed notification result omits an error message', async () => {
		notificationMocks.speak.mockResolvedValueOnce({ success: false });
		renderPanel();

		fireEvent.click(customTestButton());

		expect(await screen.findByRole('button', { name: 'Failed' })).toBeInTheDocument();
		expect(screen.getByText('Command failed')).toBeInTheDocument();
	});

	it('shows rejected notification command errors', async () => {
		const speakError = new Error('speak exploded');
		notificationMocks.speak.mockRejectedValueOnce(speakError);
		renderPanel();

		fireEvent.click(customTestButton());

		expect(await screen.findByRole('button', { name: 'Failed' })).toBeInTheDocument();
		expect(screen.getByText('Error: speak exploded')).toBeInTheDocument();
		expect(loggerMock.error).toHaveBeenCalledWith(
			'[Notification] Speak error:',
			undefined,
			speakError
		);
	});

	it('clears completed test status after the reset delay', async () => {
		vi.useFakeTimers();
		notificationMocks.speak.mockResolvedValueOnce({ success: false, error: 'bad command' });
		renderPanel();

		fireEvent.click(customTestButton());
		await act(async () => {
			await Promise.resolve();
		});

		expect(screen.getByRole('button', { name: 'Failed' })).toBeInTheDocument();
		expect(screen.getByText('bad command')).toBeInTheDocument();

		act(() => {
			vi.advanceTimersByTime(3000);
		});

		expect(customTestButton()).toBeInTheDocument();
		expect(screen.queryByText('bad command')).not.toBeInTheDocument();
	});
});
