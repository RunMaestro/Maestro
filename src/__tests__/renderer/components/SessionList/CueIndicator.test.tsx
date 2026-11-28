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

	// A running Cue is a static glow, never a looping animation: one infinite
	// pulse per row kept the renderer drawing every frame while idle.
	it('glows the Zap without animating when activeRun is true', () => {
		const { container } = render(<CueIndicator subscriptionCount={1} activeRun={true} />);
		expect(container.querySelector('[class*="animate-"]')).toBeNull();
		expect(screen.getByTestId('icon-zap').style.filter).toContain('drop-shadow');
	});

	it('draws no glow when activeRun is false', () => {
		const { container } = render(<CueIndicator subscriptionCount={1} activeRun={false} />);
		expect(container.querySelector('[class*="animate-"]')).toBeNull();
		expect(screen.getByTestId('icon-zap').style.filter).toBe('');
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
});
