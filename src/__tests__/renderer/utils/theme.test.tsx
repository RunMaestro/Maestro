/**
 * Tests for src/renderer/utils/theme.tsx
 *
 * Tests theme-related utility functions:
 * - getContextColor: Returns color based on context usage percentage
 * - getStatusColor: Returns color based on session state
 * - formatActiveTime: Formats milliseconds to display string
 * - getFileIcon: Returns file icon based on change type
 */

import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import {
	getContextColor,
	getStatusColor,
	formatActiveTime,
	getFileIcon,
} from '../../../renderer/utils/theme';
import type { Theme, SessionState, FileChangeType } from '../../../renderer/types';

// Mock theme with known colors for testing
const mockTheme: Theme = {
	id: 'test-theme',
	name: 'Test Theme',
	mode: 'dark',
	colors: {
		background: '#1a1a1a',
		backgroundDim: '#0d0d0d',
		backgroundBright: '#2a2a2a',
		textMain: '#ffffff',
		textDim: '#888888',
		textMuted: '#666666',
		textBright: '#ffffff',
		border: '#333333',
		borderBright: '#444444',
		success: '#00ff00',
		warning: '#ffff00',
		error: '#ff0000',
	},
};

// Alternative theme for testing that theme colors are used correctly
const alternativeTheme: Theme = {
	id: 'alt-theme',
	name: 'Alternative Theme',
	mode: 'light',
	colors: {
		background: '#ffffff',
		backgroundDim: '#f0f0f0',
		backgroundBright: '#ffffff',
		textMain: '#000000',
		textDim: '#444444',
		textMuted: '#666666',
		textBright: '#000000',
		border: '#cccccc',
		borderBright: '#aaaaaa',
		success: '#22c55e',
		warning: '#f59e0b',
		error: '#ef4444',
	},
};

describe('theme utilities', () => {
	// ============================================================================
	// getContextColor tests
	// ============================================================================
	describe('getContextColor', () => {
		describe('success color (usage < 60%)', () => {
			it('returns success color when usage is 0%', () => {
				expect(getContextColor(0, mockTheme)).toBe(mockTheme.colors.success);
			});

			it('returns success color when usage is 30%', () => {
				expect(getContextColor(30, mockTheme)).toBe(mockTheme.colors.success);
			});

			it('returns success color when usage is 59%', () => {
				expect(getContextColor(59, mockTheme)).toBe(mockTheme.colors.success);
			});

			it('returns success color at boundary 59.99%', () => {
				expect(getContextColor(59.99, mockTheme)).toBe(mockTheme.colors.success);
			});
		});

		describe('warning color (60% <= usage < 80%)', () => {
			it('returns warning color when usage is exactly 60%', () => {
				expect(getContextColor(60, mockTheme)).toBe(mockTheme.colors.warning);
			});

			it('returns warning color when usage is 70%', () => {
				expect(getContextColor(70, mockTheme)).toBe(mockTheme.colors.warning);
			});

			it('returns warning color when usage is 79%', () => {
				expect(getContextColor(79, mockTheme)).toBe(mockTheme.colors.warning);
			});

			it('returns warning color at boundary 79.99%', () => {
				expect(getContextColor(79.99, mockTheme)).toBe(mockTheme.colors.warning);
			});
		});

		describe('error color (usage >= 80%)', () => {
			it('returns error color when usage is exactly 80%', () => {
				expect(getContextColor(80, mockTheme)).toBe(mockTheme.colors.error);
			});

			it('returns error color when usage is 90%', () => {
				expect(getContextColor(90, mockTheme)).toBe(mockTheme.colors.error);
			});

			it('returns error color when usage is 100%', () => {
				expect(getContextColor(100, mockTheme)).toBe(mockTheme.colors.error);
			});

			it('returns error color at boundary 80.01%', () => {
				expect(getContextColor(80.01, mockTheme)).toBe(mockTheme.colors.error);
			});
		});

		describe('uses correct theme colors', () => {
			it('uses alternative theme success color', () => {
				expect(getContextColor(50, alternativeTheme)).toBe(alternativeTheme.colors.success);
			});

			it('uses alternative theme warning color', () => {
				expect(getContextColor(70, alternativeTheme)).toBe(alternativeTheme.colors.warning);
			});

			it('uses alternative theme error color', () => {
				expect(getContextColor(90, alternativeTheme)).toBe(alternativeTheme.colors.error);
			});
		});
	});

	// ============================================================================
	// getStatusColor tests
	// ============================================================================
	describe('getStatusColor', () => {
		describe('known session states', () => {
			it('returns success color for idle state', () => {
				expect(getStatusColor('idle', mockTheme)).toBe(mockTheme.colors.success);
			});

			it('returns warning color for busy state', () => {
				expect(getStatusColor('busy', mockTheme)).toBe(mockTheme.colors.warning);
			});

			it('returns warning color for waiting_input state', () => {
				expect(getStatusColor('waiting_input', mockTheme)).toBe(mockTheme.colors.warning);
			});

			it('returns error color for error state', () => {
				expect(getStatusColor('error', mockTheme)).toBe(mockTheme.colors.error);
			});

			it('returns hardcoded orange (#ff8800) for connecting state', () => {
				expect(getStatusColor('connecting', mockTheme)).toBe('#ff8800');
			});
		});

		describe('default case', () => {
			it('returns success color for unknown state', () => {
				// Cast to SessionState to test default branch
				const unknownState = 'unknown' as SessionState;
				expect(getStatusColor(unknownState, mockTheme)).toBe(mockTheme.colors.success);
			});
		});

		describe('uses correct theme colors', () => {
			it('uses alternative theme success color for idle', () => {
				expect(getStatusColor('idle', alternativeTheme)).toBe(alternativeTheme.colors.success);
			});

			it('uses alternative theme warning color for busy', () => {
				expect(getStatusColor('busy', alternativeTheme)).toBe(alternativeTheme.colors.warning);
			});

			it('uses alternative theme error color for error', () => {
				expect(getStatusColor('error', alternativeTheme)).toBe(alternativeTheme.colors.error);
			});

			it('connecting state uses hardcoded orange regardless of theme', () => {
				expect(getStatusColor('connecting', alternativeTheme)).toBe('#ff8800');
			});
		});
	});

	// ============================================================================
	// formatActiveTime tests
	// ============================================================================
	describe('formatActiveTime', () => {
		// Time constants for clarity
		const SECOND = 1000;
		const MINUTE = 60 * SECOND;
		const HOUR = 60 * MINUTE;
		const DAY = 24 * HOUR;

		describe('less than 1 minute', () => {
			it('returns "<1M" for 0 milliseconds', () => {
				expect(formatActiveTime(0)).toBe('<1M');
			});

			it('returns "<1M" for 500 milliseconds', () => {
				expect(formatActiveTime(500)).toBe('<1M');
			});

			it('returns "<1M" for 30 seconds', () => {
				expect(formatActiveTime(30 * SECOND)).toBe('<1M');
			});

			it('returns "<1M" for 59 seconds', () => {
				expect(formatActiveTime(59 * SECOND)).toBe('<1M');
			});

			it('returns "<1M" for 59.9 seconds', () => {
				expect(formatActiveTime(59.9 * SECOND)).toBe('<1M');
			});
		});

		describe('minutes only (1-59 minutes)', () => {
			it('returns "1M" for exactly 1 minute', () => {
				expect(formatActiveTime(1 * MINUTE)).toBe('1M');
			});

			it('returns "1M" for 1 minute 30 seconds', () => {
				expect(formatActiveTime(1.5 * MINUTE)).toBe('1M');
			});

			it('returns "15M" for 15 minutes', () => {
				expect(formatActiveTime(15 * MINUTE)).toBe('15M');
			});

			it('returns "30M" for 30 minutes', () => {
				expect(formatActiveTime(30 * MINUTE)).toBe('30M');
			});

			it('returns "59M" for 59 minutes', () => {
				expect(formatActiveTime(59 * MINUTE)).toBe('59M');
			});

			it('returns "59M" for 59 minutes 59 seconds', () => {
				expect(formatActiveTime(59 * MINUTE + 59 * SECOND)).toBe('59M');
			});
		});

		describe('hours only (exact hours)', () => {
			it('returns "1H" for exactly 1 hour', () => {
				expect(formatActiveTime(1 * HOUR)).toBe('1H');
			});

			it('returns "2H" for exactly 2 hours', () => {
				expect(formatActiveTime(2 * HOUR)).toBe('2H');
			});

			it('returns "12H" for 12 hours', () => {
				expect(formatActiveTime(12 * HOUR)).toBe('12H');
			});

			it('returns "23H" for 23 hours', () => {
				expect(formatActiveTime(23 * HOUR)).toBe('23H');
			});
		});

		describe('hours with remaining minutes', () => {
			it('returns "1H 1M" for 1 hour 1 minute', () => {
				expect(formatActiveTime(1 * HOUR + 1 * MINUTE)).toBe('1H 1M');
			});

			it('returns "1H 30M" for 1 hour 30 minutes', () => {
				expect(formatActiveTime(1 * HOUR + 30 * MINUTE)).toBe('1H 30M');
			});

			it('returns "2H 15M" for 2 hours 15 minutes', () => {
				expect(formatActiveTime(2 * HOUR + 15 * MINUTE)).toBe('2H 15M');
			});

			it('returns "5H 45M" for 5 hours 45 minutes', () => {
				expect(formatActiveTime(5 * HOUR + 45 * MINUTE)).toBe('5H 45M');
			});

			it('returns "23H 59M" for 23 hours 59 minutes', () => {
				expect(formatActiveTime(23 * HOUR + 59 * MINUTE)).toBe('23H 59M');
			});

			it('ignores seconds when displaying hours and minutes', () => {
				expect(formatActiveTime(1 * HOUR + 30 * MINUTE + 45 * SECOND)).toBe('1H 30M');
			});
		});

		describe('days', () => {
			it('returns "1D" for exactly 1 day', () => {
				expect(formatActiveTime(1 * DAY)).toBe('1D');
			});

			it('returns "1D" for 1 day 12 hours (truncates to days)', () => {
				expect(formatActiveTime(1 * DAY + 12 * HOUR)).toBe('1D');
			});

			it('returns "2D" for 2 days', () => {
				expect(formatActiveTime(2 * DAY)).toBe('2D');
			});

			it('returns "7D" for 7 days', () => {
				expect(formatActiveTime(7 * DAY)).toBe('7D');
			});

			it('returns "30D" for 30 days', () => {
				expect(formatActiveTime(30 * DAY)).toBe('30D');
			});

			it('returns "365D" for 1 year', () => {
				expect(formatActiveTime(365 * DAY)).toBe('365D');
			});
		});

		describe('edge cases', () => {
			it('handles very large values', () => {
				// 1000 days
				expect(formatActiveTime(1000 * DAY)).toBe('1000D');
			});
		});
	});

	// ============================================================================
	// getFileIcon tests
	// ============================================================================
	describe('getFileIcon', () => {
		describe('added file type', () => {
			it('returns an icon element for added file type', () => {
				const icon = getFileIcon('added', mockTheme);
				const { container } = render(icon);
				const svg = container.querySelector('svg');
				expect(svg).toBeInTheDocument();
			});

			it('applies success color to added file icon', () => {
				const icon = getFileIcon('added', mockTheme);
				const { container } = render(icon);
				const svg = container.querySelector('svg');
				expect(svg).toHaveStyle({ color: mockTheme.colors.success });
			});

			it('uses alternative theme success color', () => {
				const icon = getFileIcon('added', alternativeTheme);
				const { container } = render(icon);
				const svg = container.querySelector('svg');
				expect(svg).toHaveStyle({ color: alternativeTheme.colors.success });
			});
		});

		describe('deleted file type', () => {
			it('returns an icon element for deleted file type', () => {
				const icon = getFileIcon('deleted', mockTheme);
				const { container } = render(icon);
				const svg = container.querySelector('svg');
				expect(svg).toBeInTheDocument();
			});

			it('applies error color to deleted file icon', () => {
				const icon = getFileIcon('deleted', mockTheme);
				const { container } = render(icon);
				const svg = container.querySelector('svg');
				expect(svg).toHaveStyle({ color: mockTheme.colors.error });
			});

			it('uses alternative theme error color', () => {
				const icon = getFileIcon('deleted', alternativeTheme);
				const { container } = render(icon);
				const svg = container.querySelector('svg');
				expect(svg).toHaveStyle({ color: alternativeTheme.colors.error });
			});
		});

		describe('modified file type', () => {
			it('returns an icon element for modified file type', () => {
				const icon = getFileIcon('modified', mockTheme);
				const { container } = render(icon);
				const svg = container.querySelector('svg');
				expect(svg).toBeInTheDocument();
			});

			it('applies warning color to modified file icon', () => {
				const icon = getFileIcon('modified', mockTheme);
				const { container } = render(icon);
				const svg = container.querySelector('svg');
				expect(svg).toHaveStyle({ color: mockTheme.colors.warning });
			});

			it('uses alternative theme warning color', () => {
				const icon = getFileIcon('modified', alternativeTheme);
				const { container } = render(icon);
				const svg = container.querySelector('svg');
				expect(svg).toHaveStyle({ color: alternativeTheme.colors.warning });
			});
		});

		describe('undefined file type (default)', () => {
			it('returns an icon element for undefined file type', () => {
				const icon = getFileIcon(undefined, mockTheme);
				const { container } = render(icon);
				const svg = container.querySelector('svg');
				expect(svg).toBeInTheDocument();
			});

			it('applies textDim color to undefined file type icon', () => {
				const icon = getFileIcon(undefined, mockTheme);
				const { container } = render(icon);
				const svg = container.querySelector('svg');
				expect(svg).toHaveStyle({ color: mockTheme.colors.textDim });
			});

			it('uses alternative theme textDim color', () => {
				const icon = getFileIcon(undefined, alternativeTheme);
				const { container } = render(icon);
				const svg = container.querySelector('svg');
				expect(svg).toHaveStyle({ color: alternativeTheme.colors.textDim });
			});
		});

		describe('icon styling', () => {
			it('all icons have consistent sizing classes', () => {
				const types: (FileChangeType | undefined)[] = ['added', 'deleted', 'modified', undefined];

				types.forEach((type) => {
					const icon = getFileIcon(type, mockTheme);
					const { container } = render(icon);
					const svg = container.querySelector('svg');
					expect(svg).toHaveClass('w-3.5', 'h-3.5');
				});
			});
		});

		describe('unknown file type', () => {
			it('treats unknown file type as default (textDim color)', () => {
				// Cast to test the default case with an invalid type
				const unknownType = 'unknown' as FileChangeType;
				const icon = getFileIcon(unknownType, mockTheme);
				const { container } = render(icon);
				const svg = container.querySelector('svg');
				expect(svg).toHaveStyle({ color: mockTheme.colors.textDim });
			});
		});
	});
});
