/**
 * @fileoverview Tests for LeaderboardRegistrationModal component
 * Tests: Bluesky field rendering, @ prefix stripping, form submission, state persistence
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { LeaderboardRegistrationModal } from '../../../renderer/components/LeaderboardRegistrationModal';
import type { Theme, AutoRunStats, LeaderboardRegistration } from '../../../renderer/types';
import type { KeyboardMasteryStats } from '../../../shared/types';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';

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

	beforeEach(() => {
		theme = createTheme();
		autoRunStats = createAutoRunStats();
		keyboardMasteryStats = createKeyboardMasteryStats();
		onClose = vi.fn();
		onSave = vi.fn();

		// Mock leaderboard API
		vi.mocked(window.maestro.leaderboard.submit).mockResolvedValue({
			success: true,
			rank: 42,
		});

		// Reset layer stack mocks
		mockRegisterLayer.mockClear().mockReturnValue('layer-leaderboard-123');
		mockUnregisterLayer.mockClear();
	});

	afterEach(() => {
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

// Issue #2011: the server resolves auth-status by clientToken alone, so an
// install that confirmed two emails got the OLD email's auth token back and
// every submit and Pull Down for the new email returned 401.
describe('LeaderboardRegistrationModal install binding (#2011)', () => {
	const OLD_CLIENT_TOKEN = 'client-token-bound-to-old-email';

	const baseRegistration = (): LeaderboardRegistration => ({
		displayName: 'Maesbro',
		email: 'new@example.com',
		registeredAt: 1,
		emailConfirmed: true,
		clientToken: OLD_CLIENT_TOKEN,
		authToken: 'old-email-token',
	});

	const renderModal = (existingRegistration: LeaderboardRegistration, onSave = vi.fn()) => {
		useSettingsStore.setState({ leaderboardRegistration: existingRegistration });
		render(
			<LeaderboardRegistrationModal
				theme={createTheme()}
				autoRunStats={createAutoRunStats()}
				keyboardMasteryStats={createKeyboardMasteryStats()}
				existingRegistration={existingRegistration}
				onClose={vi.fn()}
				onSave={onSave}
				onSyncStats={vi.fn()}
			/>
		);
		return onSave;
	};

	afterEach(() => {
		useSettingsStore.setState({ leaderboardRegistration: null });
		vi.clearAllMocks();
	});

	it('starts a changed email on a fresh clientToken without the old auth token', async () => {
		vi.mocked(window.maestro.leaderboard.submit).mockResolvedValueOnce({
			success: true,
			message: 'ok',
			pendingEmailConfirmation: true,
		});
		vi.mocked(window.maestro.leaderboard.pollAuthStatus).mockResolvedValue({
			status: 'pending',
		});
		renderModal({ ...baseRegistration(), email: 'old@example.com' });

		const emailInput = screen.getByDisplayValue('old@example.com');
		fireEvent.change(emailInput, { target: { value: 'new@example.com' } });
		await act(async () => {
			fireEvent.click(screen.getByText('Push Up'));
		});

		await waitFor(() => expect(window.maestro.leaderboard.submit).toHaveBeenCalled());
		const sent = vi.mocked(window.maestro.leaderboard.submit).mock.calls[0][0];
		expect(sent.email).toBe('new@example.com');
		expect(sent.authToken).toBeUndefined();
		expect(sent.clientToken).toBeTruthy();
		expect(sent.clientToken).not.toBe(OLD_CLIENT_TOKEN);
		expect(window.maestro.leaderboard.pollAuthStatus).toHaveBeenCalledWith(sent.clientToken);
	});

	it('keeps the clientToken and auth token when only the email case differs', async () => {
		renderModal({ ...baseRegistration(), email: 'New@Example.com' });

		await act(async () => {
			fireEvent.click(screen.getByText('Push Up'));
		});

		await waitFor(() => expect(window.maestro.leaderboard.submit).toHaveBeenCalled());
		const sent = vi.mocked(window.maestro.leaderboard.submit).mock.calls[0][0];
		expect(sent.clientToken).toBe(OLD_CLIENT_TOKEN);
		expect(sent.authToken).toBe('old-email-token');
	});

	it('rebinds instead of retrying when a 401 recovery returns another email token', async () => {
		vi.mocked(window.maestro.leaderboard.submit).mockResolvedValueOnce({
			success: false,
			message: 'Authentication required',
			error: 'Invalid auth token',
			authTokenRequired: true,
		});
		vi.mocked(window.maestro.leaderboard.pollAuthStatus).mockResolvedValueOnce({
			status: 'confirmed',
			authToken: 'old-email-token',
			email: 'old@example.com',
		});
		const onSave = renderModal(baseRegistration());

		await act(async () => {
			fireEvent.click(screen.getByText('Push Up'));
		});

		await waitFor(() =>
			expect(screen.getByRole('button', { name: /Resend Confirmation Email/ })).toBeInTheDocument()
		);
		// No retry with the wrong token.
		expect(window.maestro.leaderboard.submit).toHaveBeenCalledTimes(1);
		const saved = onSave.mock.calls.at(-1)?.[0] as LeaderboardRegistration;
		expect(saved.authToken).toBeUndefined();
		expect(saved.clientToken).toBeTruthy();
		expect(saved.clientToken).not.toBe(OLD_CLIENT_TOKEN);

		// Resend now binds the fresh clientToken to this email.
		await act(async () => {
			fireEvent.click(screen.getByRole('button', { name: /Resend Confirmation Email/ }));
		});
		expect(window.maestro.leaderboard.resendConfirmation).toHaveBeenCalledWith({
			email: 'new@example.com',
			clientToken: saved.clientToken,
		});
	});

	it('does not store a polled token that belongs to another email', async () => {
		vi.mocked(window.maestro.leaderboard.submit).mockResolvedValueOnce({
			success: true,
			message: 'ok',
			pendingEmailConfirmation: true,
		});
		vi.mocked(window.maestro.leaderboard.pollAuthStatus).mockResolvedValueOnce({
			status: 'confirmed',
			authToken: 'old-email-token',
			email: 'old@example.com',
		});
		const onSave = renderModal({ ...baseRegistration(), authToken: undefined });

		await act(async () => {
			fireEvent.click(screen.getByText('Push Up'));
		});

		await waitFor(() =>
			expect(screen.getByRole('button', { name: /Resend Confirmation Email/ })).toBeInTheDocument()
		);
		expect(screen.queryByText(/Email confirmed!/)).not.toBeInTheDocument();
		for (const [registration] of onSave.mock.calls) {
			expect((registration as LeaderboardRegistration).authToken).not.toBe('old-email-token');
		}
	});

	it('surfaces a Pull Down 401 and offers Resend Confirmation', async () => {
		vi.mocked(window.maestro.leaderboard.sync).mockResolvedValueOnce({
			success: false,
			found: false,
			error: 'Invalid auth token',
			errorCode: 'INVALID_TOKEN',
		});
		const onSave = renderModal(baseRegistration());

		await act(async () => {
			fireEvent.click(screen.getByText('Pull Down'));
		});

		await waitFor(() =>
			expect(screen.getByText(/did not accept this install's auth token/)).toBeInTheDocument()
		);
		expect(screen.getByRole('button', { name: /Resend Confirmation Email/ })).toBeInTheDocument();
		const saved = onSave.mock.calls.at(-1)?.[0] as LeaderboardRegistration;
		expect(saved.authToken).toBeUndefined();
		expect(saved.clientToken).not.toBe(OLD_CLIENT_TOKEN);
	});
});
