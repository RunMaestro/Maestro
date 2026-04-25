// Remove SSH remote command - delete an SSH remote configuration

import {
	readSshRemotes,
	writeSshRemotes,
	resolveSshRemoteId,
	readSettingValue,
	writeSettingValue,
} from '../services/storage';
import { formatError, formatSuccess } from '../output/formatter';

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
		return process.exit(1);
	}

	const remotes = readSshRemotes();
	const index = remotes.findIndex((r) => r.id === resolvedId);

	if (index === -1) {
		const msg = `SSH remote not found: ${resolvedId}`;
		if (options.json) {
			console.log(JSON.stringify({ success: false, error: msg }));
		} else {
			console.error(formatError(msg));
		}
		process.exit(1);
	}

	const removedName = remotes[index].name;
	remotes.splice(index, 1);
	writeSshRemotes(remotes);

	// Clear default if it was the deleted remote
	const defaultId = readSettingValue('defaultSshRemoteId') as string | null;
	if (defaultId === resolvedId) {
		writeSettingValue('defaultSshRemoteId', null);
	}

	if (options.json) {
		console.log(JSON.stringify({ success: true, id: resolvedId, name: removedName }));
	} else {
		console.log(formatSuccess(`Removed SSH remote "${removedName}" (${resolvedId})`));
	}
}
