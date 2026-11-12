/**
 * Tests for PlaybookImportFooter: the Exchange detail view's bottom bar.
 *
 * Three states, by what the playbook ships:
 * - no `launch` block: Import Playbook alone, exactly as before;
 * - a `launch` block that can run here: Launch is the primary button and Download the secondary;
 * - a `launch` block that cannot run here: Download alone, with the reason on hover.
 *
 * The test setup reports the host platform as `darwin`.
 */

import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { PlaybookImportFooter } from '../../../../../renderer/components/MarketplaceModal/components';
import type { PlaybookImportFooterProps } from '../../../../../renderer/components/MarketplaceModal/components/PlaybookImportFooter';
import type { PlaybookLaunchSpec } from '../../../../../shared/marketplace-types';
import { makePlaybook, mockTheme } from '../_fixtures';

const FOLDER_LABEL_IMPORT = 'Import to folder (single name inside the Auto Run folder)';
const FOLDER_LABEL_DOWNLOAD = 'Download to folder (single name inside the Auto Run folder)';

function launchSpec(overrides: Partial<PlaybookLaunchSpec> = {}): PlaybookLaunchSpec {
	return { inputs: [], outro: { summary: 'Done.', nextSteps: [] }, ...overrides };
}

function renderFooter(playbook = makePlaybook(), props: Partial<PlaybookImportFooterProps> = {}) {
	const handlers = {
		onTargetFolderChange: vi.fn(),
		onBrowseFolder: vi.fn(),
		onImport: vi.fn(),
		onLaunch: vi.fn(),
	};
	const view = render(
		<PlaybookImportFooter
			theme={mockTheme}
			playbook={playbook}
			targetFolderName="test-playbook"
			isImporting={false}
			isRemoteSession={false}
			runningVersion="1.0.0"
			{...handlers}
			{...props}
		/>
	);
	return { ...handlers, ...view };
}

const launchButton = () => screen.queryByTestId('playbook-launch-button');
const importButton = () => screen.getByTestId('playbook-import-button');

describe('PlaybookImportFooter', () => {
	describe('a playbook without a launch block', () => {
		it('is unchanged: Import Playbook alone, with no Launch', () => {
			renderFooter();

			expect(within(importButton()).getByText('Import Playbook')).toBeTruthy();
			expect(launchButton()).toBeNull();
			expect(screen.queryByText('Download')).toBeNull();
			expect(screen.getByText(FOLDER_LABEL_IMPORT)).toBeTruthy();
		});

		it('draws that one button as the primary action, with no hover text', () => {
			renderFooter();

			expect(importButton()).toHaveStyle({ backgroundColor: mockTheme.colors.accent });
			expect(importButton()).not.toHaveAttribute('title');
		});

		it('imports on click', () => {
			const { onImport, onLaunch } = renderFooter();

			fireEvent.click(importButton());

			expect(onImport).toHaveBeenCalledTimes(1);
			expect(onLaunch).not.toHaveBeenCalled();
		});
	});

	describe('a playbook whose launch can run here', () => {
		const launchable = () => makePlaybook({ launch: launchSpec() });

		it('shows Launch first and Download beside it', () => {
			renderFooter(launchable());

			const buttons = screen
				.getAllByRole('button')
				.filter((button) => ['Launch', 'Download'].includes(button.textContent ?? ''));
			expect(buttons.map((button) => button.textContent)).toEqual(['Launch', 'Download']);
			expect(screen.queryByText('Import Playbook')).toBeNull();
		});

		it('makes Launch the primary button and Download the secondary one', () => {
			renderFooter(launchable());

			expect(launchButton()).toHaveStyle({ backgroundColor: mockTheme.colors.accent });
			expect(importButton()).not.toHaveStyle({ backgroundColor: mockTheme.colors.accent });
			expect(importButton().className).toContain('border');
		});

		it('opens the launch dialog on Launch and imports on Download', () => {
			const { onImport, onLaunch } = renderFooter(launchable());

			fireEvent.click(launchButton()!);
			expect(onLaunch).toHaveBeenCalledTimes(1);
			expect(onImport).not.toHaveBeenCalled();

			fireEvent.click(importButton());
			expect(onImport).toHaveBeenCalledTimes(1);
			expect(onLaunch).toHaveBeenCalledTimes(1);
		});

		it('says the folder belongs to Download, because Launch makes its own', () => {
			renderFooter(launchable());

			expect(screen.getByText(FOLDER_LABEL_DOWNLOAD)).toBeTruthy();
			expect(screen.queryByText(FOLDER_LABEL_IMPORT)).toBeNull();
		});

		it('keeps Launch on while Download has no folder to write to', () => {
			renderFooter(launchable(), { targetFolderName: '   ' });

			expect(importButton()).toBeDisabled();
			expect(launchButton()).toBeEnabled();
		});

		it('turns both off while an import runs', () => {
			renderFooter(launchable(), { isImporting: true });

			expect(launchButton()).toBeDisabled();
			expect(importButton()).toBeDisabled();
			expect(within(importButton()).getByText('Importing...')).toBeTruthy();
		});

		it('still offers Launch for an agent on an SSH remote: the dialog checks the rest', () => {
			renderFooter(launchable(), { isRemoteSession: true });

			expect(launchButton()).toBeEnabled();
			expect(screen.getByTitle('Browse is not available for remote sessions')).toBeDisabled();
		});

		it('offers Launch on a platform the block lists', () => {
			renderFooter(
				makePlaybook({ launch: launchSpec({ preconditions: { platforms: ['darwin'] } }) })
			);

			expect(launchButton()).toBeTruthy();
		});
	});

	describe('a playbook whose launch cannot run here', () => {
		it('shows Download alone, as the primary button, with the reason on hover', () => {
			renderFooter(
				makePlaybook({ launch: launchSpec({ preconditions: { platforms: ['win32'] } }) })
			);

			expect(launchButton()).toBeNull();
			expect(within(importButton()).getByText('Download')).toBeTruthy();
			expect(importButton()).toHaveStyle({ backgroundColor: mockTheme.colors.accent });
			expect(importButton()).toHaveAttribute('title', 'This playbook runs on Windows only.');
			expect(screen.getByText(FOLDER_LABEL_DOWNLOAD)).toBeTruthy();
		});

		it('gives the reason for a block that needs a newer Maestro', () => {
			renderFooter(makePlaybook({ launch: launchSpec({ minMaestroVersion: '9.0.0' }) }));

			expect(launchButton()).toBeNull();
			expect(importButton()).toHaveAttribute(
				'title',
				'Launch needs Maestro 9.0.0 or newer (this is 1.0.0).'
			);
		});

		it('still downloads on click', () => {
			const { onImport } = renderFooter(
				makePlaybook({ launch: launchSpec({ preconditions: { platforms: ['win32'] } }) })
			);

			fireEvent.click(importButton());

			expect(onImport).toHaveBeenCalledTimes(1);
		});

		it('keeps the update message when the playbook itself needs a newer Maestro', () => {
			renderFooter(makePlaybook({ launch: launchSpec(), minMaestroVersion: '9.0.0' }));

			expect(launchButton()).toBeNull();
			expect(within(importButton()).getByText('Update Maestro to install')).toBeTruthy();
			expect(importButton()).toBeDisabled();
			expect(importButton()).toHaveAttribute(
				'title',
				'Update Maestro to 9.0.0 or newer to install this playbook.'
			);
		});
	});
});
