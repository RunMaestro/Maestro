/**
 * @file PianolaTabControls.test.tsx
 * @description Behavior tests for Pianola's pinned Dashboard TabBar control
 * `PianolaDashboardTab`: its pressed state tracks `active`, and its
 * needs-input badge appears only for a positive count. lucide-react is
 * auto-mocked in `src/__tests__/setup.ts`.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { Theme } from '../../../../renderer/types';
import { PianolaDashboardTab } from '../../../../renderer/components/PianolaDashboard/PianolaTabControls';

// Minimal stub — only the color keys the two controls read. Cast like other
// renderer tests (see PianolaDashboard.test.tsx) rather than spelling out the
// full Theme/ThemeColors shape.
const theme = {
	colors: {
		accent: '#7b2cbf',
		accentForeground: '#0d0d17',
		textDim: '#888888',
		warning: '#f59e0b',
	},
} as unknown as Theme;

describe('PianolaDashboardTab', () => {
	it('renders the Dashboard label under its testid', () => {
		render(
			<PianolaDashboardTab theme={theme} active={false} needsInputCount={0} onClick={vi.fn()} />
		);

		const button = screen.getByTestId('pianola-tab-dashboard');
		expect(button).toBeInTheDocument();
		expect(screen.getByText('Dashboard')).toBeInTheDocument();
	});

	it.each([
		[true, 'true'],
		[false, 'false'],
	])('reflects active=%s as aria-pressed="%s"', (active, expected) => {
		render(
			<PianolaDashboardTab theme={theme} active={active} needsInputCount={0} onClick={vi.fn()} />
		);

		expect(screen.getByTestId('pianola-tab-dashboard')).toHaveAttribute('aria-pressed', expected);
	});

	it('shows the numeric badge when needsInputCount is positive', () => {
		render(
			<PianolaDashboardTab theme={theme} active={false} needsInputCount={3} onClick={vi.fn()} />
		);

		expect(screen.getByText('3')).toBeInTheDocument();
	});

	it('omits the badge when needsInputCount is zero', () => {
		render(
			<PianolaDashboardTab theme={theme} active={false} needsInputCount={0} onClick={vi.fn()} />
		);

		// A dropped `> 0` guard would render the literal count ("0"); it must not.
		expect(screen.queryByText('0')).not.toBeInTheDocument();
	});

	it('fires onClick once when clicked', () => {
		const onClick = vi.fn();
		render(
			<PianolaDashboardTab theme={theme} active={false} needsInputCount={0} onClick={onClick} />
		);

		fireEvent.click(screen.getByTestId('pianola-tab-dashboard'));
		expect(onClick).toHaveBeenCalledTimes(1);
	});
});
