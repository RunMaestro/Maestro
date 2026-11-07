// List SSH remotes command - list all configured SSH remote hosts

import { readSshRemotes, readSettingValue } from '../services/storage';
import { formatSshRemotes } from '../output/formatter';
import { resolveSshOptions } from '../../shared/sshOptions';
import { isEncoreEnabled } from '../utils/encore-gate';

interface ListSshRemotesOptions {
	json?: boolean;
}

export function listSshRemotes(options: ListSshRemotesOptions): void {
	const remotes = readSshRemotes();
	const defaultId = readSettingValue('defaultSshRemoteId') as string | null;

	if (options.json) {
		// Federation is an Encore Feature: while it is off the field is left out.
		const federationOn = isEncoreEnabled('federation');
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
					sshOptions: remote.sshOptions ?? {},
					// Switched-off entries, reported so an agent can see what exists to
					// turn back on. They are deliberately absent from resolvedSshOptions.
					sshOptionsDisabled: remote.sshOptionsDisabled ?? {},
					remoteEnvDisabled: remote.remoteEnvDisabled ?? {},
					// The full option set ssh will receive, defaults included. An agent
					// debugging a connection needs what is actually passed, not just the
					// overrides layered on top of it.
					resolvedSshOptions: resolveSshOptions(remote.sshOptions),
					isDefault: remote.id === defaultId,
					...(federationOn ? { federation: remote.federation === true } : {}),
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
