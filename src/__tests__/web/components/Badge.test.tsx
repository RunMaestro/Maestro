/**
 * Tests for Badge, StatusDot, and ModeBadge components
 *
 * Tests component behavior and user interactions. Tailwind class-name
 * containment is asserted where we need to prove the variant/style/size
 * resolution still picks the right token (jsdom doesn't compute Tailwind
 * classes, so we can't assert real CSS values).
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import React from 'react';
import { Badge, StatusDot, ModeBadge } from '../../../web/components/Badge';

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

		it('applies base layout classes on non-dot badges', () => {
			render(<Badge data-testid="b">Test</Badge>);
			const badge = screen.getByTestId('b');
			expect(badge.className).toContain('inline-flex');
			expect(badge.className).toContain('items-center');
			expect(badge.className).toContain('font-medium');
			expect(badge.className).toContain('whitespace-nowrap');
			expect(badge.className).toContain('leading-none');
		});

		it('passes through user style prop', () => {
			render(
				<Badge data-testid="b" style={{ marginTop: '10px' }}>
					Test
				</Badge>
			);
			const badge = screen.getByTestId('b');
			expect(badge.style.marginTop).toBe('10px');
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

		it('applies success tokens for success variant (subtle default)', () => {
			render(
				<Badge variant="success" data-testid="b">
					Ready
				</Badge>
			);
			const badge = screen.getByTestId('b');
			// subtle style uses color-mix for bg and text-<variant> for text
			expect(badge.className).toContain('text-success');
			expect(badge.className).toContain('color-mix');
		});

		it('applies connecting tokens for connecting variant', () => {
			render(
				<Badge variant="connecting" data-testid="b">
					Connecting
				</Badge>
			);
			const badge = screen.getByTestId('b');
			expect(badge.className).toContain('text-connecting');
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

		it('solid style applies bg + text-white', () => {
			render(
				<Badge variant="success" badgeStyle="solid" data-testid="b">
					Ready
				</Badge>
			);
			const badge = screen.getByTestId('b');
			expect(badge.className).toContain('bg-success');
			expect(badge.className).toContain('text-white');
		});

		it('outline style applies transparent bg + variant text + variant border', () => {
			render(
				<Badge variant="error" badgeStyle="outline" data-testid="b">
					Fail
				</Badge>
			);
			const badge = screen.getByTestId('b');
			expect(badge.className).toContain('bg-transparent');
			expect(badge.className).toContain('text-error');
			expect(badge.className).toContain('border-error');
		});

		it('dot style applies rounded-full + variant bg', () => {
			render(<Badge variant="warning" badgeStyle="dot" data-testid="b" />);
			const badge = screen.getByTestId('b');
			expect(badge.className).toContain('rounded-full');
			expect(badge.className).toContain('bg-warning');
			expect(badge.className).toContain('inline-block');
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

		it('applies correct size class for sm (non-dot)', () => {
			render(
				<Badge size="sm" data-testid="b">
					X
				</Badge>
			);
			const badge = screen.getByTestId('b');
			expect(badge.className).toContain('px-1.5');
			expect(badge.className).toContain('text-xs');
			expect(badge.className).toContain('rounded');
		});

		it('applies correct size class for md (non-dot)', () => {
			render(
				<Badge size="md" data-testid="b">
					X
				</Badge>
			);
			const badge = screen.getByTestId('b');
			expect(badge.className).toContain('px-2');
			expect(badge.className).toContain('text-sm');
			expect(badge.className).toContain('rounded-md');
		});

		it('applies correct size class for lg (non-dot)', () => {
			render(
				<Badge size="lg" data-testid="b">
					X
				</Badge>
			);
			const badge = screen.getByTestId('b');
			expect(badge.className).toContain('px-2.5');
			expect(badge.className).toContain('text-base');
			expect(badge.className).toContain('rounded-lg');
		});

		it('applies correct dot dimensions for sm', () => {
			render(<Badge size="sm" badgeStyle="dot" data-testid="b" />);
			const badge = screen.getByTestId('b');
			expect(badge.className).toContain('w-1.5');
			expect(badge.className).toContain('h-1.5');
		});

		it('applies correct dot dimensions for md', () => {
			render(<Badge size="md" badgeStyle="dot" data-testid="b" />);
			const badge = screen.getByTestId('b');
			expect(badge.className).toContain('w-2');
			expect(badge.className).toContain('h-2');
		});

		it('applies correct dot dimensions for lg', () => {
			render(<Badge size="lg" badgeStyle="dot" data-testid="b" />);
			const badge = screen.getByTestId('b');
			expect(badge.className).toContain('w-2.5');
			expect(badge.className).toContain('h-2.5');
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

		it('does not pulse by default', () => {
			render(<Badge>Static</Badge>);
			expect(screen.getByRole('status').className).not.toContain('animate-pulse');
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

		it('dot badge exposes variant as implicit aria-label when non-default', () => {
			render(<Badge variant="success" badgeStyle="dot" data-testid="b" />);
			const badge = screen.getByTestId('b');
			expect(badge).toHaveAttribute('aria-label', 'success');
		});

		it('user aria-label wins over implicit variant label on dot badge', () => {
			render(<Badge variant="success" badgeStyle="dot" aria-label="Custom" data-testid="b" />);
			const badge = screen.getByTestId('b');
			expect(badge).toHaveAttribute('aria-label', 'Custom');
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

	it('uses dot styling (rounded-full + inline-block)', () => {
		render(<StatusDot status="idle" data-testid="dot" />);
		const dot = screen.getByTestId('dot');
		expect(dot.className).toContain('rounded-full');
		expect(dot.className).toContain('inline-block');
	});

	it('maps idle → success color', () => {
		render(<StatusDot status="idle" data-testid="dot" />);
		expect(screen.getByTestId('dot').className).toContain('bg-success');
	});

	it('maps busy → warning color', () => {
		render(<StatusDot status="busy" data-testid="dot" />);
		expect(screen.getByTestId('dot').className).toContain('bg-warning');
	});

	it('maps error → error color', () => {
		render(<StatusDot status="error" data-testid="dot" />);
		expect(screen.getByTestId('dot').className).toContain('bg-error');
	});

	it('maps connecting → connecting color', () => {
		render(<StatusDot status="connecting" data-testid="dot" />);
		expect(screen.getByTestId('dot').className).toContain('bg-connecting');
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

	it('defaults to outline style (bg-transparent + border)', () => {
		render(<ModeBadge mode="ai" data-testid="m" />);
		const badge = screen.getByTestId('m');
		expect(badge.className).toContain('bg-transparent');
		expect(badge.className).toContain('border-accent');
	});

	it('ai mode uses accent (info variant)', () => {
		render(<ModeBadge mode="ai" data-testid="m" />);
		expect(screen.getByTestId('m').className).toContain('text-accent');
	});

	it('terminal mode uses text-dim (default variant)', () => {
		render(<ModeBadge mode="terminal" data-testid="m" />);
		expect(screen.getByTestId('m').className).toContain('text-text-dim');
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
