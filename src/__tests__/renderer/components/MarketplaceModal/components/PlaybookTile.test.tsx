import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { PlaybookTile } from '../../../../../renderer/components/MarketplaceModal/components';
import { makePlaybook, mockTheme } from '../_fixtures';

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
});
