/**
 * LeaderboardRegistrationModal.tsx
 *
 * Modal for registering to the runmaestro.ai leaderboard.
 * Users provide display name, email (required), and optional social handles.
 * On submission, stats are sent to the API and email confirmation is required.
 */

import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
	X,
	Trophy,
	Mail,
	User,
	Loader2,
	Check,
	AlertCircle,
	ExternalLink,
	UserX,
	Key,
	RefreshCw,
	Send,
	DownloadCloud,
} from 'lucide-react';
import type { Theme, AutoRunStats, LeaderboardRegistration, KeyboardMasteryStats } from '../types';
import { useLayerStack } from '../contexts/LayerStackContext';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { getBadgeForTime } from '../constants/conductorBadges';
import { KEYBOARD_MASTERY_LEVELS } from '../constants/keyboardMastery';
import { DEFAULT_SHORTCUTS, TAB_SHORTCUTS, FIXED_SHORTCUTS } from '../constants/shortcuts';
import { generateId } from '../utils/ids';

// Total shortcuts for calculating mastery percentage
const TOTAL_SHORTCUTS_COUNT =
	Object.keys(DEFAULT_SHORTCUTS).length +
	Object.keys(TAB_SHORTCUTS).length +
	Object.keys(FIXED_SHORTCUTS).length;

// Social media icons as SVG components
const GithubIcon = ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
	<svg className={className} style={style} viewBox="0 0 24 24" fill="currentColor">
		<path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
	</svg>
);

const XTwitterIcon = ({
	className,
	style,
}: {
	className?: string;
	style?: React.CSSProperties;
}) => (
	<svg className={className} style={style} viewBox="0 0 24 24" fill="currentColor">
		<path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
	</svg>
);

const LinkedInIcon = ({
	className,
	style,
}: {
	className?: string;
	style?: React.CSSProperties;
}) => (
	<svg className={className} style={style} viewBox="0 0 24 24" fill="currentColor">
		<path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z" />
	</svg>
);

const DiscordIcon = ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
	<svg className={className} style={style} viewBox="0 0 24 24" fill="currentColor">
		<path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
	</svg>
);

const BlueskySkyIcon = ({
	className,
	style,
}: {
	className?: string;
	style?: React.CSSProperties;
}) => (
	<svg className={className} style={style} viewBox="0 0 24 24" fill="currentColor">
		<path d="M12 10.8c-1.087-2.114-4.046-6.053-6.798-7.995C2.566.944 1.561 1.266.902 1.565.139 1.908 0 3.08 0 3.768c0 .69.378 5.65.624 6.479.815 2.736 3.713 3.66 6.383 3.364.136-.02.275-.039.415-.056-.138.022-.276.04-.415.056-3.912.58-7.387 2.005-2.83 7.078 5.013 5.19 6.87-1.113 7.823-4.308.953 3.195 2.05 9.271 7.733 4.308 4.267-4.308 1.172-6.498-2.74-7.078a8.741 8.741 0 0 1-.415-.056c.14.017.279.036.415.056 2.67.297 5.568-.628 6.383-3.364.246-.828.624-5.79.624-6.478 0-.69-.139-1.861-.902-2.206-.659-.298-1.664-.62-4.3 1.24C16.046 4.748 13.087 8.687 12 10.8Z" />
	</svg>
);

interface LeaderboardRegistrationModalProps {
	theme: Theme;
	autoRunStats: AutoRunStats;
	keyboardMasteryStats: KeyboardMasteryStats;
	existingRegistration: LeaderboardRegistration | null;
	onClose: () => void;
	onSave: (registration: LeaderboardRegistration) => void;
	onOptOut: () => void;
	onSyncStats?: (stats: {
		cumulativeTimeMs: number;
		totalRuns: number;
		currentBadgeLevel: number;
		longestRunMs: number;
		longestRunTimestamp: number;
	}) => void;
}

type SubmitState =
	| 'idle'
	| 'submitting'
	| 'success'
	| 'awaiting_confirmation'
	| 'polling'
	| 'error'
	| 'opted_out';

// Generate a random client token for polling
function generateClientToken(): string {
	return generateId();
}

// Error message for lost auth token
const AUTH_TOKEN_LOST_MESSAGE =
	'Your email is confirmed but we seem to have lost your auth token. Click "Resend Confirmation" below to receive a new confirmation email with your auth token.';

export function LeaderboardRegistrationModal({
	theme,
	autoRunStats,
	keyboardMasteryStats,
	existingRegistration,
	onClose,
	onSave,
	onOptOut,
	onSyncStats,
}: LeaderboardRegistrationModalProps) {
	const { registerLayer, unregisterLayer } = useLayerStack();
	const layerIdRef = useRef<string>();
	const containerRef = useRef<HTMLDivElement>(null);
	const onCloseRef = useRef(onClose);
	onCloseRef.current = onClose;

	// Form state
	const [displayName, setDisplayName] = useState(existingRegistration?.displayName || '');
	const [email, setEmail] = useState(existingRegistration?.email || '');
	const [twitterHandle, setTwitterHandle] = useState(existingRegistration?.twitterHandle || '');
	const [githubUsername, setGithubUsername] = useState(existingRegistration?.githubUsername || '');
	const [linkedinHandle, setLinkedinHandle] = useState(existingRegistration?.linkedinHandle || '');
	const [discordUsername, setDiscordUsername] = useState(
		existingRegistration?.discordUsername || ''
	);
	const [blueskyHandle, setBlueskyHandle] = useState(existingRegistration?.blueskyHandle || '');

	// Submission state
	const [submitState, setSubmitState] = useState<SubmitState>('idle');
	const [errorMessage, setErrorMessage] = useState('');
	const [successMessage, setSuccessMessage] = useState('');
	const [showOptOutConfirm, setShowOptOutConfirm] = useState(false);

	// Polling state - generate clientToken once if not already persisted
	const [clientToken] = useState(() => existingRegistration?.clientToken || generateClientToken());
	const [_isPolling, setIsPolling] = useState(false);
	const pollingIntervalRef = useRef<NodeJS.Timeout | null>(null);

	// Manual token entry state
	const [showManualTokenEntry, setShowManualTokenEntry] = useState(false);
	const [manualToken, setManualToken] = useState('');
	const [recoveryAttempted, setRecoveryAttempted] = useState(false);
	const [isRecovering, setIsRecovering] = useState(false);

	// Resend confirmation state
	const [isResending, setIsResending] = useState(false);
	const [resendSuccess, setResendSuccess] = useState(false);

	// Sync from server state
	const [isSyncing, setIsSyncing] = useState(false);
	const [syncMessage, setSyncMessage] = useState('');

	// Get current badge info
	const currentBadge = getBadgeForTime(autoRunStats.cumulativeTimeMs);
	const badgeLevel = currentBadge?.level || 0;
	const badgeName = currentBadge?.name || 'No Badge Yet';

	// Calculate keyboard mastery info (aligned with RunMaestro.ai server schema)
	// Server expects 1-5, we store 0-4, so add 1 for display friendliness
	const keyboardMasteryLevel = keyboardMasteryStats.currentLevel + 1;
	const keyboardMasteryTitle =
		KEYBOARD_MASTERY_LEVELS[keyboardMasteryStats.currentLevel]?.name || 'Beginner';
	const keyboardKeysUnlocked = keyboardMasteryStats.usedShortcuts.length;
	const keyboardTotalKeys = TOTAL_SHORTCUTS_COUNT;
	const keyboardCoveragePercent = Math.round((keyboardKeysUnlocked / keyboardTotalKeys) * 100);

	// Check if we need to recover auth token (email confirmed but no token)
	const needsAuthTokenRecovery =
		existingRegistration?.emailConfirmed &&
		!existingRegistration?.authToken &&
		existingRegistration?.clientToken;

	// Validate email format
	const isValidEmail = (email: string): boolean => {
		const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
		return emailRegex.test(email);
	};

	// Check if form is valid
	const isFormValid =
		displayName.trim().length > 0 && email.trim().length > 0 && isValidEmail(email);

	// Stop polling
	const stopPolling = useCallback(() => {
		if (pollingIntervalRef.current) {
			clearInterval(pollingIntervalRef.current);
			pollingIntervalRef.current = null;
		}
		setIsPolling(false);
	}, []);

	// Poll for auth token
	const pollForAuthToken = useCallback(
		async (token: string) => {
			try {
				const result = await window.maestro.leaderboard.pollAuthStatus(token);

				if (result.status === 'confirmed' && result.authToken) {
					stopPolling();
					// Save the auth token
					const registration: LeaderboardRegistration = {
						email: email.trim(),
						displayName: displayName.trim(),
						twitterHandle: twitterHandle.trim() || undefined,
						githubUsername: githubUsername.trim() || undefined,
						linkedinHandle: linkedinHandle.trim() || undefined,
						discordUsername: discordUsername.trim() || undefined,
						registeredAt: existingRegistration?.registeredAt || Date.now(),
						emailConfirmed: true,
						lastSubmissionAt: Date.now(),
						clientToken: token,
						authToken: result.authToken,
					};
					onSave(registration);
					setSubmitState('success');
					setSuccessMessage('Email confirmed! Your stats have been submitted to the leaderboard.');
				} else if (result.status === 'expired') {
					stopPolling();
					setSubmitState('error');
					setErrorMessage(
						'Confirmation link expired. Please submit again to receive a new confirmation email.'
					);
				} else if (result.status === 'error') {
					// Don't stop polling on transient errors, just log
					console.warn('Polling error:', result.error);
				}
				// 'pending' status - continue polling
			} catch (error) {
				console.warn('Poll request failed:', error);
				// Continue polling on network errors
			}
		},
		[
			email,
			displayName,
			twitterHandle,
			githubUsername,
			linkedinHandle,
			discordUsername,
			existingRegistration,
			onSave,
			stopPolling,
		]
	);

	// Start polling for confirmation
	const startPolling = useCallback(
		(token: string) => {
			setIsPolling(true);
			setSubmitState('polling');

			// Poll immediately, then every 5 seconds
			pollForAuthToken(token);
			pollingIntervalRef.current = setInterval(() => {
				pollForAuthToken(token);
			}, 5000);
		},
		[pollForAuthToken]
	);

	// Handle form submission
	const handleSubmit = useCallback(async () => {
		if (!isFormValid) return;

		setSubmitState('submitting');
		setErrorMessage('');

		try {
			// Format longest run date if available
			let longestRunDate: string | undefined;
			if (autoRunStats.longestRunTimestamp > 0) {
				longestRunDate = new Date(autoRunStats.longestRunTimestamp).toISOString().split('T')[0];
			}

			// IMPORTANT: For multi-device support, we use delta mode for stats updates.
			// Profile-only submissions (when user has no new stats to report) should send
			// cumulative fields for initial registration, but the server handles updates
			// via delta mode when Auto Runs complete in App.tsx.
			//
			// API behavior:
			// - If deltaMs > 0 is present: Delta mode - adds to server totals
			// - If only cumulativeTimeMs (no deltaMs): Sets initial values for new users,
			//   or is ignored for existing users (server keeps its totals)
			//
			// We send local cumulative as both cumulativeTimeMs (for API requirements)
			// and clientTotalTimeMs (for discrepancy detection).
			const result = await window.maestro.leaderboard.submit({
				email: email.trim(),
				displayName: displayName.trim(),
				githubUsername: githubUsername.trim() || undefined,
				twitterHandle: twitterHandle.trim() || undefined,
				linkedinHandle: linkedinHandle.trim() || undefined,
				discordUsername: discordUsername.trim() || undefined,
				blueskyHandle: blueskyHandle.trim() || undefined,
				badgeLevel,
				badgeName,
				// Send cumulative stats - required by API. Server handles multi-device via delta mode.
				cumulativeTimeMs: autoRunStats.cumulativeTimeMs,
				totalRuns: autoRunStats.totalRuns,
				longestRunMs: autoRunStats.longestRunMs || undefined,
				longestRunDate,
				theme: theme.id,
				clientToken,
				authToken: existingRegistration?.authToken,
				// Keyboard mastery data (aligned with RunMaestro.ai server schema)
				keyboardMasteryLevel,
				keyboardMasteryTitle,
				keyboardCoveragePercent,
				keyboardKeysUnlocked,
				keyboardTotalKeys,
				// Client's local total for discrepancy detection
				clientTotalTimeMs: autoRunStats.cumulativeTimeMs,
			});

			if (result.success) {
				// Save registration locally with clientToken (persists the token)
				const registration: LeaderboardRegistration = {
					email: email.trim(),
					displayName: displayName.trim(),
					twitterHandle: twitterHandle.trim() || undefined,
					githubUsername: githubUsername.trim() || undefined,
					linkedinHandle: linkedinHandle.trim() || undefined,
					discordUsername: discordUsername.trim() || undefined,
					blueskyHandle: blueskyHandle.trim() || undefined,
					registeredAt: existingRegistration?.registeredAt || Date.now(),
					emailConfirmed: !result.pendingEmailConfirmation,
					lastSubmissionAt: Date.now(),
					clientToken,
					authToken: existingRegistration?.authToken,
				};
				onSave(registration);

				if (result.pendingEmailConfirmation) {
					setSubmitState('awaiting_confirmation');
					setSuccessMessage('Please check your email to confirm your registration.');
					// Start polling for confirmation
					startPolling(clientToken);
				} else {
					setSubmitState('success');
					// Profile submitted - stats sync via delta mode from Auto Runs or Pull Down
					setSuccessMessage(
						'Profile submitted! Stats are synced via Auto Runs. Use "Pull Down" to sync from other devices.'
					);
				}
			} else if (result.authTokenRequired) {
				// Email is confirmed but auth token is missing/invalid - try to recover it automatically
				let recovered = false;
				if (clientToken) {
					setSubmitState('submitting');
					setErrorMessage('');
					try {
						const pollResult = await window.maestro.leaderboard.pollAuthStatus(clientToken);
						if (pollResult.status === 'confirmed' && pollResult.authToken) {
							// Token recovered! Save it and retry submission
							const registration: LeaderboardRegistration = {
								email: email.trim(),
								displayName: displayName.trim(),
								twitterHandle: twitterHandle.trim() || undefined,
								githubUsername: githubUsername.trim() || undefined,
								linkedinHandle: linkedinHandle.trim() || undefined,
								discordUsername: discordUsername.trim() || undefined,
								registeredAt: existingRegistration?.registeredAt || Date.now(),
								emailConfirmed: true,
								lastSubmissionAt: Date.now(),
								clientToken,
								authToken: pollResult.authToken,
							};
							onSave(registration);

							// Retry submission with recovered token
							let longestRunDate: string | undefined;
							if (autoRunStats.longestRunTimestamp > 0) {
								longestRunDate = new Date(autoRunStats.longestRunTimestamp)
									.toISOString()
									.split('T')[0];
							}

							// Retry submission with recovered token
							const retryResult = await window.maestro.leaderboard.submit({
								email: email.trim(),
								displayName: displayName.trim(),
								githubUsername: githubUsername.trim() || undefined,
								twitterHandle: twitterHandle.trim() || undefined,
								linkedinHandle: linkedinHandle.trim() || undefined,
								discordUsername: discordUsername.trim() || undefined,
								badgeLevel,
								badgeName,
								// Send cumulative stats - required by API
								cumulativeTimeMs: autoRunStats.cumulativeTimeMs,
								totalRuns: autoRunStats.totalRuns,
								longestRunMs: autoRunStats.longestRunMs || undefined,
								longestRunDate,
								theme: theme.id,
								clientToken,
								authToken: pollResult.authToken,
								// Keyboard mastery data (aligned with RunMaestro.ai server schema)
								keyboardMasteryLevel,
								keyboardMasteryTitle,
								keyboardCoveragePercent,
								keyboardKeysUnlocked,
								keyboardTotalKeys,
								// Client's local total for discrepancy detection
								clientTotalTimeMs: autoRunStats.cumulativeTimeMs,
							});

							if (retryResult.success) {
								setSubmitState('success');
								setSuccessMessage('Auth token recovered and stats submitted successfully!');
								recovered = true;
							} else {
								setErrorMessage(retryResult.error || 'Submission failed after token recovery');
							}
						}
					} catch {
						// Recovery failed - fall through to manual entry
					}
				}
				// If recovery failed or wasn't possible, show manual entry
				if (!recovered) {
					setSubmitState('error');
					setShowManualTokenEntry(true);
					if (!errorMessage) setErrorMessage(AUTH_TOKEN_LOST_MESSAGE);
				}
			} else {
				setSubmitState('error');
				setErrorMessage(result.error || result.message || 'Submission failed');
			}
		} catch (error) {
			setSubmitState('error');
			setErrorMessage(error instanceof Error ? error.message : 'An unexpected error occurred');
		}
	}, [
		isFormValid,
		email,
		displayName,
		githubUsername,
		twitterHandle,
		linkedinHandle,
		discordUsername,
		badgeLevel,
		badgeName,
		autoRunStats,
		existingRegistration,
		onSave,
		theme.id,
		clientToken,
		startPolling,
		keyboardMasteryLevel,
		keyboardMasteryTitle,
		keyboardCoveragePercent,
		keyboardKeysUnlocked,
		keyboardTotalKeys,
	]);

	// Handle manual token submission
	const handleManualTokenSubmit = useCallback(async () => {
		if (!manualToken.trim()) return;

		// Save the manually entered token and retry submission
		const registration: LeaderboardRegistration = {
			email: email.trim(),
			displayName: displayName.trim(),
			twitterHandle: twitterHandle.trim() || undefined,
			githubUsername: githubUsername.trim() || undefined,
			linkedinHandle: linkedinHandle.trim() || undefined,
			discordUsername: discordUsername.trim() || undefined,
			registeredAt: existingRegistration?.registeredAt || Date.now(),
			emailConfirmed: true,
			lastSubmissionAt: Date.now(),
			clientToken,
			authToken: manualToken.trim(),
		};
		onSave(registration);
		setShowManualTokenEntry(false);
		setManualToken('');

		// Now submit with the token
		setSubmitState('submitting');
		try {
			let longestRunDate: string | undefined;
			if (autoRunStats.longestRunTimestamp > 0) {
				longestRunDate = new Date(autoRunStats.longestRunTimestamp).toISOString().split('T')[0];
			}

			// Manual token submission
			const result = await window.maestro.leaderboard.submit({
				email: email.trim(),
				displayName: displayName.trim(),
				githubUsername: githubUsername.trim() || undefined,
				twitterHandle: twitterHandle.trim() || undefined,
				linkedinHandle: linkedinHandle.trim() || undefined,
				discordUsername: discordUsername.trim() || undefined,
				badgeLevel,
				badgeName,
				// Send cumulative stats - required by API
				cumulativeTimeMs: autoRunStats.cumulativeTimeMs,
				totalRuns: autoRunStats.totalRuns,
				longestRunMs: autoRunStats.longestRunMs || undefined,
				longestRunDate,
				theme: theme.id,
				clientToken,
				authToken: manualToken.trim(),
				// Keyboard mastery data (aligned with RunMaestro.ai server schema)
				keyboardMasteryLevel,
				keyboardMasteryTitle,
				keyboardCoveragePercent,
				keyboardKeysUnlocked,
				keyboardTotalKeys,
				// Client's local total for discrepancy detection
				clientTotalTimeMs: autoRunStats.cumulativeTimeMs,
			});

			if (result.success) {
				setSubmitState('success');
				setSuccessMessage(
					'Your profile has been updated! Use "Pull Down" to sync stats from the server.'
				);
			} else {
				setSubmitState('error');
				setErrorMessage(
					result.error || result.message || 'Submission failed. Please check your auth token.'
				);
			}
		} catch (error) {
			setSubmitState('error');
			setErrorMessage(error instanceof Error ? error.message : 'An unexpected error occurred');
		}
	}, [
		manualToken,
		email,
		displayName,
		twitterHandle,
		githubUsername,
		linkedinHandle,
		discordUsername,
		existingRegistration,
		clientToken,
		onSave,
		autoRunStats,
		badgeLevel,
		badgeName,
		theme.id,
		keyboardMasteryLevel,
		keyboardMasteryTitle,
		keyboardCoveragePercent,
		keyboardKeysUnlocked,
		keyboardTotalKeys,
	]);

	// Handle resend confirmation email
	const handleResendConfirmation = useCallback(async () => {
		if (!email.trim() || !clientToken) return;

		setIsResending(true);
		setResendSuccess(false);
		setErrorMessage('');

		try {
			const result = await window.maestro.leaderboard.resendConfirmation({
				email: email.trim(),
				clientToken,
			});

			if (result.success) {
				setResendSuccess(true);
				setErrorMessage('');
				// Start polling for the new confirmation
				startPolling(clientToken);
				setSubmitState('awaiting_confirmation');
				setSuccessMessage(
					result.message ||
						'Confirmation email sent! Please check your inbox and click the link to get your auth token.'
				);
			} else {
				setErrorMessage(result.error || 'Failed to resend confirmation email. Please try again.');
			}
		} catch (error) {
			setErrorMessage(
				error instanceof Error ? error.message : 'Failed to resend confirmation email'
			);
		} finally {
			setIsResending(false);
		}
	}, [email, clientToken, startPolling]);

	// Handle sync from server (for new device installations)
	const handleSyncFromServer = useCallback(async () => {
		if (!existingRegistration?.authToken || !email.trim()) return;

		setIsSyncing(true);
		setSyncMessage('');
		setErrorMessage('');

		try {
			const result = await window.maestro.leaderboard.sync({
				email: email.trim(),
				authToken: existingRegistration.authToken,
			});

			if (result.success && result.found && result.data) {
				// Check if server has more data than local
				const serverTime = result.data.cumulativeTimeMs;
				const localTime = autoRunStats.cumulativeTimeMs;

				if (serverTime > localTime) {
					// Server has more data - sync it down
					const longestRunTimestamp = result.data.longestRunDate
						? new Date(result.data.longestRunDate).getTime()
						: 0;

					if (onSyncStats) {
						onSyncStats({
							cumulativeTimeMs: serverTime,
							totalRuns: result.data.totalRuns,
							currentBadgeLevel: result.data.badgeLevel,
							longestRunMs: result.data.longestRunMs || 0,
							longestRunTimestamp,
						});
					}

					const hours = Math.floor(serverTime / 3600000);
					const minutes = Math.floor((serverTime % 3600000) / 60000);
					setSyncMessage(
						`Synced! Updated to ${hours}h ${minutes}m from server (was ${Math.floor(localTime / 3600000)}h ${Math.floor((localTime % 3600000) / 60000)}m locally)`
					);
				} else if (serverTime === localTime) {
					setSyncMessage('Already in sync! Local and server stats match.');
				} else {
					// Local has more data - no update needed
					const hours = Math.floor(localTime / 3600000);
					const minutes = Math.floor((localTime % 3600000) / 60000);
					setSyncMessage(
						`Local is ahead (${hours}h ${minutes}m). No sync needed - your next submission will update the server.`
					);
				}
			} else if (result.success && !result.found) {
				setSyncMessage('No server record found. Submit your first entry to create one!');
			} else {
				// Handle errors
				if (result.errorCode === 'EMAIL_NOT_CONFIRMED') {
					setErrorMessage(
						'Email not yet confirmed. Please check your inbox for the confirmation email.'
					);
				} else if (result.errorCode === 'INVALID_TOKEN') {
					setErrorMessage('Invalid auth token. Please re-register to get a new token.');
				} else {
					setErrorMessage(result.error || 'Failed to sync from server');
				}
			}
		} catch (error) {
			setErrorMessage(error instanceof Error ? error.message : 'Failed to sync from server');
		} finally {
			setIsSyncing(false);
		}
	}, [existingRegistration?.authToken, email, autoRunStats.cumulativeTimeMs, onSyncStats]);

	// Cleanup polling on unmount
	useEffect(() => {
		return () => {
			if (pollingIntervalRef.current) {
				clearInterval(pollingIntervalRef.current);
			}
		};
	}, []);

	// On mount, if we need auth token recovery, try polling once to see if the server has our token
	useEffect(() => {
		if (needsAuthTokenRecovery && existingRegistration?.clientToken && !recoveryAttempted) {
			setRecoveryAttempted(true);
			setIsRecovering(true);
			// Try a single poll to recover the auth token
			window.maestro.leaderboard
				.pollAuthStatus(existingRegistration.clientToken)
				.then((result) => {
					setIsRecovering(false);
					if (result.status === 'confirmed' && result.authToken) {
						// Token recovered! Save it
						const registration: LeaderboardRegistration = {
							...existingRegistration,
							emailConfirmed: true,
							authToken: result.authToken,
						};
						onSave(registration);
						setSubmitState('success');
						setSuccessMessage('Auth token recovered! Your registration is complete.');
					} else {
						// Token not available from server, show manual entry
						setShowManualTokenEntry(true);
						setErrorMessage(AUTH_TOKEN_LOST_MESSAGE);
					}
				})
				.catch(() => {
					setIsRecovering(false);
					// On error, show manual entry as fallback
					setShowManualTokenEntry(true);
					setErrorMessage(AUTH_TOKEN_LOST_MESSAGE);
				});
		}
	}, [needsAuthTokenRecovery, existingRegistration, onSave, recoveryAttempted]);

	// Handle opt-out (clears local registration)
	const handleOptOut = useCallback(() => {
		onOptOut();
		setSubmitState('opted_out');
		setSuccessMessage('You have opted out of the leaderboard. Your local stats are preserved.');
	}, [onOptOut]);

	// Register layer on mount
	useEffect(() => {
		const id = registerLayer({
			type: 'modal',
			priority: MODAL_PRIORITIES.LEADERBOARD_REGISTRATION,
			blocksLowerLayers: true,
			capturesFocus: true,
			focusTrap: 'strict',
			ariaLabel: 'Register for Leaderboard',
			onEscape: () => onCloseRef.current(),
		});
		layerIdRef.current = id;

		containerRef.current?.focus();

		return () => {
			if (layerIdRef.current) {
				unregisterLayer(layerIdRef.current);
			}
		};
	}, [registerLayer, unregisterLayer]);

	// Handle Enter key for form submission
	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent) => {
			if (e.key === 'Enter' && !e.shiftKey && isFormValid && submitState === 'idle') {
				e.preventDefault();
				handleSubmit();
			}
		},
		[isFormValid, submitState, handleSubmit]
	);

	return (
		<div
			ref={containerRef}
			className="fixed inset-0 modal-overlay flex items-center justify-center z-[9999] animate-in fade-in duration-200"
			role="dialog"
			aria-modal="true"
			aria-label="Register for Leaderboard"
			tabIndex={-1}
			onKeyDown={handleKeyDown}
		>
			<div
				className="w-[480px] max-h-[90vh] border rounded-lg shadow-2xl overflow-hidden flex flex-col"
				style={{ backgroundColor: theme.colors.bgSidebar, borderColor: theme.colors.border }}
			>
				{/* Header */}
				<div
					className="p-4 border-b flex items-center justify-between"
					style={{ borderColor: theme.colors.border }}
				>
					<div className="flex items-center gap-2">
						<Trophy className="w-5 h-5" style={{ color: '#FFD700' }} />
						<h2 className="text-sm font-bold" style={{ color: theme.colors.textMain }}>
							{existingRegistration
								? 'Update Leaderboard Registration'
								: 'Register for Leaderboard'}
						</h2>
					</div>
					<button
						onClick={onClose}
						className="p-1 rounded hover:bg-white/10 transition-colors"
						style={{ color: theme.colors.textDim }}
					>
						<X className="w-4 h-4" />
					</button>
				</div>

				{/* Content */}
				<div className="p-5 space-y-4 overflow-y-auto">
					{/* Info text */}
					<p className="text-sm" style={{ color: theme.colors.textDim }}>
						Join the global Maestro leaderboard at{' '}
						<button
							onClick={() => window.maestro.shell.openExternal('https://runmaestro.ai')}
							className="inline-flex items-center gap-1 hover:underline"
							style={{ color: theme.colors.accent }}
						>
							runmaestro.ai
							<ExternalLink className="w-3 h-3" />
						</button>
						. Your cumulative AutoRun time and achievements will be displayed.
					</p>

					{/* Current stats preview */}
					<div
						className="p-3 rounded-lg"
						style={{
							backgroundColor: theme.colors.bgActivity,
							border: `1px solid ${theme.colors.border}`,
						}}
					>
						<div className="flex items-center gap-2 mb-2">
							<Trophy className="w-4 h-4" style={{ color: '#FFD700' }} />
							<span className="text-xs font-medium" style={{ color: theme.colors.textMain }}>
								Your Current Stats
							</span>
						</div>
						<div className="flex gap-2 text-xs">
							<div className="flex-[3]">
								<span style={{ color: theme.colors.textDim }}>Badge: </span>
								<span className="font-medium" style={{ color: theme.colors.accent }}>
									{badgeName}
								</span>
							</div>
							<div className="flex-[2]">
								<span style={{ color: theme.colors.textDim }}>Total Runs: </span>
								<span className="font-medium" style={{ color: theme.colors.textMain }}>
									{autoRunStats.totalRuns}
								</span>
							</div>
						</div>
					</div>

					{/* Form fields */}
					<div className="space-y-3">
						{/* Display Name - Required */}
						<div>
							<label
								className="flex items-center gap-2 text-xs font-medium mb-1.5"
								style={{ color: theme.colors.textMain }}
							>
								<User className="w-3.5 h-3.5" />
								Display Name <span style={{ color: theme.colors.error }}>*</span>
							</label>
							<input
								type="text"
								value={displayName}
								onChange={(e) => setDisplayName(e.target.value)}
								placeholder="ConductorPedram"
								className="w-full px-3 py-2 text-sm rounded border outline-none focus:ring-1"
								style={{
									backgroundColor: theme.colors.bgActivity,
									borderColor: theme.colors.border,
									color: theme.colors.textMain,
								}}
								disabled={submitState === 'submitting'}
							/>
						</div>

						{/* Email - Required */}
						<div>
							<label
								className="flex items-center gap-2 text-xs font-medium mb-1.5"
								style={{ color: theme.colors.textMain }}
							>
								<Mail className="w-3.5 h-3.5" />
								Email Address <span style={{ color: theme.colors.error }}>*</span>
							</label>
							<input
								type="email"
								value={email}
								onChange={(e) => setEmail(e.target.value)}
								placeholder="conductor@maestro.ai"
								className="w-full px-3 py-2 text-sm rounded border outline-none focus:ring-1"
								style={{
									backgroundColor: theme.colors.bgActivity,
									borderColor:
										email && !isValidEmail(email) ? theme.colors.error : theme.colors.border,
									color: theme.colors.textMain,
								}}
								disabled={submitState === 'submitting'}
							/>
							{email && !isValidEmail(email) && (
								<p className="text-xs mt-1" style={{ color: theme.colors.error }}>
									Please enter a valid email address
								</p>
							)}
							<p className="text-xs mt-1" style={{ color: theme.colors.textDim }}>
								Your email is kept private and will not be displayed on the leaderboard
							</p>
						</div>

						{/* Social handles - Optional */}
						<div className="pt-2 border-t" style={{ borderColor: theme.colors.border }}>
							<p className="text-xs font-medium mb-3" style={{ color: theme.colors.textDim }}>
								Optional: Link your social profiles
							</p>

							<div className="space-y-3">
								{/* GitHub */}
								<div className="flex items-center gap-2">
									<GithubIcon
										className="w-4 h-4 flex-shrink-0"
										style={{ color: theme.colors.textDim }}
									/>
									<input
										type="text"
										value={githubUsername}
										onChange={(e) => setGithubUsername(e.target.value.replace(/^@/, ''))}
										placeholder="username"
										className="flex-1 px-3 py-1.5 text-sm rounded border outline-none focus:ring-1"
										style={{
											backgroundColor: theme.colors.bgActivity,
											borderColor: theme.colors.border,
											color: theme.colors.textMain,
										}}
										disabled={submitState === 'submitting'}
									/>
								</div>

								{/* X/Twitter */}
								<div className="flex items-center gap-2">
									<XTwitterIcon
										className="w-4 h-4 flex-shrink-0"
										style={{ color: theme.colors.textDim }}
									/>
									<input
										type="text"
										value={twitterHandle}
										onChange={(e) => setTwitterHandle(e.target.value.replace(/^@/, ''))}
										placeholder="handle"
										className="flex-1 px-3 py-1.5 text-sm rounded border outline-none focus:ring-1"
										style={{
											backgroundColor: theme.colors.bgActivity,
											borderColor: theme.colors.border,
											color: theme.colors.textMain,
										}}
										disabled={submitState === 'submitting'}
									/>
								</div>

								{/* LinkedIn */}
								<div className="flex items-center gap-2">
									<LinkedInIcon
										className="w-4 h-4 flex-shrink-0"
										style={{ color: theme.colors.textDim }}
									/>
									<input
										type="text"
										value={linkedinHandle}
										onChange={(e) => setLinkedinHandle(e.target.value.replace(/^@/, ''))}
										placeholder="username"
										className="flex-1 px-3 py-1.5 text-sm rounded border outline-none focus:ring-1"
										style={{
											backgroundColor: theme.colors.bgActivity,
											borderColor: theme.colors.border,
											color: theme.colors.textMain,
										}}
										disabled={submitState === 'submitting'}
									/>
								</div>

								{/* Discord */}
								<div className="flex items-center gap-2">
									<DiscordIcon
										className="w-4 h-4 flex-shrink-0"
										style={{ color: theme.colors.textDim }}
									/>
									<input
										type="text"
										value={discordUsername}
										onChange={(e) => setDiscordUsername(e.target.value.replace(/^@/, ''))}
										placeholder="username#1234 or username"
										className="flex-1 px-3 py-1.5 text-sm rounded border outline-none focus:ring-1"
										style={{
											backgroundColor: theme.colors.bgActivity,
											borderColor: theme.colors.border,
											color: theme.colors.textMain,
										}}
										disabled={submitState === 'submitting'}
									/>
								</div>

								{/* Bluesky */}
								<div className="flex items-center gap-2">
									<BlueskySkyIcon
										className="w-4 h-4 flex-shrink-0"
										style={{ color: theme.colors.textDim }}
									/>
									<input
										type="text"
										value={blueskyHandle}
										onChange={(e) => setBlueskyHandle(e.target.value.replace(/^@/, ''))}
										placeholder="username.bsky.social"
										className="flex-1 px-3 py-1.5 text-sm rounded border outline-none focus:ring-1"
										style={{
											backgroundColor: theme.colors.bgActivity,
											borderColor: theme.colors.border,
											color: theme.colors.textMain,
										}}
										disabled={submitState === 'submitting'}
									/>
								</div>
							</div>
						</div>
					</div>

					{/* Status messages - show errors from submit or sync operations */}
					{errorMessage &&
						!showManualTokenEntry &&
						(submitState === 'error' || submitState === 'idle') && (
							<div
								className="flex items-start gap-2 p-3 rounded-lg"
								style={{
									backgroundColor: `${theme.colors.error}15`,
									border: `1px solid ${theme.colors.error}30`,
								}}
							>
								<AlertCircle
									className="w-4 h-4 flex-shrink-0 mt-0.5"
									style={{ color: theme.colors.error }}
								/>
								<p className="text-xs" style={{ color: theme.colors.error }}>
									{errorMessage}
								</p>
							</div>
						)}

					{/* Recovering auth token status */}
					{isRecovering && (
						<div
							className="flex items-start gap-2 p-3 rounded-lg"
							style={{
								backgroundColor: `${theme.colors.accent}15`,
								border: `1px solid ${theme.colors.accent}30`,
							}}
						>
							<RefreshCw
								className="w-4 h-4 flex-shrink-0 mt-0.5 animate-spin"
								style={{ color: theme.colors.accent }}
							/>
							<p className="text-xs" style={{ color: theme.colors.textMain }}>
								Checking for your auth token...
							</p>
						</div>
					)}

					{/* Polling status */}
					{(submitState === 'awaiting_confirmation' || submitState === 'polling') && (
						<div
							className="flex items-start gap-2 p-3 rounded-lg"
							style={{
								backgroundColor: `${theme.colors.accent}15`,
								border: `1px solid ${theme.colors.accent}30`,
							}}
						>
							<RefreshCw
								className="w-4 h-4 flex-shrink-0 mt-0.5 animate-spin"
								style={{ color: theme.colors.accent }}
							/>
							<div className="flex-1">
								<p className="text-xs" style={{ color: theme.colors.textMain }}>
									{successMessage || 'Waiting for email confirmation...'}
								</p>
								<p className="text-xs mt-1" style={{ color: theme.colors.textDim }}>
									Click the link in your email to complete registration. This will update
									automatically.
								</p>
							</div>
						</div>
					)}

					{/* Manual token entry / Resend confirmation */}
					{showManualTokenEntry && !resendSuccess && (
						<>
							{/* Error/info message above token entry */}
							{errorMessage && (
								<div
									className="flex items-start gap-2 p-3 rounded-lg"
									style={{
										backgroundColor: `${theme.colors.error}15`,
										border: `1px solid ${theme.colors.error}30`,
									}}
								>
									<AlertCircle
										className="w-4 h-4 flex-shrink-0 mt-0.5"
										style={{ color: theme.colors.error }}
									/>
									<p className="text-xs" style={{ color: theme.colors.error }}>
										{errorMessage}
									</p>
								</div>
							)}

							{/* Resend confirmation button - primary action */}
							<div
								className="p-3 rounded-lg space-y-3"
								style={{
									backgroundColor: `${theme.colors.accent}10`,
									border: `1px solid ${theme.colors.accent}30`,
								}}
							>
								<div className="flex items-start gap-2">
									<Send
										className="w-4 h-4 flex-shrink-0 mt-0.5"
										style={{ color: theme.colors.accent }}
									/>
									<div className="flex-1">
										<p className="text-xs font-medium" style={{ color: theme.colors.textMain }}>
											Resend Confirmation Email
										</p>
										<p className="text-xs mt-1" style={{ color: theme.colors.textDim }}>
											We'll send a new confirmation email to{' '}
											<span className="font-medium">{email}</span>. Click the link to get your auth
											token.
										</p>
									</div>
								</div>
								<button
									onClick={handleResendConfirmation}
									disabled={isResending || !email.trim()}
									className="w-full px-3 py-2 text-xs font-medium rounded transition-colors flex items-center justify-center gap-2 disabled:opacity-50"
									style={{
										backgroundColor: theme.colors.accent,
										color: '#fff',
									}}
								>
									{isResending ? (
										<>
											<Loader2 className="w-3.5 h-3.5 animate-spin" />
											Sending...
										</>
									) : (
										<>
											<Mail className="w-3.5 h-3.5" />
											Resend Confirmation Email
										</>
									)}
								</button>
							</div>

							{/* Manual token entry - secondary/fallback option */}
							<div
								className="p-3 rounded-lg space-y-3"
								style={{
									backgroundColor: theme.colors.bgActivity,
									border: `1px solid ${theme.colors.border}`,
								}}
							>
								<div className="flex items-start gap-2">
									<Key
										className="w-4 h-4 flex-shrink-0 mt-0.5"
										style={{ color: theme.colors.textDim }}
									/>
									<div>
										<p className="text-xs font-medium" style={{ color: theme.colors.textMain }}>
											Enter Auth Token
										</p>
										<p className="text-xs mt-1" style={{ color: theme.colors.textDim }}>
											Copy the token from your confirmation email or the confirmation page.
										</p>
									</div>
								</div>
								<div className="flex gap-2">
									<input
										type="text"
										value={manualToken}
										onChange={(e) => setManualToken(e.target.value)}
										placeholder="Paste your 64-character auth token"
										className="flex-1 px-3 py-2 text-xs rounded border outline-none focus:ring-1 font-mono"
										style={{
											backgroundColor: theme.colors.bgActivity,
											borderColor: theme.colors.border,
											color: theme.colors.textMain,
										}}
									/>
									<button
										onClick={handleManualTokenSubmit}
										disabled={!manualToken.trim()}
										className="px-3 py-2 text-xs font-medium rounded transition-colors disabled:opacity-50"
										style={{
											backgroundColor: theme.colors.accent,
											color: '#fff',
										}}
									>
										Submit
									</button>
								</div>
							</div>
						</>
					)}

					{(submitState === 'success' || submitState === 'opted_out') && (
						<div
							className="flex items-start gap-2 p-3 rounded-lg"
							style={{
								backgroundColor: `${theme.colors.success}15`,
								border: `1px solid ${theme.colors.success}30`,
							}}
						>
							<Check
								className="w-4 h-4 flex-shrink-0 mt-0.5"
								style={{ color: theme.colors.success }}
							/>
							<p className="text-xs" style={{ color: theme.colors.success }}>
								{successMessage}
							</p>
						</div>
					)}

					{/* Opt-out confirmation */}
					{showOptOutConfirm && submitState === 'idle' && (
						<div
							className="p-3 rounded-lg"
							style={{
								backgroundColor: `${theme.colors.error}10`,
								border: `1px solid ${theme.colors.error}30`,
							}}
						>
							<p className="text-xs mb-3" style={{ color: theme.colors.textMain }}>
								Are you sure you want to remove yourself from the leaderboard? This will request
								removal of your entry from runmaestro.ai.
							</p>
							<div className="flex gap-2 justify-end">
								<button
									onClick={() => setShowOptOutConfirm(false)}
									className="px-3 py-1.5 text-xs rounded hover:bg-white/10 transition-colors"
									style={{ color: theme.colors.textDim }}
								>
									Keep Registration
								</button>
								<button
									onClick={handleOptOut}
									className="px-3 py-1.5 text-xs rounded transition-colors flex items-center gap-1.5"
									style={{
										backgroundColor: theme.colors.error,
										color: '#fff',
									}}
								>
									<UserX className="w-3.5 h-3.5" />
									Yes, Remove Me
								</button>
							</div>
						</div>
					)}

					{/* Sync status message */}
					{syncMessage && (
						<div
							className="flex items-start gap-2 p-3 rounded-lg"
							style={{
								backgroundColor: `${theme.colors.success}15`,
								border: `1px solid ${theme.colors.success}30`,
							}}
						>
							<DownloadCloud
								className="w-4 h-4 flex-shrink-0 mt-0.5"
								style={{ color: theme.colors.success }}
							/>
							<p className="text-xs" style={{ color: theme.colors.success }}>
								{syncMessage}
							</p>
						</div>
					)}
				</div>

				{/* Footer */}
				<div
					className="p-4 border-t flex justify-center gap-3"
					style={{ borderColor: theme.colors.border }}
				>
					{/* Push Up - Submit stats to leaderboard */}
					{submitState !== 'awaiting_confirmation' &&
						submitState !== 'polling' &&
						submitState !== 'opted_out' &&
						!showOptOutConfirm && (
							<button
								onClick={handleSubmit}
								disabled={!isFormValid || submitState === 'submitting' || showManualTokenEntry}
								className="px-4 py-2 text-sm rounded transition-colors flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
								style={{
									backgroundColor: theme.colors.bgActivity,
									color: theme.colors.accent,
									border: `1px solid ${theme.colors.border}`,
								}}
							>
								{submitState === 'submitting' ? (
									<>
										<Loader2 className="w-4 h-4 animate-spin" />
										Pushing...
									</>
								) : (
									<>
										<Trophy className="w-4 h-4" />
										Push Up
									</>
								)}
							</button>
						)}

					{/* Pull Down - Sync from cloud (only for existing registrations with auth token) */}
					{existingRegistration?.authToken &&
						!showOptOutConfirm &&
						(submitState === 'idle' || submitState === 'error' || submitState === 'success') &&
						onSyncStats && (
							<button
								onClick={handleSyncFromServer}
								disabled={isSyncing}
								className="px-4 py-2 text-sm rounded transition-colors flex items-center gap-2 disabled:opacity-50"
								style={{
									backgroundColor: theme.colors.bgActivity,
									color: theme.colors.accent,
									border: `1px solid ${theme.colors.border}`,
								}}
							>
								{isSyncing ? (
									<>
										<Loader2 className="w-4 h-4 animate-spin" />
										Pulling...
									</>
								) : (
									<>
										<DownloadCloud className="w-4 h-4" />
										Pull Down
									</>
								)}
							</button>
						)}

					{/* Opt Out */}
					{existingRegistration &&
						!showOptOutConfirm &&
						(submitState === 'idle' || submitState === 'success') && (
							<button
								onClick={() => setShowOptOutConfirm(true)}
								className="px-4 py-2 text-sm rounded transition-colors flex items-center gap-2"
								style={{
									backgroundColor: theme.colors.bgActivity,
									color: theme.colors.error,
									border: `1px solid ${theme.colors.border}`,
								}}
							>
								<UserX className="w-4 h-4" />
								Opt Out
							</button>
						)}
				</div>
			</div>
		</div>
	);
}

export default LeaderboardRegistrationModal;
