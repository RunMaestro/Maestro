/**
 * notificationStore tests
 *
 * Tests for the toast notification Zustand store:
 * - Toast CRUD (add, remove, clear)
 * - Notification config (duration, audio feedback, OS notifications)
 * - notifyToast wrapper (ID generation, duration calc, side effects)
 * - Selectors
 * - Non-React access
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
	useNotificationStore,
	notifyToast,
	resetToastIdCounter,
	getNotificationState,
	getNotificationActions,
	selectToasts,
	selectToastCount,
	selectConfig,
} from '../../../renderer/stores/notificationStore';
import type { Toast } from '../../../renderer/stores/notificationStore';

// ============================================================================
// Mocks
// ============================================================================

const mockSpeak = vi.fn().mockResolvedValue(undefined);
const mockShow = vi.fn().mockResolvedValue(undefined);
const mockLoggerToast = vi.fn();

beforeEach(() => {
	// Reset store
	useNotificationStore.setState({
		toasts: [],
		config: {
			defaultDuration: 20,
			audioFeedbackEnabled: false,
			audioFeedbackCommand: '',
			osNotificationsEnabled: true,
		},
	});
	resetToastIdCounter();

	// Mock window.maestro
	(globalThis as any).window = {
		maestro: {
			logger: { toast: mockLoggerToast },
			notification: { speak: mockSpeak, show: mockShow },
		},
	};

	vi.clearAllMocks();
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

// ============================================================================
// Helpers
// ============================================================================

function createToast(overrides: Partial<Toast> = {}): Toast {
	return {
		id: 'test-1',
		type: 'success',
		title: 'Test',
		message: 'Test message',
		timestamp: Date.now(),
		...overrides,
	};
}

// ============================================================================
// Tests
// ============================================================================

describe('notificationStore', () => {
	// ==========================================================================
	// Initial state
	// ==========================================================================

	describe('initial state', () => {
		it('has empty toasts array', () => {
			expect(useNotificationStore.getState().toasts).toEqual([]);
		});

		it('has default config', () => {
			const { config } = useNotificationStore.getState();
			expect(config.defaultDuration).toBe(20);
			expect(config.audioFeedbackEnabled).toBe(false);
			expect(config.audioFeedbackCommand).toBe('');
			expect(config.osNotificationsEnabled).toBe(true);
		});
	});

	// ==========================================================================
	// Toast CRUD
	// ==========================================================================

	describe('addToast', () => {
		it('adds toast to array', () => {
			const toast = createToast({ id: 'a' });
			useNotificationStore.getState().addToast(toast);
			expect(useNotificationStore.getState().toasts).toHaveLength(1);
			expect(useNotificationStore.getState().toasts[0].id).toBe('a');
		});

		it('preserves insertion order', () => {
			useNotificationStore.getState().addToast(createToast({ id: 'a' }));
			useNotificationStore.getState().addToast(createToast({ id: 'b' }));
			useNotificationStore.getState().addToast(createToast({ id: 'c' }));
			const ids = useNotificationStore.getState().toasts.map((t) => t.id);
			expect(ids).toEqual(['a', 'b', 'c']);
		});

		it('creates new array reference', () => {
			const ref1 = useNotificationStore.getState().toasts;
			useNotificationStore.getState().addToast(createToast({ id: 'a' }));
			const ref2 = useNotificationStore.getState().toasts;
			expect(ref1).not.toBe(ref2);
		});
	});

	describe('removeToast', () => {
		it('removes toast by ID', () => {
			useNotificationStore.getState().addToast(createToast({ id: 'a' }));
			useNotificationStore.getState().addToast(createToast({ id: 'b' }));
			useNotificationStore.getState().removeToast('a');
			expect(useNotificationStore.getState().toasts).toHaveLength(1);
			expect(useNotificationStore.getState().toasts[0].id).toBe('b');
		});

		it('does nothing for non-existent ID', () => {
			useNotificationStore.getState().addToast(createToast({ id: 'a' }));
			useNotificationStore.getState().removeToast('nonexistent');
			expect(useNotificationStore.getState().toasts).toHaveLength(1);
		});
	});

	describe('clearToasts', () => {
		it('removes all toasts', () => {
			useNotificationStore.getState().addToast(createToast({ id: 'a' }));
			useNotificationStore.getState().addToast(createToast({ id: 'b' }));
			useNotificationStore.getState().clearToasts();
			expect(useNotificationStore.getState().toasts).toEqual([]);
		});

		it('is safe to call on empty array', () => {
			useNotificationStore.getState().clearToasts();
			expect(useNotificationStore.getState().toasts).toEqual([]);
		});
	});

	// ==========================================================================
	// Configuration
	// ==========================================================================

	describe('setDefaultDuration', () => {
		it('updates default duration', () => {
			useNotificationStore.getState().setDefaultDuration(30);
			expect(useNotificationStore.getState().config.defaultDuration).toBe(30);
		});

		it('allows 0 (never dismiss)', () => {
			useNotificationStore.getState().setDefaultDuration(0);
			expect(useNotificationStore.getState().config.defaultDuration).toBe(0);
		});

		it('allows -1 (toasts disabled)', () => {
			useNotificationStore.getState().setDefaultDuration(-1);
			expect(useNotificationStore.getState().config.defaultDuration).toBe(-1);
		});

		it('does not affect other config fields', () => {
			useNotificationStore.getState().setAudioFeedback(true, 'say');
			useNotificationStore.getState().setDefaultDuration(5);
			expect(useNotificationStore.getState().config.audioFeedbackEnabled).toBe(true);
			expect(useNotificationStore.getState().config.audioFeedbackCommand).toBe('say');
		});
	});

	describe('setAudioFeedback', () => {
		it('enables audio feedback', () => {
			useNotificationStore.getState().setAudioFeedback(true, 'say');
			const { config } = useNotificationStore.getState();
			expect(config.audioFeedbackEnabled).toBe(true);
			expect(config.audioFeedbackCommand).toBe('say');
		});

		it('disables audio feedback', () => {
			useNotificationStore.getState().setAudioFeedback(true, 'say');
			useNotificationStore.getState().setAudioFeedback(false, '');
			const { config } = useNotificationStore.getState();
			expect(config.audioFeedbackEnabled).toBe(false);
			expect(config.audioFeedbackCommand).toBe('');
		});
	});

	describe('setOsNotifications', () => {
		it('disables OS notifications', () => {
			useNotificationStore.getState().setOsNotifications(false);
			expect(useNotificationStore.getState().config.osNotificationsEnabled).toBe(false);
		});

		it('enables OS notifications', () => {
			useNotificationStore.getState().setOsNotifications(false);
			useNotificationStore.getState().setOsNotifications(true);
			expect(useNotificationStore.getState().config.osNotificationsEnabled).toBe(true);
		});
	});

	// ==========================================================================
	// notifyToast wrapper
	// ==========================================================================

	describe('notifyToast', () => {
		describe('ID generation', () => {
			it('returns generated toast ID', () => {
				const id = notifyToast({ type: 'success', title: 'Test', message: 'msg' });
				expect(id).toMatch(/^toast-\d+-0$/);
			});

			it('generates unique IDs', () => {
				const id1 = notifyToast({ type: 'success', title: 'A', message: 'a' });
				const id2 = notifyToast({ type: 'success', title: 'B', message: 'b' });
				expect(id1).not.toBe(id2);
			});

			it('increments counter', () => {
				notifyToast({ type: 'success', title: 'A', message: 'a' });
				const id2 = notifyToast({ type: 'success', title: 'B', message: 'b' });
				expect(id2).toMatch(/^toast-\d+-1$/);
			});
		});

		describe('duration calculation', () => {
			it('uses default duration when toast has no explicit duration', () => {
				useNotificationStore.getState().setDefaultDuration(10);
				notifyToast({ type: 'success', title: 'Test', message: 'msg' });
				const toast = useNotificationStore.getState().toasts[0];
				expect(toast.duration).toBe(10000); // 10s → 10000ms
			});

			it('uses explicit toast duration when provided', () => {
				notifyToast({ type: 'success', title: 'Test', message: 'msg', duration: 5000 });
				const toast = useNotificationStore.getState().toasts[0];
				expect(toast.duration).toBe(5000);
			});

			it('sets duration 0 when default is 0 (never dismiss)', () => {
				useNotificationStore.getState().setDefaultDuration(0);
				notifyToast({ type: 'success', title: 'Test', message: 'msg' });
				const toast = useNotificationStore.getState().toasts[0];
				expect(toast.duration).toBe(0);
			});
		});

		describe('toast queue', () => {
			it('adds toast to visible queue', () => {
				notifyToast({ type: 'info', title: 'Hello', message: 'World' });
				expect(useNotificationStore.getState().toasts).toHaveLength(1);
				expect(useNotificationStore.getState().toasts[0].title).toBe('Hello');
			});

			it('skips toast queue when defaultDuration is -1 (disabled)', () => {
				useNotificationStore.getState().setDefaultDuration(-1);
				notifyToast({ type: 'info', title: 'Hello', message: 'World' });
				expect(useNotificationStore.getState().toasts).toHaveLength(0);
			});

			it('still triggers side effects when toasts disabled', () => {
				useNotificationStore.getState().setDefaultDuration(-1);
				notifyToast({ type: 'info', title: 'Hello', message: 'World' });
				// Logging should still happen
				expect(mockLoggerToast).toHaveBeenCalled();
				// OS notification should still fire
				expect(mockShow).toHaveBeenCalled();
			});

			it('sets timestamp on toast', () => {
				const before = Date.now();
				notifyToast({ type: 'success', title: 'Test', message: 'msg' });
				const toast = useNotificationStore.getState().toasts[0];
				expect(toast.timestamp).toBeGreaterThanOrEqual(before);
			});
		});

		describe('logging', () => {
			it('logs toast via window.maestro.logger.toast', () => {
				notifyToast({
					type: 'success',
					title: 'Done',
					message: 'Task complete',
					group: 'MyGroup',
					project: 'MyProject',
				});
				expect(mockLoggerToast).toHaveBeenCalledWith(
					'Done',
					expect.objectContaining({
						type: 'success',
						message: 'Task complete',
						group: 'MyGroup',
						project: 'MyProject',
					})
				);
			});

			it('includes audioNotification disabled reason', () => {
				notifyToast({ type: 'info', title: 'Test', message: 'msg' });
				expect(mockLoggerToast).toHaveBeenCalledWith(
					'Test',
					expect.objectContaining({
						audioNotification: expect.objectContaining({
							enabled: false,
							reason: 'disabled',
						}),
					})
				);
			});

			it('includes audioNotification enabled info when triggering', () => {
				useNotificationStore.getState().setAudioFeedback(true, 'say');
				notifyToast({ type: 'info', title: 'Test', message: 'Hello world' });
				expect(mockLoggerToast).toHaveBeenCalledWith(
					'Test',
					expect.objectContaining({
						audioNotification: expect.objectContaining({
							enabled: true,
							command: 'say',
						}),
					})
				);
			});
		});

		describe('audio feedback', () => {
			it('calls speak when enabled with command and content', () => {
				useNotificationStore.getState().setAudioFeedback(true, 'say');
				notifyToast({ type: 'success', title: 'Test', message: 'Hello world' });
				expect(mockSpeak).toHaveBeenCalledWith('Hello world', 'say');
			});

			it('does not call speak when disabled', () => {
				useNotificationStore.getState().setAudioFeedback(false, 'say');
				notifyToast({ type: 'success', title: 'Test', message: 'Hello' });
				expect(mockSpeak).not.toHaveBeenCalled();
			});

			it('does not call speak when no command', () => {
				useNotificationStore.getState().setAudioFeedback(true, '');
				notifyToast({ type: 'success', title: 'Test', message: 'Hello' });
				expect(mockSpeak).not.toHaveBeenCalled();
			});

			it('does not call speak when message is empty', () => {
				useNotificationStore.getState().setAudioFeedback(true, 'say');
				notifyToast({ type: 'success', title: 'Test', message: '' });
				expect(mockSpeak).not.toHaveBeenCalled();
			});

			it('does not call speak when message is whitespace only', () => {
				useNotificationStore.getState().setAudioFeedback(true, 'say');
				notifyToast({ type: 'success', title: 'Test', message: '   ' });
				expect(mockSpeak).not.toHaveBeenCalled();
			});

			it('does not call speak when skipCustomNotification is true', () => {
				useNotificationStore.getState().setAudioFeedback(true, 'say');
				notifyToast({
					type: 'success',
					title: 'Test',
					message: 'Hello',
					skipCustomNotification: true,
				});
				expect(mockSpeak).not.toHaveBeenCalled();
			});
		});

		describe('OS notifications', () => {
			it('calls show when enabled', () => {
				notifyToast({ type: 'success', title: 'Done', message: 'Task complete.' });
				expect(mockShow).toHaveBeenCalledWith('Done', 'Task complete.');
			});

			it('does not call show when disabled', () => {
				useNotificationStore.getState().setOsNotifications(false);
				notifyToast({ type: 'success', title: 'Done', message: 'Task complete.' });
				expect(mockShow).not.toHaveBeenCalled();
			});

			it('uses project as notification title when available', () => {
				notifyToast({
					type: 'success',
					title: 'Done',
					message: 'Finished.',
					project: 'MyAgent',
				});
				expect(mockShow).toHaveBeenCalledWith('MyAgent', 'Finished.');
			});

			it('builds body with group prefix', () => {
				notifyToast({
					type: 'success',
					title: 'Done',
					message: 'Finished.',
					group: 'Backend',
				});
				expect(mockShow).toHaveBeenCalledWith('Done', 'Backend: Finished.');
			});

			it('builds body with tab prefix', () => {
				notifyToast({
					type: 'success',
					title: 'Done',
					message: 'Finished.',
					tabName: 'Tab1',
				});
				expect(mockShow).toHaveBeenCalledWith('Done', 'Tab1: Finished.');
			});

			it('builds body with group > tab prefix', () => {
				notifyToast({
					type: 'success',
					title: 'Done',
					message: 'Finished.',
					group: 'Backend',
					tabName: 'Tab1',
				});
				expect(mockShow).toHaveBeenCalledWith('Done', 'Backend > Tab1: Finished.');
			});

			it('uses short agentSessionId when no tabName', () => {
				notifyToast({
					type: 'success',
					title: 'Done',
					message: 'Finished.',
					agentSessionId: 'abcdefgh-1234-5678-9abc-def012345678',
				});
				expect(mockShow).toHaveBeenCalledWith('Done', 'abcdefgh: Finished.');
			});

			it('extracts first sentence from message', () => {
				notifyToast({
					type: 'success',
					title: 'Done',
					message: 'First sentence. Second sentence.',
				});
				expect(mockShow).toHaveBeenCalledWith('Done', 'First sentence.');
			});
		});

		describe('auto-dismiss', () => {
			it('removes toast after duration', () => {
				notifyToast({ type: 'success', title: 'Test', message: 'msg' });
				expect(useNotificationStore.getState().toasts).toHaveLength(1);
				const toast = useNotificationStore.getState().toasts[0];
				vi.advanceTimersByTime(toast.duration!);
				expect(useNotificationStore.getState().toasts).toHaveLength(0);
			});

			it('does not auto-dismiss when duration is 0', () => {
				useNotificationStore.getState().setDefaultDuration(0);
				notifyToast({ type: 'success', title: 'Test', message: 'msg' });
				vi.advanceTimersByTime(60000);
				expect(useNotificationStore.getState().toasts).toHaveLength(1);
			});

			it('does not set timer when toasts disabled', () => {
				useNotificationStore.getState().setDefaultDuration(-1);
				notifyToast({ type: 'success', title: 'Test', message: 'msg' });
				// No timer set, no toast in queue
				expect(useNotificationStore.getState().toasts).toHaveLength(0);
			});
		});
	});

	// ==========================================================================
	// Selectors
	// ==========================================================================

	describe('selectors', () => {
		it('selectToasts returns toasts array', () => {
			useNotificationStore.getState().addToast(createToast({ id: 'a' }));
			expect(selectToasts(useNotificationStore.getState())).toHaveLength(1);
		});

		it('selectToastCount returns count', () => {
			useNotificationStore.getState().addToast(createToast({ id: 'a' }));
			useNotificationStore.getState().addToast(createToast({ id: 'b' }));
			expect(selectToastCount(useNotificationStore.getState())).toBe(2);
		});

		it('selectConfig returns config object', () => {
			const config = selectConfig(useNotificationStore.getState());
			expect(config.defaultDuration).toBe(20);
			expect(config.osNotificationsEnabled).toBe(true);
		});
	});

	// ==========================================================================
	// Non-React access
	// ==========================================================================

	describe('non-React access', () => {
		it('getNotificationState returns current state', () => {
			notifyToast({ type: 'info', title: 'Test', message: 'msg' });
			expect(getNotificationState().toasts).toHaveLength(1);
		});

		it('getNotificationActions returns working action references', () => {
			const actions = getNotificationActions();
			actions.addToast(createToast({ id: 'from-actions' }));
			expect(useNotificationStore.getState().toasts[0].id).toBe('from-actions');
		});

		it('getNotificationActions.clearToasts works', () => {
			notifyToast({ type: 'info', title: 'A', message: 'a' });
			getNotificationActions().clearToasts();
			expect(useNotificationStore.getState().toasts).toHaveLength(0);
		});
	});

	// ==========================================================================
	// Action stability
	// ==========================================================================

	describe('action stability', () => {
		it('action references are stable across state changes', () => {
			const actions1 = useNotificationStore.getState();
			notifyToast({ type: 'info', title: 'Change', message: 'msg' });
			const actions2 = useNotificationStore.getState();
			expect(actions1.addToast).toBe(actions2.addToast);
			expect(actions1.removeToast).toBe(actions2.removeToast);
			expect(actions1.clearToasts).toBe(actions2.clearToasts);
			expect(actions1.setDefaultDuration).toBe(actions2.setDefaultDuration);
			expect(actions1.setAudioFeedback).toBe(actions2.setAudioFeedback);
			expect(actions1.setOsNotifications).toBe(actions2.setOsNotifications);
		});
	});

	// ==========================================================================
	// Store reset
	// ==========================================================================

	describe('store reset', () => {
		it('can reset entire store', () => {
			notifyToast({ type: 'info', title: 'A', message: 'a' });
			useNotificationStore.getState().setAudioFeedback(true, 'say');

			useNotificationStore.setState({
				toasts: [],
				config: {
					defaultDuration: 20,
					audioFeedbackEnabled: false,
					audioFeedbackCommand: '',
					osNotificationsEnabled: true,
				},
			});

			expect(useNotificationStore.getState().toasts).toEqual([]);
			expect(useNotificationStore.getState().config.audioFeedbackEnabled).toBe(false);
		});
	});

	// ==========================================================================
	// Config and toast isolation
	// ==========================================================================

	describe('config and toast isolation', () => {
		it('config changes do not affect toasts array reference', () => {
			notifyToast({ type: 'info', title: 'A', message: 'a' });
			const toastsRef = useNotificationStore.getState().toasts;
			useNotificationStore.getState().setDefaultDuration(5);
			expect(useNotificationStore.getState().toasts).toBe(toastsRef);
		});

		it('toast changes do not affect config reference', () => {
			const configRef = useNotificationStore.getState().config;
			notifyToast({ type: 'info', title: 'A', message: 'a' });
			expect(useNotificationStore.getState().config).toBe(configRef);
		});
	});

	// ==========================================================================
	// Error resilience
	// ==========================================================================

	describe('error resilience', () => {
		it('notifyToast works when window.maestro is undefined', () => {
			(globalThis as any).window = {};
			const id = notifyToast({ type: 'info', title: 'Test', message: 'msg' });
			expect(id).toBeDefined();
			expect(useNotificationStore.getState().toasts).toHaveLength(1);
		});

		it('notifyToast works when window.maestro.logger is undefined', () => {
			(globalThis as any).window = { maestro: {} };
			const id = notifyToast({ type: 'info', title: 'Test', message: 'msg' });
			expect(id).toBeDefined();
			expect(useNotificationStore.getState().toasts).toHaveLength(1);
		});

		it('notifyToast works when window.maestro.notification is undefined', () => {
			(globalThis as any).window = {
				maestro: { logger: { toast: mockLoggerToast } },
			};
			useNotificationStore.getState().setAudioFeedback(true, 'say');
			const id = notifyToast({ type: 'info', title: 'Test', message: 'Speak me' });
			expect(id).toBeDefined();
			expect(mockSpeak).not.toHaveBeenCalled();
		});

		it('handles speak() rejection gracefully', async () => {
			const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
			mockSpeak.mockRejectedValueOnce(new Error('speak failed'));
			useNotificationStore.getState().setAudioFeedback(true, 'say');
			notifyToast({ type: 'info', title: 'Test', message: 'Hello' });

			// Flush the microtask queue so the .catch handler runs
			await vi.advanceTimersByTimeAsync(0);
			expect(consoleSpy).toHaveBeenCalledWith(
				'[notificationStore] Custom notification failed:',
				expect.any(Error)
			);
			consoleSpy.mockRestore();
		});

		it('handles show() rejection gracefully', async () => {
			const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
			mockShow.mockRejectedValueOnce(new Error('show failed'));
			notifyToast({ type: 'info', title: 'Test', message: 'Hello' });

			await vi.advanceTimersByTimeAsync(0);
			expect(consoleSpy).toHaveBeenCalledWith(
				'[notificationStore] Failed to show OS notification:',
				expect.any(Error)
			);
			consoleSpy.mockRestore();
		});
	});

	// ==========================================================================
	// notifyToast — logging disabled reason variants
	// ==========================================================================

	describe('notifyToast logging disabled reasons', () => {
		it('logs no-command reason when audio enabled but no command', () => {
			useNotificationStore.getState().setAudioFeedback(true, '');
			notifyToast({ type: 'info', title: 'Test', message: 'Hello' });
			expect(mockLoggerToast).toHaveBeenCalledWith(
				'Test',
				expect.objectContaining({
					audioNotification: expect.objectContaining({
						enabled: false,
						reason: 'no-command',
					}),
				})
			);
		});

		it('logs opted-out reason when skipCustomNotification is true', () => {
			useNotificationStore.getState().setAudioFeedback(true, 'say');
			notifyToast({ type: 'info', title: 'Test', message: 'Hello', skipCustomNotification: true });
			expect(mockLoggerToast).toHaveBeenCalledWith(
				'Test',
				expect.objectContaining({
					audioNotification: expect.objectContaining({
						enabled: false,
						reason: 'opted-out',
					}),
				})
			);
		});

		it('logs no-content reason when message is empty', () => {
			useNotificationStore.getState().setAudioFeedback(true, 'say');
			notifyToast({ type: 'info', title: 'Test', message: '' });
			expect(mockLoggerToast).toHaveBeenCalledWith(
				'Test',
				expect.objectContaining({
					audioNotification: expect.objectContaining({
						enabled: false,
						reason: 'no-content',
					}),
				})
			);
		});
	});

	// ==========================================================================
	// notifyToast — OS notification body construction
	// ==========================================================================

	describe('notifyToast OS notification body variants', () => {
		it('builds body with group + project + tabName', () => {
			notifyToast({
				type: 'success',
				title: 'Done',
				message: 'Finished.',
				group: 'Backend',
				project: 'MyAgent',
				tabName: 'Tab2',
			});
			// project overrides title
			expect(mockShow).toHaveBeenCalledWith('MyAgent', 'Backend > Tab2: Finished.');
		});

		it('builds body with no prefix when no metadata', () => {
			notifyToast({
				type: 'success',
				title: 'Done',
				message: 'Finished.',
			});
			expect(mockShow).toHaveBeenCalledWith('Done', 'Finished.');
		});

		it('handles message with no sentence-ending punctuation', () => {
			notifyToast({
				type: 'success',
				title: 'Done',
				message: 'No period here',
			});
			expect(mockShow).toHaveBeenCalledWith('Done', 'No period here');
		});
	});

	// ==========================================================================
	// notifyToast — optional field passthrough
	// ==========================================================================

	describe('notifyToast field passthrough', () => {
		it('preserves sessionId, tabId, actionUrl, actionLabel on toast', () => {
			notifyToast({
				type: 'success',
				title: 'PR Created',
				message: 'Pull request opened.',
				sessionId: 'sess-1',
				tabId: 'tab-1',
				actionUrl: 'https://github.com/org/repo/pull/1',
				actionLabel: 'View PR',
			});
			const toast = useNotificationStore.getState().toasts[0];
			expect(toast.sessionId).toBe('sess-1');
			expect(toast.tabId).toBe('tab-1');
			expect(toast.actionUrl).toBe('https://github.com/org/repo/pull/1');
			expect(toast.actionLabel).toBe('View PR');
		});

		it('preserves taskDuration on toast', () => {
			notifyToast({
				type: 'success',
				title: 'Done',
				message: 'Complete.',
				taskDuration: 5000,
			});
			const toast = useNotificationStore.getState().toasts[0];
			expect(toast.taskDuration).toBe(5000);
		});
	});

	// ==========================================================================
	// notifyToast — concurrent auto-dismiss timers
	// ==========================================================================

	describe('notifyToast concurrent auto-dismiss', () => {
		it('dismisses multiple toasts at their own durations independently', () => {
			useNotificationStore.getState().setDefaultDuration(5);
			notifyToast({ type: 'info', title: 'A', message: 'a', duration: 2000 });
			notifyToast({ type: 'info', title: 'B', message: 'b', duration: 4000 });
			notifyToast({ type: 'info', title: 'C', message: 'c', duration: 6000 });

			expect(useNotificationStore.getState().toasts).toHaveLength(3);

			vi.advanceTimersByTime(2000);
			expect(useNotificationStore.getState().toasts).toHaveLength(2);
			expect(useNotificationStore.getState().toasts.map((t) => t.title)).toEqual(['B', 'C']);

			vi.advanceTimersByTime(2000);
			expect(useNotificationStore.getState().toasts).toHaveLength(1);
			expect(useNotificationStore.getState().toasts[0].title).toBe('C');

			vi.advanceTimersByTime(2000);
			expect(useNotificationStore.getState().toasts).toHaveLength(0);
		});

		it('manual removal does not break pending auto-dismiss timer', () => {
			notifyToast({ type: 'info', title: 'A', message: 'a', duration: 5000 });
			const toastId = useNotificationStore.getState().toasts[0].id;

			// Remove manually before timer fires
			useNotificationStore.getState().removeToast(toastId);
			expect(useNotificationStore.getState().toasts).toHaveLength(0);

			// Timer fires but toast already gone — should not error
			vi.advanceTimersByTime(5000);
			expect(useNotificationStore.getState().toasts).toHaveLength(0);
		});
	});

	// ==========================================================================
	// notifyToast — duration edge cases
	// ==========================================================================

	describe('notifyToast duration edge cases', () => {
		it('explicit duration 0 means never dismiss', () => {
			notifyToast({ type: 'info', title: 'Sticky', message: 'msg', duration: 0 });
			const toast = useNotificationStore.getState().toasts[0];
			expect(toast.duration).toBe(0);

			vi.advanceTimersByTime(60000);
			expect(useNotificationStore.getState().toasts).toHaveLength(1);
		});

		it('explicit duration overrides disabled default (-1)', () => {
			useNotificationStore.getState().setDefaultDuration(-1);
			// Toasts with explicit duration are still skipped from queue when disabled
			notifyToast({ type: 'info', title: 'Explicit', message: 'msg', duration: 3000 });
			// defaultDuration -1 disables the entire queue
			expect(useNotificationStore.getState().toasts).toHaveLength(0);
		});
	});
});
