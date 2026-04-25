// List SSH remotes command - list all configured SSH remote hosts

import { readSshRemotes, readSettingValue } from '../services/storage';
import { formatSshRemotes } from '../output/formatter';

interface ListSshRemotesOptions {
	json?: boolean;
}

export function listSshRemotes(options: ListSshRemotesOptions): void {
	const remotes = readSshRemotes();
	const defaultId = readSettingValue('defaultSshRemoteId') as string | null;

	if (options.json) {
		for (const remote of remotes) {
			console.log(
				JSON.stringify({
					id: remote.id,
					name: remote.name,
					host: remote.host,
					port: remote.port,
					username: remote.username,
					enabled: remote.enabled,
					useSshConfig: remote.useSshConfig || false,
					isDefault: remote.id === defaultId,
				})
			);
		}
		return;
	}

	console.log(
		formatSshRemotes(
			remotes.map((r) => ({
				id: r.id,
				name: r.name,
				host: r.host,
				port: r.port,
				username: r.username,
				enabled: r.enabled,
				useSshConfig: r.useSshConfig,
				isDefault: r.id === defaultId,
			}))
		)
	);
}
