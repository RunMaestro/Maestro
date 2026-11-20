/**
 * BrowseFolderButton - the folder-picker button beside a working directory
 * input (`FormInput`'s `addon`).
 *
 * An agent on an SSH remote has no folder to pick on this machine, so the
 * button is disabled there and its title says to type the remote path.
 */

import { Folder } from 'lucide-react';
import type { Theme } from '../../types';

/** The button's title while the form's agent runs on an SSH remote. */
export function sshFolderPickerUnavailableTitle(sshRemoteHost: string | undefined): string {
	return `Folder picker unavailable for SSH remote${sshRemoteHost ? ` (${sshRemoteHost})` : ''}. Enter the remote path manually.`;
}

export interface BrowseFolderButtonProps {
	theme: Theme;
	onBrowse: () => void;
	disabled?: boolean;
	/** Defaults to "Browse folders". Pass the reason when `disabled`. */
	title?: string;
}

export function BrowseFolderButton({
	theme,
	onBrowse,
	disabled = false,
	title = 'Browse folders',
}: BrowseFolderButtonProps) {
	return (
		<button
			type="button"
			onClick={onBrowse}
			disabled={disabled}
			className={`p-2 rounded border transition-colors ${disabled ? 'opacity-40 cursor-not-allowed' : 'row-hover'}`}
			style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
			title={title}
			aria-label="Browse folders"
		>
			<Folder className="w-5 h-5" />
		</button>
	);
}
