// Update SSH remote command - edit an existing SSH remote configuration

import {
	readSshRemotes,
	writeSshRemotes,
	resolveSshRemoteId,
	writeSettingValue,
} from '../services/storage';
import { formatError, formatSuccess } from '../output/formatter';
import { parseCliBool } from '../utils/parse';
import type { SshRemoteConfig } from '../../shared/types';
import {
	normalizeSshOptions,
	parseSshOptionAssignments,
	resolveSshOptions,
} from '../../shared/sshOptions';

interface UpdateSshRemoteOptions {
	name?: string;
	host?: string;
	port?: string;
	username?: string;
	key?: string;
	env?: string[];
	clearEnv?: boolean;
	sshOption?: string[];
	clearSshOptions?: boolean;
	sshConfig?: string;
	enabled?: string;
	setDefault?: boolean;
	json?: boolean;
}

/** Report a failure in whichever shape the caller asked for, then exit. */
function fail(message: string, json: boolean | undefined): never {
	if (json) {
		console.log(JSON.stringify({ success: false, error: message }));
	} else {
		console.error(formatError(message));
	}
	return process.exit(1);
}

/**
 * Parse repeated `KEY=VALUE` entries into a record.
 *
 * Splits on the first `=` only, so a value may contain more of them.
 */
function parseAssignments(entries: string[], flag: string, json?: boolean): Record<string, string> {
	const result: Record<string, string> = {};
	for (const entry of entries) {
		const eqIndex = entry.indexOf('=');
		if (eqIndex === -1) {
			fail(`Invalid ${flag} format "${entry}". Expected KEY=VALUE`, json);
		}
		result[entry.slice(0, eqIndex)] = entry.slice(eqIndex + 1);
	}
	return result;
}

export function updateSshRemote(remoteId: string, options: UpdateSshRemoteOptions): void {
	let resolvedId: string;
	try {
		resolvedId = resolveSshRemoteId(remoteId);
	} catch (error) {
		fail(error instanceof Error ? error.message : String(error), options.json);
	}

	const remotes = readSshRemotes();
	const index = remotes.findIndex((r) => r.id === resolvedId);
	if (index === -1) {
		fail(`SSH remote not found: ${resolvedId}`, options.json);
	}

	const existing = remotes[index];
	const updated: SshRemoteConfig = { ...existing };

	if (options.name !== undefined) {
		if (!options.name.trim()) fail('Name cannot be empty', options.json);
		updated.name = options.name.trim();
	}

	if (options.host !== undefined) {
		if (!options.host.trim()) fail('Host cannot be empty', options.json);
		updated.host = options.host.trim();
	}

	if (options.port !== undefined) {
		const port = parseInt(options.port, 10);
		if (isNaN(port) || port < 1 || port > 65535) {
			fail('--port must be a number between 1 and 65535', options.json);
		}
		updated.port = port;
	}

	// Empty string is a meaningful value for both: it clears the override and
	// hands the decision back to ~/.ssh/config or ssh-agent.
	if (options.username !== undefined) updated.username = options.username.trim();
	if (options.key !== undefined) updated.privateKeyPath = options.key.trim();

	if (options.sshConfig !== undefined) {
		let useSshConfig: boolean;
		try {
			useSshConfig = parseCliBool(options.sshConfig, '--ssh-config');
		} catch (error) {
			fail(error instanceof Error ? error.message : String(error), options.json);
		}
		updated.useSshConfig = useSshConfig || undefined;
		updated.sshConfigHost = useSshConfig ? updated.host : undefined;
	}

	if (options.enabled !== undefined) {
		try {
			updated.enabled = parseCliBool(options.enabled, '--enabled');
		} catch (error) {
			fail(error instanceof Error ? error.message : String(error), options.json);
		}
	}

	// Env and -o options MERGE by default so a single edit does not silently drop
	// the rest of the set; --clear-* is the explicit way to start over.
	if (options.clearEnv) updated.remoteEnv = undefined;
	if (options.env && options.env.length > 0) {
		const parsed = parseAssignments(options.env, '--env', options.json);
		const merged = { ...(updated.remoteEnv ?? {}), ...parsed };
		updated.remoteEnv = Object.keys(merged).length > 0 ? merged : undefined;
	}

	if (options.clearSshOptions) updated.sshOptions = undefined;
	if (options.sshOption && options.sshOption.length > 0) {
		const parsed = parseSshOptionAssignments(options.sshOption);
		if (parsed.error) fail(parsed.error, options.json);
		updated.sshOptions = normalizeSshOptions({ ...(updated.sshOptions ?? {}), ...parsed.options });
	}

	remotes[index] = updated;
	writeSshRemotes(remotes);

	if (options.setDefault) {
		writeSettingValue('defaultSshRemoteId', updated.id);
	}

	if (options.json) {
		console.log(
			JSON.stringify({
				success: true,
				id: updated.id,
				name: updated.name,
				host: updated.host,
				port: updated.port,
				username: updated.username,
				enabled: updated.enabled,
				useSshConfig: updated.useSshConfig || false,
				sshOptions: updated.sshOptions ?? {},
				// What ssh will actually receive, defaults included - the point of an
				// override is usually to change one of those, so echoing only the
				// overrides would not answer "did my ConnectTimeout take effect?"
				resolvedSshOptions: resolveSshOptions(updated.sshOptions),
			})
		);
		return;
	}

	console.log(formatSuccess(`Updated SSH remote "${updated.name}"`));
	console.log(`  ID:   ${updated.id}`);
	console.log(
		`  Host: ${updated.username ? `${updated.username}@` : ''}${updated.host}${updated.port !== 22 ? `:${updated.port}` : ''}`
	);
	if (updated.useSshConfig) {
		console.log(`  Mode: ssh-config`);
	}
	for (const [key, value] of Object.entries(resolveSshOptions(updated.sshOptions))) {
		console.log(`  -o    ${key}=${value}`);
	}
	if (options.setDefault) {
		console.log(`  Set as default`);
	}
}
