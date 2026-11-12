import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { PlaybookTile } from '../../../../../renderer/components/MarketplaceModal/components';
import type { PlaybookLaunchSpec } from '../../../../../shared/marketplace-types';
import { makePlaybook, mockTheme } from '../_fixtures';

const launchSpec = (overrides: Partial<PlaybookLaunchSpec> = {}): PlaybookLaunchSpec => ({
	inputs: [],
	outro: { summary: 'Done.', nextSteps: [] },
	...overrides,
});

function renderTile(playbook = makePlaybook(), runningVersion = '1.0.0') {
	return render(
		<PlaybookTile
			playbook={playbook}
			theme={mockTheme}
			isSelected={false}
			runningVersion={runningVersion}
			onSelect={vi.fn()}
		/>
	);
}

describe('PlaybookTile', () => {
	it('renders playbook metadata and fires onSelect', () => {
		const onSelect = vi.fn();
		const playbook = makePlaybook({ title: 'Security Audit', author: 'Ada' });
		const { getByText } = render(
			<PlaybookTile
				playbook={playbook}
				theme={mockTheme}
				isSelected={false}
				runningVersion="1.0.0"
				onSelect={onSelect}
			/>
		);

		expect(getByText('Security Audit')).toBeTruthy();
		expect(getByText('Development')).toBeTruthy();
		expect(getByText('/ Quality')).toBeTruthy();
		expect(getByText('Ada')).toBeTruthy();
		expect(getByText('2 docs')).toBeTruthy();

		fireEvent.click(getByText('Security Audit'));
		expect(onSelect).toHaveBeenCalledTimes(1);
	});

	it('renders local, beta, and incompatible badges', () => {
		const playbook = makePlaybook({
			source: 'local',
			beta: true,
			minMaestroVersion: '99.0.0',
		});
		const { getByText } = render(
			<PlaybookTile
				playbook={playbook}
				theme={mockTheme}
				isSelected={false}
				runningVersion="1.0.0"
				onSelect={vi.fn()}
			/>
		);

		expect(getByText('Local')).toBeTruthy();
		expect(getByText('BETA')).toBeTruthy();
		expect(getByText('Requires Maestro 99.0.0+')).toBeTruthy();
	});

	it('shows selected ring styling and scrolls into view when selected', () => {
		const scrollSpy = vi.spyOn(Element.prototype, 'scrollIntoView');
		const { container } = render(
			<PlaybookTile
				playbook={makePlaybook()}
				theme={mockTheme}
				isSelected={true}
				runningVersion="1.0.0"
				onSelect={vi.fn()}
			/>
		);

		const button = container.querySelector('button')!;
		expect(button.getAttribute('class')).toContain('ring-2');
		expect(button.getAttribute('style')).toContain('box-shadow');
		expect(scrollSpy).toHaveBeenCalledTimes(1);
	});

	describe('Launch badge', () => {
		it('marks a playbook whose launch can run here', () => {
			const { getByTestId } = renderTile(makePlaybook({ launch: launchSpec() }));

			const badge = getByTestId('playbook-tile-launch-badge');
			expect(badge.textContent).toBe('Launch');
			expect(badge.getAttribute('title')).toBe(
				'Launch runs this playbook on an agent after a few questions.'
			);
		});

		it('sits with the category row, not in the top-right corner of BETA and version badges', () => {
			const { getByTestId, getByText } = renderTile(
				makePlaybook({ launch: launchSpec(), beta: true, source: 'local' })
			);

			expect(getByTestId('playbook-tile-launch-badge').parentElement).toBe(
				getByText('Development').parentElement
			);
		});

		it('is absent for a playbook without a launch block', () => {
			const { queryByTestId } = renderTile();

			expect(queryByTestId('playbook-tile-launch-badge')).toBeNull();
		});

		it('is absent when the launch cannot run on this platform', () => {
			// The test setup reports the host platform as darwin.
			const { queryByTestId } = renderTile(
				makePlaybook({ launch: launchSpec({ preconditions: { platforms: ['win32'] } }) })
			);

			expect(queryByTestId('playbook-tile-launch-badge')).toBeNull();
		});

		it('is absent when the block needs a newer Maestro', () => {
			const { queryByTestId } = renderTile(
				makePlaybook({ launch: launchSpec({ minMaestroVersion: '9.0.0' }) })
			);

			expect(queryByTestId('playbook-tile-launch-badge')).toBeNull();
		});

		it('is absent when the playbook itself needs a newer Maestro', () => {
			const { queryByTestId } = renderTile(
				makePlaybook({ launch: launchSpec(), minMaestroVersion: '9.0.0' })
			);

			expect(queryByTestId('playbook-tile-launch-badge')).toBeNull();
		});
	});
});
