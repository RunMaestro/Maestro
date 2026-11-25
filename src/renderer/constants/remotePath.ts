/**
 * Copy for a path field whose folder lives on a remote (an SSH or a hosted agent). One wording in
 * every modal, and no host name and no transport in it: the mode pill is the only mark that names
 * an agent's mode (docs/parity/agent-ux-parity.md).
 */

/** The folder picker's title when the folder is on a remote: the native picker browses this disk. */
export const REMOTE_FOLDER_PICKER_UNAVAILABLE =
	'Folder picker unavailable for a remote agent. Enter the remote path manually.';

/** The path field's placeholder when the folder is on a remote. */
export function remotePathPlaceholder(example: string): string {
	return `Enter remote path (e.g., ${example})`;
}
