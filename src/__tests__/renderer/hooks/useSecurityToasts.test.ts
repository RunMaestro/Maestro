import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useSecurityToasts } from '../../../renderer/hooks';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';
import * as notificationStore from '../../../renderer/stores/notificationStore';
import type { SecurityEventData } from '../../../main/preload/security';

// Mock the notification store
vi.mock('../../../renderer/stores/notificationStore', async () => {
	const actual = await vi.importActual('../../../renderer/stores/notificationStore');
	return {
		...actual,
		notifyToast: vi.fn(),
	};
});

// Mock window.maestro.security
const mockOnSecurityEvent = vi.fn();
const mockUnsubscribe = vi.fn();

// Store original maestro object for restoration
let originalMaestro: typeof window.maestro | undefined;
let securityEventCallback: ((event: SecurityEventData) => void) | null = null;

describe('useSecurityToasts', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		securityEventCallback = null;

		// Save original maestro object
		originalMaestro = window.maestro;

		// Setup window.maestro.security mock
		mockOnSecurityEvent.mockImplementation((callback: (event: SecurityEventData) => void) => {
			securityEventCallback = callback;
			return mockUnsubscribe;
		});

		// Assign mock to window.maestro.security
		(window as any).maestro = {
			...window.maestro,
			security: {
				onSecurityEvent: mockOnSecurityEvent,
			},
		};

		// Reset settings store to default state with showSecurityToasts enabled
		useSettingsStore.setState({
			llmGuardSettings: {
				enabled: true,
				action: 'sanitize',
				input: {
					anonymizePii: true,
					redactSecrets: true,
					detectPromptInjection: true,
				},
				output: {
					deanonymizePii: true,
					redactSecrets: true,
					detectPiiLeakage: true,
				},
				thresholds: {
					promptInjection: 0.7,
				},
				showSecurityToasts: true,
			},
		});
	});

	afterEach(() => {
		securityEventCallback = null;
		// Restore original maestro object
		(window as any).maestro = originalMaestro;
	});

	describe('initialization', () => {
		it('subscribes to security events on mount', () => {
			renderHook(() => useSecurityToasts());

			expect(mockOnSecurityEvent).toHaveBeenCalledTimes(1);
			expect(mockOnSecurityEvent).toHaveBeenCalledWith(expect.any(Function));
		});

		it('unsubscribes from security events on unmount', () => {
			const { unmount } = renderHook(() => useSecurityToasts());

			unmount();

			expect(mockUnsubscribe).toHaveBeenCalledTimes(1);
		});

		it('does not subscribe if window.maestro.security is not available', () => {
			// Remove security from maestro
			(window as any).maestro = {
				...window.maestro,
				security: undefined,
			};

			renderHook(() => useSecurityToasts());

			expect(mockOnSecurityEvent).not.toHaveBeenCalled();
		});
	});

	describe('toast notifications', () => {
		it('shows toast for blocked content', () => {
			renderHook(() => useSecurityToasts());

			const event: SecurityEventData = {
				sessionId: 'session-1',
				tabId: 'tab-1',
				eventType: 'blocked',
				findingTypes: ['SECRET_GITHUB_TOKEN'],
				findingCount: 1,
				action: 'blocked',
				originalLength: 100,
				sanitizedLength: 0,
			};

			act(() => {
				securityEventCallback(event);
			});

			expect(notificationStore.notifyToast).toHaveBeenCalledWith(
				expect.objectContaining({
					type: 'error',
					title: 'Content Blocked',
					sessionId: 'session-1',
					tabId: 'tab-1',
				})
			);
		});

		it('shows toast for sanitized secrets', () => {
			renderHook(() => useSecurityToasts());

			const event: SecurityEventData = {
				sessionId: 'session-1',
				eventType: 'input_scan',
				findingTypes: ['SECRET_AWS_ACCESS_KEY', 'SECRET_GITHUB_TOKEN'],
				findingCount: 2,
				action: 'sanitized',
				originalLength: 200,
				sanitizedLength: 180,
			};

			act(() => {
				securityEventCallback(event);
			});

			expect(notificationStore.notifyToast).toHaveBeenCalledWith(
				expect.objectContaining({
					type: 'warning',
					title: 'Secrets Redacted',
				})
			);
		});

		it('shows toast for anonymized PII', () => {
			renderHook(() => useSecurityToasts());

			const event: SecurityEventData = {
				sessionId: 'session-1',
				eventType: 'input_scan',
				findingTypes: ['PII_EMAIL', 'PII_PHONE'],
				findingCount: 2,
				action: 'sanitized',
				originalLength: 150,
				sanitizedLength: 130,
			};

			act(() => {
				securityEventCallback(event);
			});

			expect(notificationStore.notifyToast).toHaveBeenCalledWith(
				expect.objectContaining({
					type: 'warning',
					title: 'PII Anonymized',
				})
			);
		});

		it('shows toast for detected injection', () => {
			renderHook(() => useSecurityToasts());

			const event: SecurityEventData = {
				sessionId: 'session-1',
				eventType: 'input_scan',
				findingTypes: ['PROMPT_INJECTION'],
				findingCount: 1,
				action: 'sanitized',
				originalLength: 500,
				sanitizedLength: 450,
			};

			act(() => {
				securityEventCallback(event);
			});

			expect(notificationStore.notifyToast).toHaveBeenCalledWith(
				expect.objectContaining({
					type: 'warning',
					title: 'Injection Detected',
				})
			);
		});

		it('shows toast for security warning', () => {
			renderHook(() => useSecurityToasts());

			const event: SecurityEventData = {
				sessionId: 'session-1',
				eventType: 'warning',
				findingTypes: ['PROMPT_INJECTION'],
				findingCount: 1,
				action: 'warned',
				originalLength: 500,
				sanitizedLength: 500,
			};

			act(() => {
				securityEventCallback(event);
			});

			expect(notificationStore.notifyToast).toHaveBeenCalledWith(
				expect.objectContaining({
					type: 'warning',
					title: 'Injection Warning',
				})
			);
		});

		it('uses longer duration for error toasts', () => {
			renderHook(() => useSecurityToasts());

			const event: SecurityEventData = {
				sessionId: 'session-1',
				eventType: 'blocked',
				findingTypes: ['SECRET_GITHUB_TOKEN'],
				findingCount: 1,
				action: 'blocked',
				originalLength: 100,
				sanitizedLength: 0,
			};

			act(() => {
				securityEventCallback(event);
			});

			// Error toasts use a fixed 15 second duration
			expect(notificationStore.notifyToast).toHaveBeenCalledWith(
				expect.objectContaining({
					duration: 15000,
				})
			);
		});
	});

	describe('toast filtering', () => {
		it('does not show toast when showSecurityToasts is disabled', () => {
			useSettingsStore.setState({
				llmGuardSettings: {
					...useSettingsStore.getState().llmGuardSettings,
					showSecurityToasts: false,
				},
			});

			renderHook(() => useSecurityToasts());

			const event: SecurityEventData = {
				sessionId: 'session-1',
				eventType: 'blocked',
				findingTypes: ['SECRET_GITHUB_TOKEN'],
				findingCount: 1,
				action: 'blocked',
				originalLength: 100,
				sanitizedLength: 0,
			};

			act(() => {
				securityEventCallback(event);
			});

			expect(notificationStore.notifyToast).not.toHaveBeenCalled();
		});

		it('does not show toast for events with no findings', () => {
			renderHook(() => useSecurityToasts());

			const event: SecurityEventData = {
				sessionId: 'session-1',
				eventType: 'input_scan',
				findingTypes: [],
				findingCount: 0,
				action: 'none',
				originalLength: 100,
				sanitizedLength: 100,
			};

			act(() => {
				securityEventCallback(event);
			});

			expect(notificationStore.notifyToast).not.toHaveBeenCalled();
		});

		it('does not show toast for events with action "none"', () => {
			renderHook(() => useSecurityToasts());

			const event: SecurityEventData = {
				sessionId: 'session-1',
				eventType: 'input_scan',
				findingTypes: ['PII_EMAIL'],
				findingCount: 1,
				action: 'none',
				originalLength: 100,
				sanitizedLength: 100,
			};

			act(() => {
				securityEventCallback(event);
			});

			expect(notificationStore.notifyToast).not.toHaveBeenCalled();
		});
	});

	describe('message generation', () => {
		it('generates correct message for single finding', () => {
			renderHook(() => useSecurityToasts());

			const event: SecurityEventData = {
				sessionId: 'session-1',
				eventType: 'input_scan',
				findingTypes: ['SECRET_GITHUB_TOKEN'],
				findingCount: 1,
				action: 'sanitized',
				originalLength: 100,
				sanitizedLength: 80,
			};

			act(() => {
				securityEventCallback(event);
			});

			expect(notificationStore.notifyToast).toHaveBeenCalledWith(
				expect.objectContaining({
					message: expect.stringContaining('1 secrets instance was sanitized'),
				})
			);
		});

		it('generates correct message for multiple findings', () => {
			renderHook(() => useSecurityToasts());

			const event: SecurityEventData = {
				sessionId: 'session-1',
				eventType: 'input_scan',
				findingTypes: ['PII_EMAIL', 'PII_PHONE'],
				findingCount: 3,
				action: 'sanitized',
				originalLength: 200,
				sanitizedLength: 150,
			};

			act(() => {
				securityEventCallback(event);
			});

			expect(notificationStore.notifyToast).toHaveBeenCalledWith(
				expect.objectContaining({
					message: expect.stringContaining('3 PII instances were sanitized'),
				})
			);
		});

		it('includes direction (input) in message', () => {
			renderHook(() => useSecurityToasts());

			const event: SecurityEventData = {
				sessionId: 'session-1',
				eventType: 'input_scan',
				findingTypes: ['SECRET_GITHUB_TOKEN'],
				findingCount: 1,
				action: 'sanitized',
				originalLength: 100,
				sanitizedLength: 80,
			};

			act(() => {
				securityEventCallback(event);
			});

			expect(notificationStore.notifyToast).toHaveBeenCalledWith(
				expect.objectContaining({
					message: expect.stringContaining('input'),
				})
			);
		});

		it('includes direction (output) in message', () => {
			renderHook(() => useSecurityToasts());

			const event: SecurityEventData = {
				sessionId: 'session-1',
				eventType: 'output_scan',
				findingTypes: ['SECRET_GITHUB_TOKEN'],
				findingCount: 1,
				action: 'sanitized',
				originalLength: 100,
				sanitizedLength: 80,
			};

			act(() => {
				securityEventCallback(event);
			});

			expect(notificationStore.notifyToast).toHaveBeenCalledWith(
				expect.objectContaining({
					message: expect.stringContaining('output'),
				})
			);
		});
	});

	describe('settings reactivity', () => {
		it('respects setting changes without re-subscribing', () => {
			renderHook(() => useSecurityToasts());

			// Initially enabled
			const event: SecurityEventData = {
				sessionId: 'session-1',
				eventType: 'blocked',
				findingTypes: ['SECRET_GITHUB_TOKEN'],
				findingCount: 1,
				action: 'blocked',
				originalLength: 100,
				sanitizedLength: 0,
			};

			act(() => {
				securityEventCallback(event);
			});

			expect(notificationStore.notifyToast).toHaveBeenCalledTimes(1);

			// Disable toasts
			act(() => {
				useSettingsStore.setState({
					llmGuardSettings: {
						...useSettingsStore.getState().llmGuardSettings,
						showSecurityToasts: false,
					},
				});
			});

			// Fire another event
			act(() => {
				securityEventCallback(event);
			});

			// Should not show another toast
			expect(notificationStore.notifyToast).toHaveBeenCalledTimes(1);

			// Should not have re-subscribed
			expect(mockOnSecurityEvent).toHaveBeenCalledTimes(1);
		});
	});

	describe('toast metadata', () => {
		it('includes session and tab IDs for navigation', () => {
			renderHook(() => useSecurityToasts());

			const event: SecurityEventData = {
				sessionId: 'session-1',
				tabId: 'tab-1',
				eventType: 'input_scan',
				findingTypes: ['SECRET_GITHUB_TOKEN'],
				findingCount: 1,
				action: 'sanitized',
				originalLength: 100,
				sanitizedLength: 80,
			};

			act(() => {
				securityEventCallback(event);
			});

			expect(notificationStore.notifyToast).toHaveBeenCalledWith(
				expect.objectContaining({
					sessionId: 'session-1',
					tabId: 'tab-1',
				})
			);
		});
	});
});
