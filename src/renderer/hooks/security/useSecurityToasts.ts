/**
 * useSecurityToasts - Hook for showing toast notifications for LLM Guard security events
 *
 * Subscribes to security events from the main process and shows appropriate toast
 * notifications based on the event type and action taken.
 *
 * Toast behavior:
 * - Content blocked: Red error toast with block reason
 * - Secrets detected and sanitized: Yellow warning toast
 * - PII detected and anonymized: Yellow warning toast
 * - Prompt injection detected: Yellow/red based on action taken
 *
 * Respects the user's showSecurityToasts setting.
 */

import { useEffect, useRef } from 'react';
import { notifyToast } from '../../stores/notificationStore';
import { useSettingsStore } from '../../stores/settingsStore';
import type { SecurityEventData } from '../../../main/preload/security';

/**
 * Get a human-readable title for a security event
 */
function getEventTitle(event: SecurityEventData): string {
	if (event.eventType === 'blocked') {
		return 'Content Blocked';
	}

	if (event.action === 'sanitized') {
		// Determine what type of content was sanitized
		if (event.findingTypes.some((t) => t.startsWith('SECRET_'))) {
			return 'Secrets Redacted';
		}
		if (
			event.findingTypes.some((t) =>
				['PII_EMAIL', 'PII_PHONE', 'PII_SSN', 'PII_IP_ADDRESS', 'PII_CREDIT_CARD'].includes(t)
			)
		) {
			return 'PII Anonymized';
		}
		if (event.findingTypes.some((t) => t.includes('INJECTION'))) {
			return 'Injection Detected';
		}
		return 'Content Sanitized';
	}

	if (event.action === 'warned') {
		if (event.findingTypes.some((t) => t.includes('INJECTION'))) {
			return 'Injection Warning';
		}
		return 'Security Warning';
	}

	// Default for input_scan/output_scan with no action
	return 'Content Scanned';
}

/**
 * Get a human-readable message for a security event
 */
function getEventMessage(event: SecurityEventData): string {
	const findingCount = event.findingCount;
	const direction = event.eventType === 'input_scan' ? 'input' : 'output';

	if (event.eventType === 'blocked') {
		return `Content was blocked due to security policy violations.`;
	}

	if (event.action === 'sanitized') {
		// Build a description of what was sanitized
		const types: string[] = [];

		const hasSecrets = event.findingTypes.some((t) => t.startsWith('SECRET_'));
		const hasPii = event.findingTypes.some((t) =>
			['PII_EMAIL', 'PII_PHONE', 'PII_SSN', 'PII_IP_ADDRESS', 'PII_CREDIT_CARD'].includes(t)
		);
		const hasInjection = event.findingTypes.some((t) => t.includes('INJECTION'));

		if (hasSecrets) types.push('secrets');
		if (hasPii) types.push('PII');
		if (hasInjection) types.push('injection patterns');

		const typeList = types.length > 0 ? types.join(', ') : 'sensitive content';

		return `${findingCount} ${typeList} ${findingCount === 1 ? 'instance' : 'instances'} ${findingCount === 1 ? 'was' : 'were'} sanitized in ${direction}.`;
	}

	if (event.action === 'warned') {
		return `${findingCount} potential security ${findingCount === 1 ? 'issue' : 'issues'} detected in ${direction}.`;
	}

	return `Scanned ${direction} for security issues.`;
}

/**
 * Get the toast type for a security event
 */
function getToastType(event: SecurityEventData): 'success' | 'info' | 'warning' | 'error' {
	switch (event.action) {
		case 'blocked':
			return 'error';
		case 'sanitized':
		case 'warned':
			return 'warning';
		default:
			return 'info';
	}
}

/**
 * Determine if a security event should show a toast notification
 */
function shouldShowToast(event: SecurityEventData): boolean {
	// Only show toasts for events with findings
	if (event.findingCount === 0) {
		return false;
	}

	// Only show toasts for events with meaningful actions
	if (event.action === 'none') {
		return false;
	}

	return true;
}

/**
 * Hook that subscribes to security events and shows toast notifications.
 *
 * Features:
 * - Respects user's showSecurityToasts setting
 * - Shows error toasts for blocked content with longer duration (15 seconds)
 * - Shows warning toasts for sanitized/warned events
 * - Clicking toast navigates to session
 */
export function useSecurityToasts(): void {
	const llmGuardSettings = useSettingsStore((s) => s.llmGuardSettings);

	// Use ref to avoid re-subscribing on every settings change
	const settingsRef = useRef(llmGuardSettings);
	settingsRef.current = llmGuardSettings;

	useEffect(() => {
		// Don't subscribe if window.maestro.security is not available
		if (!window.maestro?.security?.onSecurityEvent) {
			return;
		}

		const unsubscribe = window.maestro.security.onSecurityEvent((event: SecurityEventData) => {
			// Check if toasts are enabled
			const showToasts = settingsRef.current.showSecurityToasts !== false;
			if (!showToasts) {
				return;
			}

			// Check if this event should trigger a toast
			if (!shouldShowToast(event)) {
				return;
			}

			const title = getEventTitle(event);
			const message = getEventMessage(event);
			const type = getToastType(event);

			// Show the toast - clicking it will navigate to session
			notifyToast({
				type,
				title,
				message,
				sessionId: event.sessionId,
				tabId: event.tabId,
				// Don't auto-dismiss error toasts as quickly - they're important
				duration: type === 'error' ? 15000 : undefined,
			});
		});

		return unsubscribe;
	}, []); // Empty deps - we use refs for changing values
}
