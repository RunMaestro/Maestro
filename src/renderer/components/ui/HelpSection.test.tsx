import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { HelpSection } from './HelpSection';

describe('HelpSection', () => {
	it('preserves the heading hierarchy and feature-owned link content', () => {
		render(
			<HelpSection heading={<h3 className="font-bold">Getting Started</h3>}>
				<div className="text-sm space-y-2 pl-7">
					<a href="https://docs.runmaestro.ai/cue">Read the Cue guide</a>
				</div>
			</HelpSection>
		);

		expect(screen.getByRole('heading', { level: 3, name: 'Getting Started' })).toBeVisible();
		expect(screen.getByRole('link', { name: 'Read the Cue guide' })).toHaveAttribute(
			'href',
			'https://docs.runmaestro.ai/cue'
		);
	});
});
