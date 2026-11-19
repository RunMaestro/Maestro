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

	describe('health badges', () => {
		const healthy = {
			installs_30d: 50,
			runs_30d: 200,
			success_rate_30d: 0.95,
			recent_failures: 0,
		};

		it('shows Most popular only when the tile is in the top installs', () => {
			const { getByTestId, queryByTestId, rerender } = render(
				<PlaybookTile
					playbook={makePlaybook()}
					theme={mockTheme}
					isSelected={false}
					runningVersion="1.0.0"
					health={healthy}
					isMostPopular
					onSelect={vi.fn()}
				/>
			);
			const badge = getByTestId('playbook-tile-popular-badge');
			expect(badge.textContent).toBe('Most popular');
			expect(badge.getAttribute('title')).toContain('50 installs');
			expect(queryByTestId('playbook-tile-broken-badge')).toBeNull();

			rerender(
				<PlaybookTile
					playbook={makePlaybook()}
					theme={mockTheme}
					isSelected={false}
					runningVersion="1.0.0"
					health={healthy}
					onSelect={vi.fn()}
				/>
			);
			expect(queryByTestId('playbook-tile-popular-badge')).toBeNull();
		});

		it('shows Recently broken from the failure figures', () => {
			const { getByTestId } = render(
				<PlaybookTile
					playbook={makePlaybook()}
					theme={mockTheme}
					isSelected={false}
					runningVersion="1.0.0"
					health={{ ...healthy, success_rate_30d: 0.5, recent_failures: 4 }}
					onSelect={vi.fn()}
				/>
			);
			const badge = getByTestId('playbook-tile-broken-badge');
			expect(badge.textContent).toBe('Recently broken');
			expect(badge.getAttribute('title')).toContain('4 recent failed runs');
			expect(badge.getAttribute('title')).toContain('50%');
		});

		it('shows no health badges without figures, even if marked popular', () => {
			const { queryByTestId } = render(
				<PlaybookTile
					playbook={makePlaybook()}
					theme={mockTheme}
					isSelected={false}
					runningVersion="1.0.0"
					isMostPopular
					onSelect={vi.fn()}
				/>
			);
			expect(queryByTestId('playbook-tile-popular-badge')).toBeNull();
			expect(queryByTestId('playbook-tile-broken-badge')).toBeNull();
		});
	});
});
