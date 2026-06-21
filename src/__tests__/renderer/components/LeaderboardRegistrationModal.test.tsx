/**
 * @fileoverview Tests for LeaderboardRegistrationModal component
 * Tests: Bluesky field rendering, @ prefix stripping, form submission, state persistence
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { LeaderboardRegistrationModal } from '../../../renderer/components/LeaderboardRegistrationModal';
import type { Theme, AutoRunStats, LeaderboardRegistration } from '../../../renderer/types';
import type { KeyboardMasteryStats } from '../../../shared/types';

// Mock layer stack context
const mockRegisterLayer = vi.fn(() => 'layer-leaderboard-123');
const mockUnregisterLayer = vi.fn();

vi.mock('../../../renderer/contexts/LayerStackContext', () => ({
	useLayerStack: () => ({
		registerLayer: mockRegisterLayer,
		unregisterLayer: mockUnregisterLayer,
		updateLayerHandler: vi.fn(),
	}),
}));

// Add __APP_VERSION__ global
(globalThis as unknown as { __APP_VERSION__: string }).__APP_VERSION__ = '1.0.0';

// Create test theme
const createTheme = (): Theme => ({
	id: 'test-dark',
	name: 'Test Dark',
	mode: 'dark',
	colors: {
		bgMain: '#1a1a2e',
		bgSidebar: '#16213e',
		bgActivity: '#0f3460',
		textMain: '#e8e8e8',
		textDim: '#888888',
		accent: '#7b2cbf',
		border: '#333355',
		success: '#22c55e',
		warning: '#f59e0b',
		error: '#ef4444',
		info: '#3b82f6',
		bgAccentHover: '#9333ea',
	},
});

// Create test autoRunStats
const createAutoRunStats = (overrides: Partial<AutoRunStats> = {}): AutoRunStats => ({
	cumulativeTimeMs: 120000, // 2 minutes
	longestRunMs: 60000, // 1 minute
	totalRuns: 5,
	lastBadgeAcknowledged: null,
	badgeHistory: [],
	...overrides,
});

// Create test keyboard mastery stats
const createKeyboardMasteryStats = (
	overrides: Partial<KeyboardMasteryStats> = {}
): KeyboardMasteryStats => ({
	shortcutUsageCounts: {},
	totalShortcutsUsed: 50,
	firstShortcutAt: new Date('2024-01-01').toISOString(),
	lastShortcutAt: new Date('2024-01-10').toISOString(),
	usedShortcuts: ['openCommandPalette', 'newSession', 'closeSession'],
	currentLevel: 1,
	...overrides,
});

describe('LeaderboardRegistrationModal', () => {
	let theme: Theme;
	let autoRunStats: AutoRunStats;
	let keyboardMasteryStats: KeyboardMasteryStats;
	let onClose: ReturnType<typeof vi.fn>;
	let onSave: ReturnType<typeof vi.fn>;
	let onOptOut: ReturnType<typeof vi.fn>;

	const renderModal = (
		overrides: Partial<ComponentProps<typeof LeaderboardRegistrationModal>> = {}
	) =>
		render(
			<LeaderboardRegistrationModal
				theme={theme}
				autoRunStats={autoRunStats}
				keyboardMasteryStats={keyboardMasteryStats}
				existingRegistration={null}
				onClose={onClose}
				onSave={onSave}
				onOptOut={onOptOut}
				{...overrides}
			/>
		);

	const fillRequiredFields = async (displayName = 'Test User', email = 'test@example.com') => {
		await act(async () => {
			fireEvent.change(screen.getByPlaceholderText('ConductorPedram'), {
				target: { value: displayName },
			});
			fireEvent.change(
				screen.getByPlaceholderText((_, element) => element?.getAttribute('type') === 'email'),
				{ target: { value: email } }
			);
		});
	};

	beforeEach(() => {
		theme = createTheme();
		autoRunStats = createAutoRunStats();
		keyboardMasteryStats = createKeyboardMasteryStats();
		onClose = vi.fn();
		onSave = vi.fn();
		onOptOut = vi.fn();

		// Mock leaderboard API
		vi.mocked(window.maestro.leaderboard.submit).mockResolvedValue({
			success: true,
			rank: 42,
		});
		vi.mocked(window.maestro.leaderboard.pollAuthStatus).mockResolvedValue({
			status: 'pending',
		});
		vi.mocked(window.maestro.leaderboard.resendConfirmation).mockResolvedValue({
			success: true,
			message: 'Confirmation email queued.',
		});
		vi.mocked(window.maestro.leaderboard.sync).mockResolvedValue({
			success: true,
			found: false,
		});
		vi.mocked(window.maestro.shell.openExternal).mockResolvedValue(undefined);

		// Reset layer stack mocks
		mockRegisterLayer.mockClear().mockReturnValue('layer-leaderboard-123');
		mockUnregisterLayer.mockClear();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.clearAllMocks();
	});

	describe('Bluesky field rendering', () => {
		it('should render Bluesky input field', () => {
			render(
				<LeaderboardRegistrationModal
					theme={theme}
					autoRunStats={autoRunStats}
					keyboardMasteryStats={keyboardMasteryStats}
					existingRegistration={null}
					onClose={onClose}
					onSave={onSave}
				/>
			);

			const blueskyInput = screen.getByPlaceholderText('username.bsky.social');
			expect(blueskyInput).toBeInTheDocument();
		});

		it('should render Bluesky icon with correct styling', () => {
			render(
				<LeaderboardRegistrationModal
					theme={theme}
					autoRunStats={autoRunStats}
					keyboardMasteryStats={keyboardMasteryStats}
					existingRegistration={null}
					onClose={onClose}
					onSave={onSave}
				/>
			);

			// The BlueskySkyIcon renders an SVG path - check for the icon container
			const blueskyInput = screen.getByPlaceholderText('username.bsky.social');
			const iconContainer = blueskyInput.parentElement?.querySelector('svg');
			expect(iconContainer).toBeInTheDocument();
			expect(iconContainer).toHaveClass('w-4', 'h-4');
		});

		it('should have correct placeholder text', () => {
			render(
				<LeaderboardRegistrationModal
					theme={theme}
					autoRunStats={autoRunStats}
					keyboardMasteryStats={keyboardMasteryStats}
					existingRegistration={null}
					onClose={onClose}
					onSave={onSave}
				/>
			);

			const blueskyInput = screen.getByPlaceholderText('username.bsky.social');
			expect(blueskyInput).toHaveAttribute('placeholder', 'username.bsky.social');
		});
	});

	describe('@ prefix stripping', () => {
		it('should strip leading @ when user types it', () => {
			render(
				<LeaderboardRegistrationModal
					theme={theme}
					autoRunStats={autoRunStats}
					keyboardMasteryStats={keyboardMasteryStats}
					existingRegistration={null}
					onClose={onClose}
					onSave={onSave}
				/>
			);

			const blueskyInput = screen.getByPlaceholderText('username.bsky.social') as HTMLInputElement;
			fireEvent.change(blueskyInput, { target: { value: '@username.bsky.social' } });

			expect(blueskyInput.value).toBe('username.bsky.social');
		});

		it('should handle multiple @ symbols (only strip the leading one)', () => {
			render(
				<LeaderboardRegistrationModal
					theme={theme}
					autoRunStats={autoRunStats}
					keyboardMasteryStats={keyboardMasteryStats}
					existingRegistration={null}
					onClose={onClose}
					onSave={onSave}
				/>
			);

			const blueskyInput = screen.getByPlaceholderText('username.bsky.social') as HTMLInputElement;
			fireEvent.change(blueskyInput, { target: { value: '@user@name.bsky.social' } });

			expect(blueskyInput.value).toBe('user@name.bsky.social');
		});

		it('should allow input without @ prefix', () => {
			render(
				<LeaderboardRegistrationModal
					theme={theme}
					autoRunStats={autoRunStats}
					keyboardMasteryStats={keyboardMasteryStats}
					existingRegistration={null}
					onClose={onClose}
					onSave={onSave}
				/>
			);

			const blueskyInput = screen.getByPlaceholderText('username.bsky.social') as HTMLInputElement;
			fireEvent.change(blueskyInput, { target: { value: 'username.bsky.social' } });

			expect(blueskyInput.value).toBe('username.bsky.social');
		});
	});

	describe('Custom domain support', () => {
		it('should accept custom domain handles', () => {
			render(
				<LeaderboardRegistrationModal
					theme={theme}
					autoRunStats={autoRunStats}
					keyboardMasteryStats={keyboardMasteryStats}
					existingRegistration={null}
					onClose={onClose}
					onSave={onSave}
				/>
			);

			const blueskyInput = screen.getByPlaceholderText('username.bsky.social') as HTMLInputElement;
			fireEvent.change(blueskyInput, { target: { value: 'user.example.com' } });

			expect(blueskyInput.value).toBe('user.example.com');
		});

		it('should strip @ from custom domain handles', () => {
			render(
				<LeaderboardRegistrationModal
					theme={theme}
					autoRunStats={autoRunStats}
					keyboardMasteryStats={keyboardMasteryStats}
					existingRegistration={null}
					onClose={onClose}
					onSave={onSave}
				/>
			);

			const blueskyInput = screen.getByPlaceholderText('username.bsky.social') as HTMLInputElement;
			fireEvent.change(blueskyInput, { target: { value: '@user.example.com' } });

			expect(blueskyInput.value).toBe('user.example.com');
		});
	});

	describe('State persistence', () => {
		it('should load existing Bluesky handle from registration', () => {
			const existingRegistration: LeaderboardRegistration = {
				displayName: 'Test User',
				gitHubUsername: 'testuser',
				twitterHandle: 'testuser',
				discordUsername: 'testuser#1234',
				blueskyHandle: 'testuser.bsky.social',
				submittedAt: new Date().toISOString(),
			};

			render(
				<LeaderboardRegistrationModal
					theme={theme}
					autoRunStats={autoRunStats}
					keyboardMasteryStats={keyboardMasteryStats}
					existingRegistration={existingRegistration}
					onClose={onClose}
					onSave={onSave}
				/>
			);

			const blueskyInput = screen.getByPlaceholderText('username.bsky.social') as HTMLInputElement;
			expect(blueskyInput.value).toBe('testuser.bsky.social');
		});

		it('should load custom domain Bluesky handle from registration', () => {
			const existingRegistration: LeaderboardRegistration = {
				displayName: 'Test User',
				gitHubUsername: 'testuser',
				twitterHandle: 'testuser',
				discordUsername: 'testuser#1234',
				blueskyHandle: 'testuser.example.com',
				submittedAt: new Date().toISOString(),
			};

			render(
				<LeaderboardRegistrationModal
					theme={theme}
					autoRunStats={autoRunStats}
					keyboardMasteryStats={keyboardMasteryStats}
					existingRegistration={existingRegistration}
					onClose={onClose}
					onSave={onSave}
				/>
			);

			const blueskyInput = screen.getByPlaceholderText('username.bsky.social') as HTMLInputElement;
			expect(blueskyInput.value).toBe('testuser.example.com');
		});

		it('should handle missing Bluesky handle in existing registration', () => {
			const existingRegistration: LeaderboardRegistration = {
				displayName: 'Test User',
				gitHubUsername: 'testuser',
				twitterHandle: 'testuser',
				discordUsername: 'testuser#1234',
				submittedAt: new Date().toISOString(),
			};

			render(
				<LeaderboardRegistrationModal
					theme={theme}
					autoRunStats={autoRunStats}
					keyboardMasteryStats={keyboardMasteryStats}
					existingRegistration={existingRegistration}
					onClose={onClose}
					onSave={onSave}
				/>
			);

			const blueskyInput = screen.getByPlaceholderText('username.bsky.social') as HTMLInputElement;
			expect(blueskyInput.value).toBe('');
		});
	});

	describe('Form submission', () => {
		it('should enter email confirmation polling for pending registrations', async () => {
			vi.mocked(window.maestro.leaderboard.submit).mockResolvedValueOnce({
				success: true,
				pendingEmailConfirmation: true,
			});
			vi.mocked(window.maestro.leaderboard.pollAuthStatus).mockResolvedValue({ status: 'pending' });

			const { unmount } = renderModal();

			await fillRequiredFields();

			await act(async () => {
				fireEvent.click(screen.getByText('Push Up'));
			});

			await waitFor(() => {
				expect(
					screen.getByText('Please check your email to confirm your registration.')
				).toBeInTheDocument();
			});
			expect(onSave).toHaveBeenCalledWith(
				expect.objectContaining({
					email: 'test@example.com',
					displayName: 'Test User',
					emailConfirmed: false,
					clientToken: expect.any(String),
				})
			);
			expect(window.maestro.leaderboard.pollAuthStatus).toHaveBeenCalledWith(expect.any(String));

			unmount();
		});

		it('should save recovered auth token when polling confirms email', async () => {
			vi.mocked(window.maestro.leaderboard.submit).mockResolvedValueOnce({
				success: true,
				pendingEmailConfirmation: true,
			});
			vi.mocked(window.maestro.leaderboard.pollAuthStatus).mockResolvedValueOnce({
				status: 'confirmed',
				authToken: 'confirmed-token',
			});

			renderModal();

			await fillRequiredFields('Poll User', 'poll@example.com');

			await act(async () => {
				fireEvent.click(screen.getByText('Push Up'));
			});

			await waitFor(() => {
				expect(
					screen.getByText('Email confirmed! Your stats have been submitted to the leaderboard.')
				).toBeInTheDocument();
			});
			expect(onSave).toHaveBeenLastCalledWith(
				expect.objectContaining({
					email: 'poll@example.com',
					displayName: 'Poll User',
					emailConfirmed: true,
					authToken: 'confirmed-token',
				})
			);
		});

		it('should recover a missing auth token and retry submission', async () => {
			const existingRegistration: LeaderboardRegistration = {
				displayName: 'Token User',
				email: 'token@example.com',
				registeredAt: 123,
				emailConfirmed: true,
				clientToken: 'client-token',
				authToken: 'stale-token',
			};
			vi.mocked(window.maestro.leaderboard.submit)
				.mockResolvedValueOnce({ success: false, authTokenRequired: true })
				.mockResolvedValueOnce({ success: true });
			vi.mocked(window.maestro.leaderboard.pollAuthStatus).mockResolvedValueOnce({
				status: 'confirmed',
				authToken: 'recovered-token',
			});

			renderModal({ existingRegistration });

			await act(async () => {
				fireEvent.click(screen.getByText('Push Up'));
			});

			await waitFor(() => {
				expect(
					screen.getByText('Auth token recovered and stats submitted successfully!')
				).toBeInTheDocument();
			});
			expect(window.maestro.leaderboard.submit).toHaveBeenLastCalledWith(
				expect.objectContaining({
					authToken: 'recovered-token',
					clientToken: 'client-token',
				})
			);
			expect(onSave).toHaveBeenCalledWith(
				expect.objectContaining({
					authToken: 'recovered-token',
					emailConfirmed: true,
				})
			);
		});

		it('should include longest-run date when retrying after token recovery', async () => {
			autoRunStats = createAutoRunStats({
				longestRunTimestamp: new Date('2026-06-18T12:00:00Z').getTime(),
			});
			const existingRegistration: LeaderboardRegistration = {
				displayName: 'Token User',
				email: 'token@example.com',
				registeredAt: 123,
				emailConfirmed: true,
				clientToken: 'client-token',
				authToken: 'stale-token',
			};
			vi.mocked(window.maestro.leaderboard.submit)
				.mockResolvedValueOnce({ success: false, authTokenRequired: true })
				.mockResolvedValueOnce({ success: true });
			vi.mocked(window.maestro.leaderboard.pollAuthStatus).mockResolvedValueOnce({
				status: 'confirmed',
				authToken: 'recovered-token',
			});

			renderModal({ existingRegistration });

			await act(async () => {
				fireEvent.click(screen.getByText('Push Up'));
			});

			await waitFor(() => {
				expect(window.maestro.leaderboard.submit).toHaveBeenLastCalledWith(
					expect.objectContaining({
						longestRunDate: '2026-06-18',
						authToken: 'recovered-token',
					})
				);
			});
		});

		it('should show retry failure after token recovery', async () => {
			const existingRegistration: LeaderboardRegistration = {
				displayName: 'Token User',
				email: 'token@example.com',
				registeredAt: 123,
				emailConfirmed: true,
				clientToken: 'client-token',
				authToken: 'stale-token',
			};
			vi.mocked(window.maestro.leaderboard.submit)
				.mockResolvedValueOnce({ success: false, authTokenRequired: true })
				.mockResolvedValueOnce({ success: false, error: 'Retry failed' });
			vi.mocked(window.maestro.leaderboard.pollAuthStatus).mockResolvedValueOnce({
				status: 'confirmed',
				authToken: 'recovered-token',
			});

			renderModal({ existingRegistration });

			await act(async () => {
				fireEvent.click(screen.getByText('Push Up'));
			});

			await waitFor(() => {
				expect(window.maestro.leaderboard.submit).toHaveBeenCalledTimes(2);
			});
			expect(window.maestro.leaderboard.submit).toHaveBeenLastCalledWith(
				expect.objectContaining({
					authToken: 'recovered-token',
				})
			);
		});

		it('should allow manual token entry when automatic recovery is unavailable', async () => {
			const existingRegistration: LeaderboardRegistration = {
				displayName: 'Manual User',
				email: 'manual@example.com',
				registeredAt: 123,
				emailConfirmed: true,
				clientToken: 'manual-client-token',
				authToken: 'stale-token',
			};
			vi.mocked(window.maestro.leaderboard.submit)
				.mockResolvedValueOnce({ success: false, authTokenRequired: true })
				.mockResolvedValueOnce({ success: true });
			vi.mocked(window.maestro.leaderboard.pollAuthStatus).mockResolvedValue({ status: 'pending' });

			renderModal({ existingRegistration });

			await act(async () => {
				fireEvent.click(screen.getByText('Push Up'));
			});

			const manualTokenInput = await screen.findByPlaceholderText(
				'Paste your 64-character auth token'
			);
			await act(async () => {
				fireEvent.change(manualTokenInput, { target: { value: 'manual-token' } });
				fireEvent.click(screen.getByText('Submit'));
			});

			await waitFor(() => {
				expect(
					screen.getByText(
						'Your profile has been updated! Use "Pull Down" to sync stats from the server.'
					)
				).toBeInTheDocument();
			});
			expect(window.maestro.leaderboard.submit).toHaveBeenLastCalledWith(
				expect.objectContaining({
					authToken: 'manual-token',
					clientToken: 'manual-client-token',
				})
			);
			expect(onSave).toHaveBeenCalledWith(
				expect.objectContaining({
					authToken: 'manual-token',
					emailConfirmed: true,
				})
			);
		});

		it('should show manual token submission failures', async () => {
			const existingRegistration: LeaderboardRegistration = {
				displayName: 'Manual User',
				email: 'manual@example.com',
				registeredAt: 123,
				emailConfirmed: true,
				clientToken: 'manual-client-token',
				authToken: 'stale-token',
			};
			vi.mocked(window.maestro.leaderboard.submit)
				.mockResolvedValueOnce({ success: false, authTokenRequired: true })
				.mockResolvedValueOnce({ success: false, message: 'Manual token rejected' });
			vi.mocked(window.maestro.leaderboard.pollAuthStatus).mockResolvedValue({ status: 'pending' });

			renderModal({ existingRegistration });

			await act(async () => {
				fireEvent.click(screen.getByText('Push Up'));
			});

			const manualTokenInput = await screen.findByPlaceholderText(
				'Paste your 64-character auth token'
			);
			await act(async () => {
				fireEvent.change(manualTokenInput, { target: { value: 'bad-token' } });
				fireEvent.click(screen.getByText('Submit'));
			});

			expect(await screen.findByText('Manual token rejected')).toBeInTheDocument();
		});

		it('should show manual token submission exceptions', async () => {
			const existingRegistration: LeaderboardRegistration = {
				displayName: 'Manual User',
				email: 'manual@example.com',
				registeredAt: 123,
				emailConfirmed: true,
				clientToken: 'manual-client-token',
				authToken: 'stale-token',
			};
			vi.mocked(window.maestro.leaderboard.submit)
				.mockResolvedValueOnce({ success: false, authTokenRequired: true })
				.mockRejectedValueOnce(new Error('manual submit failed'));
			vi.mocked(window.maestro.leaderboard.pollAuthStatus).mockResolvedValue({ status: 'pending' });

			renderModal({ existingRegistration });

			await act(async () => {
				fireEvent.click(screen.getByText('Push Up'));
			});

			const manualTokenInput = await screen.findByPlaceholderText(
				'Paste your 64-character auth token'
			);
			await act(async () => {
				fireEvent.change(manualTokenInput, { target: { value: 'manual-token' } });
				fireEvent.click(screen.getByText('Submit'));
			});

			expect(await screen.findByText('manual submit failed')).toBeInTheDocument();
		});

		it('should skip manual token submit when the defensive token guard sees an empty token', async () => {
			const existingRegistration: LeaderboardRegistration = {
				displayName: 'Manual User',
				email: 'manual@example.com',
				registeredAt: 123,
				emailConfirmed: true,
				clientToken: 'manual-client-token',
				authToken: 'stale-token',
			};
			vi.mocked(window.maestro.leaderboard.submit).mockResolvedValueOnce({
				success: false,
				authTokenRequired: true,
			});
			vi.mocked(window.maestro.leaderboard.pollAuthStatus).mockResolvedValue({ status: 'pending' });

			renderModal({ existingRegistration });

			await act(async () => {
				fireEvent.click(screen.getByText('Push Up'));
			});

			await screen.findByPlaceholderText('Paste your 64-character auth token');
			const manualSubmitButton = screen.getByText('Submit') as HTMLButtonElement;
			manualSubmitButton.removeAttribute('disabled');
			manualSubmitButton.disabled = false;
			fireEvent.click(manualSubmitButton);

			expect(window.maestro.leaderboard.submit).toHaveBeenCalledTimes(1);
		});

		it('should include longest-run date during manual token submit', async () => {
			autoRunStats = createAutoRunStats({
				longestRunTimestamp: new Date('2026-06-18T12:00:00Z').getTime(),
			});
			const existingRegistration: LeaderboardRegistration = {
				displayName: 'Manual User',
				email: 'manual@example.com',
				registeredAt: 123,
				emailConfirmed: true,
				clientToken: 'manual-client-token',
				authToken: 'stale-token',
			};
			vi.mocked(window.maestro.leaderboard.submit)
				.mockResolvedValueOnce({ success: false, authTokenRequired: true })
				.mockResolvedValueOnce({ success: true });
			vi.mocked(window.maestro.leaderboard.pollAuthStatus).mockResolvedValue({ status: 'pending' });

			renderModal({ existingRegistration });

			await act(async () => {
				fireEvent.click(screen.getByText('Push Up'));
			});

			const manualTokenInput = await screen.findByPlaceholderText(
				'Paste your 64-character auth token'
			);
			await act(async () => {
				fireEvent.change(manualTokenInput, { target: { value: 'manual-token' } });
				fireEvent.click(screen.getByText('Submit'));
			});

			await waitFor(() => {
				expect(window.maestro.leaderboard.submit).toHaveBeenLastCalledWith(
					expect.objectContaining({
						longestRunDate: '2026-06-18',
						authToken: 'manual-token',
					})
				);
			});
		});

		it('should show expired confirmation during polling', async () => {
			vi.mocked(window.maestro.leaderboard.submit).mockResolvedValueOnce({
				success: true,
				pendingEmailConfirmation: true,
			});
			vi.mocked(window.maestro.leaderboard.pollAuthStatus).mockResolvedValueOnce({
				status: 'expired',
			});

			renderModal();

			await fillRequiredFields();
			await act(async () => {
				fireEvent.click(screen.getByText('Push Up'));
			});

			expect(
				await screen.findByText(
					'Confirmation link expired. Please submit again to receive a new confirmation email.'
				)
			).toBeInTheDocument();
		});

		it('should keep polling on the confirmation interval', async () => {
			vi.useFakeTimers();
			vi.mocked(window.maestro.leaderboard.submit).mockResolvedValueOnce({
				success: true,
				pendingEmailConfirmation: true,
			});
			vi.mocked(window.maestro.leaderboard.pollAuthStatus).mockResolvedValue({ status: 'pending' });

			const { unmount } = renderModal();

			await fillRequiredFields();
			await act(async () => {
				fireEvent.click(screen.getByText('Push Up'));
				await Promise.resolve();
				await Promise.resolve();
			});
			expect(window.maestro.leaderboard.pollAuthStatus).toHaveBeenCalledTimes(1);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(5000);
			});

			expect(window.maestro.leaderboard.pollAuthStatus).toHaveBeenCalledTimes(2);
			unmount();
		});

		it('should tolerate polling API errors while waiting for confirmation', async () => {
			vi.mocked(window.maestro.leaderboard.submit).mockResolvedValueOnce({
				success: true,
				pendingEmailConfirmation: true,
			});
			vi.mocked(window.maestro.leaderboard.pollAuthStatus).mockResolvedValueOnce({
				status: 'error',
				error: 'temporary polling failure',
			});

			const { unmount } = renderModal();

			await fillRequiredFields();
			await act(async () => {
				fireEvent.click(screen.getByText('Push Up'));
			});

			await waitFor(() => {
				expect(window.maestro.leaderboard.pollAuthStatus).toHaveBeenCalled();
			});
			expect(
				screen.getByText('Please check your email to confirm your registration.')
			).toBeInTheDocument();

			unmount();
		});

		it('should tolerate rejected polling requests while waiting for confirmation', async () => {
			vi.mocked(window.maestro.leaderboard.submit).mockResolvedValueOnce({
				success: true,
				pendingEmailConfirmation: true,
			});
			vi.mocked(window.maestro.leaderboard.pollAuthStatus).mockRejectedValueOnce(
				new Error('poll rejected')
			);

			const { unmount } = renderModal();

			await fillRequiredFields();
			await act(async () => {
				fireEvent.click(screen.getByText('Push Up'));
			});

			await waitFor(() => {
				expect(window.maestro.leaderboard.pollAuthStatus).toHaveBeenCalled();
			});
			expect(
				screen.getByText('Please check your email to confirm your registration.')
			).toBeInTheDocument();

			unmount();
		});

		it('should skip submit when the defensive submit guard sees invalid form state', () => {
			renderModal();

			const submitButton = screen.getByText('Push Up') as HTMLButtonElement;
			submitButton.removeAttribute('disabled');
			submitButton.disabled = false;
			fireEvent.click(submitButton);

			expect(window.maestro.leaderboard.submit).not.toHaveBeenCalled();
		});

		it('should show submission errors from the leaderboard API', async () => {
			vi.mocked(window.maestro.leaderboard.submit).mockResolvedValueOnce({
				success: false,
				error: 'Leaderboard rejected the profile',
			});

			renderModal();

			await fillRequiredFields();
			await act(async () => {
				fireEvent.click(screen.getByText('Push Up'));
			});

			expect(await screen.findByText('Leaderboard rejected the profile')).toBeInTheDocument();
		});

		it('should show unexpected submit exceptions', async () => {
			vi.mocked(window.maestro.leaderboard.submit).mockRejectedValueOnce(
				new Error('network unavailable')
			);

			renderModal();

			await fillRequiredFields();
			await act(async () => {
				fireEvent.click(screen.getByText('Push Up'));
			});

			expect(await screen.findByText('network unavailable')).toBeInTheDocument();
		});

		it('should include Bluesky handle in API submission', async () => {
			// Use existing registration with Bluesky handle to test submission includes it
			const existingRegistration: LeaderboardRegistration = {
				displayName: 'Test User',
				email: 'test@example.com',
				blueskyHandle: 'testuser.bsky.social',
				registeredAt: Date.now(),
				emailConfirmed: true,
				authToken: 'test-auth-token',
			};

			render(
				<LeaderboardRegistrationModal
					theme={theme}
					autoRunStats={autoRunStats}
					keyboardMasteryStats={keyboardMasteryStats}
					existingRegistration={existingRegistration}
					onClose={onClose}
					onSave={onSave}
				/>
			);

			// Submit form (existing registration pre-populates fields)
			const submitButton = screen.getByText('Push Up');
			await act(async () => {
				fireEvent.click(submitButton);
			});

			await waitFor(() => {
				expect(window.maestro.leaderboard.submit).toHaveBeenCalledWith(
					expect.objectContaining({
						blueskyHandle: 'testuser.bsky.social',
					})
				);
			});
		});

		it('should include custom domain Bluesky handle in API submission', async () => {
			// Use existing registration with custom domain Bluesky handle
			const existingRegistration: LeaderboardRegistration = {
				displayName: 'Test User',
				email: 'test@example.com',
				blueskyHandle: 'user.example.com',
				registeredAt: Date.now(),
				emailConfirmed: true,
				authToken: 'test-auth-token',
			};

			render(
				<LeaderboardRegistrationModal
					theme={theme}
					autoRunStats={autoRunStats}
					keyboardMasteryStats={keyboardMasteryStats}
					existingRegistration={existingRegistration}
					onClose={onClose}
					onSave={onSave}
				/>
			);

			// Submit form (existing registration pre-populates fields)
			const submitButton = screen.getByText('Push Up');
			await act(async () => {
				fireEvent.click(submitButton);
			});

			await waitFor(() => {
				expect(window.maestro.leaderboard.submit).toHaveBeenCalledWith(
					expect.objectContaining({
						blueskyHandle: 'user.example.com',
					})
				);
			});
		});

		it('should handle empty Bluesky handle (optional field)', async () => {
			render(
				<LeaderboardRegistrationModal
					theme={theme}
					autoRunStats={autoRunStats}
					keyboardMasteryStats={keyboardMasteryStats}
					existingRegistration={null}
					onClose={onClose}
					onSave={onSave}
				/>
			);

			// Fill required fields
			const displayNameInput = screen.getByPlaceholderText('ConductorPedram');
			await act(async () => {
				fireEvent.change(displayNameInput, { target: { value: 'Test User' } });
			});

			const emailInput = screen.getByPlaceholderText((content, element) => {
				return element?.getAttribute('type') === 'email' || false;
			});
			await act(async () => {
				fireEvent.change(emailInput, { target: { value: 'test@example.com' } });
			});

			// Leave Bluesky field empty
			const blueskyInput = screen.getByPlaceholderText('username.bsky.social');
			expect(blueskyInput).toHaveValue('');

			// Submit form
			const submitButton = screen.getByText('Push Up');
			await act(async () => {
				fireEvent.click(submitButton);
			});

			await waitFor(() => {
				expect(window.maestro.leaderboard.submit).toHaveBeenCalledWith(
					expect.objectContaining({
						blueskyHandle: undefined,
					})
				);
			});
		});

		it('should include Bluesky handle in local save', async () => {
			// Use existing registration with Bluesky handle
			const existingRegistration: LeaderboardRegistration = {
				displayName: 'Test User',
				email: 'test@example.com',
				blueskyHandle: 'testuser.bsky.social',
				registeredAt: Date.now(),
				emailConfirmed: true,
				authToken: 'test-auth-token',
			};

			render(
				<LeaderboardRegistrationModal
					theme={theme}
					autoRunStats={autoRunStats}
					keyboardMasteryStats={keyboardMasteryStats}
					existingRegistration={existingRegistration}
					onClose={onClose}
					onSave={onSave}
				/>
			);

			// Submit form (existing registration pre-populates fields)
			const submitButton = screen.getByText('Push Up');
			await act(async () => {
				fireEvent.click(submitButton);
			});

			await waitFor(() => {
				expect(onSave).toHaveBeenCalledWith(
					expect.objectContaining({
						blueskyHandle: 'testuser.bsky.social',
					})
				);
			});
		});
	});

	describe('Social handle fields', () => {
		it('should strip leading @ from non-Bluesky social handles', () => {
			renderModal();

			const usernameInputs = screen.getAllByPlaceholderText('username');
			const inputs = [
				usernameInputs[0],
				screen.getByPlaceholderText('handle'),
				usernameInputs[1],
				screen.getByPlaceholderText('username#1234 or username'),
			] as HTMLInputElement[];

			fireEvent.change(inputs[0], { target: { value: '@github-user' } });
			fireEvent.change(inputs[1], { target: { value: '@twitter-user' } });
			fireEvent.change(inputs[2], { target: { value: '@linkedin-user' } });
			fireEvent.change(inputs[3], { target: { value: '@discord-user' } });

			expect(inputs[0].value).toBe('github-user');
			expect(inputs[1].value).toBe('twitter-user');
			expect(inputs[2].value).toBe('linkedin-user');
			expect(inputs[3].value).toBe('discord-user');
		});
	});

	describe('Confirmation recovery and sync actions', () => {
		const confirmedRegistration = (overrides: Partial<LeaderboardRegistration> = {}) => ({
			displayName: 'Existing User',
			email: 'existing@example.com',
			registeredAt: 123,
			emailConfirmed: true,
			clientToken: 'existing-client-token',
			authToken: 'existing-auth-token',
			...overrides,
		});

		it('should recover auth token on mount when a confirmed registration lost its token', async () => {
			vi.mocked(window.maestro.leaderboard.pollAuthStatus).mockResolvedValueOnce({
				status: 'confirmed',
				authToken: 'mounted-recovery-token',
			});

			renderModal({
				existingRegistration: confirmedRegistration({ authToken: undefined }),
			});

			expect(
				await screen.findByText('Auth token recovered! Your registration is complete.')
			).toBeInTheDocument();
			expect(onSave).toHaveBeenCalledWith(
				expect.objectContaining({
					authToken: 'mounted-recovery-token',
					emailConfirmed: true,
				})
			);
		});

		it('should show manual recovery fallback when mount recovery fails', async () => {
			vi.mocked(window.maestro.leaderboard.pollAuthStatus).mockRejectedValueOnce(
				new Error('poll failed')
			);

			renderModal({
				existingRegistration: confirmedRegistration({ authToken: undefined }),
			});

			expect(
				await screen.findByPlaceholderText('Paste your 64-character auth token')
			).toBeInTheDocument();
			expect(
				screen.getByText(/Your email is confirmed but we seem to have lost your auth token/)
			).toBeInTheDocument();
		});

		it('should resend confirmation and resume polling', async () => {
			vi.mocked(window.maestro.leaderboard.pollAuthStatus).mockResolvedValue({ status: 'pending' });
			vi.mocked(window.maestro.leaderboard.resendConfirmation).mockResolvedValueOnce({
				success: true,
				message: 'Confirmation email queued.',
			});

			const { unmount } = renderModal({
				existingRegistration: confirmedRegistration({ authToken: undefined }),
			});

			await screen.findByPlaceholderText('Paste your 64-character auth token');
			const resendButton = screen.getByRole('button', { name: /Resend Confirmation Email/ });
			await act(async () => {
				fireEvent.click(resendButton);
			});

			await waitFor(() => {
				expect(window.maestro.leaderboard.resendConfirmation).toHaveBeenCalledWith({
					email: 'existing@example.com',
					clientToken: 'existing-client-token',
				});
			});
			expect(await screen.findByText('Confirmation email queued.')).toBeInTheDocument();

			unmount();
		});

		it('should show resend confirmation errors', async () => {
			vi.mocked(window.maestro.leaderboard.pollAuthStatus).mockResolvedValue({ status: 'pending' });
			vi.mocked(window.maestro.leaderboard.resendConfirmation).mockResolvedValueOnce({
				success: false,
				error: 'Cannot resend yet',
			});

			renderModal({
				existingRegistration: confirmedRegistration({ authToken: undefined }),
			});

			await screen.findByPlaceholderText('Paste your 64-character auth token');
			const resendButton = screen.getByRole('button', { name: /Resend Confirmation Email/ });
			await act(async () => {
				fireEvent.click(resendButton);
			});

			expect(await screen.findByText('Cannot resend yet')).toBeInTheDocument();
		});

		it('should show resend confirmation exceptions', async () => {
			vi.mocked(window.maestro.leaderboard.pollAuthStatus).mockResolvedValue({ status: 'pending' });
			vi.mocked(window.maestro.leaderboard.resendConfirmation).mockRejectedValueOnce(
				new Error('resend transport failed')
			);

			renderModal({
				existingRegistration: confirmedRegistration({ authToken: undefined }),
			});

			await screen.findByPlaceholderText('Paste your 64-character auth token');
			const resendButton = screen.getByRole('button', { name: /Resend Confirmation Email/ });
			await act(async () => {
				fireEvent.click(resendButton);
			});

			expect(await screen.findByText('resend transport failed')).toBeInTheDocument();
		});

		it('should skip resend when the defensive email guard sees an empty email', async () => {
			vi.mocked(window.maestro.leaderboard.pollAuthStatus).mockResolvedValue({ status: 'pending' });

			renderModal({
				existingRegistration: confirmedRegistration({ email: '', authToken: undefined }),
			});

			await screen.findByPlaceholderText('Paste your 64-character auth token');
			const resendButton = screen.getByRole('button', { name: /Resend Confirmation Email/ });
			resendButton.removeAttribute('disabled');
			resendButton.disabled = false;
			fireEvent.click(resendButton);

			expect(window.maestro.leaderboard.resendConfirmation).not.toHaveBeenCalled();
		});

		it('should pull down newer server stats', async () => {
			const onSyncStats = vi.fn();
			vi.mocked(window.maestro.leaderboard.sync).mockResolvedValueOnce({
				success: true,
				found: true,
				data: {
					cumulativeTimeMs: 7_500_000,
					totalRuns: 12,
					badgeLevel: 3,
					longestRunMs: 600_000,
					longestRunDate: '2026-06-18',
				},
			});

			renderModal({
				existingRegistration: confirmedRegistration(),
				onSyncStats,
			});

			await act(async () => {
				fireEvent.click(screen.getByText('Pull Down'));
			});

			await waitFor(() => {
				expect(onSyncStats).toHaveBeenCalledWith(
					expect.objectContaining({
						cumulativeTimeMs: 7_500_000,
						totalRuns: 12,
						currentBadgeLevel: 3,
						longestRunMs: 600_000,
					})
				);
			});
			expect(screen.getByText(/Synced! Updated to 2h 5m from server/)).toBeInTheDocument();
		});

		it('should skip sync when the defensive email guard sees an empty email', () => {
			const onSyncStats = vi.fn();

			renderModal({
				existingRegistration: confirmedRegistration({ email: '' }),
				onSyncStats,
			});

			fireEvent.click(screen.getByText('Pull Down'));

			expect(window.maestro.leaderboard.sync).not.toHaveBeenCalled();
		});

		it('should report sync states for matched, missing, and rejected server records', async () => {
			const onSyncStats = vi.fn();
			const existingRegistration = confirmedRegistration();
			const { rerender } = renderModal({ existingRegistration, onSyncStats });

			vi.mocked(window.maestro.leaderboard.sync).mockResolvedValueOnce({
				success: true,
				found: true,
				data: {
					cumulativeTimeMs: autoRunStats.cumulativeTimeMs,
					totalRuns: 5,
					badgeLevel: 1,
				},
			});
			await act(async () => {
				fireEvent.click(screen.getByText('Pull Down'));
			});
			expect(
				await screen.findByText('Already in sync! Local and server stats match.')
			).toBeInTheDocument();

			vi.mocked(window.maestro.leaderboard.sync).mockResolvedValueOnce({
				success: true,
				found: false,
			});
			await act(async () => {
				fireEvent.click(screen.getByText('Pull Down'));
			});
			expect(
				await screen.findByText('No server record found. Submit your first entry to create one!')
			).toBeInTheDocument();

			vi.mocked(window.maestro.leaderboard.sync).mockResolvedValueOnce({
				success: false,
				errorCode: 'EMAIL_NOT_CONFIRMED',
			});
			await act(async () => {
				fireEvent.click(screen.getByText('Pull Down'));
			});
			expect(
				await screen.findByText(
					'Email not yet confirmed. Please check your inbox for the confirmation email.'
				)
			).toBeInTheDocument();

			vi.mocked(window.maestro.leaderboard.sync).mockResolvedValueOnce({
				success: false,
				errorCode: 'INVALID_TOKEN',
			});
			await act(async () => {
				fireEvent.click(screen.getByText('Pull Down'));
			});
			expect(
				await screen.findByText('Invalid auth token. Please re-register to get a new token.')
			).toBeInTheDocument();

			vi.mocked(window.maestro.leaderboard.sync).mockResolvedValueOnce({
				success: false,
				error: 'Generic sync failure',
			});
			await act(async () => {
				fireEvent.click(screen.getByText('Pull Down'));
			});
			expect(await screen.findByText('Generic sync failure')).toBeInTheDocument();

			vi.mocked(window.maestro.leaderboard.sync).mockRejectedValueOnce(
				new Error('sync transport failed')
			);
			await act(async () => {
				fireEvent.click(screen.getByText('Pull Down'));
			});
			expect(await screen.findByText('sync transport failed')).toBeInTheDocument();

			rerender(
				<LeaderboardRegistrationModal
					theme={theme}
					autoRunStats={createAutoRunStats({ cumulativeTimeMs: 9_000_000 })}
					keyboardMasteryStats={keyboardMasteryStats}
					existingRegistration={existingRegistration}
					onClose={onClose}
					onSave={onSave}
					onOptOut={onOptOut}
					onSyncStats={onSyncStats}
				/>
			);
			vi.mocked(window.maestro.leaderboard.sync).mockResolvedValueOnce({
				success: true,
				found: true,
				data: {
					cumulativeTimeMs: 1_000,
					totalRuns: 1,
					badgeLevel: 0,
				},
			});
			await act(async () => {
				fireEvent.click(screen.getByText('Pull Down'));
			});
			expect(await screen.findByText(/Local is ahead \(2h 30m\)/)).toBeInTheDocument();
		});
	});

	describe('Footer actions and keyboard shortcuts', () => {
		it('should open the public leaderboard link externally', () => {
			renderModal();

			fireEvent.click(screen.getByText('runmaestro.ai'));

			expect(window.maestro.shell.openExternal).toHaveBeenCalledWith(
				expect.stringMatching(/^https:\/\/runmaestro\.ai/)
			);
		});

		it('should submit from Enter when the form is valid and idle', async () => {
			renderModal();

			await fillRequiredFields();
			await act(async () => {
				fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Enter' });
			});

			await waitFor(() => {
				expect(window.maestro.leaderboard.submit).toHaveBeenCalled();
			});
		});

		it('should ignore shifted Enter', async () => {
			renderModal();

			await fillRequiredFields();
			await act(async () => {
				fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Enter', shiftKey: true });
			});

			expect(window.maestro.leaderboard.submit).not.toHaveBeenCalled();
		});

		it('should confirm and cancel opt-out', async () => {
			const existingRegistration: LeaderboardRegistration = {
				displayName: 'Opt User',
				email: 'opt@example.com',
				registeredAt: 123,
				emailConfirmed: true,
				authToken: 'auth-token',
			};

			renderModal({ existingRegistration });

			fireEvent.click(screen.getByText('Opt Out'));
			expect(
				screen.getByText(
					'Are you sure you want to remove yourself from the leaderboard? This will request removal of your entry from runmaestro.ai.'
				)
			).toBeInTheDocument();

			fireEvent.click(screen.getByText('Keep Registration'));
			expect(screen.queryByText('Yes, Remove Me')).not.toBeInTheDocument();

			fireEvent.click(screen.getByText('Opt Out'));
			fireEvent.click(screen.getByText('Yes, Remove Me'));

			expect(onOptOut).toHaveBeenCalled();
			expect(
				screen.getByText('You have opted out of the leaderboard. Your local stats are preserved.')
			).toBeInTheDocument();
		});
	});

	describe('Field disabled state', () => {
		it('should have Bluesky field enabled when not submitting', () => {
			render(
				<LeaderboardRegistrationModal
					theme={theme}
					autoRunStats={autoRunStats}
					keyboardMasteryStats={keyboardMasteryStats}
					existingRegistration={null}
					onClose={onClose}
					onSave={onSave}
				/>
			);

			// Verify Bluesky field is initially enabled
			const blueskyInput = screen.getByPlaceholderText('username.bsky.social');
			expect(blueskyInput).not.toBeDisabled();
		});
	});

	describe('Theme styling', () => {
		it('should apply theme colors to Bluesky input', () => {
			render(
				<LeaderboardRegistrationModal
					theme={theme}
					autoRunStats={autoRunStats}
					keyboardMasteryStats={keyboardMasteryStats}
					existingRegistration={null}
					onClose={onClose}
					onSave={onSave}
				/>
			);

			const blueskyInput = screen.getByPlaceholderText('username.bsky.social');
			expect(blueskyInput).toHaveStyle({
				backgroundColor: theme.colors.bgActivity,
				borderColor: theme.colors.border,
				color: theme.colors.textMain,
			});
		});

		it('should apply theme colors to Bluesky icon', () => {
			render(
				<LeaderboardRegistrationModal
					theme={theme}
					autoRunStats={autoRunStats}
					keyboardMasteryStats={keyboardMasteryStats}
					existingRegistration={null}
					onClose={onClose}
					onSave={onSave}
				/>
			);

			const blueskyInput = screen.getByPlaceholderText('username.bsky.social');
			const iconContainer = blueskyInput.parentElement?.querySelector('svg');
			expect(iconContainer).toHaveStyle({ color: theme.colors.textDim });
		});
	});

	describe('Layer stack integration', () => {
		it('should register layer on mount', () => {
			render(
				<LeaderboardRegistrationModal
					theme={theme}
					autoRunStats={autoRunStats}
					keyboardMasteryStats={keyboardMasteryStats}
					existingRegistration={null}
					onClose={onClose}
					onSave={onSave}
				/>
			);

			expect(mockRegisterLayer).toHaveBeenCalledTimes(1);
			expect(mockRegisterLayer).toHaveBeenCalledWith(
				expect.objectContaining({
					type: 'modal',
				})
			);
		});

		it('should invoke the current close handler through the registered escape callback', () => {
			renderModal();

			const layer = mockRegisterLayer.mock.calls[0]?.[0];
			layer.onEscape();

			expect(onClose).toHaveBeenCalled();
		});

		it('should unregister layer on unmount', () => {
			const { unmount } = render(
				<LeaderboardRegistrationModal
					theme={theme}
					autoRunStats={autoRunStats}
					keyboardMasteryStats={keyboardMasteryStats}
					existingRegistration={null}
					onClose={onClose}
					onSave={onSave}
				/>
			);

			unmount();

			expect(mockUnregisterLayer).toHaveBeenCalledWith('layer-leaderboard-123');
		});
	});
});
