/**
 * Hook for real-time detection of sensitive content in input text.
 * Used to show visual preview of what will be anonymized by LLM Guard.
 *
 * Features:
 * - Debounced IPC calls to main process for scanning
 * - Adjusts finding positions during typing to prevent flickering
 * - Memoized findings to prevent unnecessary re-renders
 * - Skips scanning for very short inputs
 * - Returns findings with positions for UI highlighting
 */

import { useState, useEffect, useRef, useMemo } from 'react';
import type { InputScanFinding, InputScanPreviewResult } from '../../../main/preload/security';

export interface UseSensitiveContentDetectionOptions {
	/** Whether detection is enabled */
	enabled: boolean;
	/** Debounce delay in milliseconds (default: 300) */
	debounceMs?: number;
	/** Minimum input length to trigger scanning (default: 3) */
	minLength?: number;
	/** LLM Guard configuration to use for scanning */
	llmGuardConfig?: {
		input?: {
			anonymizePii?: boolean;
			redactSecrets?: boolean;
		};
	};
}

export interface UseSensitiveContentDetectionReturn {
	/** Detected findings with positions for UI highlighting */
	findings: InputScanFinding[];
	/** Whether a scan is currently in progress */
	isScanning: boolean;
	/** Time taken for the last scan in milliseconds */
	lastScanDurationMs: number;
	/** Error message if scan failed */
	error: string | null;
}

/**
 * Adjust finding positions based on text changes.
 * When user types, shift findings that come after the edit point.
 * Returns null for findings that are no longer valid (edited within the finding).
 */
function adjustFindingsForTextChange(
	findings: InputScanFinding[],
	oldText: string,
	newText: string
): InputScanFinding[] {
	if (oldText === newText || findings.length === 0) {
		return findings;
	}

	const lengthDiff = newText.length - oldText.length;

	// Find the first position where texts differ
	let editStart = 0;
	while (
		editStart < oldText.length &&
		editStart < newText.length &&
		oldText[editStart] === newText[editStart]
	) {
		editStart++;
	}

	// Adjust findings based on where the edit occurred
	return findings
		.map((finding) => {
			// If edit is after this finding, no adjustment needed
			if (editStart >= finding.end) {
				return finding;
			}

			// If edit is within this finding, invalidate it (will be re-scanned)
			if (editStart >= finding.start && editStart < finding.end) {
				return null;
			}

			// If edit is before this finding, shift positions
			if (editStart < finding.start) {
				const newStart = finding.start + lengthDiff;
				const newEnd = finding.end + lengthDiff;

				// Validate the shifted finding still matches the text
				if (newStart >= 0 && newEnd <= newText.length) {
					const expectedValue = newText.slice(newStart, newEnd);
					if (expectedValue === finding.value) {
						return {
							...finding,
							start: newStart,
							end: newEnd,
						};
					}
				}
				return null;
			}

			return finding;
		})
		.filter((f): f is InputScanFinding => f !== null);
}

/**
 * Hook for real-time sensitive content detection in input text.
 *
 * @param inputValue - The input text to scan
 * @param options - Configuration options
 * @returns Detection results with findings and status
 */
export function useSensitiveContentDetection(
	inputValue: string,
	options: UseSensitiveContentDetectionOptions
): UseSensitiveContentDetectionReturn {
	const { enabled, debounceMs = 300, minLength = 3, llmGuardConfig } = options;

	const [findings, setFindings] = useState<InputScanFinding[]>([]);
	const [isScanning, setIsScanning] = useState(false);
	const [lastScanDurationMs, setLastScanDurationMs] = useState(0);
	const [error, setError] = useState<string | null>(null);

	// Track the last scanned text to avoid duplicate scans
	const lastScannedTextRef = useRef<string>('');
	// Track the previous input value for position adjustment
	const prevInputRef = useRef<string>('');
	// Track pending timeout for debounce
	const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	// Track if component is mounted to prevent state updates after unmount
	const mountedRef = useRef(true);

	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
			if (timeoutRef.current) {
				clearTimeout(timeoutRef.current);
			}
		};
	}, []);

	// Adjust finding positions immediately when input changes (before debounced scan)
	useEffect(() => {
		if (!enabled || findings.length === 0) {
			prevInputRef.current = inputValue;
			return;
		}

		const prevInput = prevInputRef.current;
		prevInputRef.current = inputValue;

		if (prevInput !== inputValue && prevInput.length > 0) {
			const adjustedFindings = adjustFindingsForTextChange(findings, prevInput, inputValue);
			if (
				adjustedFindings.length !== findings.length ||
				adjustedFindings.some((f, i) => f.start !== findings[i]?.start)
			) {
				setFindings(adjustedFindings);
			}
		}
	}, [inputValue, enabled, findings]);

	useEffect(() => {
		// Clear previous timeout
		if (timeoutRef.current) {
			clearTimeout(timeoutRef.current);
			timeoutRef.current = null;
		}

		// Skip if disabled - but DON'T clear findings
		// This preserves highlights when switching modes (e.g., AI -> Terminal -> AI)
		if (!enabled) {
			return;
		}

		// Skip if input is too short
		if (inputValue.length < minLength) {
			if (findings.length > 0) {
				setFindings([]);
			}
			lastScannedTextRef.current = '';
			return;
		}

		// Skip if text hasn't changed
		if (inputValue === lastScannedTextRef.current) {
			return;
		}

		// Debounce the scan
		timeoutRef.current = setTimeout(async () => {
			if (!mountedRef.current) return;

			setIsScanning(true);
			setError(null);

			try {
				const result: InputScanPreviewResult = await window.maestro.security.scanInputPreview(
					inputValue,
					llmGuardConfig
				);

				if (!mountedRef.current) return;

				lastScannedTextRef.current = inputValue;
				setFindings(result.findings);
				setLastScanDurationMs(result.scanDurationMs);
			} catch (err) {
				if (!mountedRef.current) return;

				setError(err instanceof Error ? err.message : 'Scan failed');
				setFindings([]);
			} finally {
				if (mountedRef.current) {
					setIsScanning(false);
				}
			}
		}, debounceMs);

		// Cleanup on unmount or when dependencies change
		return () => {
			if (timeoutRef.current) {
				clearTimeout(timeoutRef.current);
				timeoutRef.current = null;
			}
		};
		// Note: findings.length removed from deps to prevent loops with position adjustment
	}, [inputValue, enabled, debounceMs, minLength, llmGuardConfig]);

	// Memoize return value to prevent unnecessary re-renders in consumers
	return useMemo(
		() => ({
			findings,
			isScanning,
			lastScanDurationMs,
			error,
		}),
		[findings, isScanning, lastScanDurationMs, error]
	);
}

/**
 * Get the category of a finding type for color coding
 */
export function getFindingCategory(type: string): 'pii' | 'secret' | 'credit_card' | 'unknown' {
	if (type.startsWith('PII_CREDIT_CARD')) return 'credit_card';
	if (type.startsWith('PII_')) return 'pii';
	if (type.startsWith('SECRET_')) return 'secret';
	return 'unknown';
}

/**
 * Get a human-readable label for a finding type
 */
export function getFindingLabel(type: string): string {
	const labels: Record<string, string> = {
		// PII
		PII_EMAIL: 'Email',
		PII_PHONE: 'Phone',
		PII_SSN: 'SSN',
		PII_IP_ADDRESS: 'IP Address',
		PII_CREDIT_CARD: 'Credit Card',
		// Git providers
		SECRET_GITHUB_TOKEN: 'GitHub Token',
		SECRET_GITHUB_PAT: 'GitHub PAT',
		SECRET_GITLAB_PAT: 'GitLab PAT',
		SECRET_GITLAB_PIPELINE_TOKEN: 'GitLab Pipeline',
		SECRET_BITBUCKET_APP_PASSWORD: 'Bitbucket Password',
		// Cloud providers
		SECRET_AWS_ACCESS_KEY: 'AWS Key',
		SECRET_AWS_SECRET_KEY: 'AWS Secret',
		SECRET_AZURE_STORAGE_KEY: 'Azure Storage',
		SECRET_GOOGLE_API_KEY: 'Google API Key',
		SECRET_GOOGLE_OAUTH_TOKEN: 'Google OAuth',
		SECRET_GOOGLE_OAUTH_SECRET: 'Google OAuth Secret',
		SECRET_DIGITALOCEAN_TOKEN: 'DigitalOcean Token',
		SECRET_HEROKU_API_KEY: 'Heroku Key',
		// AI providers
		SECRET_OPENAI_KEY: 'OpenAI Key',
		SECRET_OPENAI_KEY_LEGACY: 'OpenAI Key',
		SECRET_ANTHROPIC_KEY: 'Anthropic Key',
		SECRET_HUGGINGFACE_TOKEN: 'Hugging Face',
		SECRET_REPLICATE_TOKEN: 'Replicate Token',
		SECRET_COHERE_API_KEY: 'Cohere Key',
		// Communication
		SECRET_SLACK_TOKEN: 'Slack Token',
		SECRET_SLACK_WEBHOOK: 'Slack Webhook',
		SECRET_DISCORD_BOT_TOKEN: 'Discord Token',
		SECRET_TELEGRAM_BOT_TOKEN: 'Telegram Token',
		SECRET_TWILIO_ACCOUNT_SID: 'Twilio SID',
		SECRET_TWILIO_AUTH_TOKEN: 'Twilio Token',
		// Payment
		SECRET_STRIPE_KEY: 'Stripe Key',
		SECRET_PLAID_CLIENT_ID: 'Plaid Client ID',
		SECRET_PLAID_SECRET: 'Plaid Secret',
		// Email services
		SECRET_SENDGRID_API_KEY: 'SendGrid Key',
		SECRET_MAILCHIMP_API_KEY: 'Mailchimp Key',
		SECRET_POSTMARK_TOKEN: 'Postmark Token',
		// CI/CD
		SECRET_CIRCLECI_TOKEN: 'CircleCI Token',
		SECRET_TRAVIS_TOKEN: 'Travis Token',
		SECRET_JENKINS_TOKEN: 'Jenkins Token',
		// Monitoring
		SECRET_DATADOG_API_KEY: 'Datadog Key',
		SECRET_NEWRELIC_LICENSE_KEY: 'New Relic Key',
		SECRET_PAGERDUTY_TOKEN: 'PagerDuty Token',
		SECRET_SENTRY_DSN: 'Sentry DSN',
		SECRET_GRAFANA_API_KEY: 'Grafana Key',
		// Infrastructure
		SECRET_NETLIFY_TOKEN: 'Netlify Token',
		SECRET_VERCEL_TOKEN: 'Vercel Token',
		SECRET_CLOUDFLARE_TOKEN: 'Cloudflare Token',
		SECRET_DOPPLER_TOKEN: 'Doppler Token',
		SECRET_VAULT_TOKEN: 'Vault Token',
		SECRET_VAULT_BATCH_TOKEN: 'Vault Batch Token',
		SECRET_PULUMI_TOKEN: 'Pulumi Token',
		SECRET_SUPABASE_TOKEN: 'Supabase Token',
		SECRET_FIREBASE_TOKEN: 'Firebase Token',
		SECRET_FASTLY_API_TOKEN: 'Fastly Token',
		// E-commerce
		SECRET_SHOPIFY_ACCESS_TOKEN: 'Shopify Token',
		SECRET_SHOPIFY_CUSTOM_TOKEN: 'Shopify Custom',
		SECRET_SHOPIFY_PRIVATE_TOKEN: 'Shopify Private',
		SECRET_SHOPIFY_SHARED_SECRET: 'Shopify Secret',
		// Package registries
		SECRET_NPM_TOKEN: 'npm Token',
		SECRET_PYPI_TOKEN: 'PyPI Token',
		SECRET_NUGET_API_KEY: 'NuGet Key',
		// Other
		SECRET_LINEAR_API_KEY: 'Linear Key',
		SECRET_FIGMA_TOKEN: 'Figma Token',
		SECRET_1PASSWORD_TOKEN: '1Password Token',
		SECRET_AGE_SECRET_KEY: 'Age Secret Key',
		SECRET_ALGOLIA_API_KEY: 'Algolia Key',
		SECRET_JWT_TOKEN: 'JWT Token',
		SECRET_BEARER_TOKEN: 'Bearer Token',
		SECRET_GENERIC_API_KEY: 'API Key',
		SECRET_GENERIC_SECRET: 'Secret Key',
		// Private keys
		SECRET_RSA_PRIVATE_KEY: 'RSA Private Key',
		SECRET_OPENSSH_PRIVATE_KEY: 'SSH Private Key',
		SECRET_PGP_PRIVATE_KEY: 'PGP Private Key',
		SECRET_EC_PRIVATE_KEY: 'EC Private Key',
		SECRET_GENERIC_PRIVATE_KEY: 'Private Key',
		// Database connections
		SECRET_CONNECTION_STRING_POSTGRES: 'Postgres URL',
		SECRET_CONNECTION_STRING_MYSQL: 'MySQL URL',
		SECRET_CONNECTION_STRING_MONGODB: 'MongoDB URL',
		SECRET_CONNECTION_STRING_REDIS: 'Redis URL',
		SECRET_CONNECTION_STRING_SQLSERVER: 'SQL Server',
	};

	// Check for exact match
	if (labels[type]) return labels[type];

	// Fall back to formatted type name
	return type
		.replace(/^(PII_|SECRET_)/, '')
		.split('_')
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
		.join(' ');
}
