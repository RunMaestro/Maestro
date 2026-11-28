import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { FederationAutomationSection } from '../../../../renderer/components/Settings/FederationAutomationSection';
import { mockTheme } from '../../../helpers/mockTheme';
import { SETTINGS_METADATA } from '../../../../shared/settingsMetadata';

describe('FederationAutomationSection copy', () => {
	it('says, for each switch, that it is off by default and what it does to a remote', () => {
		render(<FederationAutomationSection theme={mockTheme} />);
		const hosted = screen.getByText(/connects to each SSH remote/);
		const autoMove = screen.getByText(/changes nothing on a remote unless you use Move to Host/);
		for (const description of [hosted, autoMove]) {
			expect(description.textContent).toMatch(/^Off by default: on, .+; off, .+\.$/);
		}
		expect(hosted.textContent).toContain('opens no connection to a remote on its own');
	});

	it('never suggests turning either switch on', () => {
		const { container } = render(<FederationAutomationSection theme={mockTheme} />);
		expect(container.textContent).not.toMatch(/turn (it|them|this|either|both)? ?on/i);
		for (const key of ['federationHostedAgents', 'federationAutoMove'] as const) {
			expect(SETTINGS_METADATA[key].description).toMatch(/off by default/);
			expect(SETTINGS_METADATA[key].description).not.toMatch(/turn (it|them)? ?on/i);
		}
	});
});
