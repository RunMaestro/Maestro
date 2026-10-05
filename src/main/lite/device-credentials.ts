import { safeStorage } from 'electron';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assertSerializedJsonIsSafe, parseJsonWithBom } from '../../shared/jsonUtils';
import { connectionOrigin } from './discovery/types';

interface SavedDevice {
	instanceId: string;
	origin: string;
	credential: string;
	peerId?: string;
}
/** Main-process only. Never send credentials to the renderer, URLs, clipboard or logs. */
export class DeviceCredentials {
	private rows = new Map<string, { instanceId: string; origin: string; encrypted: string }>();
	private pending: Promise<void> = Promise.resolve();
	private loaded?: Promise<void>;
	private readonly file: string;
	constructor(directory: string) {
		this.file = path.join(directory, 'lite-device-credentials.json');
	}
	assertAvailable(): void {
		if (
			!safeStorage.isEncryptionAvailable() ||
			(process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')
		)
			throw new Error(
				'Unlock the operating-system credential store before pairing. Unencrypted storage is not allowed.'
			);
	}
	private key(instanceId: string, origin: string): string {
		return createHash('sha256')
			.update(JSON.stringify([instanceId, origin]))
			.digest('hex');
	}
	private load(): Promise<void> {
		return (this.loaded ??= (async () => {
			let text: string;
			try {
				text = await readFile(this.file, 'utf8');
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
				throw error;
			}
			if (text.length > 1024 * 1024) throw new Error('Saved device credentials are invalid.');
			const rows = parseJsonWithBom<unknown>(text);
			if (!Array.isArray(rows) || rows.length > 128)
				throw new Error('Saved device credentials are invalid.');
			for (const row of rows) {
				if (
					!row ||
					typeof row.instanceId !== 'string' ||
					!row.instanceId ||
					typeof row.encrypted !== 'string' ||
					!/^[A-Za-z0-9+/=]+$/.test(row.encrypted)
				)
					throw new Error('Saved device credentials are invalid.');
				this.rows.set(this.key(row.instanceId, connectionOrigin(row.origin)), row);
			}
		})());
	}
	async get(instanceId: string, origin: string, peerId?: string): Promise<string | undefined> {
		await this.load();
		this.assertAvailable();
		origin = connectionOrigin(origin);
		if (origin.startsWith('http:') && !peerId)
			throw new Error('A verified Tailscale node identity is required.');
		if (
			[...this.rows.values()].some((row) => row.origin === origin && row.instanceId !== instanceId)
		)
			throw new Error(
				'Paired host identity changed. Verify this host before explicitly forgetting its old pairing.'
			);
		const row = this.rows.get(this.key(instanceId, origin));
		if (!row) return;
		const value = JSON.parse(
			safeStorage.decryptString(Buffer.from(row.encrypted, 'base64'))
		) as SavedDevice;
		if (
			value.instanceId !== instanceId ||
			value.origin !== origin ||
			(origin.startsWith('http:') && value.peerId !== peerId) ||
			!/^[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/.test(value.credential)
		)
			throw new Error('Saved device identity does not match.');
		return value.credential;
	}
	async save(
		instanceId: string,
		origin: string,
		credential: string,
		peerId?: string
	): Promise<void> {
		await this.load();
		this.assertAvailable();
		origin = connectionOrigin(origin);
		if (origin.startsWith('http:') && !peerId)
			throw new Error('A verified Tailscale node identity is required.');
		if (!/^[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/.test(credential) || !instanceId)
			throw new Error('Invalid paired-device credential.');
		const key = this.key(instanceId, origin);
		if (!this.rows.has(key) && this.rows.size >= 128)
			throw new Error('Remove a saved pairing before adding another device.');
		const previous = this.rows.get(key);
		this.rows.set(key, {
			instanceId,
			origin,
			encrypted: safeStorage
				.encryptString(JSON.stringify({ instanceId, origin, credential, peerId }))
				.toString('base64'),
		});
		try {
			await this.persist();
		} catch (error) {
			if (previous) this.rows.set(key, previous);
			else this.rows.delete(key);
			throw error;
		}
	}
	async forget(origin: string, expectedCredential?: string): Promise<void> {
		await this.load();
		for (const [key, row] of this.rows) {
			if (row.origin !== connectionOrigin(origin)) continue;
			if (
				expectedCredential &&
				JSON.parse(safeStorage.decryptString(Buffer.from(row.encrypted, 'base64'))).credential !==
					expectedCredential
			)
				continue;
			this.rows.delete(key);
		}
		await this.persist();
	}
	private persist(): Promise<void> {
		const text = JSON.stringify([...this.rows.values()]);
		assertSerializedJsonIsSafe(text, this.file);
		const operation = this.pending.then(async () => {
			await mkdir(path.dirname(this.file), { recursive: true });
			await writeFile(this.file + '.tmp', text, { mode: 0o600 });
			await rename(this.file + '.tmp', this.file);
		});
		this.pending = operation.catch(() => {});
		return operation;
	}
}
