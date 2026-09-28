/**
 * @fileoverview SnoozedTabsModal layering with its history log.
 *
 * Snooze History opens on top of the Snoozed Tabs list. Escape closes the
 * highest-priority layer, so the history has to outrank the list: ranked
 * below it, Escape closed the list and unmounted the history along with it,
 * dropping the user out of both instead of back to the list.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SnoozedTabsModal } from '../../../renderer/components/SnoozedTabsModal';
import { LayerStackProvider } from '../../../renderer/contexts/LayerStackContext';
import { mockTheme } from '../../helpers/mockTheme';

function renderList() {
	const onClose = vi.fn();
	render(
		<LayerStackProvider>
			<SnoozedTabsModal theme={mockTheme} onClose={onClose} />
		</LayerStackProvider>
	);
	return { onClose };
}

describe('SnoozedTabsModal history layering', () => {
	it('returns to the snoozed tabs list when Escape closes the history', async () => {
		const { onClose } = renderList();

		fireEvent.click(screen.getByText('View History'));
		expect(await screen.findByText('Snooze History')).toBeInTheDocument();

		fireEvent.keyDown(window, { key: 'Escape' });

		await waitFor(() => {
			expect(screen.queryByText('Snooze History')).not.toBeInTheDocument();
		});
		expect(screen.getByText('Snoozed Tabs')).toBeInTheDocument();
		expect(onClose).not.toHaveBeenCalled();
	});

	it('closes the list itself on a second Escape', async () => {
		const { onClose } = renderList();

		fireEvent.click(screen.getByText('View History'));
		expect(await screen.findByText('Snooze History')).toBeInTheDocument();

		fireEvent.keyDown(window, { key: 'Escape' });
		await waitFor(() => {
			expect(screen.queryByText('Snooze History')).not.toBeInTheDocument();
		});

		fireEvent.keyDown(window, { key: 'Escape' });
		await waitFor(() => {
			expect(onClose).toHaveBeenCalledTimes(1);
		});
	});
});
