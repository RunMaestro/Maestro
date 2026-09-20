/**
 * The ERR badge is the only thing that tells a user a long unattended Auto Run
 * has stopped, so what it must get right is the DISTINCTION it draws: whether
 * another automatic resume is still coming (leave it alone) or the run is
 * waiting on a person (go and click Resume). Getting that backwards is worse
 * than no badge, because it teaches the user to ignore a real stall.
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AutoRunErrorBadge } from '../../../renderer/components/SessionList/AutoRunErrorBadge';

describe('AutoRunErrorBadge', () => {
	it('renders nothing while the run is healthy', () => {
		const { container } = render(<AutoRunErrorBadge errorPaused={false} />);
		expect(container).toBeEmptyDOMElement();
	});

	it('appears as soon as the run is error-paused', () => {
		render(<AutoRunErrorBadge errorPaused />);
		expect(screen.getByText('ERR')).toBeInTheDocument();
	});

	it('says a resume is coming, and when, while one is scheduled', () => {
		render(
			<AutoRunErrorBadge
				errorPaused
				attempts={2}
				maxAttempts={5}
				nextResumeAt={Date.now() + 5 * 60_000}
			/>
		);
		const badge = screen.getByText('ERR');
		expect(badge.getAttribute('title')).toContain('resuming in about 5 minutes');
		expect(badge.getAttribute('title')).toContain('2 of 5');
	});

	it('asks for a human once the attempts are spent', () => {
		render(
			<AutoRunErrorBadge errorPaused attempts={5} maxAttempts={5} nextResumeAt={null} exhausted />
		);
		const badge = screen.getByText('ERR');
		expect(badge.getAttribute('title')).toContain('gave up after 5');
		expect(badge.getAttribute('title')).toContain('Resume it yourself');
	});

	it('asks for a human when the run turned auto-resume off entirely', () => {
		// No entry at all: nothing is scheduled and nothing will be.
		render(<AutoRunErrorBadge errorPaused />);
		expect(screen.getByText('ERR').getAttribute('title')).toContain('paused until you resume it');
	});

	it('pulses only when the run needs attention, not while it is retrying', () => {
		const { rerender } = render(
			<AutoRunErrorBadge errorPaused nextResumeAt={Date.now() + 60_000} />
		);
		expect(screen.getByText('ERR').className).not.toContain('animate-pulse');

		rerender(<AutoRunErrorBadge errorPaused exhausted maxAttempts={5} nextResumeAt={null} />);
		expect(screen.getByText('ERR').className).toContain('animate-pulse');
	});

	it('never shows a countdown below one minute', () => {
		// Rounding a nearly-elapsed wait to "in about 0 minutes" reads as broken.
		render(<AutoRunErrorBadge errorPaused nextResumeAt={Date.now() + 500} />);
		expect(screen.getByText('ERR').getAttribute('title')).toContain('about 1 minute');
	});
});
