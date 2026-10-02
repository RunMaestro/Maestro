import { createHash } from 'crypto';
import { readFile, writeFile, mkdir, rename } from 'fs/promises';
import path from 'path';
import type { SshRemoteConfig } from '../../shared/types';
import { validateSshOption } from '../../shared/sshOptions';

export interface LiteProfile {
	id: string;
	name: string;
	transport: 'ssh' | 'https';
	url: string;
	ssh?: SshRemoteConfig;
	instanceId?: string;
	localPort?: number;
}

export function normalizeRemoteUrl(input: string, transport: LiteProfile['transport']): URL {
	if (typeof input !== 'string' || /[\s\\\x00-\x1f]/.test(input))
		throw new Error('Enter a Remote Control URL without whitespace or backslashes.');
	const url = new URL(input);
	if (url.username || url.password || url.search || url.hash)
		throw new Error(
			'Remote Control URLs must not contain credentials, query parameters, or fragments.'
		);
	if (
		transport === 'https' ? url.protocol !== 'https:' : !['http:', 'https:'].includes(url.protocol)
	)
		throw new Error('Direct connections require HTTPS with a valid certificate.');
	if (transport === 'ssh' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
		throw new Error('SSH Remote Control URL must address the host’s loopback interface.');
	url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/desktop$/, '');
	const segments = url.pathname.split('/').slice(1);
	if (!segments.length || segments.some((part) => !part || !/^[A-Za-z0-9_-]+$/.test(part)))
		throw new Error('Paste the host’s Remote Control URL including its token.');
	return url;
}

export function validateProfile(profile: LiteProfile): LiteProfile {
	if (
		!profile ||
		!/^[A-Za-z0-9_-]{1,100}$/.test(profile.id) ||
		typeof profile.name !== 'string' ||
		!profile.name.trim()
	)
		throw new Error('Profile name and ID are required.');
	if (profile.transport !== 'ssh' && profile.transport !== 'https')
		throw new Error('Choose SSH or HTTPS.');
	if (
		profile.localPort !== undefined &&
		(!Number.isInteger(profile.localPort) || profile.localPort < 1024 || profile.localPort > 65535)
	)
		throw new Error('Invalid saved loopback port.');
	const normalized = normalizeRemoteUrl(profile.url, profile.transport).toString();
	if (profile.transport === 'ssh') {
		const ssh = profile.ssh;
		if (
			!ssh ||
			!/^[A-Za-z0-9_.:[\]-]+$/.test(ssh.host) ||
			ssh.host.startsWith('-') ||
			(ssh.username && !/^[A-Za-z0-9_.-]+$/.test(ssh.username)) ||
			!Number.isInteger(ssh.port) ||
			ssh.port < 1 ||
			ssh.port > 65535
		)
			throw new Error('Enter a valid SSH host/config alias, username, and port.');
		for (const [key, value] of Object.entries(ssh.sshOptions ?? {})) {
			if (typeof value !== 'string') throw new Error('SSH option values must be strings.');
			const error = validateSshOption(key, value);
			if (error) throw new Error(error);
			if (
				/^(localforward|remoteforward|dynamicforward|permitlocalcommand|localcommand|remotecommand|sessiontype|forkafterauthentication|controlmaster|controlpath|controlpersist|stricthostkeychecking|userknownhostsfile|globalknownhostsfile|clearallforwardings|exitonforwardfailure|batchmode)$/i.test(
					key
				)
			)
				throw new Error(`Lite manages SSH option ${key}; remove this override.`);
		}
	}
	return { ...profile, name: profile.name.trim(), url: normalized };
}

export function hostPartition(profileId: string, instanceId: string): string {
	return `persist:maestro-lite-${createHash('sha256')
		.update(JSON.stringify([profileId, instanceId]))
		.digest('hex')}`;
}

export class LiteProfiles {
	private profiles: LiteProfile[] = [];
	private pending: Promise<void> = Promise.resolve();
	private readonly file: string;
	constructor(directory: string) {
		this.file = path.join(directory, 'lite-profiles.json');
	}
	async load(): Promise<void> {
		try {
			const parsed: unknown = JSON.parse(await readFile(this.file, 'utf8'));
			if (!Array.isArray(parsed)) throw new Error('Lite profiles file must contain a list.');
			this.profiles = parsed.map((profile) => validateProfile(profile));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
		}
	}
	list(): LiteProfile[] {
		return this.profiles.map((profile) => ({ ...profile }));
	}
	get(id: string): LiteProfile {
		const profile = this.profiles.find((entry) => entry.id === id);
		if (!profile) throw new Error('Select a saved connection.');
		return profile;
	}
	async save(profile: LiteProfile): Promise<void> {
		const validated = validateProfile(profile);
		const saving = this.pending.then(async () => {
			const previous = this.profiles.find((entry) => entry.id === profile.id);
			// Editing a target cannot silently carry trust from its previous endpoint.
			if (
				previous &&
				(previous.url !== validated.url ||
					previous.transport !== validated.transport ||
					JSON.stringify(previous.ssh) !== JSON.stringify(validated.ssh))
			)
				delete validated.instanceId;
			this.profiles = [...this.profiles.filter((entry) => entry.id !== profile.id), validated];
			await this.persist();
		});
		this.pending = saving.catch(() => {});
		return saving;
	}
	async remove(id: string): Promise<void> {
		const removing = this.pending.then(async () => {
			this.profiles = this.profiles.filter((entry) => entry.id !== id);
			await this.persist();
		});
		this.pending = removing.catch(() => {});
		return removing;
	}
	private async persist(): Promise<void> {
		await mkdir(path.dirname(this.file), { recursive: true });
		await writeFile(`${this.file}.tmp`, JSON.stringify(this.profiles, null, 2), { mode: 0o600 });
		await rename(`${this.file}.tmp`, this.file);
	}
}
