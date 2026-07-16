import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ConcertoHtmlPreview } from '../../../../renderer/components/Concerto/ConcertoHtmlPreview';

describe('ConcertoHtmlPreview', () => {
	it('loads the dedicated document protocol in an isolated iframe', () => {
		render(
			<ConcertoHtmlPreview
				surface="movement"
				id="checkout/mockup"
				revision={42}
				title="Checkout mockup"
			/>
		);

		const iframe = screen.getByTitle('Checkout mockup');
		expect(iframe).toHaveAttribute('sandbox', 'allow-scripts');
		expect(iframe.getAttribute('sandbox')).not.toContain('allow-same-origin');
		expect(iframe).toHaveAttribute('referrerpolicy', 'no-referrer');
		expect(iframe.getAttribute('src')).toBe(
			'maestro-concerto://render/?surface=movement&id=checkout%2Fmockup&revision=42'
		);
		expect(iframe).not.toHaveAttribute('srcdoc');
		expect(iframe).toHaveAttribute('data-concerto-surface', 'movement');
		expect(iframe).toHaveAttribute('data-concerto-id', 'checkout/mockup');
	});
});
