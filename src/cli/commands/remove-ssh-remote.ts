// Remove SSH remote command - delete an SSH remote configuration

import {
	readSshRemotesForEdit,
	writeSshRemotes,
	resolveSshRemoteId,
	writeSettingValueIn,
} from '../services/storage';
import { formatError, formatSuccess } from '../output/formatter';
import { ExitCode, exitWith } from '../exit-codes';

interface RemoveSshRemoteOptions {
	json?: boolean;
}

export function removeSshRemote(remoteId: string, options: RemoveSshRemoteOptions): void {
	// Resolve partial ID
	let resolvedId: string;
	try {
		resolvedId = resolveSshRemoteId(remoteId);
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		if (options.json) {
			console.log(JSON.stringify({ success: false, error: msg }));
		} else {
			console.error(formatError(msg));
		}
		return exitWith(ExitCode.GeneralError);
	}

	const { remotes, defaultId, dir } = readSshRemotesForEdit();
	const index = remotes.findIndex((r) => r.id === resolvedId);

	if (index === -1) {
		const msg = `SSH remote not found: ${resolvedId}`;
		if (options.json) {
			console.log(JSON.stringify({ success: false, error: msg }));
		} else {
			console.error(formatError(msg));
		}
		exitWith(ExitCode.GeneralError);
	}

	const removedName = remotes[index].name;
	remotes.splice(index, 1);
	writeSshRemotes(remotes, dir);

	// Clear default if it was the deleted remote (same store as the list)
	if (defaultId === resolvedId) {
		writeSettingValueIn(dir, 'defaultSshRemoteId', null);
	}

	if (options.json) {
		console.log(JSON.stringify({ success: true, id: resolvedId, name: removedName }));
	} else {
		console.log(formatSuccess(`Removed SSH remote "${removedName}" (${resolvedId})`));
	}
}
