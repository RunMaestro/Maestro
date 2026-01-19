import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, renderHook, waitFor } from '@testing-library/react';
import React, { useEffect } from 'react';
import { ToastProvider, useToast, Toast } from '../../../renderer/contexts/ToastContext';

// Helper component to access toast context
function ToastConsumer({ onMount }: { onMount: (toast: ReturnType<typeof useToast>) => void }) {
	const toastContext = useToast();
	useEffect(() => {
		onMount(toastContext);
	}, [toastContext, onMount]);
	return <div data-testid="consumer">Consumer</div>;
}

// Helper to render with provider
function renderWithProvider(ui: React.ReactElement, providerProps?: { defaultDuration?: number }) {
	return render(
		<ToastProvider defaultDuration={providerProps?.defaultDuration}>{ui}</ToastProvider>
	);
}

describe('ToastContext', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	describe('ToastProvider', () => {
		it('renders children correctly', () => {
			render(
				<ToastProvider>
					<div data-testid="child">Child Content</div>
				</ToastProvider>
			);
			expect(screen.getByTestId('child')).toBeInTheDocument();
			expect(screen.getByText('Child Content')).toBeInTheDocument();
		});

		it('provides initial empty toasts array', () => {
			let toasts: Toast[] = [];
			renderWithProvider(
				<ToastConsumer
					onMount={(ctx) => {
						toasts = ctx.toasts;
					}}
				/>
			);
			expect(toasts).toEqual([]);
		});

		it('accepts custom default duration', () => {
			let defaultDuration = 0;
			renderWithProvider(
				<ToastConsumer
					onMount={(ctx) => {
						defaultDuration = ctx.defaultDuration;
					}}
				/>,
				{ defaultDuration: 30 }
			);
			expect(defaultDuration).toBe(30);
		});

		it('uses 20 seconds as default duration when not specified', () => {
			let defaultDuration = 0;
			renderWithProvider(
				<ToastConsumer
					onMount={(ctx) => {
						defaultDuration = ctx.defaultDuration;
					}}
				/>
			);
			expect(defaultDuration).toBe(20);
		});
	});

	describe('addToast', () => {
		it('adds toast with unique ID', async () => {
			vi.useFakeTimers({ shouldAdvanceTime: true });
			let contextValue: ReturnType<typeof useToast> | null = null;

			renderWithProvider(
				<ToastConsumer
					onMount={(ctx) => {
						contextValue = ctx;
					}}
				/>
			);

			await act(async () => {
				contextValue!.addToast({
					type: 'success',
					title: 'Test Toast',
					message: 'Test message',
				});
			});

			expect(contextValue!.toasts).toHaveLength(1);
			expect(contextValue!.toasts[0].id).toMatch(/^toast-\d+-\d+$/);
		});

		it('adds toast with timestamp', async () => {
			vi.useFakeTimers({ shouldAdvanceTime: true });
			const now = Date.now();
			let contextValue: ReturnType<typeof useToast> | null = null;

			renderWithProvider(
				<ToastConsumer
					onMount={(ctx) => {
						contextValue = ctx;
					}}
				/>
			);

			await act(async () => {
				contextValue!.addToast({
					type: 'info',
					title: 'Timestamp Test',
					message: 'Test message',
				});
			});

			expect(contextValue!.toasts[0].timestamp).toBeGreaterThanOrEqual(now);
		});

		it('converts custom duration from provided value to stored duration', async () => {
			vi.useFakeTimers({ shouldAdvanceTime: true });
			let contextValue: ReturnType<typeof useToast> | null = null;

			renderWithProvider(
				<ToastConsumer
					onMount={(ctx) => {
						contextValue = ctx;
					}}
				/>
			);

			await act(async () => {
				contextValue!.addToast({
					type: 'success',
					title: 'Duration Test',
					message: 'Test message',
					duration: 5000, // 5 seconds in ms
				});
			});

			expect(contextValue!.toasts[0].duration).toBe(5000);
		});

		it('uses default duration when not specified', async () => {
			vi.useFakeTimers({ shouldAdvanceTime: true });
			let contextValue: ReturnType<typeof useToast> | null = null;

			renderWithProvider(
				<ToastConsumer
					onMount={(ctx) => {
						contextValue = ctx;
					}}
				/>,
				{ defaultDuration: 10 } // 10 seconds
			);

			await act(async () => {
				contextValue!.addToast({
					type: 'success',
					title: 'Default Duration Test',
					message: 'Test message',
				});
			});

			// Default duration is in seconds, converted to ms
			expect(contextValue!.toasts[0].duration).toBe(10000);
		});

		it('duration of 0 means never auto-dismiss', async () => {
			vi.useFakeTimers({ shouldAdvanceTime: true });
			let contextValue: ReturnType<typeof useToast> | null = null;

			renderWithProvider(
				<ToastConsumer
					onMount={(ctx) => {
						contextValue = ctx;
					}}
				/>,
				{ defaultDuration: 0 } // 0 = never auto-dismiss
			);

			await act(async () => {
				contextValue!.addToast({
					type: 'warning',
					title: 'Never Dismiss',
					message: 'Should not auto-dismiss',
				});
			});

			expect(contextValue!.toasts[0].duration).toBe(0);

			// Advance time significantly
			await act(async () => {
				vi.advanceTimersByTime(60000); // 1 minute
			});

			// Toast should still be there
			expect(contextValue!.toasts).toHaveLength(1);
		});

		it('duration of -1 disables toast UI but still logs and notifies', async () => {
			vi.useFakeTimers({ shouldAdvanceTime: true });
			let contextValue: ReturnType<typeof useToast> | null = null;

			renderWithProvider(
				<ToastConsumer
					onMount={(ctx) => {
						contextValue = ctx;
					}}
				/>,
				{ defaultDuration: -1 } // -1 = toasts disabled
			);

			await act(async () => {
				contextValue!.addToast({
					type: 'success',
					title: 'Hidden Toast',
					message: 'Should not appear in UI',
				});
			});

			// Toast should NOT be in the visible toasts array
			expect(contextValue!.toasts).toHaveLength(0);

			// But logging should still happen
			expect(window.maestro.logger.toast).toHaveBeenCalledWith('Hidden Toast', expect.any(Object));

			// And OS notification should still be shown (if enabled)
			expect(window.maestro.notification.show).toHaveBeenCalled();
		});

		it('logs toast via window.maestro.logger.toast', async () => {
			vi.useFakeTimers({ shouldAdvanceTime: true });
			let contextValue: ReturnType<typeof useToast> | null = null;

			renderWithProvider(
				<ToastConsumer
					onMount={(ctx) => {
						contextValue = ctx;
					}}
				/>
			);

			await act(async () => {
				contextValue!.addToast({
					type: 'success',
					title: 'Log Test',
					message: 'Test message for logging',
					group: 'Test Group',
					project: 'Test Project',
					taskDuration: 5000,
					agentSessionId: 'test-session-id',
					tabName: 'TestTab',
				});
			});

			expect(window.maestro.logger.toast).toHaveBeenCalledWith('Log Test', {
				type: 'success',
				message: 'Test message for logging',
				group: 'Test Group',
				project: 'Test Project',
				taskDuration: 5000,
				agentSessionId: 'test-session-id',
				tabName: 'TestTab',
				audioNotification: { enabled: false },
			});
		});

		it('triggers audio feedback when enabled with command', async () => {
			vi.useFakeTimers({ shouldAdvanceTime: true });
			let contextValue: ReturnType<typeof useToast> | null = null;

			renderWithProvider(
				<ToastConsumer
					onMount={(ctx) => {
						contextValue = ctx;
					}}
				/>
			);

			// Enable audio feedback
			await act(async () => {
				contextValue!.setAudioFeedback(true, 'say -v Alex');
			});

			await act(async () => {
				contextValue!.addToast({
					type: 'success',
					title: 'Audio Test',
					message: 'This should be spoken',
				});
			});

			expect(window.maestro.notification.speak).toHaveBeenCalledWith(
				'This should be spoken',
				'say -v Alex'
			);
		});

		it('does not trigger audio when disabled', async () => {
			vi.useFakeTimers({ shouldAdvanceTime: true });
			let contextValue: ReturnType<typeof useToast> | null = null;

			renderWithProvider(
				<ToastConsumer
					onMount={(ctx) => {
						contextValue = ctx;
					}}
				/>
			);

			// Ensure audio is disabled (default)
			await act(async () => {
				contextValue!.setAudioFeedback(false, '');
			});

			await act(async () => {
				contextValue!.addToast({
					type: 'success',
					title: 'Silent Test',
					message: 'This should not be spoken',
				});
			});

			expect(window.maestro.notification.speak).not.toHaveBeenCalled();
		});

		it('does not trigger audio when enabled but command is empty', async () => {
			vi.useFakeTimers({ shouldAdvanceTime: true });
			let contextValue: ReturnType<typeof useToast> | null = null;

			renderWithProvider(
				<ToastConsumer
					onMount={(ctx) => {
						contextValue = ctx;
					}}
				/>
			);

			await act(async () => {
				contextValue!.setAudioFeedback(true, ''); // enabled but no command
			});

			await act(async () => {
				contextValue!.addToast({
					type: 'info',
					title: 'No Command Test',
					message: 'Should not speak',
				});
			});

			expect(window.maestro.notification.speak).not.toHaveBeenCalled();
		});

		it('shows OS notification when enabled', async () => {
			vi.useFakeTimers({ shouldAdvanceTime: true });
			let contextValue: ReturnType<typeof useToast> | null = null;

			renderWithProvider(
				<ToastConsumer
					onMount={(ctx) => {
						contextValue = ctx;
					}}
				/>
			);

			// OS notifications are enabled by default
			await act(async () => {
				contextValue!.addToast({
					type: 'success',
					title: 'Notification Test',
					message: 'OS notification message',
					group: 'MyGroup',
					tabName: 'MyTab',
				});
			});

			// Title is project field or fallback to toast title
			// Body is [Group > ] [TabName: ] First sentence of message
			expect(window.maestro.notification.show).toHaveBeenCalledWith(
				'Notification Test',
				'MyGroup > MyTab: OS notification message'
			);
		});

		it('builds notification title with group and agentSessionId when no tabName', async () => {
			vi.useFakeTimers({ shouldAdvanceTime: true });
			let contextValue: ReturnType<typeof useToast> | null = null;

			renderWithProvider(
				<ToastConsumer
					onMount={(ctx) => {
						contextValue = ctx;
					}}
				/>
			);

			await act(async () => {
				contextValue!.addToast({
					type: 'error',
					title: 'Session ID Test',
					message: 'Error message',
					group: 'ErrorGroup',
					agentSessionId: '12345678-abcd-efgh',
				});
			});

			// Title is project field or fallback to toast title
			// Body uses first 8 chars of agentSessionId when no tabName
			expect(window.maestro.notification.show).toHaveBeenCalledWith(
				'Session ID Test',
				'ErrorGroup > 12345678: Error message'
			);
		});

		it('falls back to group only when no session identifier', async () => {
			vi.useFakeTimers({ shouldAdvanceTime: true });
			let contextValue: ReturnType<typeof useToast> | null = null;

			renderWithProvider(
				<ToastConsumer
					onMount={(ctx) => {
						contextValue = ctx;
					}}
				/>
			);

			await act(async () => {
				contextValue!.addToast({
					type: 'warning',
					title: 'Group Only Test',
					message: 'Warning message',
					group: 'OnlyGroup',
				});
			});

			// Title is project field or fallback to toast title
			// Body is [Group: ] First sentence of message
			expect(window.maestro.notification.show).toHaveBeenCalledWith(
				'Group Only Test',
				'OnlyGroup: Warning message'
			);
		});

		it('falls back to title when no group or session', async () => {
			vi.useFakeTimers({ shouldAdvanceTime: true });
			let contextValue: ReturnType<typeof useToast> | null = null;

			renderWithProvider(
				<ToastConsumer
					onMount={(ctx) => {
						contextValue = ctx;
					}}
				/>
			);

			await act(async () => {
				contextValue!.addToast({
					type: 'info',
					title: 'Fallback Title',
					message: 'Info message',
				});
			});

			// Title is project field or fallback to toast title
			// Body is just the first sentence when no group/tab
			expect(window.maestro.notification.show).toHaveBeenCalledWith(
				'Fallback Title',
				'Info message'
			);
		});

		it('does not show OS notification when disabled', async () => {
			vi.useFakeTimers({ shouldAdvanceTime: true });
			let contextValue: ReturnType<typeof useToast> | null = null;

			renderWithProvider(
				<ToastConsumer
					onMount={(ctx) => {
						contextValue = ctx;
					}}
				/>
			);

			// Disable OS notifications
			await act(async () => {
				contextValue!.setOsNotifications(false);
			});

			vi.clearAllMocks(); // Clear any previous calls

			await act(async () => {
				contextValue!.addToast({
					type: 'success',
					title: 'No Notification',
					message: 'Should not show OS notification',
				});
			});

			expect(window.maestro.notification.show).not.toHaveBeenCalled();
		});

		it('auto-removes toast after duration expires', async () => {
			vi.useFakeTimers({ shouldAdvanceTime: true });
			let contextValue: ReturnType<typeof useToast> | null = null;

			renderWithProvider(
				<ToastConsumer
					onMount={(ctx) => {
						contextValue = ctx;
					}}
				/>,
				{ defaultDuration: 5 } // 5 seconds
			);

			await act(async () => {
				contextValue!.addToast({
					type: 'success',
					title: 'Auto Dismiss',
					message: 'Should auto-dismiss',
				});
			});

			expect(contextValue!.toasts).toHaveLength(1);

			// Advance time past duration
			await act(async () => {
				vi.advanceTimersByTime(5001); // Just over 5 seconds
			});

			expect(contextValue!.toasts).toHaveLength(0);
		});

		it('can add multiple toasts', async () => {
			vi.useFakeTimers({ shouldAdvanceTime: true });
			let contextValue: ReturnType<typeof useToast> | null = null;

			renderWithProvider(
				<ToastConsumer
					onMount={(ctx) => {
						contextValue = ctx;
					}}
				/>,
				{ defaultDuration: 0 } // Prevent auto-dismiss
			);

			await act(async () => {
				contextValue!.addToast({
					type: 'success',
					title: 'Toast 1',
					message: 'First toast',
				});
				contextValue!.addToast({
					type: 'info',
					title: 'Toast 2',
					message: 'Second toast',
				});
				contextValue!.addToast({
					type: 'warning',
					title: 'Toast 3',
					message: 'Third toast',
				});
			});

			expect(contextValue!.toasts).toHaveLength(3);
			expect(contextValue!.toasts[0].title).toBe('Toast 1');
			expect(contextValue!.toasts[1].title).toBe('Toast 2');
			expect(contextValue!.toasts[2].title).toBe('Toast 3');
		});

		it('generates unique IDs for each toast', async () => {
			vi.useFakeTimers({ shouldAdvanceTime: true });
			let contextValue: ReturnType<typeof useToast> | null = null;

			renderWithProvider(
				<ToastConsumer
					onMount={(ctx) => {
						contextValue = ctx;
					}}
				/>,
				{ defaultDuration: 0 }
			);

			await act(async () => {
				contextValue!.addToast({
					type: 'success',
					title: 'Toast A',
					message: 'Message A',
				});
				contextValue!.addToast({
					type: 'success',
					title: 'Toast B',
					message: 'Message B',
				});
			});

			const id1 = contextValue!.toasts[0].id;
			const id2 = contextValue!.toasts[1].id;
			expect(id1).not.toBe(id2);
		});
	});

	describe('removeToast', () => {
		it('removes toast by ID', async () => {
			vi.useFakeTimers({ shouldAdvanceTime: true });
			let contextValue: ReturnType<typeof useToast> | null = null;

			renderWithProvider(
				<ToastConsumer
					onMount={(ctx) => {
						contextValue = ctx;
					}}
				/>,
				{ defaultDuration: 0 }
			);

			await act(async () => {
				contextValue!.addToast({
					type: 'success',
					title: 'To Be Removed',
					message: 'This will be removed',
				});
			});

			const toastId = contextValue!.toasts[0].id;
			expect(contextValue!.toasts).toHaveLength(1);

			await act(async () => {
				contextValue!.removeToast(toastId);
			});

			expect(contextValue!.toasts).toHaveLength(0);
		});

		it('leaves other toasts intact when removing one', async () => {
			vi.useFakeTimers({ shouldAdvanceTime: true });
			let contextValue: ReturnType<typeof useToast> | null = null;

			renderWithProvider(
				<ToastConsumer
					onMount={(ctx) => {
						contextValue = ctx;
					}}
				/>,
				{ defaultDuration: 0 }
			);

			await act(async () => {
				contextValue!.addToast({
					type: 'success',
					title: 'Toast 1',
					message: 'First',
				});
				contextValue!.addToast({
					type: 'info',
					title: 'Toast 2',
					message: 'Second',
				});
				contextValue!.addToast({
					type: 'warning',
					title: 'Toast 3',
					message: 'Third',
				});
			});

			const toastToRemove = contextValue!.toasts[1].id;

			await act(async () => {
				contextValue!.removeToast(toastToRemove);
			});

			expect(contextValue!.toasts).toHaveLength(2);
			expect(contextValue!.toasts[0].title).toBe('Toast 1');
			expect(contextValue!.toasts[1].title).toBe('Toast 3');
		});

		it('handles non-existent ID gracefully', async () => {
			vi.useFakeTimers({ shouldAdvanceTime: true });
			let contextValue: ReturnType<typeof useToast> | null = null;

			renderWithProvider(
				<ToastConsumer
					onMount={(ctx) => {
						contextValue = ctx;
					}}
				/>,
				{ defaultDuration: 0 }
			);

			await act(async () => {
				contextValue!.addToast({
					type: 'success',
					title: 'Existing',
					message: 'Existing toast',
				});
			});

			expect(contextValue!.toasts).toHaveLength(1);

			// Try to remove a non-existent ID
			await act(async () => {
				contextValue!.removeToast('non-existent-id');
			});

			// Should still have the original toast
			expect(contextValue!.toasts).toHaveLength(1);
		});
	});

	describe('clearToasts', () => {
		it('removes all toasts', async () => {
			vi.useFakeTimers({ shouldAdvanceTime: true });
			let contextValue: ReturnType<typeof useToast> | null = null;

			renderWithProvider(
				<ToastConsumer
					onMount={(ctx) => {
						contextValue = ctx;
					}}
				/>,
				{ defaultDuration: 0 }
			);

			await act(async () => {
				contextValue!.addToast({ type: 'success', title: 'T1', message: 'M1' });
				contextValue!.addToast({ type: 'info', title: 'T2', message: 'M2' });
				contextValue!.addToast({ type: 'warning', title: 'T3', message: 'M3' });
				contextValue!.addToast({ type: 'error', title: 'T4', message: 'M4' });
			});

			expect(contextValue!.toasts).toHaveLength(4);

			await act(async () => {
				contextValue!.clearToasts();
			});

			expect(contextValue!.toasts).toHaveLength(0);
		});

		it('results in empty array when already empty', async () => {
			let contextValue: ReturnType<typeof useToast> | null = null;

			renderWithProvider(
				<ToastConsumer
					onMount={(ctx) => {
						contextValue = ctx;
					}}
				/>
			);

			expect(contextValue!.toasts).toHaveLength(0);

			await act(async () => {
				contextValue!.clearToasts();
			});

			expect(contextValue!.toasts).toHaveLength(0);
			expect(contextValue!.toasts).toEqual([]);
		});
	});

	describe('setDefaultDuration', () => {
		it('updates default duration', async () => {
			let contextValue: ReturnType<typeof useToast> | null = null;

			renderWithProvider(
				<ToastConsumer
					onMount={(ctx) => {
						contextValue = ctx;
					}}
				/>,
				{ defaultDuration: 20 }
			);

			expect(contextValue!.defaultDuration).toBe(20);

			await act(async () => {
				contextValue!.setDefaultDuration(30);
			});

			expect(contextValue!.defaultDuration).toBe(30);
		});

		it('affects subsequently added toasts', async () => {
			vi.useFakeTimers({ shouldAdvanceTime: true });
			let contextValue: ReturnType<typeof useToast> | null = null;

			renderWithProvider(
				<ToastConsumer
					onMount={(ctx) => {
						contextValue = ctx;
					}}
				/>,
				{ defaultDuration: 10 }
			);

			// Add toast with old default duration
			await act(async () => {
				contextValue!.addToast({
					type: 'success',
					title: 'Old Duration',
					message: 'Uses 10 second default',
				});
			});

			expect(contextValue!.toasts[0].duration).toBe(10000); // 10 seconds in ms

			// Change default duration
			await act(async () => {
				contextValue!.setDefaultDuration(25);
			});

			// Add another toast
			await act(async () => {
				contextValue!.addToast({
					type: 'info',
					title: 'New Duration',
					message: 'Uses 25 second default',
				});
			});

			expect(contextValue!.toasts[1].duration).toBe(25000); // 25 seconds in ms
		});
	});

	describe('setAudioFeedback', () => {
		it('enables audio feedback with command', async () => {
			vi.useFakeTimers({ shouldAdvanceTime: true });
			let contextValue: ReturnType<typeof useToast> | null = null;

			renderWithProvider(
				<ToastConsumer
					onMount={(ctx) => {
						contextValue = ctx;
					}}
				/>
			);

			await act(async () => {
				contextValue!.setAudioFeedback(true, 'espeak');
			});

			// Now adding a toast should trigger speak
			await act(async () => {
				contextValue!.addToast({
					type: 'success',
					title: 'Audio On',
					message: 'Should speak this',
				});
			});

			expect(window.maestro.notification.speak).toHaveBeenCalledWith('Should speak this', 'espeak');
		});

		it('disables audio feedback', async () => {
			vi.useFakeTimers({ shouldAdvanceTime: true });
			let contextValue: ReturnType<typeof useToast> | null = null;

			renderWithProvider(
				<ToastConsumer
					onMount={(ctx) => {
						contextValue = ctx;
					}}
				/>
			);

			// First enable
			await act(async () => {
				contextValue!.setAudioFeedback(true, 'say');
			});

			// Then disable
			await act(async () => {
				contextValue!.setAudioFeedback(false, 'say');
			});

			vi.clearAllMocks();

			await act(async () => {
				contextValue!.addToast({
					type: 'success',
					title: 'Audio Off',
					message: 'Should not speak',
				});
			});

			expect(window.maestro.notification.speak).not.toHaveBeenCalled();
		});
	});

	describe('setOsNotifications', () => {
		it('enables OS notifications', async () => {
			vi.useFakeTimers({ shouldAdvanceTime: true });
			let contextValue: ReturnType<typeof useToast> | null = null;

			renderWithProvider(
				<ToastConsumer
					onMount={(ctx) => {
						contextValue = ctx;
					}}
				/>
			);

			// First disable
			await act(async () => {
				contextValue!.setOsNotifications(false);
			});

			vi.clearAllMocks();

			// Then enable
			await act(async () => {
				contextValue!.setOsNotifications(true);
			});

			await act(async () => {
				contextValue!.addToast({
					type: 'success',
					title: 'Notifications On',
					message: 'Should show notification',
				});
			});

			expect(window.maestro.notification.show).toHaveBeenCalled();
		});

		it('disables OS notifications', async () => {
			vi.useFakeTimers({ shouldAdvanceTime: true });
			let contextValue: ReturnType<typeof useToast> | null = null;

			renderWithProvider(
				<ToastConsumer
					onMount={(ctx) => {
						contextValue = ctx;
					}}
				/>
			);

			// Disable notifications
			await act(async () => {
				contextValue!.setOsNotifications(false);
			});

			vi.clearAllMocks();

			await act(async () => {
				contextValue!.addToast({
					type: 'success',
					title: 'Notifications Off',
					message: 'Should not show notification',
				});
			});

			expect(window.maestro.notification.show).not.toHaveBeenCalled();
		});
	});

	describe('useToast', () => {
		it('returns context when inside provider', () => {
			let contextValue: ReturnType<typeof useToast> | null = null;

			renderWithProvider(
				<ToastConsumer
					onMount={(ctx) => {
						contextValue = ctx;
					}}
				/>
			);

			expect(contextValue).not.toBeNull();
			expect(contextValue!.toasts).toBeDefined();
			expect(contextValue!.addToast).toBeInstanceOf(Function);
			expect(contextValue!.removeToast).toBeInstanceOf(Function);
			expect(contextValue!.clearToasts).toBeInstanceOf(Function);
			expect(contextValue!.defaultDuration).toBeDefined();
			expect(contextValue!.setDefaultDuration).toBeInstanceOf(Function);
			expect(contextValue!.setAudioFeedback).toBeInstanceOf(Function);
			expect(contextValue!.setOsNotifications).toBeInstanceOf(Function);
		});

		it('throws error when outside provider', () => {
			// Suppress expected error logging during this test
			const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

			expect(() => {
				renderHook(() => useToast());
			}).toThrow('useToast must be used within a ToastProvider');

			consoleSpy.mockRestore();
		});
	});

	describe('edge cases', () => {
		it('handles speak failure gracefully', async () => {
			vi.useFakeTimers({ shouldAdvanceTime: true });
			let contextValue: ReturnType<typeof useToast> | null = null;

			// Make speak reject
			vi.mocked(window.maestro.notification.speak).mockRejectedValueOnce(new Error('TTS failed'));
			const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

			renderWithProvider(
				<ToastConsumer
					onMount={(ctx) => {
						contextValue = ctx;
					}}
				/>
			);

			await act(async () => {
				contextValue!.setAudioFeedback(true, 'say');
			});

			await act(async () => {
				contextValue!.addToast({
					type: 'success',
					title: 'TTS Failure',
					message: 'This will fail to speak',
				});
			});

			// Allow promise rejection to be handled
			await act(async () => {
				vi.advanceTimersByTime(10);
			});

			// Toast should still be added despite speak failure
			expect(contextValue!.toasts).toHaveLength(1);

			consoleSpy.mockRestore();
		});

		it('handles show notification failure gracefully', async () => {
			vi.useFakeTimers({ shouldAdvanceTime: true });
			let contextValue: ReturnType<typeof useToast> | null = null;

			// Make show reject
			vi.mocked(window.maestro.notification.show).mockRejectedValueOnce(
				new Error('Notification failed')
			);
			const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

			renderWithProvider(
				<ToastConsumer
					onMount={(ctx) => {
						contextValue = ctx;
					}}
				/>
			);

			await act(async () => {
				contextValue!.addToast({
					type: 'error',
					title: 'Notification Failure',
					message: 'This will fail to notify',
				});
			});

			// Allow promise rejection to be handled
			await act(async () => {
				vi.advanceTimersByTime(10);
			});

			// Toast should still be added despite notification failure
			expect(contextValue!.toasts).toHaveLength(1);

			consoleSpy.mockRestore();
		});

		it('uses sessionLabel when only tabName is available (no group)', async () => {
			vi.useFakeTimers({ shouldAdvanceTime: true });
			let contextValue: ReturnType<typeof useToast> | null = null;

			renderWithProvider(
				<ToastConsumer
					onMount={(ctx) => {
						contextValue = ctx;
					}}
				/>
			);

			await act(async () => {
				contextValue!.addToast({
					type: 'success',
					title: 'Tab Only',
					message: 'Message',
					tabName: 'OnlyTabName',
				});
			});

			// Title is project field or fallback to toast title
			// Body is [TabName: ] First sentence of message
			expect(window.maestro.notification.show).toHaveBeenCalledWith(
				'Tab Only',
				'OnlyTabName: Message'
			);
		});
	});
});
