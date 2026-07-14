/**
 * @fileoverview Tests for AdditionalDirectoriesSection - the shared row editor
 * used by the create-agent, edit-agent, and Wizard directory surfaces.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { AdditionalDirectoriesSection } from '../../../../renderer/components/shared/AdditionalDirectoriesSection';
import { mockTheme } from '../../../helpers/mockTheme';
import type { AdditionalDirectory } from '../../../../renderer/types';

const selectFolder = vi.fn();

beforeEach(() => {
	selectFolder.mockReset();
	(window as any).maestro = {
		...(window as any).maestro,
		dialog: { selectFolder },
	};
});

function renderSection(directories: AdditionalDirectory[], props: Record<string, unknown> = {}) {
	const onChange = vi.fn();
	render(
		<AdditionalDirectoriesSection
			theme={mockTheme}
			directories={directories}
			onChange={onChange}
			{...props}
		/>
	);
	return onChange;
}

describe('AdditionalDirectoriesSection', () => {
	it('adds a read-only row by default so write is a deliberate second click', () => {
		const onChange = renderSection([]);

		fireEvent.click(screen.getByText('Add Directory'));

		expect(onChange).toHaveBeenCalledWith([{ path: '', read: true, write: false }]);
	});

	it('toggles read and write independently', () => {
		const dirs: AdditionalDirectory[] = [{ path: '/a/docs', read: true, write: false }];

		const onChange = renderSection(dirs);
		fireEvent.click(screen.getByLabelText('Write access'));
		expect(onChange).toHaveBeenCalledWith([{ path: '/a/docs', read: true, write: true }]);

		onChange.mockClear();
		fireEvent.click(screen.getByLabelText('Read access'));
		expect(onChange).toHaveBeenCalledWith([{ path: '/a/docs', read: false, write: false }]);
	});

	it('reflects each permission in the toggle state for screen readers', () => {
		renderSection([{ path: '/a/docs', read: true, write: false }]);

		expect(screen.getByLabelText('Read access')).toHaveAttribute('aria-checked', 'true');
		expect(screen.getByLabelText('Write access')).toHaveAttribute('aria-checked', 'false');
	});

	it('removes only the targeted row', () => {
		const dirs: AdditionalDirectory[] = [
			{ path: '/a', read: true, write: false },
			{ path: '/b', read: true, write: true },
		];
		const onChange = renderSection(dirs);

		fireEvent.click(screen.getAllByLabelText('Remove directory')[0]);

		expect(onChange).toHaveBeenCalledWith([{ path: '/b', read: true, write: true }]);
	});

	it('fills the row path from the folder picker', async () => {
		selectFolder.mockResolvedValue('/picked/dir');
		const onChange = renderSection([{ path: '', read: true, write: false }]);

		fireEvent.click(screen.getByLabelText('Browse folders'));
		await vi.waitFor(() =>
			expect(onChange).toHaveBeenCalledWith([{ path: '/picked/dir', read: true, write: false }])
		);
	});

	it('leaves the row untouched when the picker is cancelled', async () => {
		selectFolder.mockResolvedValue(null);
		const onChange = renderSection([{ path: '/keep/me', read: true, write: false }]);

		fireEvent.click(screen.getByLabelText('Browse folders'));
		await vi.waitFor(() => expect(selectFolder).toHaveBeenCalled());
		expect(onChange).not.toHaveBeenCalled();
	});

	it('hides Browse for SSH agents, where the local picker cannot see the remote', () => {
		renderSection([{ path: '/remote/dir', read: true, write: false }], { disableBrowse: true });

		expect(screen.queryByLabelText('Browse folders')).not.toBeInTheDocument();
		expect(screen.getByPlaceholderText('Enter remote path...')).toBeInTheDocument();
	});

	it('warns that a row with neither permission will not reach the agent', () => {
		renderSection([{ path: '/a/docs', read: false, write: false }]);

		expect(screen.getByText(/No access selected/)).toBeInTheDocument();
	});

	it('does not warn about an empty row the user has not filled in yet', () => {
		renderSection([{ path: '', read: false, write: false }]);

		expect(screen.queryByText(/No access selected/)).not.toBeInTheDocument();
	});
});
