/**
 * Tests for useNotifications hook
 *
 * Tests browser notification permission management and notification display
 * for the Maestro mobile web interface.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import {
	useNotifications,
	isNotificationSupported,
	getNotificationPermission,
	type NotificationPermission,
	type UseNotificationsOptions,
	type UseNotificationsReturn,
} from '../../../web/hooks/useNotifications';

// Mock the web logger
vi.mock('../../../web/utils/logger', () => ({
	webLogger: {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}));

import { webLogger } from '../../../web/utils/logger';

// Storage keys (must match source)
const NOTIFICATION_PROMPT_KEY = 'maestro_notification_prompted';
const NOTIFICATION_DECLINED_KEY = 'maestro_notification_declined';

// Helper to create mock Notification class
function createMockNotification(permission: NotificationPermission = 'default') {
	// Use a class-like function to avoid vitest warnings about mocks
	function MockNotificationClass(this: any, title: string, options?: NotificationOptions) {
		this.title = title;
		this.options = options;
		this.close = vi.fn();
		return this;
	}

	// Make it callable as a constructor and track calls
	const mockFn = vi.fn().mockImplementation(function (
		this: any,
		title: string,
		options?: NotificationOptions
	) {
		return new (MockNotificationClass as any)(title, options);
	});

	(mockFn as any).permission = permission;
	(mockFn as any).requestPermission = vi.fn().mockResolvedValue(permission);

	return mockFn;
}

describe('useNotifications', () => {
	let originalNotification: typeof Notification | undefined;
	let localStorageMock: {
		getItem: ReturnType<typeof vi.fn>;
		setItem: ReturnType<typeof vi.fn>;
		removeItem: ReturnType<typeof vi.fn>;
	};

	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();

		// Save original
		originalNotification = (window as any).Notification;

		// Mock localStorage
		localStorageMock = {
			getItem: vi.fn().mockReturnValue(null),
			setItem: vi.fn(),
			removeItem: vi.fn(),
		};
		Object.defineProperty(window, 'localStorage', {
			value: localStorageMock,
			writable: true,
		});

		// Setup default mock Notification
		(window as any).Notification = createMockNotification('default');

		// Mock document.visibilityState
		Object.defineProperty(document, 'visibilityState', {
			value: 'visible',
			writable: true,
			configurable: true,
		});
	});

	afterEach(() => {
		vi.useRealTimers();
		if (originalNotification !== undefined) {
			(window as any).Notification = originalNotification;
		} else {
			delete (window as any).Notification;
		}
	});

	// ============================================
	// Type Export Tests
	// ============================================
	describe('type exports', () => {
		it('NotificationPermission type accepts valid values', () => {
			const defaultPerm: NotificationPermission = 'default';
			const grantedPerm: NotificationPermission = 'granted';
			const deniedPerm: NotificationPermission = 'denied';

			expect(defaultPerm).toBe('default');
			expect(grantedPerm).toBe('granted');
			expect(deniedPerm).toBe('denied');
		});

		it('UseNotificationsOptions interface has expected properties', () => {
			const options: UseNotificationsOptions = {
				autoRequest: true,
				requestDelay: 1000,
				onGranted: () => {},
				onDenied: () => {},
				onPermissionChange: () => {},
			};

			expect(options.autoRequest).toBe(true);
			expect(options.requestDelay).toBe(1000);
			expect(typeof options.onGranted).toBe('function');
			expect(typeof options.onDenied).toBe('function');
			expect(typeof options.onPermissionChange).toBe('function');
		});

		it('UseNotificationsReturn interface has expected shape', () => {
			const { result } = renderHook(() => useNotifications({ autoRequest: false }));

			const returnValue: UseNotificationsReturn = result.current;

			expect(typeof returnValue.permission).toBe('string');
			expect(typeof returnValue.isSupported).toBe('boolean');
			expect(typeof returnValue.hasPrompted).toBe('boolean');
			expect(typeof returnValue.hasDeclined).toBe('boolean');
			expect(typeof returnValue.requestPermission).toBe('function');
			expect(typeof returnValue.declineNotifications).toBe('function');
			expect(typeof returnValue.resetPromptState).toBe('function');
			expect(typeof returnValue.showNotification).toBe('function');
		});
	});

	// ============================================
	// isNotificationSupported() Tests
	// ============================================
	describe('isNotificationSupported()', () => {
		it('returns true when Notification is in window', () => {
			(window as any).Notification = createMockNotification();
			expect(isNotificationSupported()).toBe(true);
		});

		it('returns false when Notification is not in window', () => {
			delete (window as any).Notification;
			expect(isNotificationSupported()).toBe(false);
		});

		it('returns true when Notification exists even with default permission', () => {
			(window as any).Notification = createMockNotification('default');
			expect(isNotificationSupported()).toBe(true);
		});

		it('returns true regardless of permission state', () => {
			(window as any).Notification = createMockNotification('denied');
			expect(isNotificationSupported()).toBe(true);
		});
	});

	// ============================================
	// getNotificationPermission() Tests
	// ============================================
	describe('getNotificationPermission()', () => {
		it('returns denied when not supported', () => {
			delete (window as any).Notification;
			expect(getNotificationPermission()).toBe('denied');
		});

		it('returns default permission', () => {
			(window as any).Notification = createMockNotification('default');
			expect(getNotificationPermission()).toBe('default');
		});

		it('returns granted permission', () => {
			(window as any).Notification = createMockNotification('granted');
			expect(getNotificationPermission()).toBe('granted');
		});

		it('returns denied permission', () => {
			(window as any).Notification = createMockNotification('denied');
			expect(getNotificationPermission()).toBe('denied');
		});
	});

	// ============================================
	// Initial State Tests
	// ============================================
	describe('initial state', () => {
		it('initial permission matches browser state', () => {
			(window as any).Notification = createMockNotification('granted');
			const { result } = renderHook(() => useNotifications({ autoRequest: false }));
			expect(result.current.permission).toBe('granted');
		});

		it('initial permission is default when browser has default', () => {
			(window as any).Notification = createMockNotification('default');
			const { result } = renderHook(() => useNotifications({ autoRequest: false }));
			expect(result.current.permission).toBe('default');
		});

		it('isSupported reflects Notification API availability', () => {
			(window as any).Notification = createMockNotification();
			const { result } = renderHook(() => useNotifications({ autoRequest: false }));
			expect(result.current.isSupported).toBe(true);

			delete (window as any).Notification;
			const { result: result2 } = renderHook(() => useNotifications({ autoRequest: false }));
			expect(result2.current.isSupported).toBe(false);
		});

		it('hasPrompted loads true from localStorage', () => {
			localStorageMock.getItem.mockImplementation((key: string) => {
				if (key === NOTIFICATION_PROMPT_KEY) return 'true';
				return null;
			});

			const { result } = renderHook(() => useNotifications({ autoRequest: false }));
			expect(result.current.hasPrompted).toBe(true);
		});

		it('hasPrompted defaults to false when no storage', () => {
			localStorageMock.getItem.mockReturnValue(null);
			const { result } = renderHook(() => useNotifications({ autoRequest: false }));
			expect(result.current.hasPrompted).toBe(false);
		});

		it('hasDeclined loads true from localStorage', () => {
			localStorageMock.getItem.mockImplementation((key: string) => {
				if (key === NOTIFICATION_DECLINED_KEY) return 'true';
				return null;
			});

			const { result } = renderHook(() => useNotifications({ autoRequest: false }));
			expect(result.current.hasDeclined).toBe(true);
		});

		it('hasDeclined defaults to false when no storage', () => {
			localStorageMock.getItem.mockReturnValue(null);
			const { result } = renderHook(() => useNotifications({ autoRequest: false }));
			expect(result.current.hasDeclined).toBe(false);
		});

		it('loads both prompted and declined from storage', () => {
			localStorageMock.getItem.mockImplementation((key: string) => {
				if (key === NOTIFICATION_PROMPT_KEY) return 'true';
				if (key === NOTIFICATION_DECLINED_KEY) return 'true';
				return null;
			});

			const { result } = renderHook(() => useNotifications({ autoRequest: false }));
			expect(result.current.hasPrompted).toBe(true);
			expect(result.current.hasDeclined).toBe(true);
		});
	});

	// ============================================
	// requestPermission() Callback Tests
	// ============================================
	describe('requestPermission()', () => {
		it('sets hasPrompted to true', async () => {
			const { result } = renderHook(() => useNotifications({ autoRequest: false }));

			expect(result.current.hasPrompted).toBe(false);

			await act(async () => {
				await result.current.requestPermission();
			});

			expect(result.current.hasPrompted).toBe(true);
		});

		it('saves prompted state to localStorage', async () => {
			const { result } = renderHook(() => useNotifications({ autoRequest: false }));

			await act(async () => {
				await result.current.requestPermission();
			});

			expect(localStorageMock.setItem).toHaveBeenCalledWith(NOTIFICATION_PROMPT_KEY, 'true');
		});

		it('returns denied when not supported', async () => {
			delete (window as any).Notification;
			const { result } = renderHook(() => useNotifications({ autoRequest: false }));

			let returnedPermission: NotificationPermission;
			await act(async () => {
				returnedPermission = await result.current.requestPermission();
			});

			expect(returnedPermission!).toBe('denied');
			expect(webLogger.debug).toHaveBeenCalledWith(
				'Notifications not supported in this browser',
				'Notifications'
			);
		});

		it('calls Notification.requestPermission', async () => {
			const mockRequest = vi.fn().mockResolvedValue('granted');
			(window as any).Notification.requestPermission = mockRequest;

			const { result } = renderHook(() => useNotifications({ autoRequest: false }));

			await act(async () => {
				await result.current.requestPermission();
			});

			expect(mockRequest).toHaveBeenCalled();
		});

		it('updates permission state on grant', async () => {
			(window as any).Notification.requestPermission = vi.fn().mockResolvedValue('granted');

			const { result } = renderHook(() => useNotifications({ autoRequest: false }));

			await act(async () => {
				await result.current.requestPermission();
			});

			expect(result.current.permission).toBe('granted');
		});

		it('updates permission state on denial', async () => {
			(window as any).Notification.requestPermission = vi.fn().mockResolvedValue('denied');

			const { result } = renderHook(() => useNotifications({ autoRequest: false }));

			await act(async () => {
				await result.current.requestPermission();
			});

			expect(result.current.permission).toBe('denied');
		});

		it('calls onGranted callback when granted', async () => {
			(window as any).Notification.requestPermission = vi.fn().mockResolvedValue('granted');
			const onGranted = vi.fn();

			const { result } = renderHook(() => useNotifications({ autoRequest: false, onGranted }));

			await act(async () => {
				await result.current.requestPermission();
			});

			expect(onGranted).toHaveBeenCalled();
		});

		it('calls onDenied callback when denied', async () => {
			(window as any).Notification.requestPermission = vi.fn().mockResolvedValue('denied');
			const onDenied = vi.fn();

			const { result } = renderHook(() => useNotifications({ autoRequest: false, onDenied }));

			await act(async () => {
				await result.current.requestPermission();
			});

			expect(onDenied).toHaveBeenCalled();
		});

		it('calls onPermissionChange callback with new permission', async () => {
			(window as any).Notification.requestPermission = vi.fn().mockResolvedValue('granted');
			const onPermissionChange = vi.fn();

			const { result } = renderHook(() =>
				useNotifications({ autoRequest: false, onPermissionChange })
			);

			await act(async () => {
				await result.current.requestPermission();
			});

			expect(onPermissionChange).toHaveBeenCalledWith('granted');
		});

		it('handles requestPermission error', async () => {
			const error = new Error('Permission error');
			(window as any).Notification.requestPermission = vi.fn().mockRejectedValue(error);

			const { result } = renderHook(() => useNotifications({ autoRequest: false }));

			let returnedPermission: NotificationPermission;
			await act(async () => {
				returnedPermission = await result.current.requestPermission();
			});

			expect(returnedPermission!).toBe('denied');
			expect(webLogger.error).toHaveBeenCalledWith(
				'Error requesting permission',
				'Notifications',
				error
			);
		});

		it('returns denied on error', async () => {
			(window as any).Notification.requestPermission = vi.fn().mockRejectedValue(new Error());

			const { result } = renderHook(() => useNotifications({ autoRequest: false }));

			let returnedPermission: NotificationPermission;
			await act(async () => {
				returnedPermission = await result.current.requestPermission();
			});

			expect(returnedPermission!).toBe('denied');
		});
	});

	// ============================================
	// declineNotifications() Callback Tests
	// ============================================
	describe('declineNotifications()', () => {
		it('sets hasDeclined to true', () => {
			const { result } = renderHook(() => useNotifications({ autoRequest: false }));

			expect(result.current.hasDeclined).toBe(false);

			act(() => {
				result.current.declineNotifications();
			});

			expect(result.current.hasDeclined).toBe(true);
		});

		it('sets hasPrompted to true', () => {
			const { result } = renderHook(() => useNotifications({ autoRequest: false }));

			act(() => {
				result.current.declineNotifications();
			});

			expect(result.current.hasPrompted).toBe(true);
		});

		it('saves declined state to localStorage', () => {
			const { result } = renderHook(() => useNotifications({ autoRequest: false }));

			act(() => {
				result.current.declineNotifications();
			});

			expect(localStorageMock.setItem).toHaveBeenCalledWith(NOTIFICATION_DECLINED_KEY, 'true');
		});

		it('saves prompted state to localStorage', () => {
			const { result } = renderHook(() => useNotifications({ autoRequest: false }));

			act(() => {
				result.current.declineNotifications();
			});

			expect(localStorageMock.setItem).toHaveBeenCalledWith(NOTIFICATION_PROMPT_KEY, 'true');
		});

		it('logs the decline action', () => {
			const { result } = renderHook(() => useNotifications({ autoRequest: false }));

			act(() => {
				result.current.declineNotifications();
			});

			expect(webLogger.debug).toHaveBeenCalledWith('User declined via UI', 'Notifications');
		});
	});

	// ============================================
	// resetPromptState() Callback Tests
	// ============================================
	describe('resetPromptState()', () => {
		it('sets hasPrompted to false', () => {
			localStorageMock.getItem.mockImplementation((key: string) => {
				if (key === NOTIFICATION_PROMPT_KEY) return 'true';
				return null;
			});

			const { result } = renderHook(() => useNotifications({ autoRequest: false }));
			expect(result.current.hasPrompted).toBe(true);

			act(() => {
				result.current.resetPromptState();
			});

			expect(result.current.hasPrompted).toBe(false);
		});

		it('sets hasDeclined to false', () => {
			localStorageMock.getItem.mockImplementation((key: string) => {
				if (key === NOTIFICATION_DECLINED_KEY) return 'true';
				return null;
			});

			const { result } = renderHook(() => useNotifications({ autoRequest: false }));
			expect(result.current.hasDeclined).toBe(true);

			act(() => {
				result.current.resetPromptState();
			});

			expect(result.current.hasDeclined).toBe(false);
		});

		it('removes prompted key from localStorage', () => {
			const { result } = renderHook(() => useNotifications({ autoRequest: false }));

			act(() => {
				result.current.resetPromptState();
			});

			expect(localStorageMock.removeItem).toHaveBeenCalledWith(NOTIFICATION_PROMPT_KEY);
		});

		it('removes declined key from localStorage', () => {
			const { result } = renderHook(() => useNotifications({ autoRequest: false }));

			act(() => {
				result.current.resetPromptState();
			});

			expect(localStorageMock.removeItem).toHaveBeenCalledWith(NOTIFICATION_DECLINED_KEY);
		});

		it('logs the reset action', () => {
			const { result } = renderHook(() => useNotifications({ autoRequest: false }));

			act(() => {
				result.current.resetPromptState();
			});

			expect(webLogger.debug).toHaveBeenCalledWith('Prompt state reset', 'Notifications');
		});
	});

	// ============================================
	// showNotification() Callback Tests
	// ============================================
	describe('showNotification()', () => {
		it('returns null when not supported', () => {
			delete (window as any).Notification;
			const { result } = renderHook(() => useNotifications({ autoRequest: false }));

			const notification = result.current.showNotification('Test', {});
			expect(notification).toBeNull();
		});

		it('returns null when permission is default', () => {
			(window as any).Notification = createMockNotification('default');
			const { result } = renderHook(() => useNotifications({ autoRequest: false }));

			const notification = result.current.showNotification('Test', {});
			expect(notification).toBeNull();
		});

		it('returns null when permission is denied', () => {
			(window as any).Notification = createMockNotification('denied');
			const { result } = renderHook(() => useNotifications({ autoRequest: false }));

			const notification = result.current.showNotification('Test', {});
			expect(notification).toBeNull();
		});

		it('logs when cannot show notification', () => {
			(window as any).Notification = createMockNotification('default');
			const { result } = renderHook(() => useNotifications({ autoRequest: false }));

			result.current.showNotification('Test', {});

			expect(webLogger.debug).toHaveBeenCalledWith(
				'Cannot show notification, permission: default',
				'Notifications'
			);
		});

		it('creates notification when granted', () => {
			(window as any).Notification = createMockNotification('granted');
			const { result } = renderHook(() => useNotifications({ autoRequest: false }));

			const notification = result.current.showNotification('Test Title', { body: 'Test body' });

			expect(notification).not.toBeNull();
			expect((window as any).Notification).toHaveBeenCalledWith(
				'Test Title',
				expect.objectContaining({
					body: 'Test body',
				})
			);
		});

		it('uses default icon path', () => {
			(window as any).Notification = createMockNotification('granted');
			const { result } = renderHook(() => useNotifications({ autoRequest: false }));

			result.current.showNotification('Test', {});

			expect((window as any).Notification).toHaveBeenCalledWith(
				'Test',
				expect.objectContaining({
					icon: '/maestro-icon-192.png',
				})
			);
		});

		it('uses default badge path', () => {
			(window as any).Notification = createMockNotification('granted');
			const { result } = renderHook(() => useNotifications({ autoRequest: false }));

			result.current.showNotification('Test', {});

			expect((window as any).Notification).toHaveBeenCalledWith(
				'Test',
				expect.objectContaining({
					badge: '/maestro-icon-192.png',
				})
			);
		});

		it('merges provided options with defaults', () => {
			(window as any).Notification = createMockNotification('granted');
			const { result } = renderHook(() => useNotifications({ autoRequest: false }));

			result.current.showNotification('Test', {
				body: 'Custom body',
				tag: 'custom-tag',
			});

			expect((window as any).Notification).toHaveBeenCalledWith(
				'Test',
				expect.objectContaining({
					icon: '/maestro-icon-192.png',
					badge: '/maestro-icon-192.png',
					body: 'Custom body',
					tag: 'custom-tag',
				})
			);
		});

		it('allows overriding default icon', () => {
			(window as any).Notification = createMockNotification('granted');
			const { result } = renderHook(() => useNotifications({ autoRequest: false }));

			result.current.showNotification('Test', {
				icon: '/custom-icon.png',
			});

			expect((window as any).Notification).toHaveBeenCalledWith(
				'Test',
				expect.objectContaining({
					icon: '/custom-icon.png',
				})
			);
		});

		it('handles Notification constructor error', () => {
			const mockNotification = createMockNotification('granted');
			mockNotification.mockImplementation(() => {
				throw new Error('Notification error');
			});
			(window as any).Notification = mockNotification;
			(window as any).Notification.permission = 'granted';

			const { result } = renderHook(() => useNotifications({ autoRequest: false }));
			const notification = result.current.showNotification('Test', {});

			expect(notification).toBeNull();
			expect(webLogger.error).toHaveBeenCalledWith(
				'Error showing notification',
				'Notifications',
				expect.any(Error)
			);
		});

		it('returns null on constructor error', () => {
			const mockNotification = createMockNotification('granted');
			mockNotification.mockImplementation(() => {
				throw new Error('Constructor error');
			});
			(window as any).Notification = mockNotification;
			(window as any).Notification.permission = 'granted';

			const { result } = renderHook(() => useNotifications({ autoRequest: false }));
			const notification = result.current.showNotification('Test', {});

			expect(notification).toBeNull();
		});
	});

	// ============================================
	// Auto-Request Effect Tests
	// ============================================
	describe('auto-request effect', () => {
		it('triggers after default requestDelay when autoRequest is true', async () => {
			(window as any).Notification.requestPermission = vi.fn().mockResolvedValue('granted');

			renderHook(() => useNotifications({ autoRequest: true }));

			expect((window as any).Notification.requestPermission).not.toHaveBeenCalled();

			await act(async () => {
				vi.advanceTimersByTime(2000);
			});

			expect((window as any).Notification.requestPermission).toHaveBeenCalled();
		});

		it('uses custom delay when provided', async () => {
			(window as any).Notification.requestPermission = vi.fn().mockResolvedValue('granted');

			renderHook(() => useNotifications({ autoRequest: true, requestDelay: 5000 }));

			await act(async () => {
				vi.advanceTimersByTime(2000);
			});
			expect((window as any).Notification.requestPermission).not.toHaveBeenCalled();

			await act(async () => {
				vi.advanceTimersByTime(3000);
			});
			expect((window as any).Notification.requestPermission).toHaveBeenCalled();
		});

		it('does not trigger when autoRequest is false', async () => {
			(window as any).Notification.requestPermission = vi.fn().mockResolvedValue('granted');

			renderHook(() => useNotifications({ autoRequest: false }));

			await act(async () => {
				vi.advanceTimersByTime(5000);
			});

			expect((window as any).Notification.requestPermission).not.toHaveBeenCalled();
		});

		it('does not trigger when not supported', async () => {
			delete (window as any).Notification;

			renderHook(() => useNotifications({ autoRequest: true }));

			await act(async () => {
				vi.advanceTimersByTime(5000);
			});

			// Should not throw, just do nothing
		});

		it('does not trigger when hasPrompted is true', async () => {
			localStorageMock.getItem.mockImplementation((key: string) => {
				if (key === NOTIFICATION_PROMPT_KEY) return 'true';
				return null;
			});
			(window as any).Notification.requestPermission = vi.fn().mockResolvedValue('granted');

			renderHook(() => useNotifications({ autoRequest: true }));

			await act(async () => {
				vi.advanceTimersByTime(5000);
			});

			expect((window as any).Notification.requestPermission).not.toHaveBeenCalled();
		});

		it('does not trigger when hasDeclined is true', async () => {
			localStorageMock.getItem.mockImplementation((key: string) => {
				if (key === NOTIFICATION_DECLINED_KEY) return 'true';
				return null;
			});
			(window as any).Notification.requestPermission = vi.fn().mockResolvedValue('granted');

			renderHook(() => useNotifications({ autoRequest: true }));

			await act(async () => {
				vi.advanceTimersByTime(5000);
			});

			expect((window as any).Notification.requestPermission).not.toHaveBeenCalled();
		});

		it('does not trigger when permission is granted', async () => {
			(window as any).Notification = createMockNotification('granted');
			(window as any).Notification.requestPermission = vi.fn().mockResolvedValue('granted');

			renderHook(() => useNotifications({ autoRequest: true }));

			await act(async () => {
				vi.advanceTimersByTime(5000);
			});

			expect((window as any).Notification.requestPermission).not.toHaveBeenCalled();
		});

		it('does not trigger when permission is denied', async () => {
			(window as any).Notification = createMockNotification('denied');
			(window as any).Notification.requestPermission = vi.fn().mockResolvedValue('denied');

			renderHook(() => useNotifications({ autoRequest: true }));

			await act(async () => {
				vi.advanceTimersByTime(5000);
			});

			expect((window as any).Notification.requestPermission).not.toHaveBeenCalled();
		});

		it('clears timeout on unmount', async () => {
			(window as any).Notification.requestPermission = vi.fn().mockResolvedValue('granted');

			const { unmount } = renderHook(() => useNotifications({ autoRequest: true }));

			unmount();

			await act(async () => {
				vi.advanceTimersByTime(5000);
			});

			expect((window as any).Notification.requestPermission).not.toHaveBeenCalled();
		});

		it('logs when auto-requesting', async () => {
			(window as any).Notification.requestPermission = vi.fn().mockResolvedValue('granted');

			renderHook(() => useNotifications({ autoRequest: true }));

			await act(async () => {
				vi.advanceTimersByTime(2000);
			});

			expect(webLogger.debug).toHaveBeenCalledWith(
				'Auto-requesting permission after delay',
				'Notifications'
			);
		});
	});

	// ============================================
	// Visibility Change Effect Tests
	// ============================================
	describe('visibility change effect', () => {
		it('adds visibilitychange listener when supported', () => {
			const addEventListenerSpy = vi.spyOn(document, 'addEventListener');

			renderHook(() => useNotifications({ autoRequest: false }));

			expect(addEventListenerSpy).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
		});

		it('does not add listener when not supported', () => {
			delete (window as any).Notification;
			const addEventListenerSpy = vi.spyOn(document, 'addEventListener');

			renderHook(() => useNotifications({ autoRequest: false }));

			// Should not add visibilitychange listener for notifications
			const visibilityCalls = addEventListenerSpy.mock.calls.filter(
				(call) => call[0] === 'visibilitychange'
			);
			expect(visibilityCalls.length).toBe(0);
		});

		it('checks permission on visibility change to visible', () => {
			let visibilityHandler: EventListener | null = null;
			vi.spyOn(document, 'addEventListener').mockImplementation((event, handler) => {
				if (event === 'visibilitychange') {
					visibilityHandler = handler as EventListener;
				}
			});

			(window as any).Notification = createMockNotification('default');
			const onPermissionChange = vi.fn();

			renderHook(() => useNotifications({ autoRequest: false, onPermissionChange }));

			// Change permission externally
			(window as any).Notification.permission = 'granted';

			// Simulate visibility change to visible
			Object.defineProperty(document, 'visibilityState', {
				value: 'visible',
				configurable: true,
			});

			act(() => {
				visibilityHandler?.(new Event('visibilitychange'));
			});

			expect(onPermissionChange).toHaveBeenCalledWith('granted');
		});

		it('does not check on visibility change to hidden', () => {
			let visibilityHandler: EventListener | null = null;
			vi.spyOn(document, 'addEventListener').mockImplementation((event, handler) => {
				if (event === 'visibilitychange') {
					visibilityHandler = handler as EventListener;
				}
			});

			(window as any).Notification = createMockNotification('default');
			const onPermissionChange = vi.fn();

			renderHook(() => useNotifications({ autoRequest: false, onPermissionChange }));

			// Change permission externally
			(window as any).Notification.permission = 'granted';

			// Simulate visibility change to hidden
			Object.defineProperty(document, 'visibilityState', {
				value: 'hidden',
				configurable: true,
			});

			act(() => {
				visibilityHandler?.(new Event('visibilitychange'));
			});

			expect(onPermissionChange).not.toHaveBeenCalled();
		});

		it('updates permission state when changed externally', () => {
			let visibilityHandler: EventListener | null = null;
			vi.spyOn(document, 'addEventListener').mockImplementation((event, handler) => {
				if (event === 'visibilitychange') {
					visibilityHandler = handler as EventListener;
				}
			});

			(window as any).Notification = createMockNotification('default');

			const { result } = renderHook(() => useNotifications({ autoRequest: false }));
			expect(result.current.permission).toBe('default');

			// Change permission externally
			(window as any).Notification.permission = 'granted';

			act(() => {
				visibilityHandler?.(new Event('visibilitychange'));
			});

			expect(result.current.permission).toBe('granted');
		});

		it('does not update when permission unchanged', () => {
			let visibilityHandler: EventListener | null = null;
			vi.spyOn(document, 'addEventListener').mockImplementation((event, handler) => {
				if (event === 'visibilitychange') {
					visibilityHandler = handler as EventListener;
				}
			});

			(window as any).Notification = createMockNotification('default');
			const onPermissionChange = vi.fn();

			renderHook(() => useNotifications({ autoRequest: false, onPermissionChange }));

			// Don't change permission

			act(() => {
				visibilityHandler?.(new Event('visibilitychange'));
			});

			expect(onPermissionChange).not.toHaveBeenCalled();
		});

		it('removes listener on cleanup', () => {
			const removeEventListenerSpy = vi.spyOn(document, 'removeEventListener');

			const { unmount } = renderHook(() => useNotifications({ autoRequest: false }));

			unmount();

			expect(removeEventListenerSpy).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
		});
	});

	// ============================================
	// Callback Stability Tests
	// ============================================
	describe('callback stability', () => {
		it('requestPermission reference is stable', () => {
			const { result, rerender } = renderHook(() => useNotifications({ autoRequest: false }));

			const firstRef = result.current.requestPermission;
			rerender();
			const secondRef = result.current.requestPermission;

			expect(firstRef).toBe(secondRef);
		});

		it('declineNotifications reference is stable', () => {
			const { result, rerender } = renderHook(() => useNotifications({ autoRequest: false }));

			const firstRef = result.current.declineNotifications;
			rerender();
			const secondRef = result.current.declineNotifications;

			expect(firstRef).toBe(secondRef);
		});

		it('resetPromptState reference is stable', () => {
			const { result, rerender } = renderHook(() => useNotifications({ autoRequest: false }));

			const firstRef = result.current.resetPromptState;
			rerender();
			const secondRef = result.current.resetPromptState;

			expect(firstRef).toBe(secondRef);
		});

		it('showNotification updates when permission changes', async () => {
			(window as any).Notification.requestPermission = vi.fn().mockResolvedValue('granted');

			const { result } = renderHook(() => useNotifications({ autoRequest: false }));

			const firstRef = result.current.showNotification;

			await act(async () => {
				await result.current.requestPermission();
			});

			const secondRef = result.current.showNotification;

			// showNotification depends on permission, so it may change
			// The actual behavior should still work correctly
			expect(typeof firstRef).toBe('function');
			expect(typeof secondRef).toBe('function');
		});
	});

	// ============================================
	// Default Export Tests
	// ============================================
	describe('default export', () => {
		it('useNotifications is the default export', async () => {
			const module = await import('../../../web/hooks/useNotifications');
			expect(module.default).toBe(module.useNotifications);
		});

		it('default export is a function', async () => {
			const module = await import('../../../web/hooks/useNotifications');
			expect(typeof module.default).toBe('function');
		});
	});

	// ============================================
	// Edge Cases Tests
	// ============================================
	describe('edge cases', () => {
		it('handles rapid sequential permission requests', async () => {
			const mockRequest = vi.fn().mockResolvedValue('granted');
			(window as any).Notification.requestPermission = mockRequest;

			const { result } = renderHook(() => useNotifications({ autoRequest: false }));

			await act(async () => {
				// Fire multiple requests rapidly
				const promises = [
					result.current.requestPermission(),
					result.current.requestPermission(),
					result.current.requestPermission(),
				];
				await Promise.all(promises);
			});

			// All should resolve, but we don't crash
			expect(result.current.permission).toBe('granted');
		});

		it('handles multiple notifications in sequence', () => {
			(window as any).Notification = createMockNotification('granted');
			const { result } = renderHook(() => useNotifications({ autoRequest: false }));

			const n1 = result.current.showNotification('Test 1', {});
			const n2 = result.current.showNotification('Test 2', {});
			const n3 = result.current.showNotification('Test 3', {});

			expect(n1).not.toBeNull();
			expect(n2).not.toBeNull();
			expect(n3).not.toBeNull();
		});

		it('works with empty options object', () => {
			const { result } = renderHook(() => useNotifications({}));
			expect(result.current.isSupported).toBe(true);
		});

		it('works with undefined options', () => {
			const { result } = renderHook(() => useNotifications());
			expect(result.current.isSupported).toBe(true);
		});

		it('works with all options provided', async () => {
			(window as any).Notification.requestPermission = vi.fn().mockResolvedValue('granted');

			const onGranted = vi.fn();
			const onDenied = vi.fn();
			const onPermissionChange = vi.fn();

			const { result } = renderHook(() =>
				useNotifications({
					autoRequest: false,
					requestDelay: 1000,
					onGranted,
					onDenied,
					onPermissionChange,
				})
			);

			await act(async () => {
				await result.current.requestPermission();
			});

			expect(onGranted).toHaveBeenCalled();
			expect(onPermissionChange).toHaveBeenCalledWith('granted');
		});

		it('handles notification with empty title', () => {
			(window as any).Notification = createMockNotification('granted');
			const { result } = renderHook(() => useNotifications({ autoRequest: false }));

			const notification = result.current.showNotification('', {});
			expect(notification).not.toBeNull();
		});

		it('handles notification with complex options', () => {
			(window as any).Notification = createMockNotification('granted');
			const { result } = renderHook(() => useNotifications({ autoRequest: false }));

			const notification = result.current.showNotification('Test', {
				body: 'Test body with special chars: <>&"\'',
				tag: 'test-tag',
				requireInteraction: true,
				silent: true,
				data: { custom: 'data', nested: { value: 123 } },
			});

			expect(notification).not.toBeNull();
			expect((window as any).Notification).toHaveBeenCalledWith(
				'Test',
				expect.objectContaining({
					body: 'Test body with special chars: <>&"\'',
					tag: 'test-tag',
					requireInteraction: true,
					silent: true,
				})
			);
		});

		it('decline followed by reset allows new prompt', () => {
			const { result } = renderHook(() => useNotifications({ autoRequest: false }));

			act(() => {
				result.current.declineNotifications();
			});

			expect(result.current.hasDeclined).toBe(true);
			expect(result.current.hasPrompted).toBe(true);

			act(() => {
				result.current.resetPromptState();
			});

			expect(result.current.hasDeclined).toBe(false);
			expect(result.current.hasPrompted).toBe(false);
		});
	});

	// ============================================
	// Integration Tests
	// ============================================
	describe('integration scenarios', () => {
		it('full permission grant flow', async () => {
			(window as any).Notification = createMockNotification('default');
			(window as any).Notification.requestPermission = vi.fn().mockResolvedValue('granted');

			const onGranted = vi.fn();
			const { result } = renderHook(() => useNotifications({ autoRequest: false, onGranted }));

			expect(result.current.permission).toBe('default');
			expect(result.current.hasPrompted).toBe(false);

			await act(async () => {
				await result.current.requestPermission();
			});

			expect(result.current.permission).toBe('granted');
			expect(result.current.hasPrompted).toBe(true);
			expect(onGranted).toHaveBeenCalled();

			// Now can show notification
			const notification = result.current.showNotification('Success!', {});
			expect(notification).not.toBeNull();
		});

		it('full permission deny flow', async () => {
			(window as any).Notification = createMockNotification('default');
			(window as any).Notification.requestPermission = vi.fn().mockResolvedValue('denied');

			const onDenied = vi.fn();
			const { result } = renderHook(() => useNotifications({ autoRequest: false, onDenied }));

			await act(async () => {
				await result.current.requestPermission();
			});

			expect(result.current.permission).toBe('denied');
			expect(onDenied).toHaveBeenCalled();

			// Cannot show notification
			const notification = result.current.showNotification('Test', {});
			expect(notification).toBeNull();
		});

		it('user UI decline flow', () => {
			const { result } = renderHook(() => useNotifications({ autoRequest: false }));

			expect(result.current.hasDeclined).toBe(false);

			act(() => {
				result.current.declineNotifications();
			});

			expect(result.current.hasDeclined).toBe(true);
			expect(localStorageMock.setItem).toHaveBeenCalledWith(NOTIFICATION_DECLINED_KEY, 'true');

			// Cannot show notification (permission still default)
			const notification = result.current.showNotification('Test', {});
			expect(notification).toBeNull();
		});

		it('auto-request only fires once per session', async () => {
			(window as any).Notification = createMockNotification('default');
			(window as any).Notification.requestPermission = vi.fn().mockResolvedValue('granted');

			// First render - should auto-request
			const { unmount } = renderHook(() => useNotifications({ autoRequest: true }));

			await act(async () => {
				vi.advanceTimersByTime(2000);
			});

			expect((window as any).Notification.requestPermission).toHaveBeenCalledTimes(1);

			unmount();

			// Now simulate already prompted (as stored in localStorage)
			localStorageMock.getItem.mockImplementation((key: string) => {
				if (key === NOTIFICATION_PROMPT_KEY) return 'true';
				return null;
			});

			// Second render - should NOT auto-request
			renderHook(() => useNotifications({ autoRequest: true }));

			await act(async () => {
				vi.advanceTimersByTime(5000);
			});

			// Still only 1 call from before
			expect((window as any).Notification.requestPermission).toHaveBeenCalledTimes(1);
		});
	});
});
