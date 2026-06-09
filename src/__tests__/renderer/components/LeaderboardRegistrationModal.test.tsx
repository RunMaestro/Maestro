/**
 * @fileoverview Tests for LeaderboardRegistrationModal component
 * Tests: Bluesky field rendering, @ prefix stripping, form submission, state persistence
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
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

		it('opens the public leaderboard link in the system browser', () => {
			vi.mocked(window.maestro.shell.openExternal).mockResolvedValue(undefined);

			render(
				<LeaderboardRegistrationModal
					theme={theme}
					autoRunStats={autoRunStats}
					keyboardMasteryStats={keyboardMasteryStats}
					existingRegistration={null}
					onClose={onClose}
					onSave={onSave}
					onOptOut={vi.fn()}
				/>
			);

			fireEvent.click(screen.getByRole('button', { name: /runmaestro\.ai/i }));

			expect(window.maestro.shell.openExternal).toHaveBeenCalledWith('https://runmaestro.ai');
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

		it('submits with Enter and strips leading @ from optional social handles', async () => {
			render(
				<LeaderboardRegistrationModal
					theme={theme}
					autoRunStats={autoRunStats}
					keyboardMasteryStats={keyboardMasteryStats}
					existingRegistration={null}
					onClose={onClose}
					onSave={onSave}
					onOptOut={vi.fn()}
				/>
			);

			fireEvent.change(screen.getByPlaceholderText('ConductorPedram'), {
				target: { value: 'Keyboard User' },
			});
			fireEvent.change(screen.getByPlaceholderText('conductor@maestro.ai'), {
				target: { value: 'keyboard@example.com' },
			});
			const usernameInputs = screen.getAllByPlaceholderText('username');
			fireEvent.change(usernameInputs[0], { target: { value: '@octocat' } });
			fireEvent.change(screen.getByPlaceholderText('handle'), { target: { value: '@maestro' } });
			fireEvent.change(usernameInputs[1], { target: { value: '@linkedin-user' } });
			fireEvent.change(screen.getByPlaceholderText('username#1234 or username'), {
				target: { value: '@discord-user' },
			});

			await act(async () => {
				fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Enter' });
			});

			await waitFor(() => {
				expect(window.maestro.leaderboard.submit).toHaveBeenCalledWith(
					expect.objectContaining({
						displayName: 'Keyboard User',
						email: 'keyboard@example.com',
						githubUsername: 'octocat',
						twitterHandle: 'maestro',
						linkedinHandle: 'linkedin-user',
						discordUsername: 'discord-user',
					})
				);
			});
		});

		it('submits edge-case stats with fallback keyboard title and omitted zero longest run', async () => {
			render(
				<LeaderboardRegistrationModal
					theme={theme}
					autoRunStats={createAutoRunStats({ longestRunMs: 0 })}
					keyboardMasteryStats={createKeyboardMasteryStats({
						currentLevel: 99,
						usedShortcuts: [],
					})}
					existingRegistration={null}
					onClose={onClose}
					onSave={onSave}
					onOptOut={vi.fn()}
				/>
			);

			fireEvent.change(screen.getByPlaceholderText('ConductorPedram'), {
				target: { value: 'Fallback User' },
			});
			fireEvent.change(screen.getByPlaceholderText('conductor@maestro.ai'), {
				target: { value: 'fallback@example.com' },
			});
			fireEvent.click(screen.getByRole('button', { name: 'Push Up' }));

			await waitFor(() => {
				expect(window.maestro.leaderboard.submit).toHaveBeenCalledWith(
					expect.objectContaining({
						keyboardMasteryTitle: 'Beginner',
						keyboardMasteryLevel: 100,
						keyboardKeysUnlocked: 0,
						longestRunMs: undefined,
					})
				);
			});
		});

		it('shows invalid email feedback and does not submit invalid Enter attempts', () => {
			render(
				<LeaderboardRegistrationModal
					theme={theme}
					autoRunStats={autoRunStats}
					keyboardMasteryStats={keyboardMasteryStats}
					existingRegistration={null}
					onClose={onClose}
					onSave={onSave}
					onOptOut={vi.fn()}
				/>
			);

			fireEvent.change(screen.getByPlaceholderText('ConductorPedram'), {
				target: { value: 'Invalid User' },
			});
			fireEvent.change(screen.getByPlaceholderText('conductor@maestro.ai'), {
				target: { value: 'invalid-email' },
			});
			fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Enter' });

			expect(screen.getByText('Please enter a valid email address')).toBeInTheDocument();
			expect(window.maestro.leaderboard.submit).not.toHaveBeenCalled();
		});

		it('shows API submission errors for new registrations', async () => {
			vi.mocked(window.maestro.leaderboard.submit).mockResolvedValue({
				success: false,
				error: 'Leaderboard rejected the payload',
			});

			render(
				<LeaderboardRegistrationModal
					theme={theme}
					autoRunStats={autoRunStats}
					keyboardMasteryStats={keyboardMasteryStats}
					existingRegistration={null}
					onClose={onClose}
					onSave={onSave}
					onOptOut={vi.fn()}
				/>
			);

			fireEvent.change(screen.getByPlaceholderText('ConductorPedram'), {
				target: { value: 'Rejected User' },
			});
			fireEvent.change(screen.getByPlaceholderText('conductor@maestro.ai'), {
				target: { value: 'rejected@example.com' },
			});
			fireEvent.click(screen.getByRole('button', { name: 'Push Up' }));

			expect(await screen.findByText('Leaderboard rejected the payload')).toBeInTheDocument();
		});

		it('shows thrown submission errors for new registrations', async () => {
			vi.mocked(window.maestro.leaderboard.submit).mockRejectedValue(
				new Error('Submission request failed')
			);

			render(
				<LeaderboardRegistrationModal
					theme={theme}
					autoRunStats={autoRunStats}
					keyboardMasteryStats={keyboardMasteryStats}
					existingRegistration={null}
					onClose={onClose}
					onSave={onSave}
					onOptOut={vi.fn()}
				/>
			);

			fireEvent.change(screen.getByPlaceholderText('ConductorPedram'), {
				target: { value: 'Throwing User' },
			});
			fireEvent.change(screen.getByPlaceholderText('conductor@maestro.ai'), {
				target: { value: 'throwing@example.com' },
			});
			fireEvent.click(screen.getByRole('button', { name: 'Push Up' }));

			expect(await screen.findByText('Submission request failed')).toBeInTheDocument();
		});

		it('uses message, default, and non-Error fallbacks for new registration failures', async () => {
			const renderNewRegistration = (displayName: string, email: string) => {
				const result = render(
					<LeaderboardRegistrationModal
						theme={theme}
						autoRunStats={autoRunStats}
						keyboardMasteryStats={keyboardMasteryStats}
						existingRegistration={null}
						onClose={onClose}
						onSave={onSave}
						onOptOut={vi.fn()}
					/>
				);
				fireEvent.change(screen.getByPlaceholderText('ConductorPedram'), {
					target: { value: displayName },
				});
				fireEvent.change(screen.getByPlaceholderText('conductor@maestro.ai'), {
					target: { value: email },
				});
				fireEvent.click(screen.getByRole('button', { name: 'Push Up' }));
				return result;
			};

			vi.mocked(window.maestro.leaderboard.submit).mockResolvedValueOnce({
				success: false,
				message: 'Payload message only',
			});
			const first = renderNewRegistration('Message User', 'message@example.com');
			expect(await screen.findByText('Payload message only')).toBeInTheDocument();
			first.unmount();

			vi.mocked(window.maestro.leaderboard.submit).mockResolvedValueOnce({
				success: false,
			});
			const second = renderNewRegistration('Default User', 'default@example.com');
			expect(await screen.findByText('Submission failed')).toBeInTheDocument();
			second.unmount();

			vi.mocked(window.maestro.leaderboard.submit).mockRejectedValueOnce('plain failure');
			renderNewRegistration('Plain User', 'plain@example.com');
			expect(await screen.findByText('An unexpected error occurred')).toBeInTheDocument();
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

		it('does not unregister when layer registration does not return an id', () => {
			mockRegisterLayer.mockReturnValueOnce(undefined as unknown as string);

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

			expect(mockUnregisterLayer).not.toHaveBeenCalled();
		});

		it('routes layer Escape through the latest close callback', () => {
			render(
				<LeaderboardRegistrationModal
					theme={theme}
					autoRunStats={autoRunStats}
					keyboardMasteryStats={keyboardMasteryStats}
					existingRegistration={null}
					onClose={onClose}
					onSave={onSave}
					onOptOut={vi.fn()}
				/>
			);

			const onEscape = mockRegisterLayer.mock.calls.at(-1)?.[0].onEscape as () => void;
			onEscape();

			expect(onClose).toHaveBeenCalledOnce();
		});
	});

	describe('Auth recovery and sync flows', () => {
		const confirmedWithoutAuthToken = (): LeaderboardRegistration => ({
			displayName: 'Confirmed User',
			email: 'confirmed@example.com',
			registeredAt: 1700000000000,
			emailConfirmed: true,
			clientToken: 'client-token-1',
		});

		it('recovers a missing auth token on mount when the server has it', async () => {
			vi.mocked(window.maestro.leaderboard.pollAuthStatus).mockResolvedValue({
				status: 'confirmed',
				authToken: 'recovered-auth-token',
			});

			render(
				<LeaderboardRegistrationModal
					theme={theme}
					autoRunStats={autoRunStats}
					keyboardMasteryStats={keyboardMasteryStats}
					existingRegistration={confirmedWithoutAuthToken()}
					onClose={onClose}
					onSave={onSave}
				/>
			);

			expect(screen.getByText('Checking for your auth token...')).toBeInTheDocument();

			await waitFor(() => {
				expect(onSave).toHaveBeenCalledWith(
					expect.objectContaining({
						emailConfirmed: true,
						authToken: 'recovered-auth-token',
					})
				);
			});
			expect(
				screen.getByText('Auth token recovered! Your registration is complete.')
			).toBeInTheDocument();
		});

		it('falls back to manual token entry and submits with the entered token', async () => {
			vi.mocked(window.maestro.leaderboard.pollAuthStatus).mockResolvedValue({ status: 'pending' });
			vi.mocked(window.maestro.leaderboard.submit).mockResolvedValue({ success: true });

			render(
				<LeaderboardRegistrationModal
					theme={theme}
					autoRunStats={{ ...autoRunStats, longestRunTimestamp: 1710000000000 }}
					keyboardMasteryStats={keyboardMasteryStats}
					existingRegistration={confirmedWithoutAuthToken()}
					onClose={onClose}
					onSave={onSave}
				/>
			);

			expect(
				await screen.findByText(/Your email is confirmed but we seem to have lost/)
			).toBeInTheDocument();

			fireEvent.change(screen.getByPlaceholderText('Paste your 64-character auth token'), {
				target: { value: 'manual-auth-token' },
			});
			fireEvent.click(screen.getByRole('button', { name: 'Submit' }));

			await waitFor(() => {
				expect(window.maestro.leaderboard.submit).toHaveBeenCalledWith(
					expect.objectContaining({
						authToken: 'manual-auth-token',
						longestRunDate: '2024-03-09',
					})
				);
			});
			expect(onSave).toHaveBeenCalledWith(
				expect.objectContaining({
					authToken: 'manual-auth-token',
					emailConfirmed: true,
				})
			);
			expect(
				await screen.findByText(
					'Your profile has been updated! Use "Pull Down" to sync stats from the server.'
				)
			).toBeInTheDocument();
		});

		it('recovers a required auth token during push and retries submission', async () => {
			vi.mocked(window.maestro.leaderboard.submit)
				.mockResolvedValueOnce({ success: false, authTokenRequired: true })
				.mockResolvedValueOnce({ success: true });
			vi.mocked(window.maestro.leaderboard.pollAuthStatus).mockResolvedValue({
				status: 'confirmed',
				authToken: 'retry-auth-token',
			});

			render(
				<LeaderboardRegistrationModal
					theme={theme}
					autoRunStats={{ ...autoRunStats, longestRunTimestamp: 1710000000000 }}
					keyboardMasteryStats={keyboardMasteryStats}
					existingRegistration={confirmedWithoutAuthToken()}
					onClose={onClose}
					onSave={onSave}
				/>
			);

			await waitFor(() => {
				expect(window.maestro.leaderboard.pollAuthStatus).toHaveBeenCalled();
			});

			fireEvent.click(screen.getByRole('button', { name: 'Push Up' }));

			await waitFor(() => {
				expect(window.maestro.leaderboard.submit).toHaveBeenCalledTimes(2);
			});
			expect(window.maestro.leaderboard.submit).toHaveBeenLastCalledWith(
				expect.objectContaining({
					authToken: 'retry-auth-token',
					longestRunDate: '2024-03-09',
				})
			);
			expect(
				screen.getByText('Auth token recovered and stats submitted successfully!')
			).toBeInTheDocument();
		});

		it('falls back to manual token entry when recovered-token retry fails', async () => {
			vi.mocked(window.maestro.leaderboard.submit)
				.mockResolvedValueOnce({ success: false, authTokenRequired: true })
				.mockResolvedValueOnce({ success: false, error: 'Recovered token rejected' });
			vi.mocked(window.maestro.leaderboard.pollAuthStatus).mockResolvedValue({
				status: 'confirmed',
				authToken: 'retry-auth-token',
			});

			render(
				<LeaderboardRegistrationModal
					theme={theme}
					autoRunStats={autoRunStats}
					keyboardMasteryStats={keyboardMasteryStats}
					existingRegistration={confirmedWithoutAuthToken()}
					onClose={onClose}
					onSave={onSave}
					onOptOut={vi.fn()}
				/>
			);

			await waitFor(() => {
				expect(window.maestro.leaderboard.pollAuthStatus).toHaveBeenCalled();
			});

			fireEvent.click(screen.getByRole('button', { name: 'Push Up' }));

			await waitFor(() => {
				expect(window.maestro.leaderboard.submit).toHaveBeenCalledTimes(2);
			});
			expect(
				await screen.findByPlaceholderText('Paste your 64-character auth token')
			).toBeInTheDocument();
			expect(await screen.findByText('Recovered token rejected')).toBeInTheDocument();
		});

		it('falls back to manual token entry when push recovery finds no confirmed token', async () => {
			vi.mocked(window.maestro.leaderboard.submit).mockResolvedValueOnce({
				success: false,
				authTokenRequired: true,
			});
			vi.mocked(window.maestro.leaderboard.pollAuthStatus).mockResolvedValue({
				status: 'pending',
			});

			render(
				<LeaderboardRegistrationModal
					theme={theme}
					autoRunStats={autoRunStats}
					keyboardMasteryStats={keyboardMasteryStats}
					existingRegistration={{
						...confirmedWithoutAuthToken(),
						authToken: 'stale-auth-token',
					}}
					onClose={onClose}
					onSave={onSave}
					onOptOut={vi.fn()}
				/>
			);

			fireEvent.click(screen.getByRole('button', { name: 'Push Up' }));

			expect(
				await screen.findByText(/Your email is confirmed but we seem to have lost/)
			).toBeInTheDocument();
		});

		it('saves recovered tokens with new timestamps and omits zero longest-run stats', async () => {
			vi.mocked(window.maestro.leaderboard.submit)
				.mockResolvedValueOnce({ success: false, authTokenRequired: true })
				.mockResolvedValueOnce({ success: true });
			vi.mocked(window.maestro.leaderboard.pollAuthStatus).mockResolvedValue({
				status: 'confirmed',
				authToken: 'retry-auth-token',
			});

			render(
				<LeaderboardRegistrationModal
					theme={theme}
					autoRunStats={createAutoRunStats({ longestRunMs: 0 })}
					keyboardMasteryStats={keyboardMasteryStats}
					existingRegistration={{
						displayName: 'Confirmed User',
						email: 'confirmed@example.com',
						emailConfirmed: true,
						clientToken: 'client-token-1',
						authToken: 'stale-auth-token',
					}}
					onClose={onClose}
					onSave={onSave}
					onOptOut={vi.fn()}
				/>
			);

			fireEvent.click(screen.getByRole('button', { name: 'Push Up' }));

			await waitFor(() => {
				expect(onSave).toHaveBeenCalledWith(
					expect.objectContaining({
						registeredAt: expect.any(Number),
						authToken: 'retry-auth-token',
					})
				);
			});
			expect(window.maestro.leaderboard.submit).toHaveBeenLastCalledWith(
				expect.objectContaining({
					authToken: 'retry-auth-token',
					longestRunMs: undefined,
				})
			);
		});

		it('shows a default recovered-token retry error when the server omits one', async () => {
			vi.mocked(window.maestro.leaderboard.submit)
				.mockResolvedValueOnce({ success: false, authTokenRequired: true })
				.mockResolvedValueOnce({ success: false });
			vi.mocked(window.maestro.leaderboard.pollAuthStatus).mockResolvedValue({
				status: 'confirmed',
				authToken: 'retry-auth-token',
			});

			render(
				<LeaderboardRegistrationModal
					theme={theme}
					autoRunStats={autoRunStats}
					keyboardMasteryStats={keyboardMasteryStats}
					existingRegistration={{
						...confirmedWithoutAuthToken(),
						authToken: 'stale-auth-token',
					}}
					onClose={onClose}
					onSave={onSave}
					onOptOut={vi.fn()}
				/>
			);

			fireEvent.click(screen.getByRole('button', { name: 'Push Up' }));

			expect(await screen.findByText('Submission failed after token recovery')).toBeInTheDocument();
		});

		it('falls back to manual token entry when mount-time recovery throws', async () => {
			vi.mocked(window.maestro.leaderboard.pollAuthStatus).mockRejectedValue(
				new Error('Recovery unavailable')
			);

			render(
				<LeaderboardRegistrationModal
					theme={theme}
					autoRunStats={autoRunStats}
					keyboardMasteryStats={keyboardMasteryStats}
					existingRegistration={confirmedWithoutAuthToken()}
					onClose={onClose}
					onSave={onSave}
					onOptOut={vi.fn()}
				/>
			);

			expect(
				await screen.findByPlaceholderText('Paste your 64-character auth token')
			).toBeInTheDocument();
			expect(
				screen.getByText(/Your email is confirmed but we seem to have lost/)
			).toBeInTheDocument();
		});

		it('polls for email confirmation and saves the confirmed auth token', async () => {
			vi.mocked(window.maestro.leaderboard.submit).mockResolvedValue({
				success: true,
				pendingEmailConfirmation: true,
			});
			vi.mocked(window.maestro.leaderboard.pollAuthStatus).mockResolvedValue({
				status: 'confirmed',
				authToken: 'confirmed-auth-token',
			});

			render(
				<LeaderboardRegistrationModal
					theme={theme}
					autoRunStats={autoRunStats}
					keyboardMasteryStats={keyboardMasteryStats}
					existingRegistration={null}
					onClose={onClose}
					onSave={onSave}
					onOptOut={vi.fn()}
				/>
			);

			fireEvent.change(screen.getByPlaceholderText('ConductorPedram'), {
				target: { value: 'Confirming User' },
			});
			fireEvent.change(screen.getByPlaceholderText('conductor@maestro.ai'), {
				target: { value: 'confirming@example.com' },
			});
			fireEvent.click(screen.getByRole('button', { name: 'Push Up' }));

			await waitFor(() => {
				expect(window.maestro.leaderboard.pollAuthStatus).toHaveBeenCalled();
			});
			await waitFor(() => {
				expect(onSave).toHaveBeenLastCalledWith(
					expect.objectContaining({
						email: 'confirming@example.com',
						displayName: 'Confirming User',
						emailConfirmed: true,
						authToken: 'confirmed-auth-token',
					})
				);
			});
			expect(
				screen.getByText('Email confirmed! Your stats have been submitted to the leaderboard.')
			).toBeInTheDocument();
		});

		it('shows an expired confirmation error from polling', async () => {
			vi.mocked(window.maestro.leaderboard.submit).mockResolvedValue({
				success: true,
				pendingEmailConfirmation: true,
			});
			vi.mocked(window.maestro.leaderboard.pollAuthStatus).mockResolvedValue({
				status: 'expired',
			});

			render(
				<LeaderboardRegistrationModal
					theme={theme}
					autoRunStats={autoRunStats}
					keyboardMasteryStats={keyboardMasteryStats}
					existingRegistration={null}
					onClose={onClose}
					onSave={onSave}
					onOptOut={vi.fn()}
				/>
			);

			fireEvent.change(screen.getByPlaceholderText('ConductorPedram'), {
				target: { value: 'Expired User' },
			});
			fireEvent.change(screen.getByPlaceholderText('conductor@maestro.ai'), {
				target: { value: 'expired@example.com' },
			});
			fireEvent.click(screen.getByRole('button', { name: 'Push Up' }));

			expect(
				await screen.findByText(
					'Confirmation link expired. Please submit again to receive a new confirmation email.'
				)
			).toBeInTheDocument();
		});

		it('keeps polling after transient polling errors and cleans up the interval', async () => {
			vi.useFakeTimers();
			const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
			const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
			vi.mocked(window.maestro.leaderboard.submit).mockResolvedValue({
				success: true,
				pendingEmailConfirmation: true,
			});
			vi.mocked(window.maestro.leaderboard.pollAuthStatus)
				.mockResolvedValueOnce({ status: 'error', error: 'temporarily unavailable' })
				.mockRejectedValueOnce(new Error('Network down'))
				.mockResolvedValue({ status: 'pending' });

			try {
				const { unmount } = render(
					<LeaderboardRegistrationModal
						theme={theme}
						autoRunStats={autoRunStats}
						keyboardMasteryStats={keyboardMasteryStats}
						existingRegistration={null}
						onClose={onClose}
						onSave={onSave}
						onOptOut={vi.fn()}
					/>
				);

				fireEvent.change(screen.getByPlaceholderText('ConductorPedram'), {
					target: { value: 'Polling User' },
				});
				fireEvent.change(screen.getByPlaceholderText('conductor@maestro.ai'), {
					target: { value: 'polling@example.com' },
				});
				await act(async () => {
					fireEvent.click(screen.getByRole('button', { name: 'Push Up' }));
					await Promise.resolve();
				});
				expect(warn).toHaveBeenCalledWith('Polling error:', 'temporarily unavailable');

				await act(async () => {
					vi.advanceTimersByTime(5_000);
					await Promise.resolve();
				});
				expect(warn).toHaveBeenCalledWith('Poll request failed:', expect.any(Error));
				expect(screen.getByText(/Please check your email to confirm/i)).toBeInTheDocument();

				unmount();
				expect(clearIntervalSpy).toHaveBeenCalled();
			} finally {
				warn.mockRestore();
				clearIntervalSpy.mockRestore();
				vi.useRealTimers();
			}
		});

		it('resends confirmation after token recovery falls back to manual entry', async () => {
			vi.mocked(window.maestro.leaderboard.pollAuthStatus).mockResolvedValue({ status: 'pending' });
			vi.mocked(window.maestro.leaderboard.resendConfirmation).mockResolvedValue({
				success: true,
				message: 'Confirmation sent again',
			});

			render(
				<LeaderboardRegistrationModal
					theme={theme}
					autoRunStats={autoRunStats}
					keyboardMasteryStats={keyboardMasteryStats}
					existingRegistration={confirmedWithoutAuthToken()}
					onClose={onClose}
					onSave={onSave}
				/>
			);

			expect(
				await screen.findByRole('button', { name: /Resend Confirmation Email/i })
			).toBeInTheDocument();
			fireEvent.click(screen.getByRole('button', { name: /Resend Confirmation Email/i }));

			await waitFor(() => {
				expect(window.maestro.leaderboard.resendConfirmation).toHaveBeenCalledWith({
					email: 'confirmed@example.com',
					clientToken: 'client-token-1',
				});
			});
			expect(await screen.findByText('Confirmation sent again')).toBeInTheDocument();
		});

		it('reports resend confirmation failures from response and thrown errors', async () => {
			vi.mocked(window.maestro.leaderboard.pollAuthStatus).mockResolvedValue({ status: 'pending' });
			vi.mocked(window.maestro.leaderboard.resendConfirmation)
				.mockResolvedValueOnce({ success: false, error: 'SMTP unavailable' })
				.mockRejectedValueOnce(new Error('Network unavailable'));

			const { unmount } = render(
				<LeaderboardRegistrationModal
					theme={theme}
					autoRunStats={autoRunStats}
					keyboardMasteryStats={keyboardMasteryStats}
					existingRegistration={confirmedWithoutAuthToken()}
					onClose={onClose}
					onSave={onSave}
					onOptOut={vi.fn()}
				/>
			);

			const resendButton = await screen.findByRole('button', {
				name: /Resend Confirmation Email/i,
			});
			fireEvent.click(resendButton);
			expect(await screen.findByText('SMTP unavailable')).toBeInTheDocument();

			unmount();

			render(
				<LeaderboardRegistrationModal
					theme={theme}
					autoRunStats={autoRunStats}
					keyboardMasteryStats={keyboardMasteryStats}
					existingRegistration={confirmedWithoutAuthToken()}
					onClose={onClose}
					onSave={onSave}
					onOptOut={vi.fn()}
				/>
			);
			fireEvent.click(await screen.findByRole('button', { name: /Resend Confirmation Email/i }));
			expect(await screen.findByText('Network unavailable')).toBeInTheDocument();
		});

		it('uses default resend success, failure, and non-Error messages', async () => {
			const renderManualTokenRecovery = () =>
				render(
					<LeaderboardRegistrationModal
						theme={theme}
						autoRunStats={autoRunStats}
						keyboardMasteryStats={keyboardMasteryStats}
						existingRegistration={confirmedWithoutAuthToken()}
						onClose={onClose}
						onSave={onSave}
						onOptOut={vi.fn()}
					/>
				);

			vi.mocked(window.maestro.leaderboard.pollAuthStatus).mockResolvedValue({ status: 'pending' });
			vi.mocked(window.maestro.leaderboard.resendConfirmation).mockResolvedValueOnce({
				success: true,
			});
			const first = renderManualTokenRecovery();
			fireEvent.click(await screen.findByRole('button', { name: /Resend Confirmation Email/i }));
			expect(
				await screen.findByText(
					'Confirmation email sent! Please check your inbox and click the link to get your auth token.'
				)
			).toBeInTheDocument();
			first.unmount();

			vi.mocked(window.maestro.leaderboard.resendConfirmation).mockResolvedValueOnce({
				success: false,
			});
			const second = renderManualTokenRecovery();
			fireEvent.click(await screen.findByRole('button', { name: /Resend Confirmation Email/i }));
			expect(
				await screen.findByText('Failed to resend confirmation email. Please try again.')
			).toBeInTheDocument();
			second.unmount();

			vi.mocked(window.maestro.leaderboard.resendConfirmation).mockRejectedValueOnce(
				'plain resend failure'
			);
			renderManualTokenRecovery();
			fireEvent.click(await screen.findByRole('button', { name: /Resend Confirmation Email/i }));
			expect(await screen.findByText('Failed to resend confirmation email')).toBeInTheDocument();
		});

		it('reports manual auth-token submission failures', async () => {
			vi.mocked(window.maestro.leaderboard.pollAuthStatus).mockResolvedValue({ status: 'pending' });
			vi.mocked(window.maestro.leaderboard.submit).mockResolvedValue({
				success: false,
				error: 'Token rejected',
			});

			render(
				<LeaderboardRegistrationModal
					theme={theme}
					autoRunStats={autoRunStats}
					keyboardMasteryStats={keyboardMasteryStats}
					existingRegistration={confirmedWithoutAuthToken()}
					onClose={onClose}
					onSave={onSave}
					onOptOut={vi.fn()}
				/>
			);

			fireEvent.change(await screen.findByPlaceholderText('Paste your 64-character auth token'), {
				target: { value: 'bad-token' },
			});
			fireEvent.click(screen.getByRole('button', { name: 'Submit' }));

			expect(await screen.findByText('Token rejected')).toBeInTheDocument();
		});

		it('reports thrown manual auth-token submission failures', async () => {
			vi.mocked(window.maestro.leaderboard.pollAuthStatus).mockResolvedValue({ status: 'pending' });
			vi.mocked(window.maestro.leaderboard.submit).mockRejectedValue(
				new Error('Submit request failed')
			);

			render(
				<LeaderboardRegistrationModal
					theme={theme}
					autoRunStats={autoRunStats}
					keyboardMasteryStats={keyboardMasteryStats}
					existingRegistration={confirmedWithoutAuthToken()}
					onClose={onClose}
					onSave={onSave}
					onOptOut={vi.fn()}
				/>
			);

			fireEvent.change(await screen.findByPlaceholderText('Paste your 64-character auth token'), {
				target: { value: 'throwing-token' },
			});
			fireEvent.click(screen.getByRole('button', { name: 'Submit' }));

			expect(await screen.findByText('Submit request failed')).toBeInTheDocument();
		});

		it('submits manual tokens with fresh timestamps and zero-run fallbacks', async () => {
			vi.mocked(window.maestro.leaderboard.pollAuthStatus).mockResolvedValue({ status: 'pending' });
			vi.mocked(window.maestro.leaderboard.submit).mockResolvedValue({ success: true });

			render(
				<LeaderboardRegistrationModal
					theme={theme}
					autoRunStats={createAutoRunStats({ longestRunMs: 0 })}
					keyboardMasteryStats={keyboardMasteryStats}
					existingRegistration={{
						displayName: 'Confirmed User',
						email: 'confirmed@example.com',
						emailConfirmed: true,
						clientToken: 'client-token-1',
					}}
					onClose={onClose}
					onSave={onSave}
					onOptOut={vi.fn()}
				/>
			);

			fireEvent.change(await screen.findByPlaceholderText('Paste your 64-character auth token'), {
				target: { value: 'manual-auth-token' },
			});
			fireEvent.click(screen.getByRole('button', { name: 'Submit' }));

			await waitFor(() => {
				expect(window.maestro.leaderboard.submit).toHaveBeenCalledWith(
					expect.objectContaining({
						longestRunMs: undefined,
						authToken: 'manual-auth-token',
					})
				);
			});
			expect(onSave).toHaveBeenCalledWith(
				expect.objectContaining({
					registeredAt: expect.any(Number),
					authToken: 'manual-auth-token',
				})
			);
		});

		it('uses message, default, and non-Error fallbacks for manual token failures', async () => {
			const renderManualTokenSubmit = async (token: string) => {
				const result = render(
					<LeaderboardRegistrationModal
						theme={theme}
						autoRunStats={autoRunStats}
						keyboardMasteryStats={keyboardMasteryStats}
						existingRegistration={confirmedWithoutAuthToken()}
						onClose={onClose}
						onSave={onSave}
						onOptOut={vi.fn()}
					/>
				);
				const tokenInput = await screen.findByPlaceholderText('Paste your 64-character auth token');
				await act(async () => {
					fireEvent.change(tokenInput, {
						target: { value: token },
					});
					fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
					await Promise.resolve();
				});
				return result;
			};

			vi.mocked(window.maestro.leaderboard.pollAuthStatus).mockResolvedValue({ status: 'pending' });
			vi.mocked(window.maestro.leaderboard.submit).mockResolvedValueOnce({
				success: false,
				message: 'Manual token message only',
			});
			const first = await renderManualTokenSubmit('message-token');
			expect(await screen.findByText('Manual token message only')).toBeInTheDocument();
			first.unmount();

			vi.mocked(window.maestro.leaderboard.submit).mockResolvedValueOnce({
				success: false,
			});
			const second = await renderManualTokenSubmit('default-token');
			expect(
				await screen.findByText('Submission failed. Please check your auth token.')
			).toBeInTheDocument();
			second.unmount();

			vi.mocked(window.maestro.leaderboard.submit).mockRejectedValueOnce('plain manual failure');
			await renderManualTokenSubmit('plain-token');
			expect(await screen.findByText('An unexpected error occurred')).toBeInTheDocument();
		});

		it('syncs server stats down when the server is ahead', async () => {
			const onSyncStats = vi.fn();
			vi.mocked(window.maestro.leaderboard.sync).mockResolvedValue({
				success: true,
				found: true,
				data: {
					cumulativeTimeMs: 7_500_000,
					totalRuns: 8,
					badgeLevel: 2,
					longestRunMs: 600_000,
					longestRunDate: '2024-03-10',
				},
			});

			render(
				<LeaderboardRegistrationModal
					theme={theme}
					autoRunStats={{ ...autoRunStats, cumulativeTimeMs: 3_600_000 }}
					keyboardMasteryStats={keyboardMasteryStats}
					existingRegistration={{
						...confirmedWithoutAuthToken(),
						authToken: 'existing-auth-token',
					}}
					onClose={onClose}
					onSave={onSave}
					onSyncStats={onSyncStats}
				/>
			);

			fireEvent.click(screen.getByRole('button', { name: /Pull Down/i }));

			await waitFor(() => {
				expect(onSyncStats).toHaveBeenCalledWith({
					cumulativeTimeMs: 7_500_000,
					totalRuns: 8,
					currentBadgeLevel: 2,
					longestRunMs: 600_000,
					longestRunTimestamp: new Date('2024-03-10').getTime(),
				});
			});
			expect(screen.getByText(/Synced! Updated to 2h 5m from server/)).toBeInTheDocument();
		});

		it('syncs missing server optional stats with zero fallbacks', async () => {
			const onSyncStats = vi.fn();
			vi.mocked(window.maestro.leaderboard.sync).mockResolvedValue({
				success: true,
				found: true,
				data: {
					cumulativeTimeMs: 7_500_000,
					totalRuns: 8,
					badgeLevel: 2,
					longestRunMs: 0,
				},
			});

			render(
				<LeaderboardRegistrationModal
					theme={theme}
					autoRunStats={{ ...autoRunStats, cumulativeTimeMs: 3_600_000 }}
					keyboardMasteryStats={keyboardMasteryStats}
					existingRegistration={{
						...confirmedWithoutAuthToken(),
						authToken: 'existing-auth-token',
					}}
					onClose={onClose}
					onSave={onSave}
					onSyncStats={onSyncStats}
				/>
			);

			fireEvent.click(screen.getByRole('button', { name: /Pull Down/i }));

			await waitFor(() => {
				expect(onSyncStats).toHaveBeenCalledWith({
					cumulativeTimeMs: 7_500_000,
					totalRuns: 8,
					currentBadgeLevel: 2,
					longestRunMs: 0,
					longestRunTimestamp: 0,
				});
			});
		});

		it('does not sync when the registered email has been cleared', () => {
			const onSyncStats = vi.fn();
			vi.mocked(window.maestro.leaderboard.sync).mockResolvedValue({
				success: true,
				found: true,
				data: {
					cumulativeTimeMs: 7_500_000,
					totalRuns: 8,
					badgeLevel: 2,
					longestRunMs: 600_000,
				},
			});

			render(
				<LeaderboardRegistrationModal
					theme={theme}
					autoRunStats={autoRunStats}
					keyboardMasteryStats={keyboardMasteryStats}
					existingRegistration={{
						...confirmedWithoutAuthToken(),
						authToken: 'existing-auth-token',
					}}
					onClose={onClose}
					onSave={onSave}
					onSyncStats={onSyncStats}
				/>
			);

			fireEvent.change(screen.getByPlaceholderText('conductor@maestro.ai'), {
				target: { value: '' },
			});
			fireEvent.click(screen.getByRole('button', { name: /Pull Down/i }));

			expect(window.maestro.leaderboard.sync).not.toHaveBeenCalled();
			expect(onSyncStats).not.toHaveBeenCalled();
		});

		it('reports sync states when local and server data do not need merging', async () => {
			const baseRegistration = {
				...confirmedWithoutAuthToken(),
				authToken: 'existing-auth-token',
			};

			vi.mocked(window.maestro.leaderboard.sync).mockResolvedValueOnce({
				success: true,
				found: true,
				data: {
					cumulativeTimeMs: autoRunStats.cumulativeTimeMs,
					totalRuns: autoRunStats.totalRuns,
					badgeLevel: 1,
					longestRunMs: autoRunStats.longestRunMs,
				},
			});

			const first = render(
				<LeaderboardRegistrationModal
					theme={theme}
					autoRunStats={autoRunStats}
					keyboardMasteryStats={keyboardMasteryStats}
					existingRegistration={baseRegistration}
					onClose={onClose}
					onSave={onSave}
					onOptOut={vi.fn()}
					onSyncStats={vi.fn()}
				/>
			);
			fireEvent.click(screen.getByRole('button', { name: /Pull Down/i }));
			expect(
				await screen.findByText('Already in sync! Local and server stats match.')
			).toBeInTheDocument();
			first.unmount();

			vi.mocked(window.maestro.leaderboard.sync).mockResolvedValueOnce({
				success: true,
				found: true,
				data: {
					cumulativeTimeMs: 60_000,
					totalRuns: 1,
					badgeLevel: 1,
					longestRunMs: 30_000,
				},
			});

			const second = render(
				<LeaderboardRegistrationModal
					theme={theme}
					autoRunStats={{ ...autoRunStats, cumulativeTimeMs: 7_500_000 }}
					keyboardMasteryStats={keyboardMasteryStats}
					existingRegistration={baseRegistration}
					onClose={onClose}
					onSave={onSave}
					onOptOut={vi.fn()}
					onSyncStats={vi.fn()}
				/>
			);
			fireEvent.click(screen.getByRole('button', { name: /Pull Down/i }));
			expect(await screen.findByText(/Local is ahead \(2h 5m\)/)).toBeInTheDocument();
			second.unmount();

			vi.mocked(window.maestro.leaderboard.sync).mockResolvedValueOnce({
				success: true,
				found: false,
			});

			render(
				<LeaderboardRegistrationModal
					theme={theme}
					autoRunStats={autoRunStats}
					keyboardMasteryStats={keyboardMasteryStats}
					existingRegistration={baseRegistration}
					onClose={onClose}
					onSave={onSave}
					onOptOut={vi.fn()}
					onSyncStats={vi.fn()}
				/>
			);
			fireEvent.click(screen.getByRole('button', { name: /Pull Down/i }));
			expect(
				await screen.findByText('No server record found. Submit your first entry to create one!')
			).toBeInTheDocument();
		});

		it('reports sync errors from server codes and thrown failures', async () => {
			const baseRegistration = {
				...confirmedWithoutAuthToken(),
				authToken: 'existing-auth-token',
			};
			const renderRegisteredModal = () =>
				render(
					<LeaderboardRegistrationModal
						theme={theme}
						autoRunStats={autoRunStats}
						keyboardMasteryStats={keyboardMasteryStats}
						existingRegistration={baseRegistration}
						onClose={onClose}
						onSave={onSave}
						onOptOut={vi.fn()}
						onSyncStats={vi.fn()}
					/>
				);

			vi.mocked(window.maestro.leaderboard.sync).mockResolvedValueOnce({
				success: false,
				errorCode: 'EMAIL_NOT_CONFIRMED',
			});
			const first = renderRegisteredModal();
			fireEvent.click(screen.getByRole('button', { name: /Pull Down/i }));
			expect(
				await screen.findByText(
					'Email not yet confirmed. Please check your inbox for the confirmation email.'
				)
			).toBeInTheDocument();
			first.unmount();

			vi.mocked(window.maestro.leaderboard.sync).mockResolvedValueOnce({
				success: false,
				errorCode: 'INVALID_TOKEN',
			});
			const second = renderRegisteredModal();
			fireEvent.click(screen.getByRole('button', { name: /Pull Down/i }));
			expect(
				await screen.findByText('Invalid auth token. Please re-register to get a new token.')
			).toBeInTheDocument();
			second.unmount();

			vi.mocked(window.maestro.leaderboard.sync).mockResolvedValueOnce({
				success: false,
				error: 'Server unavailable',
			});
			const third = renderRegisteredModal();
			fireEvent.click(screen.getByRole('button', { name: /Pull Down/i }));
			expect(await screen.findByText('Server unavailable')).toBeInTheDocument();
			third.unmount();

			vi.mocked(window.maestro.leaderboard.sync).mockResolvedValueOnce({
				success: false,
			});
			const fourth = renderRegisteredModal();
			fireEvent.click(screen.getByRole('button', { name: /Pull Down/i }));
			expect(await screen.findByText('Failed to sync from server')).toBeInTheDocument();
			fourth.unmount();

			vi.mocked(window.maestro.leaderboard.sync).mockRejectedValueOnce(
				new Error('Sync request failed')
			);
			const fifth = renderRegisteredModal();
			fireEvent.click(screen.getByRole('button', { name: /Pull Down/i }));
			expect(await screen.findByText('Sync request failed')).toBeInTheDocument();
			fifth.unmount();

			vi.mocked(window.maestro.leaderboard.sync).mockRejectedValueOnce('plain sync failure');
			renderRegisteredModal();
			fireEvent.click(screen.getByRole('button', { name: /Pull Down/i }));
			expect(await screen.findByText('Failed to sync from server')).toBeInTheDocument();
		});

		it('confirms opt out only after the second destructive action', () => {
			const onOptOut = vi.fn();

			render(
				<LeaderboardRegistrationModal
					theme={theme}
					autoRunStats={autoRunStats}
					keyboardMasteryStats={keyboardMasteryStats}
					existingRegistration={{
						...confirmedWithoutAuthToken(),
						authToken: 'existing-auth-token',
					}}
					onClose={onClose}
					onSave={onSave}
					onOptOut={onOptOut}
				/>
			);

			fireEvent.click(screen.getByRole('button', { name: /Opt Out/i }));
			expect(screen.getByText(/Are you sure you want to remove yourself/)).toBeInTheDocument();

			fireEvent.click(screen.getByRole('button', { name: 'Keep Registration' }));
			expect(
				screen.queryByText(/Are you sure you want to remove yourself/)
			).not.toBeInTheDocument();

			fireEvent.click(screen.getByRole('button', { name: /Opt Out/i }));
			fireEvent.click(screen.getByRole('button', { name: /Yes, Remove Me/i }));

			expect(onOptOut).toHaveBeenCalledOnce();
			expect(
				screen.getByText('You have opted out of the leaderboard. Your local stats are preserved.')
			).toBeInTheDocument();
		});
	});
});
