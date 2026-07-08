import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LeaderboardRegistrationModal } from '../../renderer/components/LeaderboardRegistrationModal';
import { LayerStackProvider } from '../../renderer/contexts/LayerStackContext';
import type {
	AutoRunStats,
	KeyboardMasteryStats,
	LeaderboardRegistration,
	Theme,
} from '../../renderer/types';

const theme: Theme = {
	id: 'midnight',
	name: 'Midnight',
	mode: 'dark',
	colors: {
		bgMain: '#111827',
		bgSidebar: '#1f2937',
		bgActivity: '#374151',
		border: '#4b5563',
		textMain: '#f9fafb',
		textDim: '#9ca3af',
		accent: '#38bdf8',
		accentDim: '#38bdf833',
		accentText: '#f9fafb',
		accentForeground: '#111827',
		success: '#22c55e',
		warning: '#f59e0b',
		error: '#ef4444',
	},
};

const autoRunStats: AutoRunStats = {
	cumulativeTimeMs: 7_500_000,
	longestRunMs: 3_600_000,
	longestRunTimestamp: Date.UTC(2026, 0, 15),
	totalRuns: 12,
	currentBadgeLevel: 3,
	lastBadgeUnlockLevel: 2,
	lastAcknowledgedBadgeLevel: 2,
	badgeHistory: [],
};

const keyboardMasteryStats: KeyboardMasteryStats = {
	usedShortcuts: ['command-palette', 'new-session', 'close-tab'],
	currentLevel: 1,
	lastLevelUpTimestamp: Date.UTC(2026, 0, 1),
	lastAcknowledgedLevel: 1,
};

const existingRegistration: LeaderboardRegistration = {
	email: 'conductor@example.com',
	displayName: 'Conductor',
	githubUsername: 'oldhub',
	registeredAt: Date.UTC(2026, 0, 1),
	emailConfirmed: true,
	clientToken: 'existing-client-token',
	authToken: 'existing-auth-token',
};

function renderModal(
	options: {
		registration?: LeaderboardRegistration | null;
		stats?: AutoRunStats;
		keyboardStats?: KeyboardMasteryStats;
		onClose?: ReturnType<typeof vi.fn>;
		onSave?: ReturnType<typeof vi.fn>;
		onOptOut?: ReturnType<typeof vi.fn>;
		onSyncStats?: ReturnType<typeof vi.fn>;
	} = {}
) {
	const onClose = options.onClose ?? vi.fn();
	const onSave = options.onSave ?? vi.fn();
	const onOptOut = options.onOptOut ?? vi.fn();
	const onSyncStats = options.onSyncStats ?? vi.fn();
	const view = render(
		<LayerStackProvider>
			<LeaderboardRegistrationModal
				theme={theme}
				autoRunStats={options.stats ?? autoRunStats}
				keyboardMasteryStats={options.keyboardStats ?? keyboardMasteryStats}
				existingRegistration={options.registration ?? null}
				onClose={onClose}
				onSave={onSave}
				onOptOut={onOptOut}
				onSyncStats={onSyncStats}
			/>
		</LayerStackProvider>
	);

	return { ...view, onClose, onSave, onOptOut, onSyncStats };
}

function fillRequiredProfile(displayName: string, email: string) {
	fireEvent.change(screen.getByPlaceholderText('ConductorPedram'), {
		target: { value: displayName },
	});
	fireEvent.change(screen.getByPlaceholderText('conductor@maestro.ai'), {
		target: { value: email },
	});
}

describe('LeaderboardRegistrationModal integration', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(window.maestro.leaderboard.submit).mockResolvedValue({
			success: true,
			rank: 7,
		});
		vi.mocked(window.maestro.leaderboard.pollAuthStatus).mockResolvedValue({
			status: 'pending',
		});
		vi.mocked(window.maestro.leaderboard.resendConfirmation).mockResolvedValue({
			success: true,
			message: 'Confirmation email sent',
		});
		vi.mocked(window.maestro.leaderboard.sync).mockResolvedValue({
			success: true,
			found: true,
			data: {
				cumulativeTimeMs: 8_100_000,
				totalRuns: 14,
				badgeLevel: 4,
				longestRunMs: 3_900_000,
				longestRunDate: '2026-01-20',
			},
		});
		vi.mocked(window.maestro.shell.openExternal).mockResolvedValue(undefined);
	});

	afterEach(() => {
		cleanup();
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it('registers a new profile, submits stats, opens the public leaderboard, and closes through the layer stack', async () => {
		const { onClose, onSave } = renderModal();

		expect(screen.getByRole('dialog', { name: 'Register for Leaderboard' })).toHaveAttribute(
			'aria-modal',
			'true'
		);
		expect(screen.getByText('Your Current Stats')).toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: /runmaestro\.ai/i }));
		expect(window.maestro.shell.openExternal).toHaveBeenCalledOnce();
		const openedUrl = new URL(vi.mocked(window.maestro.shell.openExternal).mock.calls[0][0]);
		expect(`${openedUrl.origin}${openedUrl.pathname}`).toBe('https://runmaestro.ai/');
		expect(openedUrl.searchParams.get('theme')).toBeTruthy();

		const submitButton = screen.getByRole('button', { name: /Push Up/i });
		expect(submitButton).toBeDisabled();

		fireEvent.change(screen.getByPlaceholderText('ConductorPedram'), {
			target: { value: '  Ada Maestro  ' },
		});
		fireEvent.change(screen.getByPlaceholderText('conductor@maestro.ai'), {
			target: { value: 'not-an-email' },
		});
		expect(screen.getByText('Please enter a valid email address')).toBeInTheDocument();

		fireEvent.change(screen.getByPlaceholderText('conductor@maestro.ai'), {
			target: { value: 'ada@example.com' },
		});
		const usernameInputs = screen.getAllByPlaceholderText('username');
		fireEvent.change(usernameInputs[0], { target: { value: '@ada-hub' } });
		fireEvent.change(screen.getByPlaceholderText('handle'), { target: { value: '@ada_x' } });
		fireEvent.change(usernameInputs[1], { target: { value: '@ada-linkedin' } });
		fireEvent.change(screen.getByPlaceholderText('username#1234 or username'), {
			target: { value: '@ada#1234' },
		});
		fireEvent.change(screen.getByPlaceholderText('username.bsky.social'), {
			target: { value: '@ada.bsky.social' },
		});

		fireEvent.click(submitButton);

		await waitFor(() =>
			expect(window.maestro.leaderboard.submit).toHaveBeenCalledWith(
				expect.objectContaining({
					email: 'ada@example.com',
					displayName: 'Ada Maestro',
					githubUsername: 'ada-hub',
					twitterHandle: 'ada_x',
					linkedinHandle: 'ada-linkedin',
					discordUsername: 'ada#1234',
					blueskyHandle: 'ada.bsky.social',
					cumulativeTimeMs: autoRunStats.cumulativeTimeMs,
					totalRuns: autoRunStats.totalRuns,
					longestRunDate: '2026-01-15',
					theme: 'midnight',
					clientToken: expect.any(String),
					keyboardMasteryLevel: 2,
					keyboardKeysUnlocked: 3,
				})
			)
		);
		expect(onSave).toHaveBeenCalledWith(
			expect.objectContaining({
				email: 'ada@example.com',
				displayName: 'Ada Maestro',
				emailConfirmed: true,
				clientToken: expect.any(String),
			})
		);
		expect(screen.getByText(/Profile submitted!/)).toBeInTheDocument();

		fireEvent.keyDown(window, { key: 'Escape' });
		await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
	});

	it('persists pending registration state and completes when polling returns an auth token', async () => {
		vi.mocked(window.maestro.leaderboard.submit).mockResolvedValue({
			success: true,
			pendingEmailConfirmation: true,
		});
		vi.mocked(window.maestro.leaderboard.pollAuthStatus).mockResolvedValue({
			status: 'confirmed',
			authToken: 'confirmed-auth-token',
		});
		const { onSave } = renderModal();

		fireEvent.change(screen.getByPlaceholderText('ConductorPedram'), {
			target: { value: 'Polling User' },
		});
		fireEvent.change(screen.getByPlaceholderText('conductor@maestro.ai'), {
			target: { value: 'polling@example.com' },
		});
		fireEvent.click(screen.getByRole('button', { name: /Push Up/i }));

		await waitFor(() =>
			expect(onSave).toHaveBeenCalledWith(
				expect.objectContaining({
					email: 'polling@example.com',
					emailConfirmed: true,
					authToken: 'confirmed-auth-token',
				})
			)
		);
		expect(screen.getByText(/Email confirmed!/)).toBeInTheDocument();
	});

	it('handles expired confirmations and transient polling failures without leaving the interval running', async () => {
		vi.spyOn(global, 'setInterval').mockImplementation((handler: TimerHandler) => {
			Promise.resolve()
				.then(() => {
					if (typeof handler === 'function') handler();
				})
				.then(() => {
					if (typeof handler === 'function') handler();
				});
			return 1 as unknown as ReturnType<typeof setInterval>;
		});
		vi.mocked(window.maestro.leaderboard.submit).mockResolvedValue({
			success: true,
			pendingEmailConfirmation: true,
		});
		vi.mocked(window.maestro.leaderboard.pollAuthStatus)
			.mockResolvedValueOnce({ status: 'error', error: 'temporary polling error' })
			.mockRejectedValueOnce(new Error('poll network down'))
			.mockResolvedValueOnce({ status: 'expired' });
		const { unmount } = renderModal();

		fillRequiredProfile('Polling Error User', 'poll-error@example.com');
		fireEvent.click(screen.getByRole('button', { name: /Push Up/i }));

		await waitFor(() =>
			expect(window.maestro.logger.log).toHaveBeenCalledWith(
				'warn',
				'Polling error:',
				undefined,
				'temporary polling error'
			)
		);
		await waitFor(() =>
			expect(window.maestro.logger.log).toHaveBeenCalledWith(
				'warn',
				'Poll request failed:',
				undefined,
				expect.any(Error)
			)
		);

		await waitFor(() =>
			expect(
				screen.getByText(
					'Confirmation link expired. Please submit again to receive a new confirmation email.'
				)
			).toBeInTheDocument()
		);
		unmount();
	});

	it('recovers a missing auth token during push and retries the submission', async () => {
		vi.mocked(window.maestro.leaderboard.submit)
			.mockResolvedValueOnce({
				success: false,
				authTokenRequired: true,
			})
			.mockResolvedValueOnce({
				success: true,
			});
		vi.mocked(window.maestro.leaderboard.pollAuthStatus).mockResolvedValue({
			status: 'confirmed',
			authToken: 'recovered-auth-token',
		});
		const { onSave } = renderModal({ registration: existingRegistration });

		fireEvent.click(screen.getByRole('button', { name: /Push Up/i }));

		await waitFor(() => expect(window.maestro.leaderboard.submit).toHaveBeenCalledTimes(2));
		expect(onSave).toHaveBeenCalledWith(
			expect.objectContaining({
				authToken: 'recovered-auth-token',
				emailConfirmed: true,
			})
		);
		expect(window.maestro.leaderboard.submit).toHaveBeenLastCalledWith(
			expect.objectContaining({ authToken: 'recovered-auth-token' })
		);
		expect(screen.getByText(/Auth token recovered and stats submitted/)).toBeInTheDocument();
	});

	it('surfaces submit failures and supports Enter-key submission from the real dialog', async () => {
		vi.mocked(window.maestro.leaderboard.submit).mockRejectedValue(new Error('network down'));
		renderModal();

		fillRequiredProfile('Enter User', 'enter@example.com');
		fireEvent.keyDown(screen.getByRole('dialog', { name: 'Register for Leaderboard' }), {
			key: 'Enter',
		});

		await waitFor(() => expect(screen.getByText('network down')).toBeInTheDocument());
		expect(window.maestro.leaderboard.submit).toHaveBeenCalledWith(
			expect.objectContaining({
				email: 'enter@example.com',
				displayName: 'Enter User',
			})
		);
	});

	it('surfaces API response failures and recovered-token retry failures', async () => {
		vi.mocked(window.maestro.leaderboard.submit).mockResolvedValueOnce({
			success: false,
			message: 'Server rejected this profile',
		});
		const responseFailure = renderModal();
		fillRequiredProfile('Rejected User', 'rejected@example.com');
		fireEvent.click(screen.getByRole('button', { name: /Push Up/i }));
		await screen.findByText('Server rejected this profile');
		responseFailure.unmount();

		vi.mocked(window.maestro.leaderboard.submit)
			.mockResolvedValueOnce({
				success: false,
				authTokenRequired: true,
			})
			.mockResolvedValueOnce({
				success: false,
				error: 'Recovered token rejected',
			});
		vi.mocked(window.maestro.leaderboard.pollAuthStatus).mockResolvedValue({
			status: 'confirmed',
			authToken: 'recovered-but-rejected-token',
		});
		renderModal({ registration: existingRegistration });

		fireEvent.click(screen.getByRole('button', { name: /Push Up/i }));

		await waitFor(() => expect(window.maestro.leaderboard.submit).toHaveBeenCalledTimes(2));
		expect(await screen.findByText('Recovered token rejected')).toBeInTheDocument();
		expect(screen.getByPlaceholderText('Paste your 64-character auth token')).toBeInTheDocument();
	});

	it('resends confirmation when token recovery falls back to manual entry', async () => {
		vi.mocked(window.maestro.leaderboard.pollAuthStatus).mockResolvedValue({
			status: 'pending',
		});
		const missingTokenRegistration: LeaderboardRegistration = {
			...existingRegistration,
			authToken: undefined,
			emailConfirmed: true,
		};
		renderModal({ registration: missingTokenRegistration });

		await waitFor(() => expect(screen.getByText(/lost your auth token/)).toBeInTheDocument());
		fireEvent.click(screen.getByRole('button', { name: 'Resend Confirmation Email' }));

		await waitFor(() =>
			expect(window.maestro.leaderboard.resendConfirmation).toHaveBeenCalledWith({
				email: 'conductor@example.com',
				clientToken: 'existing-client-token',
			})
		);
		expect(screen.getByText('Confirmation email sent')).toBeInTheDocument();
		expect(screen.getByText(/Click the link in your email/)).toBeInTheDocument();
	});

	it('surfaces resend confirmation response failures and thrown errors', async () => {
		vi.mocked(window.maestro.leaderboard.pollAuthStatus).mockResolvedValue({
			status: 'pending',
		});
		vi.mocked(window.maestro.leaderboard.resendConfirmation).mockResolvedValueOnce({
			success: false,
			error: 'Resend rejected',
		});
		const missingTokenRegistration: LeaderboardRegistration = {
			...existingRegistration,
			authToken: undefined,
			emailConfirmed: true,
		};
		const resendFailure = renderModal({ registration: missingTokenRegistration });
		await screen.findByText(/lost your auth token/);
		fireEvent.click(screen.getByRole('button', { name: 'Resend Confirmation Email' }));
		await screen.findByText('Resend rejected');
		resendFailure.unmount();

		vi.mocked(window.maestro.leaderboard.pollAuthStatus).mockResolvedValue({
			status: 'pending',
		});
		vi.mocked(window.maestro.leaderboard.resendConfirmation).mockRejectedValueOnce(
			new Error('resend offline')
		);
		renderModal({ registration: missingTokenRegistration });
		await screen.findByText(/lost your auth token/);
		fireEvent.click(screen.getByRole('button', { name: 'Resend Confirmation Email' }));
		await screen.findByText('resend offline');
	});

	it('syncs existing server stats and confirms opt-out through the real modal layer', async () => {
		const localStats = { ...autoRunStats, cumulativeTimeMs: 3_600_000, totalRuns: 4 };
		const { onOptOut, onSyncStats } = renderModal({
			registration: existingRegistration,
			stats: localStats,
		});

		expect(screen.getByText('Update Leaderboard Registration')).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: /Pull Down/i }));

		await waitFor(() =>
			expect(onSyncStats).toHaveBeenCalledWith({
				cumulativeTimeMs: 8_100_000,
				totalRuns: 14,
				currentBadgeLevel: 4,
				longestRunMs: 3_900_000,
				longestRunTimestamp: new Date('2026-01-20').getTime(),
			})
		);
		expect(screen.getByText(/Synced! Updated to 2h 15m from server/)).toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: /Opt Out/i }));
		expect(screen.getByText(/Are you sure you want to remove yourself/)).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'Keep Registration' }));
		expect(onOptOut).not.toHaveBeenCalled();

		fireEvent.click(screen.getByRole('button', { name: /Opt Out/i }));
		fireEvent.click(screen.getByRole('button', { name: /Yes, Remove Me/i }));

		expect(onOptOut).toHaveBeenCalledOnce();
		expect(screen.getByText(/You have opted out of the leaderboard/)).toBeInTheDocument();
	});

	it('handles server sync equal, local-ahead, missing-record, and auth-error responses', async () => {
		vi.mocked(window.maestro.leaderboard.sync).mockResolvedValueOnce({
			success: true,
			found: true,
			data: {
				cumulativeTimeMs: autoRunStats.cumulativeTimeMs,
				totalRuns: autoRunStats.totalRuns,
				badgeLevel: autoRunStats.currentBadgeLevel,
			},
		});
		const equal = renderModal({ registration: existingRegistration });
		fireEvent.click(screen.getByRole('button', { name: /Pull Down/i }));
		await screen.findByText('Already in sync! Local and server stats match.');
		equal.unmount();

		vi.mocked(window.maestro.leaderboard.sync).mockResolvedValueOnce({
			success: true,
			found: true,
			data: {
				cumulativeTimeMs: 60_000,
				totalRuns: 1,
				badgeLevel: 1,
			},
		});
		const ahead = renderModal({ registration: existingRegistration });
		fireEvent.click(screen.getByRole('button', { name: /Pull Down/i }));
		await screen.findByText(/Local is ahead/);
		ahead.unmount();

		vi.mocked(window.maestro.leaderboard.sync).mockResolvedValueOnce({
			success: true,
			found: false,
		});
		const missing = renderModal({ registration: existingRegistration });
		fireEvent.click(screen.getByRole('button', { name: /Pull Down/i }));
		await screen.findByText('No server record found. Submit your first entry to create one!');
		missing.unmount();

		vi.mocked(window.maestro.leaderboard.sync).mockResolvedValueOnce({
			success: false,
			errorCode: 'EMAIL_NOT_CONFIRMED',
		});
		renderModal({ registration: existingRegistration });
		fireEvent.click(screen.getByRole('button', { name: /Pull Down/i }));
		await screen.findByText(
			'Email not yet confirmed. Please check your inbox for the confirmation email.'
		);
	});

	it('handles sync guard, invalid-token, generic error, and thrown sync paths', async () => {
		const missingEmailRegistration: LeaderboardRegistration = {
			...existingRegistration,
			email: '',
		};
		const guarded = renderModal({ registration: missingEmailRegistration });
		fireEvent.click(screen.getByRole('button', { name: /Pull Down/i }));
		expect(window.maestro.leaderboard.sync).not.toHaveBeenCalled();
		guarded.unmount();

		vi.mocked(window.maestro.leaderboard.sync).mockResolvedValueOnce({
			success: false,
			errorCode: 'INVALID_TOKEN',
		});
		const invalid = renderModal({ registration: existingRegistration });
		fireEvent.click(screen.getByRole('button', { name: /Pull Down/i }));
		await screen.findByText('Invalid auth token. Please re-register to get a new token.');
		invalid.unmount();

		vi.mocked(window.maestro.leaderboard.sync).mockResolvedValueOnce({
			success: false,
			error: 'Sync service unavailable',
		});
		const generic = renderModal({ registration: existingRegistration });
		fireEvent.click(screen.getByRole('button', { name: /Pull Down/i }));
		await screen.findByText('Sync service unavailable');
		generic.unmount();

		vi.mocked(window.maestro.leaderboard.sync).mockRejectedValueOnce(new Error('sync exploded'));
		renderModal({ registration: existingRegistration });
		fireEvent.click(screen.getByRole('button', { name: /Pull Down/i }));
		await screen.findByText('sync exploded');
	});

	it('falls back to manual token entry when automatic token recovery is unavailable', async () => {
		vi.mocked(window.maestro.leaderboard.pollAuthStatus).mockResolvedValue({
			status: 'pending',
		});
		const missingTokenRegistration: LeaderboardRegistration = {
			...existingRegistration,
			authToken: undefined,
			emailConfirmed: true,
		};
		const { onSave } = renderModal({ registration: missingTokenRegistration });

		await waitFor(() => expect(screen.getByText(/lost your auth token/)).toBeInTheDocument());
		expect(screen.getByRole('button', { name: 'Resend Confirmation Email' })).toBeInTheDocument();

		fireEvent.change(screen.getByPlaceholderText('Paste your 64-character auth token'), {
			target: { value: ' manual-auth-token ' },
		});
		fireEvent.click(screen.getByRole('button', { name: 'Submit' }));

		await waitFor(() =>
			expect(window.maestro.leaderboard.submit).toHaveBeenCalledWith(
				expect.objectContaining({
					email: 'conductor@example.com',
					authToken: 'manual-auth-token',
				})
			)
		);
		expect(onSave).toHaveBeenCalledWith(
			expect.objectContaining({
				authToken: 'manual-auth-token',
				emailConfirmed: true,
			})
		);
		expect(screen.getByText(/Your profile has been updated!/)).toBeInTheDocument();
	});

	it('recovers missing auth tokens on mount and falls back after mount recovery errors', async () => {
		vi.mocked(window.maestro.leaderboard.pollAuthStatus).mockResolvedValueOnce({
			status: 'confirmed',
			authToken: 'mount-recovered-token',
		});
		const missingTokenRegistration: LeaderboardRegistration = {
			...existingRegistration,
			authToken: undefined,
			emailConfirmed: true,
		};
		const { onSave, unmount } = renderModal({ registration: missingTokenRegistration });
		expect(screen.getByText('Checking for your auth token...')).toBeInTheDocument();
		await waitFor(() =>
			expect(onSave).toHaveBeenCalledWith(
				expect.objectContaining({ authToken: 'mount-recovered-token', emailConfirmed: true })
			)
		);
		expect(
			screen.getByText('Auth token recovered! Your registration is complete.')
		).toBeInTheDocument();
		unmount();

		vi.mocked(window.maestro.leaderboard.pollAuthStatus).mockRejectedValueOnce(
			new Error('mount recovery failed')
		);
		renderModal({ registration: missingTokenRegistration });
		await waitFor(() => expect(screen.getByText(/lost your auth token/)).toBeInTheDocument());
		expect(screen.getByPlaceholderText('Paste your 64-character auth token')).toBeInTheDocument();
	});

	it('surfaces manual-token response failures and thrown manual-token submissions', async () => {
		vi.mocked(window.maestro.leaderboard.pollAuthStatus).mockResolvedValue({
			status: 'pending',
		});
		vi.mocked(window.maestro.leaderboard.submit).mockResolvedValueOnce({
			success: false,
			message: 'Manual token rejected',
		});
		const missingTokenRegistration: LeaderboardRegistration = {
			...existingRegistration,
			authToken: undefined,
			emailConfirmed: true,
		};
		const responseFailure = renderModal({ registration: missingTokenRegistration });
		await screen.findByText(/lost your auth token/);
		fireEvent.change(screen.getByPlaceholderText('Paste your 64-character auth token'), {
			target: { value: 'bad-manual-token' },
		});
		fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
		await screen.findByText('Manual token rejected');
		responseFailure.unmount();

		vi.mocked(window.maestro.leaderboard.pollAuthStatus).mockResolvedValue({
			status: 'pending',
		});
		vi.mocked(window.maestro.leaderboard.submit).mockRejectedValueOnce(
			new Error('manual submission offline')
		);
		renderModal({ registration: missingTokenRegistration });
		await screen.findByText(/lost your auth token/);
		fireEvent.change(screen.getByPlaceholderText('Paste your 64-character auth token'), {
			target: { value: 'throwing-manual-token' },
		});
		fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
		await screen.findByText('manual submission offline');
	});
});
