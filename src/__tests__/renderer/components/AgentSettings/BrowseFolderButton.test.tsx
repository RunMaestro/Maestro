/**
 * @fileoverview Tests for BrowseFolderButton, the folder-picker button beside
 * a working directory input.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import {
	BrowseFolderButton,
	sshFolderPickerUnavailableTitle,
} from '../../../../renderer/components/AgentSettings/BrowseFolderButton';
import { createMockTheme } from '../../../helpers/mockTheme';

const theme = createMockTheme();

describe('BrowseFolderButton', () => {
	it('opens the folder picker', () => {
		const onBrowse = vi.fn();
		render(<BrowseFolderButton theme={theme} onBrowse={onBrowse} />);

		const button = screen.getByRole('button', { name: 'Browse folders' });
		expect(button).toHaveAttribute('title', 'Browse folders');
		fireEvent.click(button);
		expect(onBrowse).toHaveBeenCalledTimes(1);
	});

	it('is disabled with the reason as its title, and keeps its name', () => {
		const title = sshFolderPickerUnavailableTitle('build-box');
		render(<BrowseFolderButton theme={theme} onBrowse={vi.fn()} disabled title={title} />);

		const button = screen.getByRole('button', { name: 'Browse folders' });
		expect(button).toBeDisabled();
		expect(button).toHaveAttribute('title', title);
	});
});

describe('sshFolderPickerUnavailableTitle', () => {
	it('names the remote when it is known', () => {
		expect(sshFolderPickerUnavailableTitle('build-box')).toBe(
			'Folder picker unavailable for SSH remote (build-box). Enter the remote path manually.'
		);
		expect(sshFolderPickerUnavailableTitle(undefined)).toBe(
			'Folder picker unavailable for SSH remote. Enter the remote path manually.'
		);
	});
});
