/**
 * Tests for the History panel's sender picker.
 *
 * The picker answers "who sent these turns?" over the loaded window, and the
 * two things worth pinning are the ones a rename would break: the synthetic
 * `DESKTOP_USER_KEY` reads as "Desktop" rather than leaking the sentinel, and
 * an account is labelled by its DISPLAY name while the value handed back is
 * still the username the entries carry.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { UserSourceFilter, DESKTOP_USER_KEY } from '../../../../renderer/components/History';
import { mockTheme } from '../../../helpers/mockTheme';

const counts = new Map<string, number>([
	[DESKTOP_USER_KEY, 3],
	['pedram', 2],
]);

const labels = new Map<string, string>([['pedram', 'Pedram A']]);

describe('UserSourceFilter', () => {
	it('shows "All Senders" with no count when nothing is selected', () => {
		render(
			<UserSourceFilter
				userCounts={counts}
				userLabels={labels}
				selectedUser={null}
				onSelect={vi.fn()}
				theme={mockTheme}
			/>
		);

		expect(screen.getByText('All Senders')).toBeInTheDocument();
	});

	it('labels the desktop key rather than leaking the sentinel', () => {
		render(
			<UserSourceFilter
				userCounts={counts}
				userLabels={labels}
				selectedUser={null}
				onSelect={vi.fn()}
				theme={mockTheme}
			/>
		);

		fireEvent.click(screen.getByText('All Senders'));

		expect(screen.getByText('Desktop (3)')).toBeInTheDocument();
		expect(screen.queryByText(new RegExp(DESKTOP_USER_KEY))).not.toBeInTheDocument();
	});

	it('reports the username, not the display name, when an account is picked', () => {
		const onSelect = vi.fn();
		render(
			<UserSourceFilter
				userCounts={counts}
				userLabels={labels}
				selectedUser={null}
				onSelect={onSelect}
				theme={mockTheme}
			/>
		);

		fireEvent.click(screen.getByText('All Senders'));
		fireEvent.click(screen.getByText('Pedram A (2)'));

		expect(onSelect).toHaveBeenCalledWith('pedram');
	});

	it('falls back to the username when the account has no display label', () => {
		render(
			<UserSourceFilter
				userCounts={counts}
				selectedUser="pedram"
				onSelect={vi.fn()}
				theme={mockTheme}
			/>
		);

		expect(screen.getByText('pedram (2)')).toBeInTheDocument();
	});

	it('clears the filter from the "All Senders" row', () => {
		const onSelect = vi.fn();
		render(
			<UserSourceFilter
				userCounts={counts}
				userLabels={labels}
				selectedUser="pedram"
				onSelect={onSelect}
				theme={mockTheme}
			/>
		);

		fireEvent.click(screen.getByText('Pedram A (2)'));
		fireEvent.click(screen.getByText('All Senders'));

		expect(onSelect).toHaveBeenCalledWith(null);
	});
});
