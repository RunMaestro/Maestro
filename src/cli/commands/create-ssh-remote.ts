// Create SSH remote command - add a new SSH remote configuration

import * as crypto from 'crypto';
import { readSshRemotes, writeSshRemotes, writeSettingValue } from '../services/storage';
import { formatError, formatSuccess } from '../output/formatter';
import type { SshRemoteConfig } from '../../shared/types';

interface CreateSshRemoteOptions {
	host: string;
	port?: string;
	username?: string;
	key?: string;
	env?: string[];
	sshConfig?: boolean;
	disabled?: boolean;
	setDefault?: boolean;
	json?: boolean;
}

export function createSshRemote(name: string, options: CreateSshRemoteOptions): void {
	// Validate host
	if (!options.host) {
		const msg = 'Missing required --host';
		if (options.json) {
			console.log(JSON.stringify({ success: false, error: msg }));
		} else {
			console.error(formatError(msg));
		}
		process.exit(1);
	}

	// Parse port
	let port = 22;
	if (options.port !== undefined) {
		port = parseInt(options.port, 10);
		if (isNaN(port) || port < 1 || port > 65535) {
			const msg = '--port must be a number between 1 and 65535';
			if (options.json) {
				console.log(JSON.stringify({ success: false, error: msg }));
			} else {
				console.error(formatError(msg));
			}
			process.exit(1);
		}
	}

	// Parse environment variables
	let remoteEnv: Record<string, string> | undefined;
	if (options.env && options.env.length > 0) {
		remoteEnv = {};
		for (const entry of options.env) {
			const eqIndex = entry.indexOf('=');
			if (eqIndex === -1) {
				const msg = `Invalid --env format "${entry}". Expected KEY=VALUE`;
				if (options.json) {
					console.log(JSON.stringify({ success: false, error: msg }));
				} else {
					console.error(formatError(msg));
				}
				process.exit(1);
			}
			remoteEnv[entry.slice(0, eqIndex)] = entry.slice(eqIndex + 1);
		}
	}

	const config: SshRemoteConfig = {
		id: crypto.randomUUID(),
		name,
		host: options.host,
		port,
		username: options.username || '',
		privateKeyPath: options.key || '',
		remoteEnv,
		enabled: !options.disabled,
		useSshConfig: options.sshConfig || undefined,
		sshConfigHost: options.sshConfig ? options.host : undefined,
	};

	// Validate: name and host must be non-empty
	if (!config.name.trim()) {
		const msg = 'Name cannot be empty';
		if (options.json) {
			console.log(JSON.stringify({ success: false, error: msg }));
		} else {
			console.error(formatError(msg));
		}
		process.exit(1);
	}

	if (!config.host.trim()) {
		const msg = 'Host cannot be empty';
		if (options.json) {
			console.log(JSON.stringify({ success: false, error: msg }));
		} else {
			console.error(formatError(msg));
		}
		process.exit(1);
	}

	// Read, append, write
	const remotes = readSshRemotes();
	remotes.push(config);
	writeSshRemotes(remotes);

	// Set as default if requested
	if (options.setDefault) {
		writeSettingValue('defaultSshRemoteId', config.id);
	}

	if (options.json) {
		console.log(
			JSON.stringify({ success: true, id: config.id, name: config.name, host: config.host })
		);
	} else {
		console.log(formatSuccess(`Created SSH remote "${config.name}"`));
		console.log(`  ID:   ${config.id}`);
		console.log(
			`  Host: ${config.username ? `${config.username}@` : ''}${config.host}${config.port !== 22 ? `:${config.port}` : ''}`
		);
		if (config.useSshConfig) {
			console.log(`  Mode: ssh-config`);
		}
		if (options.setDefault) {
			console.log(`  Set as default`);
		}
	}
}
