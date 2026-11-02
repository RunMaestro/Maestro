import { mkdir, readFile, rename, writeFile } from 'fs/promises';
import path from 'path';
import { normalizeRemoteUrl, validateProfile } from './profiles';
import type { LiteProfile } from '../../shared/lite-control';

export interface LiteLastConnection {
	profile: LiteProfile;
	enabled: boolean;
}

function readProfile(value: unknown): LiteProfile {
	if (!value || typeof value !== 'object') throw new Error('Invalid last Lite connection.');
	const candidate = value as Record<string, unknown>;
	if (
		typeof candidate.id !== 'string' ||
		typeof candidate.name !== 'string' ||
		typeof candidate.url !== 'string' ||
		!['ssh', 'https', 'tailscale', 'lan'].includes(String(candidate.transport))
	)
		throw new Error('Invalid last Lite connection.');
	const transport = candidate.transport as LiteProfile['transport'];
	// validateProfile checks every remaining manual field, including nested SSH options.
	if (transport === 'ssh' || transport === 'https')
		return validateProfile(candidate as unknown as LiteProfile);
	if (!/^discovered-\d+$/.test(candidate.id) || typeof candidate.instanceId !== 'string')
		throw new Error('Invalid last discovered Lite connection.');
	if (
		candidate.localPort !== undefined &&
		(!Number.isInteger(candidate.localPort) ||
			Number(candidate.localPort) < 1024 ||
			Number(candidate.localPort) > 65535)
	)
		throw new Error('Invalid last discovered Lite port.');
	return {
		id: candidate.id,
		name: candidate.name,
		transport,
		url: normalizeRemoteUrl(candidate.url, transport).toString(),
		instanceId: candidate.instanceId,
		...(candidate.localPort === undefined ? {} : { localPort: Number(candidate.localPort) }),
	};
}

/** Persists recovery intent only. Paired credentials remain in DeviceCredentials. */
export class LiteLastConnections {
	private value: LiteLastConnection | undefined;
	private pending: Promise<void> = Promise.resolve();
	private revision = 0;
	private readonly file: string;
	constructor(directory: string) {
		this.file = path.join(directory, 'lite-last-connection.json');
	}
	async load(): Promise<void> {
		try {
			const parsed: unknown = JSON.parse(await readFile(this.file, 'utf8'));
			if (!parsed || typeof parsed !== 'object') throw new Error('Invalid last Lite connection.');
			const record = parsed as Record<string, unknown>;
			if (typeof record.enabled !== 'boolean') throw new Error('Invalid last Lite connection.');
			this.value = { profile: readProfile(record.profile), enabled: record.enabled };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
		}
	}
	get(): LiteLastConnection | undefined {
		return this.value
			? { profile: { ...this.value.profile }, enabled: this.value.enabled }
			: undefined;
	}
	remember(profile: LiteProfile, signal?: AbortSignal): Promise<void> {
		return this.write({ profile: { ...profile }, enabled: true }, signal);
	}
	disable(): Promise<void> {
		return this.value ? this.write({ ...this.value, enabled: false }) : Promise.resolve();
	}
	private write(value: LiteLastConnection, signal?: AbortSignal): Promise<void> {
		const revision = ++this.revision;
		if (signal?.aborted) return Promise.resolve();
		this.value = value;
		const writing = this.pending.then(async () => {
			if (signal?.aborted || revision !== this.revision) return;
			await mkdir(path.dirname(this.file), { recursive: true });
			await writeFile(this.file + '.tmp', JSON.stringify(value, null, 2), { mode: 0o600 });
			if (signal?.aborted || revision !== this.revision) return;
			await rename(this.file + '.tmp', this.file);
		});
		this.pending = writing.catch(() => {});
		return writing;
	}
}
