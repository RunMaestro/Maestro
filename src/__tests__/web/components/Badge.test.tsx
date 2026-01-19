/**
 * Tests for Badge, StatusDot, and ModeBadge components
 *
 * Tests component behavior and user interactions.
 * Implementation details (exact colors, CSS classes) are not tested
 * as they're brittle and change during design iterations.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import React from 'react';
import { Badge, StatusDot, ModeBadge } from '../../../web/components/Badge';

// Mock the ThemeProvider
vi.mock('../../../web/components/ThemeProvider', () => ({
	useTheme: () => ({
		theme: {
			id: 'dracula',
			name: 'Dracula',
			mode: 'dark',
			colors: {
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
			},
		},
		isLight: false,
		isDark: true,
		isVibe: false,
		isDevicePreference: false,
	}),
	ThemeProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

describe('Badge Component', () => {
	afterEach(() => {
		cleanup();
	});

	describe('rendering', () => {
		it('renders with children text', () => {
			render(<Badge>Test Badge</Badge>);
			expect(screen.getByRole('status')).toBeInTheDocument();
			expect(screen.getByText('Test Badge')).toBeInTheDocument();
		});

		it('renders without children', () => {
			render(<Badge />);
			expect(screen.getByRole('status')).toBeInTheDocument();
		});

		it('passes through HTML attributes', () => {
			render(
				<Badge id="test-id" data-testid="test-badge" className="custom-class">
					Test
				</Badge>
			);
			const badge = screen.getByTestId('test-badge');
			expect(badge).toHaveAttribute('id', 'test-id');
			expect(badge.className).toContain('custom-class');
		});

		it('forwards ref to span element', () => {
			const ref = React.createRef<HTMLSpanElement>();
			render(<Badge ref={ref}>Ref Badge</Badge>);
			expect(ref.current).toBeInstanceOf(HTMLSpanElement);
		});
	});

	describe('variants', () => {
		it('renders all variants without error', () => {
			const variants = ['default', 'success', 'warning', 'error', 'info', 'connecting'] as const;
			variants.forEach((variant) => {
				render(<Badge variant={variant}>{variant}</Badge>);
				expect(screen.getByText(variant)).toBeInTheDocument();
				cleanup();
			});
		});

		it('handles unknown variant gracefully', () => {
			render(<Badge variant={'unknown' as any}>Unknown</Badge>);
			expect(screen.getByRole('status')).toBeInTheDocument();
		});
	});

	describe('badge styles', () => {
		it('renders all badge styles without error', () => {
			const styles = ['solid', 'outline', 'subtle', 'dot'] as const;
			styles.forEach((style) => {
				render(<Badge badgeStyle={style}>Test</Badge>);
				expect(screen.getByRole('status')).toBeInTheDocument();
				cleanup();
			});
		});

		it('dot style does not render children', () => {
			render(<Badge badgeStyle="dot">Should not appear</Badge>);
			expect(screen.queryByText('Should not appear')).not.toBeInTheDocument();
		});

		it('dot style does not render icon', () => {
			render(<Badge badgeStyle="dot" icon={<span data-testid="icon">I</span>} />);
			expect(screen.queryByTestId('icon')).not.toBeInTheDocument();
		});
	});

	describe('sizes', () => {
		it('renders all sizes without error', () => {
			const sizes = ['sm', 'md', 'lg'] as const;
			sizes.forEach((size) => {
				render(<Badge size={size}>Test</Badge>);
				expect(screen.getByRole('status')).toBeInTheDocument();
				cleanup();
			});
		});
	});

	describe('pulse animation', () => {
		it('applies pulse when prop is true', () => {
			render(<Badge pulse>Pulsing</Badge>);
			expect(screen.getByRole('status').className).toContain('animate-pulse');
		});

		it('connecting variant always pulses', () => {
			render(<Badge variant="connecting">Connecting</Badge>);
			expect(screen.getByRole('status').className).toContain('animate-pulse');
		});
	});

	describe('icon support', () => {
		it('renders icon with children', () => {
			render(<Badge icon={<span data-testid="icon">*</span>}>With Icon</Badge>);
			expect(screen.getByTestId('icon')).toBeInTheDocument();
			expect(screen.getByText('With Icon')).toBeInTheDocument();
		});
	});

	describe('accessibility', () => {
		it('has role="status" by default', () => {
			render(<Badge>Status</Badge>);
			expect(screen.getByRole('status')).toBeInTheDocument();
		});

		it('supports custom role', () => {
			render(<Badge role="alert">Alert</Badge>);
			expect(screen.getByRole('alert')).toBeInTheDocument();
		});

		it('supports aria-label', () => {
			render(<Badge aria-label="Custom label">Badge</Badge>);
			expect(screen.getByLabelText('Custom label')).toBeInTheDocument();
		});
	});
});

describe('StatusDot Component', () => {
	afterEach(() => {
		cleanup();
	});

	it('renders for all status values', () => {
		const statuses = ['idle', 'busy', 'error', 'connecting'] as const;
		statuses.forEach((status) => {
			render(<StatusDot status={status} />);
			expect(screen.getByRole('status')).toBeInTheDocument();
			cleanup();
		});
	});

	it('pulses for connecting status', () => {
		render(<StatusDot status="connecting" />);
		expect(screen.getByRole('status').className).toContain('animate-pulse');
	});

	it('does not pulse for other statuses', () => {
		render(<StatusDot status="idle" />);
		expect(screen.getByRole('status').className).not.toContain('animate-pulse');
	});

	it('forwards ref', () => {
		const ref = React.createRef<HTMLSpanElement>();
		render(<StatusDot ref={ref} status="idle" />);
		expect(ref.current).toBeInstanceOf(HTMLSpanElement);
	});

	it('passes through props', () => {
		render(<StatusDot status="idle" className="custom" data-testid="dot" />);
		const dot = screen.getByTestId('dot');
		expect(dot.className).toContain('custom');
	});
});

describe('ModeBadge Component', () => {
	afterEach(() => {
		cleanup();
	});

	it('displays correct text for each mode', () => {
		render(<ModeBadge mode="ai" />);
		expect(screen.getByText('AI')).toBeInTheDocument();
		cleanup();

		render(<ModeBadge mode="terminal" />);
		expect(screen.getByText('Terminal')).toBeInTheDocument();
	});

	it('forwards ref', () => {
		const ref = React.createRef<HTMLSpanElement>();
		render(<ModeBadge ref={ref} mode="ai" />);
		expect(ref.current).toBeInstanceOf(HTMLSpanElement);
	});

	it('supports custom props', () => {
		render(<ModeBadge mode="ai" pulse className="custom" />);
		const badge = screen.getByRole('status');
		expect(badge.className).toContain('animate-pulse');
		expect(badge.className).toContain('custom');
	});

	it('supports icon prop', () => {
		render(<ModeBadge mode="ai" icon={<span data-testid="mode-icon">*</span>} />);
		expect(screen.getByTestId('mode-icon')).toBeInTheDocument();
	});
});

describe('Component Integration', () => {
	afterEach(() => {
		cleanup();
	});

	it('all components render together without conflict', () => {
		render(
			<div>
				<Badge variant="warning">Label</Badge>
				<StatusDot status="connecting" />
				<ModeBadge mode="ai" />
			</div>
		);
		expect(screen.getAllByRole('status')).toHaveLength(3);
	});
});
