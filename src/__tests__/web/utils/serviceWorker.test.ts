/**
 * Tests for src/web/utils/serviceWorker.ts
 *
 * Service Worker Registration Utility tests covering:
 * - isServiceWorkerSupported() - Browser support detection
 * - registerServiceWorker() - Registration with callbacks
 * - unregisterServiceWorker() - Unregistration
 * - isOffline() - Online status check
 * - skipWaiting() - Skip waiting for new SW
 * - pingServiceWorker() - MessageChannel ping/pong
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the logger module - factory must be inline
vi.mock('../../../web/utils/logger', () => ({
	webLogger: {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}));

import {
	isServiceWorkerSupported,
	registerServiceWorker,
	unregisterServiceWorker,
	isOffline,
	skipWaiting,
	pingServiceWorker,
	ServiceWorkerConfig,
} from '../../../web/utils/serviceWorker';

// Get a reference to the mocked logger
import { webLogger } from '../../../web/utils/logger';
const mockWebLogger = vi.mocked(webLogger);

describe('serviceWorker', () => {
	// Store original navigator and window properties
	let originalNavigator: typeof navigator;
	let originalWindow: typeof window;

	beforeEach(() => {
		vi.clearAllMocks();

		// Save original values
		originalNavigator = global.navigator;
		originalWindow = global.window;
	});

	afterEach(() => {
		// Restore original values
		if (originalNavigator !== global.navigator) {
			Object.defineProperty(global, 'navigator', {
				value: originalNavigator,
				writable: true,
				configurable: true,
			});
		}
		vi.restoreAllMocks();
	});

	describe('isServiceWorkerSupported', () => {
		it('should return true when serviceWorker is in navigator', () => {
			Object.defineProperty(global.navigator, 'serviceWorker', {
				value: {},
				writable: true,
				configurable: true,
			});

			expect(isServiceWorkerSupported()).toBe(true);
		});

		it('should return false when serviceWorker is not in navigator', () => {
			// Create a navigator without serviceWorker
			const navigatorWithoutSW = {
				...navigator,
				userAgent: navigator.userAgent,
				language: navigator.language,
			};
			// Explicitly remove serviceWorker
			delete (navigatorWithoutSW as Record<string, unknown>).serviceWorker;

			Object.defineProperty(global, 'navigator', {
				value: navigatorWithoutSW,
				writable: true,
				configurable: true,
			});

			expect(isServiceWorkerSupported()).toBe(false);
		});
	});

	describe('isOffline', () => {
		it('should return true when navigator.onLine is false', () => {
			Object.defineProperty(global.navigator, 'onLine', {
				value: false,
				writable: true,
				configurable: true,
			});

			expect(isOffline()).toBe(true);
		});

		it('should return false when navigator.onLine is true', () => {
			Object.defineProperty(global.navigator, 'onLine', {
				value: true,
				writable: true,
				configurable: true,
			});

			expect(isOffline()).toBe(false);
		});
	});

	describe('registerServiceWorker', () => {
		let mockRegistration: Partial<ServiceWorkerRegistration>;
		let mockServiceWorker: Partial<ServiceWorker>;
		let mockServiceWorkerContainer: Partial<ServiceWorkerContainer>;
		let updateFoundCallbacks: Array<() => void>;
		let stateChangeCallbacks: Array<() => void>;
		let messageCallback: ((event: MessageEvent) => void) | null;

		beforeEach(() => {
			updateFoundCallbacks = [];
			stateChangeCallbacks = [];
			messageCallback = null;

			mockServiceWorker = {
				state: 'installing',
				addEventListener: vi.fn((event: string, cb: () => void) => {
					if (event === 'statechange') {
						stateChangeCallbacks.push(cb);
					}
				}),
				postMessage: vi.fn(),
			};

			mockRegistration = {
				scope: '/test/',
				active: null,
				installing: mockServiceWorker as ServiceWorker,
				waiting: null,
				addEventListener: vi.fn((event: string, cb: () => void) => {
					if (event === 'updatefound') {
						updateFoundCallbacks.push(cb);
					}
				}),
				unregister: vi.fn().mockResolvedValue(true),
			};

			mockServiceWorkerContainer = {
				register: vi.fn().mockResolvedValue(mockRegistration),
				ready: Promise.resolve(mockRegistration as ServiceWorkerRegistration),
				controller: null,
				addEventListener: vi.fn((event: string, cb: (event: MessageEvent) => void) => {
					if (event === 'message') {
						messageCallback = cb;
					}
				}),
			};

			Object.defineProperty(global.navigator, 'serviceWorker', {
				value: mockServiceWorkerContainer,
				writable: true,
				configurable: true,
			});

			// Clear any __MAESTRO_CONFIG__
			delete (window as unknown as { __MAESTRO_CONFIG__?: unknown }).__MAESTRO_CONFIG__;
		});

		it('should return undefined when service workers not supported', async () => {
			const navigatorWithoutSW = {
				...navigator,
				userAgent: navigator.userAgent,
			};
			delete (navigatorWithoutSW as Record<string, unknown>).serviceWorker;

			Object.defineProperty(global, 'navigator', {
				value: navigatorWithoutSW,
				writable: true,
				configurable: true,
			});

			const result = await registerServiceWorker();

			expect(result).toBeUndefined();
			expect(mockWebLogger.info).toHaveBeenCalledWith(
				'Service workers not supported',
				'ServiceWorker'
			);
		});

		it('should register service worker with default path', async () => {
			const result = await registerServiceWorker();

			expect(mockServiceWorkerContainer.register).toHaveBeenCalledWith('./sw.js', {
				scope: './',
			});
			expect(result).toBe(mockRegistration);
			expect(mockWebLogger.debug).toHaveBeenCalledWith(
				'Service worker registered',
				'ServiceWorker',
				{ scope: '/test/' }
			);
		});

		it('should register service worker with security token path', async () => {
			(window as unknown as { __MAESTRO_CONFIG__: { securityToken: string } }).__MAESTRO_CONFIG__ =
				{
					securityToken: 'abc123',
				};

			await registerServiceWorker();

			expect(mockServiceWorkerContainer.register).toHaveBeenCalledWith('/abc123/sw.js', {
				scope: '/abc123/',
			});
		});

		it('should call onSuccess when already active', async () => {
			const onSuccess = vi.fn();
			mockRegistration.active = {} as ServiceWorker;

			await registerServiceWorker({ onSuccess });

			expect(onSuccess).toHaveBeenCalledWith(mockRegistration);
		});

		it('should handle updatefound event', async () => {
			const onUpdate = vi.fn();
			const onSuccess = vi.fn();

			await registerServiceWorker({ onUpdate, onSuccess });

			// Trigger updatefound
			expect(updateFoundCallbacks.length).toBe(1);
			updateFoundCallbacks[0]();

			// Verify statechange listener was added
			expect(mockServiceWorker.addEventListener).toHaveBeenCalledWith(
				'statechange',
				expect.any(Function)
			);
		});

		it('should call onUpdate when new update is available', async () => {
			const onUpdate = vi.fn();
			mockServiceWorkerContainer.controller = {} as ServiceWorker;

			await registerServiceWorker({ onUpdate });

			// Trigger updatefound
			updateFoundCallbacks[0]();

			// Change state to installed
			mockServiceWorker.state = 'installed';
			stateChangeCallbacks[0]();

			expect(onUpdate).toHaveBeenCalledWith(mockRegistration);
			expect(mockWebLogger.info).toHaveBeenCalledWith(
				'New content available, refresh to update',
				'ServiceWorker'
			);
		});

		it('should call onSuccess on first install (no controller)', async () => {
			const onSuccess = vi.fn();
			mockServiceWorkerContainer.controller = null;

			await registerServiceWorker({ onSuccess });

			// Trigger updatefound
			updateFoundCallbacks[0]();

			// Change state to installed
			mockServiceWorker.state = 'installed';
			stateChangeCallbacks[0]();

			expect(onSuccess).toHaveBeenCalledWith(mockRegistration);
			expect(mockWebLogger.info).toHaveBeenCalledWith(
				'Content cached for offline use',
				'ServiceWorker'
			);
		});

		it('should handle updatefound with null installing', async () => {
			mockRegistration.installing = null;

			await registerServiceWorker();

			// Trigger updatefound
			updateFoundCallbacks[0]();

			// Should not throw - early return when newWorker is null
		});

		it('should set up offline status listeners when onOfflineChange provided', async () => {
			const onOfflineChange = vi.fn();
			const addEventListenerSpy = vi.spyOn(window, 'addEventListener');

			await registerServiceWorker({ onOfflineChange });

			expect(addEventListenerSpy).toHaveBeenCalledWith('online', expect.any(Function));
			expect(addEventListenerSpy).toHaveBeenCalledWith('offline', expect.any(Function));
		});

		it('should call onOfflineChange with false on online event', async () => {
			const onOfflineChange = vi.fn();
			let onlineHandler: (() => void) | null = null;

			vi.spyOn(window, 'addEventListener').mockImplementation((event, handler) => {
				if (event === 'online') {
					onlineHandler = handler as () => void;
				}
			});

			await registerServiceWorker({ onOfflineChange });

			onlineHandler?.();
			expect(onOfflineChange).toHaveBeenCalledWith(false);
		});

		it('should call onOfflineChange with true on offline event', async () => {
			const onOfflineChange = vi.fn();
			let offlineHandler: (() => void) | null = null;

			vi.spyOn(window, 'addEventListener').mockImplementation((event, handler) => {
				if (event === 'offline') {
					offlineHandler = handler as () => void;
				}
			});

			await registerServiceWorker({ onOfflineChange });

			offlineHandler?.();
			expect(onOfflineChange).toHaveBeenCalledWith(true);
		});

		it('should handle connection-change message from service worker', async () => {
			const onOfflineChange = vi.fn();

			await registerServiceWorker({ onOfflineChange });

			// Simulate message event
			const messageEvent = { data: { type: 'connection-change', online: true } } as MessageEvent;
			messageCallback?.(messageEvent);

			expect(onOfflineChange).toHaveBeenCalledWith(false); // !online = false
		});

		it('should handle connection-change message with offline status', async () => {
			const onOfflineChange = vi.fn();

			await registerServiceWorker({ onOfflineChange });

			const messageEvent = { data: { type: 'connection-change', online: false } } as MessageEvent;
			messageCallback?.(messageEvent);

			expect(onOfflineChange).toHaveBeenCalledWith(true); // !online = true
		});

		it('should forward other messages to onMessage callback', async () => {
			const onOfflineChange = vi.fn();
			const onMessage = vi.fn();

			await registerServiceWorker({ onOfflineChange, onMessage });

			const messageEvent = { data: { type: 'custom', payload: 'test' } } as MessageEvent;
			messageCallback?.(messageEvent);

			expect(onMessage).toHaveBeenCalledWith({ type: 'custom', payload: 'test' });
		});

		it('should forward connection-change messages to onMessage as well', async () => {
			const onOfflineChange = vi.fn();
			const onMessage = vi.fn();

			await registerServiceWorker({ onOfflineChange, onMessage });

			const messageEvent = { data: { type: 'connection-change', online: true } } as MessageEvent;
			messageCallback?.(messageEvent);

			// Both callbacks should be called
			expect(onOfflineChange).toHaveBeenCalledWith(false);
			expect(onMessage).toHaveBeenCalledWith({ type: 'connection-change', online: true });
		});

		it('should set up message listener when only onMessage provided (no onOfflineChange)', async () => {
			const onMessage = vi.fn();

			await registerServiceWorker({ onMessage });

			// Verify message listener was added
			expect(mockServiceWorkerContainer.addEventListener).toHaveBeenCalledWith(
				'message',
				expect.any(Function)
			);

			// Simulate message
			const messageEvent = { data: { type: 'test' } } as MessageEvent;
			messageCallback?.(messageEvent);

			expect(onMessage).toHaveBeenCalledWith({ type: 'test' });
		});

		it('should return undefined and log error on registration failure', async () => {
			const error = new Error('Registration failed');
			mockServiceWorkerContainer.register = vi.fn().mockRejectedValue(error);

			const result = await registerServiceWorker();

			expect(result).toBeUndefined();
			expect(mockWebLogger.error).toHaveBeenCalledWith(
				'Service worker registration failed',
				'ServiceWorker',
				error
			);
		});

		it('should handle config with empty callbacks', async () => {
			const result = await registerServiceWorker({});

			expect(result).toBe(mockRegistration);
		});
	});

	describe('unregisterServiceWorker', () => {
		let mockRegistration: Partial<ServiceWorkerRegistration>;
		let mockServiceWorkerContainer: Partial<ServiceWorkerContainer>;

		beforeEach(() => {
			mockRegistration = {
				unregister: vi.fn().mockResolvedValue(true),
			};

			mockServiceWorkerContainer = {
				ready: Promise.resolve(mockRegistration as ServiceWorkerRegistration),
			};

			Object.defineProperty(global.navigator, 'serviceWorker', {
				value: mockServiceWorkerContainer,
				writable: true,
				configurable: true,
			});
		});

		it('should return false when service workers not supported', async () => {
			const navigatorWithoutSW = {
				...navigator,
				userAgent: navigator.userAgent,
			};
			delete (navigatorWithoutSW as Record<string, unknown>).serviceWorker;

			Object.defineProperty(global, 'navigator', {
				value: navigatorWithoutSW,
				writable: true,
				configurable: true,
			});

			const result = await unregisterServiceWorker();

			expect(result).toBe(false);
		});

		it('should unregister service worker successfully', async () => {
			const result = await unregisterServiceWorker();

			expect(result).toBe(true);
			expect(mockRegistration.unregister).toHaveBeenCalled();
			expect(mockWebLogger.debug).toHaveBeenCalledWith(
				'Service worker unregistered',
				'ServiceWorker',
				{ success: true }
			);
		});

		it('should return false when unregister returns false', async () => {
			mockRegistration.unregister = vi.fn().mockResolvedValue(false);

			const result = await unregisterServiceWorker();

			expect(result).toBe(false);
			expect(mockWebLogger.debug).toHaveBeenCalledWith(
				'Service worker unregistered',
				'ServiceWorker',
				{ success: false }
			);
		});

		it('should return false and log error on failure', async () => {
			const error = new Error('Unregister failed');
			mockServiceWorkerContainer.ready = Promise.reject(error);

			const result = await unregisterServiceWorker();

			expect(result).toBe(false);
			expect(mockWebLogger.error).toHaveBeenCalledWith(
				'Service worker unregistration failed',
				'ServiceWorker',
				error
			);
		});
	});

	describe('skipWaiting', () => {
		let mockRegistration: Partial<ServiceWorkerRegistration>;
		let mockWaitingWorker: Partial<ServiceWorker>;
		let mockServiceWorkerContainer: Partial<ServiceWorkerContainer>;

		beforeEach(() => {
			mockWaitingWorker = {
				postMessage: vi.fn(),
			};

			mockRegistration = {
				waiting: mockWaitingWorker as ServiceWorker,
			};

			mockServiceWorkerContainer = {
				ready: Promise.resolve(mockRegistration as ServiceWorkerRegistration),
			};

			Object.defineProperty(global.navigator, 'serviceWorker', {
				value: mockServiceWorkerContainer,
				writable: true,
				configurable: true,
			});
		});

		it('should do nothing when service workers not supported', () => {
			const navigatorWithoutSW = {
				...navigator,
				userAgent: navigator.userAgent,
			};
			delete (navigatorWithoutSW as Record<string, unknown>).serviceWorker;

			Object.defineProperty(global, 'navigator', {
				value: navigatorWithoutSW,
				writable: true,
				configurable: true,
			});

			// Should not throw
			skipWaiting();
		});

		it('should post skipWaiting message to waiting worker', async () => {
			skipWaiting();

			// Wait for the promise to resolve
			await new Promise((resolve) => setTimeout(resolve, 0));

			expect(mockWaitingWorker.postMessage).toHaveBeenCalledWith('skipWaiting');
		});

		it('should handle null waiting worker gracefully', async () => {
			mockRegistration.waiting = null;

			// Should not throw
			skipWaiting();

			await new Promise((resolve) => setTimeout(resolve, 0));

			// postMessage should not be called
			expect(mockWaitingWorker.postMessage).not.toHaveBeenCalled();
		});
	});

	describe('pingServiceWorker', () => {
		let mockActiveWorker: Partial<ServiceWorker>;
		let mockRegistration: Partial<ServiceWorkerRegistration>;
		let mockServiceWorkerContainer: Partial<ServiceWorkerContainer>;
		let mockPort1: { onmessage: ((event: MessageEvent) => void) | null };
		let mockPort2: object;

		beforeEach(() => {
			mockPort1 = {
				onmessage: null,
			};

			mockPort2 = {};

			// Mock MessageChannel as a proper class
			class MockMessageChannel {
				port1 = mockPort1;
				port2 = mockPort2;
			}
			global.MessageChannel = MockMessageChannel as unknown as typeof MessageChannel;

			mockActiveWorker = {
				postMessage: vi.fn(),
			};

			mockRegistration = {
				active: mockActiveWorker as ServiceWorker,
			};

			mockServiceWorkerContainer = {
				ready: Promise.resolve(mockRegistration as ServiceWorkerRegistration),
			};

			Object.defineProperty(global.navigator, 'serviceWorker', {
				value: mockServiceWorkerContainer,
				writable: true,
				configurable: true,
			});
		});

		it('should return false when service workers not supported', async () => {
			const navigatorWithoutSW = {
				...navigator,
				userAgent: navigator.userAgent,
			};
			delete (navigatorWithoutSW as Record<string, unknown>).serviceWorker;

			Object.defineProperty(global, 'navigator', {
				value: navigatorWithoutSW,
				writable: true,
				configurable: true,
			});

			const result = await pingServiceWorker();

			expect(result).toBe(false);
		});

		it('should return false when no active service worker', async () => {
			mockRegistration.active = null;

			const result = await pingServiceWorker();

			expect(result).toBe(false);
		});

		it('should return true when service worker responds with pong', async () => {
			const resultPromise = pingServiceWorker();

			// Wait for the promise chain to set up
			await new Promise((resolve) => setTimeout(resolve, 0));

			// Simulate pong response
			mockPort1.onmessage?.({ data: 'pong' } as MessageEvent);

			const result = await resultPromise;

			expect(result).toBe(true);
			expect(mockActiveWorker.postMessage).toHaveBeenCalledWith('ping', [mockPort2]);
		});

		it('should return false when service worker responds with non-pong', async () => {
			const resultPromise = pingServiceWorker();

			await new Promise((resolve) => setTimeout(resolve, 0));

			// Simulate wrong response
			mockPort1.onmessage?.({ data: 'not-pong' } as MessageEvent);

			const result = await resultPromise;

			expect(result).toBe(false);
		});

		it('should return false on timeout (1 second)', async () => {
			vi.useFakeTimers();

			const resultPromise = pingServiceWorker();

			// Wait for the promise chain to set up and then advance timers
			await vi.runAllTimersAsync();

			const result = await resultPromise;

			expect(result).toBe(false);

			vi.useRealTimers();
		});

		it('should return false when ready promise rejects', async () => {
			mockServiceWorkerContainer.ready = Promise.reject(new Error('Not ready'));

			const result = await pingServiceWorker();

			expect(result).toBe(false);
		});

		it('should resolve with pong even if it arrives before timeout', async () => {
			vi.useFakeTimers();

			const resultPromise = pingServiceWorker();

			// Wait for setup
			await vi.advanceTimersByTimeAsync(0);

			// Respond quickly
			mockPort1.onmessage?.({ data: 'pong' } as MessageEvent);

			const result = await resultPromise;

			expect(result).toBe(true);

			vi.useRealTimers();
		});
	});

	describe('ServiceWorkerConfig interface', () => {
		it('should accept valid config with all callbacks', () => {
			const config: ServiceWorkerConfig = {
				onSuccess: () => {},
				onUpdate: () => {},
				onOfflineChange: () => {},
				onMessage: () => {},
			};

			expect(config.onSuccess).toBeDefined();
			expect(config.onUpdate).toBeDefined();
			expect(config.onOfflineChange).toBeDefined();
			expect(config.onMessage).toBeDefined();
		});

		it('should accept empty config', () => {
			const config: ServiceWorkerConfig = {};

			expect(config.onSuccess).toBeUndefined();
			expect(config.onUpdate).toBeUndefined();
		});

		it('should accept partial config', () => {
			const config: ServiceWorkerConfig = {
				onSuccess: () => {},
			};

			expect(config.onSuccess).toBeDefined();
			expect(config.onUpdate).toBeUndefined();
		});
	});

	describe('edge cases', () => {
		it('should handle rapid registration calls', async () => {
			const mockRegistration: Partial<ServiceWorkerRegistration> = {
				scope: '/test/',
				active: null,
				installing: null,
				addEventListener: vi.fn(),
			};

			const mockServiceWorkerContainer: Partial<ServiceWorkerContainer> = {
				register: vi.fn().mockResolvedValue(mockRegistration),
				ready: Promise.resolve(mockRegistration as ServiceWorkerRegistration),
				controller: null,
				addEventListener: vi.fn(),
			};

			Object.defineProperty(global.navigator, 'serviceWorker', {
				value: mockServiceWorkerContainer,
				writable: true,
				configurable: true,
			});

			// Call multiple times rapidly
			const promises = [registerServiceWorker(), registerServiceWorker(), registerServiceWorker()];

			const results = await Promise.all(promises);

			results.forEach((result) => {
				expect(result).toBe(mockRegistration);
			});
		});

		it('should handle registration with undefined __MAESTRO_CONFIG__', async () => {
			delete (window as unknown as { __MAESTRO_CONFIG__?: unknown }).__MAESTRO_CONFIG__;

			const mockRegistration: Partial<ServiceWorkerRegistration> = {
				scope: '/test/',
				active: null,
				installing: null,
				addEventListener: vi.fn(),
			};

			const mockServiceWorkerContainer: Partial<ServiceWorkerContainer> = {
				register: vi.fn().mockResolvedValue(mockRegistration),
				ready: Promise.resolve(mockRegistration as ServiceWorkerRegistration),
				controller: null,
				addEventListener: vi.fn(),
			};

			Object.defineProperty(global.navigator, 'serviceWorker', {
				value: mockServiceWorkerContainer,
				writable: true,
				configurable: true,
			});

			await registerServiceWorker();

			expect(mockServiceWorkerContainer.register).toHaveBeenCalledWith('./sw.js', {
				scope: './',
			});
		});

		it('should handle __MAESTRO_CONFIG__ with empty securityToken', async () => {
			(window as unknown as { __MAESTRO_CONFIG__: { securityToken: string } }).__MAESTRO_CONFIG__ =
				{
					securityToken: '',
				};

			const mockRegistration: Partial<ServiceWorkerRegistration> = {
				scope: '/test/',
				active: null,
				installing: null,
				addEventListener: vi.fn(),
			};

			const mockServiceWorkerContainer: Partial<ServiceWorkerContainer> = {
				register: vi.fn().mockResolvedValue(mockRegistration),
				ready: Promise.resolve(mockRegistration as ServiceWorkerRegistration),
				controller: null,
				addEventListener: vi.fn(),
			};

			Object.defineProperty(global.navigator, 'serviceWorker', {
				value: mockServiceWorkerContainer,
				writable: true,
				configurable: true,
			});

			await registerServiceWorker();

			// Empty string is falsy, so should use default path
			expect(mockServiceWorkerContainer.register).toHaveBeenCalledWith('./sw.js', {
				scope: './',
			});
		});

		it('should handle state changes for non-installed states', async () => {
			let stateChangeCallback: (() => void) | null = null;
			const mockWorker = {
				state: 'installing',
				addEventListener: vi.fn((event: string, cb: () => void) => {
					if (event === 'statechange') {
						stateChangeCallback = cb;
					}
				}),
			};

			const mockRegistration: Partial<ServiceWorkerRegistration> = {
				scope: '/test/',
				active: null,
				installing: mockWorker as unknown as ServiceWorker,
				addEventListener: vi.fn((event: string, cb: () => void) => {
					if (event === 'updatefound') {
						cb();
					}
				}),
			};

			const mockServiceWorkerContainer: Partial<ServiceWorkerContainer> = {
				register: vi.fn().mockResolvedValue(mockRegistration),
				ready: Promise.resolve(mockRegistration as ServiceWorkerRegistration),
				controller: null,
				addEventListener: vi.fn(),
			};

			Object.defineProperty(global.navigator, 'serviceWorker', {
				value: mockServiceWorkerContainer,
				writable: true,
				configurable: true,
			});

			const onSuccess = vi.fn();
			const onUpdate = vi.fn();

			await registerServiceWorker({ onSuccess, onUpdate });

			// Change state to 'activating' (not 'installed')
			mockWorker.state = 'activating';
			stateChangeCallback?.();

			// Neither callback should be called for non-installed states
			expect(onSuccess).not.toHaveBeenCalled();
			expect(onUpdate).not.toHaveBeenCalled();
		});

		it('should handle message events with null data', async () => {
			let messageCallback: ((event: MessageEvent) => void) | null = null;

			const mockRegistration: Partial<ServiceWorkerRegistration> = {
				scope: '/test/',
				active: null,
				installing: null,
				addEventListener: vi.fn(),
			};

			const mockServiceWorkerContainer: Partial<ServiceWorkerContainer> = {
				register: vi.fn().mockResolvedValue(mockRegistration),
				ready: Promise.resolve(mockRegistration as ServiceWorkerRegistration),
				controller: null,
				addEventListener: vi.fn((event: string, cb: (event: MessageEvent) => void) => {
					if (event === 'message') {
						messageCallback = cb;
					}
				}),
			};

			Object.defineProperty(global.navigator, 'serviceWorker', {
				value: mockServiceWorkerContainer,
				writable: true,
				configurable: true,
			});

			const onOfflineChange = vi.fn();
			const onMessage = vi.fn();

			await registerServiceWorker({ onOfflineChange, onMessage });

			// Send message with null data
			messageCallback?.({ data: null } as MessageEvent);

			// Should not call onOfflineChange (data?.type is falsy)
			expect(onOfflineChange).not.toHaveBeenCalled();
			// onMessage should still receive null
			expect(onMessage).toHaveBeenCalledWith(null);
		});

		it('should handle message events with undefined type', async () => {
			let messageCallback: ((event: MessageEvent) => void) | null = null;

			const mockRegistration: Partial<ServiceWorkerRegistration> = {
				scope: '/test/',
				active: null,
				installing: null,
				addEventListener: vi.fn(),
			};

			const mockServiceWorkerContainer: Partial<ServiceWorkerContainer> = {
				register: vi.fn().mockResolvedValue(mockRegistration),
				ready: Promise.resolve(mockRegistration as ServiceWorkerRegistration),
				controller: null,
				addEventListener: vi.fn((event: string, cb: (event: MessageEvent) => void) => {
					if (event === 'message') {
						messageCallback = cb;
					}
				}),
			};

			Object.defineProperty(global.navigator, 'serviceWorker', {
				value: mockServiceWorkerContainer,
				writable: true,
				configurable: true,
			});

			const onOfflineChange = vi.fn();

			await registerServiceWorker({ onOfflineChange });

			// Send message with data but no type
			messageCallback?.({ data: { foo: 'bar' } } as MessageEvent);

			// Should not call onOfflineChange
			expect(onOfflineChange).not.toHaveBeenCalled();
		});
	});

	describe('integration scenarios', () => {
		it('should handle full lifecycle: register -> update -> skip waiting', async () => {
			let updateFoundCallback: (() => void) | null = null;
			let stateChangeCallback: (() => void) | null = null;

			const mockInstallingWorker = {
				state: 'installing',
				addEventListener: vi.fn((event: string, cb: () => void) => {
					if (event === 'statechange') {
						stateChangeCallback = cb;
					}
				}),
			};

			const mockWaitingWorker = {
				postMessage: vi.fn(),
			};

			const mockRegistration: Partial<ServiceWorkerRegistration> = {
				scope: '/test/',
				active: null,
				installing: mockInstallingWorker as unknown as ServiceWorker,
				waiting: null,
				addEventListener: vi.fn((event: string, cb: () => void) => {
					if (event === 'updatefound') {
						updateFoundCallback = cb;
					}
				}),
			};

			const mockServiceWorkerContainer: Partial<ServiceWorkerContainer> = {
				register: vi.fn().mockResolvedValue(mockRegistration),
				ready: Promise.resolve(mockRegistration as ServiceWorkerRegistration),
				controller: {} as ServiceWorker, // Existing controller means update
				addEventListener: vi.fn(),
			};

			Object.defineProperty(global.navigator, 'serviceWorker', {
				value: mockServiceWorkerContainer,
				writable: true,
				configurable: true,
			});

			const onUpdate = vi.fn();

			// Register
			await registerServiceWorker({ onUpdate });

			// Trigger update found
			updateFoundCallback?.();

			// Simulate installation complete
			mockInstallingWorker.state = 'installed';
			mockRegistration.waiting = mockWaitingWorker as unknown as ServiceWorker;
			stateChangeCallback?.();

			// Verify update callback was called
			expect(onUpdate).toHaveBeenCalledWith(mockRegistration);

			// User decides to update
			skipWaiting();

			await new Promise((resolve) => setTimeout(resolve, 0));

			expect(mockWaitingWorker.postMessage).toHaveBeenCalledWith('skipWaiting');
		});

		it('should handle offline/online transitions', async () => {
			let onlineHandler: (() => void) | null = null;
			let offlineHandler: (() => void) | null = null;

			vi.spyOn(window, 'addEventListener').mockImplementation((event, handler) => {
				if (event === 'online') {
					onlineHandler = handler as () => void;
				} else if (event === 'offline') {
					offlineHandler = handler as () => void;
				}
			});

			const mockRegistration: Partial<ServiceWorkerRegistration> = {
				scope: '/test/',
				active: null,
				installing: null,
				addEventListener: vi.fn(),
			};

			const mockServiceWorkerContainer: Partial<ServiceWorkerContainer> = {
				register: vi.fn().mockResolvedValue(mockRegistration),
				ready: Promise.resolve(mockRegistration as ServiceWorkerRegistration),
				controller: null,
				addEventListener: vi.fn(),
			};

			Object.defineProperty(global.navigator, 'serviceWorker', {
				value: mockServiceWorkerContainer,
				writable: true,
				configurable: true,
			});

			const offlineStates: boolean[] = [];
			const onOfflineChange = (isOffline: boolean) => {
				offlineStates.push(isOffline);
			};

			await registerServiceWorker({ onOfflineChange });

			// Simulate going offline
			offlineHandler?.();
			expect(offlineStates).toEqual([true]);

			// Simulate coming back online
			onlineHandler?.();
			expect(offlineStates).toEqual([true, false]);

			// Multiple transitions
			offlineHandler?.();
			onlineHandler?.();
			offlineHandler?.();
			expect(offlineStates).toEqual([true, false, true, false, true]);
		});
	});
});
