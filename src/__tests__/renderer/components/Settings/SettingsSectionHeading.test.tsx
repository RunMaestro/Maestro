/**
 * SettingsSectionHeading - the canonical Settings section heading.
 *
 * These cover the two things the component owns that a caller used to get wrong
 * by hand: the single dimming channel on the label, and the gap between the
 * label and its intro paragraph.
 */

import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { Type } from 'lucide-react';
import { SettingsSectionHeading } from '../../../../renderer/components/Settings/SettingsSectionHeading';

describe('SettingsSectionHeading', () => {
	it('renders the label on the description dim scale with its icon', () => {
		const { container } = render(
			<SettingsSectionHeading icon={Type}>Fonts</SettingsSectionHeading>
		);

		const label = screen.getByText('Fonts');
		expect(label.className).toContain('opacity-70');
		expect(label.className).toContain('uppercase');
		expect(label.className).toContain('font-bold');
		// `block` and `flex` on one element contradict each other; the layout the
		// icon needs is the flex row, so that is the one that stays.
		expect(label.className).toContain('flex');
		expect(label.className).not.toContain('block');
		expect(container.querySelector('svg')).toBeInTheDocument();
	});

	it('reserves the heading-to-card gap when there is no description', () => {
		render(<SettingsSectionHeading icon={Type}>Fonts</SettingsSectionHeading>);

		expect(screen.getByText('Fonts').className).toContain('mb-2');
	});

	it('renders a description on the standard description scale', () => {
		render(
			<SettingsSectionHeading icon={Type} description="Interface is the proportional face.">
				Fonts
			</SettingsSectionHeading>
		);

		const description = screen.getByText('Interface is the proportional face.');
		expect(description.tagName).toBe('P');
		expect(description.className).toContain('text-xs');
		expect(description.className).toContain('opacity-70');
		expect(description.className).toContain('mb-2');
	});

	it('moves the bottom margin below the pair rather than clawing it back', () => {
		// The four sections that hand-rolled this paragraph each cancelled the
		// heading's own `mb-2` with a `-mt-1`. Owning both halves states the gap
		// once: the label tightens to `mb-1` and only the paragraph carries the
		// margin to the card below.
		render(
			<SettingsSectionHeading icon={Type} description="Scales every surface by the same amount.">
				Zoom
			</SettingsSectionHeading>
		);

		const label = screen.getByText('Zoom');
		expect(label.className).toContain('mb-1');
		expect(label.className).not.toContain('mb-2');
		expect(screen.getByText('Scales every surface by the same amount.').className).not.toContain(
			'-mt-'
		);
	});

	it('accepts a node description so state-dependent copy can be passed through', () => {
		render(
			<SettingsSectionHeading
				icon={Type}
				description={
					<>
						Set every font and size above at once. <strong>You are on Default.</strong>
					</>
				}
			>
				Factory Reset Fonts
			</SettingsSectionHeading>
		);

		expect(screen.getByText('You are on Default.')).toBeInTheDocument();
	});
});
