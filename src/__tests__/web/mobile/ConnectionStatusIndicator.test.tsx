/**
 * Tests for ConnectionStatusIndicator component
 *
 * @file src/web/mobile/ConnectionStatusIndicator.tsx
 *
 * Tests the connection status indicator banner that shows connection status
 * with retry functionality. Displays as a dismissible banner when connection
 * is lost or reconnecting.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import React from 'react';
import {
	ConnectionStatusIndicator,
	type ConnectionStatusIndicatorProps,
} from '../../../web/mobile/ConnectionStatusIndicator';
import type { WebSocketState } from '../../../web/hooks/useWebSocket';

// Mock colors object for theme
const mockColors = {
	bgMain: '#0b0b0d',
	bgSidebar: '#111113',
	bgActivity: '#1c1c1f',
	border: '#27272a',
	textMain: '#e4e4e7',
	textDim: '#a1a1aa',
	accent: '#6366f1',
	accentDim: 'rgba(99, 102, 241, 0.2)',
	accentText: '#a5b4fc',
	success: '#22c55e',
	warning: '#eab308',
	error: '#ef4444',
};

// Mock the ThemeProvider hooks
vi.mock('../../../web/components/ThemeProvider', () => ({
	useThemeColors: () => mockColors,
	useTheme: () => ({
		theme: {
			id: 'dracula',
			name: 'Dracula',
			mode: 'dark',
			colors: mockColors,
		},
		isLight: false,
		isDark: true,
		isVibe: false,
		isDevicePreference: false,
	}),
	ThemeProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// Track triggerHaptic calls
const mockTriggerHaptic = vi.fn();

// Mock the constants for haptics
vi.mock('../../../web/mobile/constants', () => ({
	triggerHaptic: (...args: unknown[]) => mockTriggerHaptic(...args),
	HAPTIC_PATTERNS: {
		tap: [10],
		send: [10, 50, 10],
		interrupt: [50],
		success: [10, 30, 10],
		error: [50, 50, 50],
	},
}));

// Import mock for assertions
import { HAPTIC_PATTERNS } from '../../../web/mobile/constants';

describe('ConnectionStatusIndicator', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	// Helper to create default props
	const createProps = (
		overrides: Partial<ConnectionStatusIndicatorProps> = {}
	): ConnectionStatusIndicatorProps => ({
		connectionState: 'disconnected',
		isOffline: false,
		reconnectAttempts: 0,
		onRetry: vi.fn(),
		...overrides,
	});

	describe('Render conditions', () => {
		it('renders null when connectionState is connected', () => {
			const { container } = render(
				<ConnectionStatusIndicator {...createProps({ connectionState: 'connected' })} />
			);
			expect(container.firstChild).toBeNull();
		});

		it('renders null when connectionState is authenticated', () => {
			const { container } = render(
				<ConnectionStatusIndicator {...createProps({ connectionState: 'authenticated' })} />
			);
			expect(container.firstChild).toBeNull();
		});

		it('renders when connectionState is disconnected', () => {
			render(<ConnectionStatusIndicator {...createProps({ connectionState: 'disconnected' })} />);
			expect(screen.getByRole('alert')).toBeInTheDocument();
		});

		it('renders when connectionState is connecting', () => {
			render(<ConnectionStatusIndicator {...createProps({ connectionState: 'connecting' })} />);
			expect(screen.getByRole('alert')).toBeInTheDocument();
		});

		it('renders when connectionState is authenticating', () => {
			render(<ConnectionStatusIndicator {...createProps({ connectionState: 'authenticating' })} />);
			expect(screen.getByRole('alert')).toBeInTheDocument();
		});

		it('renders when isOffline is true', () => {
			render(
				<ConnectionStatusIndicator
					{...createProps({ connectionState: 'disconnected', isOffline: true })}
				/>
			);
			expect(screen.getByRole('alert')).toBeInTheDocument();
		});
	});

	describe('Offline state', () => {
		it('shows "No internet connection" message when offline', () => {
			render(<ConnectionStatusIndicator {...createProps({ isOffline: true })} />);
			expect(screen.getByText('No internet connection')).toBeInTheDocument();
		});

		it('shows automatic reconnection sub-message when offline', () => {
			render(<ConnectionStatusIndicator {...createProps({ isOffline: true })} />);
			expect(screen.getByText('Will reconnect automatically when online')).toBeInTheDocument();
		});

		it('does not show retry button when offline', () => {
			render(<ConnectionStatusIndicator {...createProps({ isOffline: true })} />);
			expect(screen.queryByLabelText('Retry connection')).not.toBeInTheDocument();
		});

		it('renders wifi-off icon when offline', () => {
			const { container } = render(
				<ConnectionStatusIndicator {...createProps({ isOffline: true })} />
			);
			// Check for the wifi-off SVG path
			const svg = container.querySelector('svg');
			expect(svg).toBeInTheDocument();
			// WifiOffIcon has diagonal line from (1,1) to (23,23)
			const lineWithX1 = container.querySelector('line[x1="1"][y1="1"]');
			expect(lineWithX1).toBeInTheDocument();
		});
	});

	describe('Connecting state', () => {
		it('shows "Connecting..." message', () => {
			render(<ConnectionStatusIndicator {...createProps({ connectionState: 'connecting' })} />);
			expect(screen.getByText('Connecting...')).toBeInTheDocument();
		});

		it('shows "Establishing connection..." sub-message when no attempts yet', () => {
			render(
				<ConnectionStatusIndicator
					{...createProps({ connectionState: 'connecting', reconnectAttempts: 0 })}
				/>
			);
			expect(screen.getByText('Establishing connection...')).toBeInTheDocument();
		});

		it('shows attempt count when reconnectAttempts > 0', () => {
			render(
				<ConnectionStatusIndicator
					{...createProps({
						connectionState: 'connecting',
						reconnectAttempts: 3,
						maxReconnectAttempts: 10,
					})}
				/>
			);
			expect(screen.getByText('Attempt 3 of 10')).toBeInTheDocument();
		});

		it('uses default maxReconnectAttempts of 10 if not provided', () => {
			render(
				<ConnectionStatusIndicator
					{...createProps({ connectionState: 'connecting', reconnectAttempts: 3 })}
				/>
			);
			expect(screen.getByText('Attempt 3 of 10')).toBeInTheDocument();
		});

		it('does not show retry button when reconnectAttempts <= 2', () => {
			render(
				<ConnectionStatusIndicator
					{...createProps({ connectionState: 'connecting', reconnectAttempts: 2 })}
				/>
			);
			expect(screen.queryByLabelText('Retry connection')).not.toBeInTheDocument();
		});

		it('shows retry button when reconnectAttempts > 2', () => {
			render(
				<ConnectionStatusIndicator
					{...createProps({ connectionState: 'connecting', reconnectAttempts: 3 })}
				/>
			);
			expect(screen.getByLabelText('Retry connection')).toBeInTheDocument();
		});

		it('renders loading icon (animate-spin class) when connecting', () => {
			const { container } = render(
				<ConnectionStatusIndicator {...createProps({ connectionState: 'connecting' })} />
			);
			const svg = container.querySelector('svg.animate-spin');
			expect(svg).toBeInTheDocument();
		});

		it('has pulse animation when connecting', () => {
			const { container } = render(
				<ConnectionStatusIndicator {...createProps({ connectionState: 'connecting' })} />
			);
			const alert = container.querySelector('[role="alert"]');
			expect(alert).toHaveStyle({ animation: 'pulse 2s ease-in-out infinite' });
		});
	});

	describe('Authenticating state', () => {
		it('shows "Authenticating..." message', () => {
			render(<ConnectionStatusIndicator {...createProps({ connectionState: 'authenticating' })} />);
			expect(screen.getByText('Authenticating...')).toBeInTheDocument();
		});

		it('shows attempt count when reconnectAttempts > 0', () => {
			render(
				<ConnectionStatusIndicator
					{...createProps({ connectionState: 'authenticating', reconnectAttempts: 2 })}
				/>
			);
			expect(screen.getByText('Attempt 2 of 10')).toBeInTheDocument();
		});
	});

	describe('Disconnected state', () => {
		it('shows "Disconnected" message when not at max attempts', () => {
			render(
				<ConnectionStatusIndicator
					{...createProps({ connectionState: 'disconnected', reconnectAttempts: 3 })}
				/>
			);
			expect(screen.getByText('Disconnected')).toBeInTheDocument();
		});

		it('shows "Connection failed" when max attempts reached', () => {
			render(
				<ConnectionStatusIndicator
					{...createProps({
						connectionState: 'disconnected',
						reconnectAttempts: 10,
						maxReconnectAttempts: 10,
					})}
				/>
			);
			expect(screen.getByText('Connection failed')).toBeInTheDocument();
		});

		it('shows "Tap retry to reconnect" sub-message when not at max attempts', () => {
			render(
				<ConnectionStatusIndicator
					{...createProps({ connectionState: 'disconnected', reconnectAttempts: 3 })}
				/>
			);
			expect(screen.getByText('Tap retry to reconnect')).toBeInTheDocument();
		});

		it('shows max attempts message when max attempts reached', () => {
			render(
				<ConnectionStatusIndicator
					{...createProps({
						connectionState: 'disconnected',
						reconnectAttempts: 10,
						maxReconnectAttempts: 10,
					})}
				/>
			);
			expect(screen.getByText('Failed after 10 attempts')).toBeInTheDocument();
		});

		it('shows error message if provided', () => {
			render(
				<ConnectionStatusIndicator
					{...createProps({ connectionState: 'disconnected', error: 'Connection refused' })}
				/>
			);
			expect(screen.getByText('Connection refused')).toBeInTheDocument();
		});

		it('shows retry button when disconnected', () => {
			render(<ConnectionStatusIndicator {...createProps({ connectionState: 'disconnected' })} />);
			expect(screen.getByLabelText('Retry connection')).toBeInTheDocument();
		});

		it('shows dismiss button when disconnected and not offline', () => {
			render(
				<ConnectionStatusIndicator
					{...createProps({ connectionState: 'disconnected', isOffline: false })}
				/>
			);
			expect(screen.getByLabelText('Dismiss notification')).toBeInTheDocument();
		});

		it('renders disconnect icon when disconnected', () => {
			const { container } = render(
				<ConnectionStatusIndicator {...createProps({ connectionState: 'disconnected' })} />
			);
			const svg = container.querySelector('svg');
			expect(svg).toBeInTheDocument();
			// DisconnectIcon has polyline with points "16 17 21 12 16 7"
			const polyline = container.querySelector('polyline[points="16 17 21 12 16 7"]');
			expect(polyline).toBeInTheDocument();
		});

		it('does not have pulse animation when disconnected', () => {
			const { container } = render(
				<ConnectionStatusIndicator {...createProps({ connectionState: 'disconnected' })} />
			);
			const alert = container.querySelector('[role="alert"]');
			expect(alert?.style.animation).toBeFalsy();
		});
	});

	describe('Unknown/fallback state', () => {
		it('shows "Unknown state" for unknown connection states', () => {
			render(
				<ConnectionStatusIndicator
					{...createProps({ connectionState: 'unknown' as WebSocketState })}
				/>
			);
			expect(screen.getByText('Unknown state')).toBeInTheDocument();
		});

		it('shows retry button for unknown states', () => {
			render(
				<ConnectionStatusIndicator
					{...createProps({ connectionState: 'unknown' as WebSocketState })}
				/>
			);
			expect(screen.getByLabelText('Retry connection')).toBeInTheDocument();
		});
	});

	describe('Retry button', () => {
		it('calls onRetry when retry button is clicked', () => {
			const onRetry = vi.fn();
			render(
				<ConnectionStatusIndicator {...createProps({ connectionState: 'disconnected', onRetry })} />
			);

			fireEvent.click(screen.getByLabelText('Retry connection'));

			expect(onRetry).toHaveBeenCalledTimes(1);
		});

		it('triggers haptic feedback when retry button is clicked', () => {
			render(<ConnectionStatusIndicator {...createProps({ connectionState: 'disconnected' })} />);

			fireEvent.click(screen.getByLabelText('Retry connection'));

			expect(mockTriggerHaptic).toHaveBeenCalledWith(HAPTIC_PATTERNS.tap);
		});

		it('retry button has correct styling', () => {
			render(<ConnectionStatusIndicator {...createProps({ connectionState: 'disconnected' })} />);

			const retryButton = screen.getByLabelText('Retry connection');
			expect(retryButton).toHaveStyle({ backgroundColor: mockColors.accent });
		});

		it('retry button contains "Retry" text', () => {
			render(<ConnectionStatusIndicator {...createProps({ connectionState: 'disconnected' })} />);
			expect(screen.getByText('Retry')).toBeInTheDocument();
		});
	});

	describe('Dismiss button', () => {
		it('hides indicator when dismiss button is clicked', () => {
			const { container } = render(
				<ConnectionStatusIndicator {...createProps({ connectionState: 'disconnected' })} />
			);

			expect(screen.getByRole('alert')).toBeInTheDocument();

			fireEvent.click(screen.getByLabelText('Dismiss notification'));

			expect(container.firstChild).toBeNull();
		});

		it('triggers haptic feedback when dismiss button is clicked', () => {
			render(<ConnectionStatusIndicator {...createProps({ connectionState: 'disconnected' })} />);

			fireEvent.click(screen.getByLabelText('Dismiss notification'));

			expect(mockTriggerHaptic).toHaveBeenCalledWith(HAPTIC_PATTERNS.tap);
		});

		it('does not show dismiss button when connecting', () => {
			render(<ConnectionStatusIndicator {...createProps({ connectionState: 'connecting' })} />);
			expect(screen.queryByLabelText('Dismiss notification')).not.toBeInTheDocument();
		});

		it('does not show dismiss button when offline', () => {
			render(
				<ConnectionStatusIndicator
					{...createProps({ connectionState: 'disconnected', isOffline: true })}
				/>
			);
			expect(screen.queryByLabelText('Dismiss notification')).not.toBeInTheDocument();
		});
	});

	describe('Dismissed state behavior', () => {
		it('remains hidden when dismissed and connectionState stays the same', () => {
			const { container, rerender } = render(
				<ConnectionStatusIndicator {...createProps({ connectionState: 'disconnected' })} />
			);

			fireEvent.click(screen.getByLabelText('Dismiss notification'));
			expect(container.firstChild).toBeNull();

			// Rerender with same state
			rerender(<ConnectionStatusIndicator {...createProps({ connectionState: 'disconnected' })} />);
			expect(container.firstChild).toBeNull();
		});

		it('shows indicator again when dismissed but connectionState becomes connecting', () => {
			const { container, rerender } = render(
				<ConnectionStatusIndicator {...createProps({ connectionState: 'disconnected' })} />
			);

			fireEvent.click(screen.getByLabelText('Dismiss notification'));
			expect(container.firstChild).toBeNull();

			// State changes to connecting - indicator should show even if dismissed
			rerender(<ConnectionStatusIndicator {...createProps({ connectionState: 'connecting' })} />);
			expect(screen.getByRole('alert')).toBeInTheDocument();
		});

		it('resets dismissed state when connectionState changes to disconnected', () => {
			const { rerender } = render(
				<ConnectionStatusIndicator {...createProps({ connectionState: 'disconnected' })} />
			);

			fireEvent.click(screen.getByLabelText('Dismiss notification'));

			// Change to connected then back to disconnected
			rerender(<ConnectionStatusIndicator {...createProps({ connectionState: 'connected' })} />);
			rerender(<ConnectionStatusIndicator {...createProps({ connectionState: 'disconnected' })} />);

			// Should be visible again since dismissed was reset when state changed to disconnected
			expect(screen.getByRole('alert')).toBeInTheDocument();
		});
	});

	describe('Details expansion', () => {
		it('toggles details when message area is clicked', () => {
			render(
				<ConnectionStatusIndicator
					{...createProps({ connectionState: 'disconnected', error: 'Test error' })}
				/>
			);

			// Initially not expanded - no "Error details:" heading
			expect(screen.queryByText('Error details:')).not.toBeInTheDocument();

			// Click to expand
			const messageArea = screen.getByRole('button', { expanded: false });
			fireEvent.click(messageArea);

			// After expansion, "Error details:" heading should be visible
			expect(screen.getByText('Error details:')).toBeInTheDocument();
			// Error text appears in both sub-message and details section when expanded
			const errorTexts = screen.getAllByText('Test error');
			expect(errorTexts.length).toBeGreaterThanOrEqual(1);
		});

		it('triggers haptic feedback when toggling details', () => {
			render(
				<ConnectionStatusIndicator
					{...createProps({ connectionState: 'disconnected', error: 'Test error' })}
				/>
			);

			const messageArea = screen.getByRole('button', { expanded: false });
			fireEvent.click(messageArea);

			expect(mockTriggerHaptic).toHaveBeenCalledWith(HAPTIC_PATTERNS.tap);
		});

		it('shows expanded details section with error styling', () => {
			const { container } = render(
				<ConnectionStatusIndicator
					{...createProps({ connectionState: 'disconnected', error: 'Connection refused' })}
				/>
			);

			const messageArea = screen.getByRole('button', { expanded: false });
			fireEvent.click(messageArea);

			// Check for error details section - error appears in both sub-message and details
			const errorTexts = screen.getAllByText('Connection refused');
			expect(errorTexts.length).toBeGreaterThanOrEqual(2); // sub-message + details section
			// Find the one in the details section with monospace font
			const monoText = errorTexts.find((el) => el.style.fontFamily === 'monospace');
			expect(monoText).toBeDefined();
		});

		it('does not show details section if no error', () => {
			render(<ConnectionStatusIndicator {...createProps({ connectionState: 'disconnected' })} />);

			const messageArea = screen.getByRole('button', { expanded: false });
			fireEvent.click(messageArea);

			// Should not show error details even when expanded
			expect(screen.queryByText('Error details:')).not.toBeInTheDocument();
		});

		it('toggles aria-expanded state', () => {
			render(
				<ConnectionStatusIndicator
					{...createProps({ connectionState: 'disconnected', error: 'Test error' })}
				/>
			);

			const messageArea = screen.getByRole('button', { expanded: false });
			expect(messageArea).toHaveAttribute('aria-expanded', 'false');

			fireEvent.click(messageArea);
			expect(messageArea).toHaveAttribute('aria-expanded', 'true');

			fireEvent.click(messageArea);
			expect(messageArea).toHaveAttribute('aria-expanded', 'false');
		});

		it('changes sub-message text wrapping when expanded', () => {
			const { container } = render(
				<ConnectionStatusIndicator
					{...createProps({ connectionState: 'disconnected', reconnectAttempts: 3 })}
				/>
			);

			// Initially collapsed - should have nowrap
			const subMessage = screen.getByText('Tap retry to reconnect');
			expect(subMessage).toHaveStyle({ whiteSpace: 'nowrap' });

			// Expand
			const messageArea = screen.getByRole('button', { expanded: false });
			fireEvent.click(messageArea);

			// After expansion - should have normal wrapping
			expect(subMessage).toHaveStyle({ whiteSpace: 'normal' });
		});
	});

	describe('Styling', () => {
		it('applies custom style prop', () => {
			const { container } = render(
				<ConnectionStatusIndicator
					{...createProps({ connectionState: 'disconnected', style: { marginTop: '20px' } })}
				/>
			);

			const alert = container.querySelector('[role="alert"]');
			expect(alert).toHaveStyle({ marginTop: '20px' });
		});

		it('has fixed positioning', () => {
			const { container } = render(
				<ConnectionStatusIndicator {...createProps({ connectionState: 'disconnected' })} />
			);

			const alert = container.querySelector('[role="alert"]');
			expect(alert).toHaveStyle({ position: 'fixed' });
		});

		it('has correct z-index', () => {
			const { container } = render(
				<ConnectionStatusIndicator {...createProps({ connectionState: 'disconnected' })} />
			);

			const alert = container.querySelector('[role="alert"]');
			expect(alert).toHaveStyle({ zIndex: '100' });
		});

		it('uses error color for border when offline', () => {
			const { container } = render(
				<ConnectionStatusIndicator {...createProps({ isOffline: true })} />
			);

			const alert = container.querySelector('[role="alert"]');
			expect(alert).toHaveStyle({ borderColor: mockColors.error });
		});

		it('uses error color for border when disconnected', () => {
			const { container } = render(
				<ConnectionStatusIndicator {...createProps({ connectionState: 'disconnected' })} />
			);

			const alert = container.querySelector('[role="alert"]');
			expect(alert).toHaveStyle({ borderColor: mockColors.error });
		});

		it('uses orange color for border when connecting', () => {
			const { container } = render(
				<ConnectionStatusIndicator {...createProps({ connectionState: 'connecting' })} />
			);

			const alert = container.querySelector('[role="alert"]');
			expect(alert).toHaveStyle({ borderColor: '#f97316' });
		});
	});

	describe('Accessibility', () => {
		it('has role="alert" for screen readers', () => {
			render(<ConnectionStatusIndicator {...createProps({ connectionState: 'disconnected' })} />);
			expect(screen.getByRole('alert')).toBeInTheDocument();
		});

		it('has aria-live="polite"', () => {
			const { container } = render(
				<ConnectionStatusIndicator {...createProps({ connectionState: 'disconnected' })} />
			);

			const alert = container.querySelector('[role="alert"]');
			expect(alert).toHaveAttribute('aria-live', 'polite');
		});

		it('retry button has aria-label', () => {
			render(<ConnectionStatusIndicator {...createProps({ connectionState: 'disconnected' })} />);
			expect(screen.getByLabelText('Retry connection')).toBeInTheDocument();
		});

		it('dismiss button has aria-label', () => {
			render(<ConnectionStatusIndicator {...createProps({ connectionState: 'disconnected' })} />);
			expect(screen.getByLabelText('Dismiss notification')).toBeInTheDocument();
		});

		it('message area has tabIndex for keyboard navigation', () => {
			render(<ConnectionStatusIndicator {...createProps({ connectionState: 'disconnected' })} />);

			const messageArea = screen.getByRole('button', { expanded: false });
			expect(messageArea).toHaveAttribute('tabIndex', '0');
		});
	});

	describe('Icon rendering', () => {
		it('renders WifiOffIcon when offline', () => {
			const { container } = render(
				<ConnectionStatusIndicator {...createProps({ isOffline: true })} />
			);

			// WifiOffIcon has specific path elements
			const wifiPath = container.querySelector('path[d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55"]');
			expect(wifiPath).toBeInTheDocument();
		});

		it('renders LoadingIcon when connecting', () => {
			const { container } = render(
				<ConnectionStatusIndicator {...createProps({ connectionState: 'connecting' })} />
			);

			// LoadingIcon has animate-spin class and specific structure
			const loadingIcon = container.querySelector('svg.animate-spin');
			expect(loadingIcon).toBeInTheDocument();
		});

		it('renders DisconnectIcon when disconnected', () => {
			const { container } = render(
				<ConnectionStatusIndicator {...createProps({ connectionState: 'disconnected' })} />
			);

			// DisconnectIcon has specific path elements
			const disconnectPath = container.querySelector(
				'path[d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"]'
			);
			expect(disconnectPath).toBeInTheDocument();
		});

		it('renders RetryIcon in retry button', () => {
			const { container } = render(
				<ConnectionStatusIndicator {...createProps({ connectionState: 'disconnected' })} />
			);

			// RetryIcon has specific path with refresh shape
			const retryPath = container.querySelector('path[d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"]');
			expect(retryPath).toBeInTheDocument();
		});

		it('renders CloseIcon in dismiss button', () => {
			const { container } = render(
				<ConnectionStatusIndicator {...createProps({ connectionState: 'disconnected' })} />
			);

			// CloseIcon has two crossing lines
			const closeLine1 = container.querySelector('line[x1="18"][y1="6"][x2="6"][y2="18"]');
			const closeLine2 = container.querySelector('line[x1="6"][y1="6"][x2="18"][y2="18"]');
			expect(closeLine1).toBeInTheDocument();
			expect(closeLine2).toBeInTheDocument();
		});
	});

	describe('CSS animation', () => {
		it('includes pulse keyframes style element', () => {
			const { container } = render(
				<ConnectionStatusIndicator {...createProps({ connectionState: 'connecting' })} />
			);

			const styleElement = container.querySelector('style');
			expect(styleElement).toBeInTheDocument();
			expect(styleElement?.textContent).toContain('@keyframes pulse');
		});
	});

	describe('Edge cases', () => {
		it('handles null error gracefully', () => {
			render(
				<ConnectionStatusIndicator
					{...createProps({ connectionState: 'disconnected', error: null })}
				/>
			);
			expect(screen.getByText('Tap retry to reconnect')).toBeInTheDocument();
		});

		it('handles undefined error gracefully', () => {
			render(
				<ConnectionStatusIndicator
					{...createProps({ connectionState: 'disconnected', error: undefined })}
				/>
			);
			expect(screen.getByText('Tap retry to reconnect')).toBeInTheDocument();
		});

		it('handles very long error messages', () => {
			const longError = 'A'.repeat(500);
			render(
				<ConnectionStatusIndicator
					{...createProps({ connectionState: 'disconnected', error: longError })}
				/>
			);

			// Expand to see error
			const messageArea = screen.getByRole('button', { expanded: false });
			fireEvent.click(messageArea);

			// Error appears in both sub-message and details section
			const errorTexts = screen.getAllByText(longError);
			expect(errorTexts.length).toBeGreaterThanOrEqual(1);
		});

		it('handles special characters in error message', () => {
			render(
				<ConnectionStatusIndicator
					{...createProps({
						connectionState: 'disconnected',
						error: '<script>alert("xss")</script>',
					})}
				/>
			);

			const messageArea = screen.getByRole('button', { expanded: false });
			fireEvent.click(messageArea);

			// Error appears in both sub-message and details section
			const errorTexts = screen.getAllByText('<script>alert("xss")</script>');
			expect(errorTexts.length).toBeGreaterThanOrEqual(1);
		});

		it('handles unicode in error message', () => {
			render(
				<ConnectionStatusIndicator
					{...createProps({ connectionState: 'disconnected', error: '连接失败 🔌' })}
				/>
			);

			const messageArea = screen.getByRole('button', { expanded: false });
			fireEvent.click(messageArea);

			// Error appears in both sub-message and details section
			const errorTexts = screen.getAllByText('连接失败 🔌');
			expect(errorTexts.length).toBeGreaterThanOrEqual(1);
		});

		it('handles maxReconnectAttempts of 0', () => {
			render(
				<ConnectionStatusIndicator
					{...createProps({
						connectionState: 'disconnected',
						reconnectAttempts: 0,
						maxReconnectAttempts: 0,
					})}
				/>
			);
			expect(screen.getByText('Connection failed')).toBeInTheDocument();
		});

		it('handles reconnectAttempts exceeding maxReconnectAttempts', () => {
			render(
				<ConnectionStatusIndicator
					{...createProps({
						connectionState: 'disconnected',
						reconnectAttempts: 15,
						maxReconnectAttempts: 10,
					})}
				/>
			);
			expect(screen.getByText('Connection failed')).toBeInTheDocument();
		});

		it('handles negative reconnectAttempts gracefully', () => {
			render(
				<ConnectionStatusIndicator
					{...createProps({ connectionState: 'connecting', reconnectAttempts: -1 })}
				/>
			);
			// Negative reconnectAttempts is <= 0, so shows "Establishing connection..." (initial connection text)
			// because attemptText = reconnectAttempts > 0 ? `Attempt ${reconnectAttempts}...` : 'Establishing connection...'
			expect(screen.getByText('Establishing connection...')).toBeInTheDocument();
		});
	});

	describe('Default export', () => {
		it('exports ConnectionStatusIndicator as default', async () => {
			const module = await import('../../../web/mobile/ConnectionStatusIndicator');
			expect(module.default).toBe(module.ConnectionStatusIndicator);
		});
	});

	describe('Interaction scenarios', () => {
		it('handles rapid retry clicks', () => {
			const onRetry = vi.fn();
			render(
				<ConnectionStatusIndicator {...createProps({ connectionState: 'disconnected', onRetry })} />
			);

			const retryButton = screen.getByLabelText('Retry connection');
			fireEvent.click(retryButton);
			fireEvent.click(retryButton);
			fireEvent.click(retryButton);

			expect(onRetry).toHaveBeenCalledTimes(3);
			expect(mockTriggerHaptic).toHaveBeenCalledTimes(3);
		});

		it('handles state transitions from connected to disconnected', () => {
			const { rerender } = render(
				<ConnectionStatusIndicator {...createProps({ connectionState: 'connected' })} />
			);

			expect(screen.queryByRole('alert')).not.toBeInTheDocument();

			rerender(<ConnectionStatusIndicator {...createProps({ connectionState: 'disconnected' })} />);
			expect(screen.getByRole('alert')).toBeInTheDocument();
		});

		it('handles state transitions through connecting states', () => {
			const { rerender } = render(
				<ConnectionStatusIndicator {...createProps({ connectionState: 'disconnected' })} />
			);

			expect(screen.getByText('Disconnected')).toBeInTheDocument();

			rerender(
				<ConnectionStatusIndicator
					{...createProps({ connectionState: 'connecting', reconnectAttempts: 1 })}
				/>
			);
			expect(screen.getByText('Connecting...')).toBeInTheDocument();

			rerender(
				<ConnectionStatusIndicator
					{...createProps({ connectionState: 'authenticating', reconnectAttempts: 1 })}
				/>
			);
			expect(screen.getByText('Authenticating...')).toBeInTheDocument();

			rerender(
				<ConnectionStatusIndicator {...createProps({ connectionState: 'authenticated' })} />
			);
			expect(screen.queryByRole('alert')).not.toBeInTheDocument();
		});

		it('handles dismiss then state change to connecting', () => {
			const { container, rerender } = render(
				<ConnectionStatusIndicator {...createProps({ connectionState: 'disconnected' })} />
			);

			// Dismiss
			fireEvent.click(screen.getByLabelText('Dismiss notification'));
			expect(container.firstChild).toBeNull();

			// Change to connecting - should still show because connecting/authenticating ignore dismissed
			rerender(<ConnectionStatusIndicator {...createProps({ connectionState: 'connecting' })} />);
			expect(screen.getByRole('alert')).toBeInTheDocument();
		});
	});

	describe('Error display priority', () => {
		it('shows provided error over default sub-message', () => {
			render(
				<ConnectionStatusIndicator
					{...createProps({ connectionState: 'disconnected', error: 'Custom error' })}
				/>
			);
			expect(screen.getByText('Custom error')).toBeInTheDocument();
			expect(screen.queryByText('Tap retry to reconnect')).not.toBeInTheDocument();
		});

		it('shows max attempts message when at max attempts with error', () => {
			render(
				<ConnectionStatusIndicator
					{...createProps({
						connectionState: 'disconnected',
						reconnectAttempts: 10,
						maxReconnectAttempts: 10,
						error: 'Custom error',
					})}
				/>
			);
			// Error should override default sub-message
			expect(screen.getByText('Custom error')).toBeInTheDocument();
		});
	});
});
