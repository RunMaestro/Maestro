/**
 * Tests for {@link CueIndicator} - the Maestro Cue pill rendered next to a
 * session name when the session has registered subscriptions. Extracted from
 * SessionItem in Tier 3.3 so the icon can be memoized independently of the
 * row.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CueIndicator } from '../../../../renderer/components/SessionList/CueIndicator';

// Mock lucide-react so we can assert on the Zap icon by test id rather than
// rendering the real SVG (matches the SessionList.test.tsx pattern).
vi.mock('lucide-react', () => ({
	Zap: ({ className, style, fill }: { className?: string; style?: object; fill?: string }) => (
		<span data-testid="icon-zap" className={className} data-fill={fill} style={style} />
	),
}));

describe('CueIndicator', () => {
	it('renders nothing when subscriptionCount is 0', () => {
		const { container } = render(<CueIndicator subscriptionCount={0} activeRun={false} />);
		expect(container.firstChild).toBeNull();
		expect(screen.queryByTestId('icon-zap')).toBeNull();
	});

	it('renders nothing when subscriptionCount is negative (defensive)', () => {
		const { container } = render(<CueIndicator subscriptionCount={-1} activeRun={false} />);
		expect(container.firstChild).toBeNull();
	});

	it('renders the Zap icon when subscriptionCount is positive', () => {
		render(<CueIndicator subscriptionCount={1} activeRun={false} />);
		expect(screen.getByTestId('icon-zap')).toBeInTheDocument();
	});

	it('adds animate-pulse class when activeRun is true', () => {
		const { container } = render(<CueIndicator subscriptionCount={1} activeRun={true} />);
		const wrapper = container.querySelector('span');
		expect(wrapper?.className).toMatch(/animate-pulse/);
	});

	it('omits animate-pulse class when activeRun is false', () => {
		const { container } = render(<CueIndicator subscriptionCount={1} activeRun={false} />);
		const wrapper = container.querySelector('span');
		expect(wrapper?.className).not.toMatch(/animate-pulse/);
	});

	it('tooltip uses singular "subscription" for count of 1 and "active" when not running', () => {
		render(<CueIndicator subscriptionCount={1} activeRun={false} />);
		const wrapper = screen.getByTitle(/Maestro Cue/);
		expect(wrapper.getAttribute('title')).toBe('Maestro Cue active (1 subscription)');
	});

	it('tooltip uses plural "subscriptions" for count > 1 and "running" when active', () => {
		render(<CueIndicator subscriptionCount={3} activeRun={true} />);
		const wrapper = screen.getByTitle(/Maestro Cue/);
		expect(wrapper.getAttribute('title')).toBe('Maestro Cue running (3 subscriptions)');
	});

	it('turns the zap red and says so in the tooltip when subscriptions are failing', () => {
		render(<CueIndicator subscriptionCount={3} activeRun={false} failingCount={1} />);
		const zap = screen.getByTestId('icon-zap');
		expect(zap.getAttribute('data-fill')).toBe('#ef4444');
		expect(zap).toHaveStyle({ color: '#ef4444' });
		expect(screen.getByTestId('cue-indicator-failing').getAttribute('title')).toBe(
			'Maestro Cue: 1 of 3 subscriptions failing - open the Cue dashboard to see which'
		);
	});

	it('stays teal when nothing is failing', () => {
		render(<CueIndicator subscriptionCount={2} activeRun={false} failingCount={0} />);
		expect(screen.getByTestId('icon-zap').getAttribute('data-fill')).toBe('#2dd4bf');
		expect(screen.queryByTestId('cue-indicator-failing')).toBeNull();
	});
});
