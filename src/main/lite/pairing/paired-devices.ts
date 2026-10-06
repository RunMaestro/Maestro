import { createHash, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assertSerializedJsonIsSafe, parseJsonWithBom } from '../../../shared/jsonUtils';
import { displayName, connectionOrigin } from '../discovery/types';
import { createKeyedWriteQueue } from '../../utils/atomic-json-store';

export interface PairedDevice {
	id: string;
	name: string;
	instanceId: string;
	origin: string;
	createdAt: number;
}
interface DeviceRecord extends PairedDevice {
	verifier: string;
}
const validCredential = (value: unknown): value is string =>
	typeof value === 'string' && /^[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/.test(value);
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
/** Host-only registry. Disk contains high-entropy credential verifiers, never client secrets. */
export class PairedDevices {
	private records = new Map<string, DeviceRecord>();
	private loaded?: Promise<void>;
	private writes = createKeyedWriteQueue();
	private file?: string;
	constructor(directory?: string) {
		if (directory) this.file = path.join(directory, 'lite-paired-devices.json');
	}
	load(): Promise<void> {
		return (this.loaded ??= this.read());
	}
	private async read(): Promise<void> {
		if (!this.file) return;
		let text: string;
		try {
			text = await readFile(this.file, 'utf8');
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
			throw error;
		}
		if (text.length > 128 * 1024)
			throw new Error('Paired device registry is invalid. Access remains closed.');
		const rows = parseJsonWithBom<unknown>(text);
		if (!Array.isArray(rows) || rows.length > 128)
			throw new Error('Paired device registry is invalid.');
		const records = new Map<string, DeviceRecord>();
		for (const row of rows) {
			if (
				!row ||
				!/^[A-Za-z0-9_-]{43}$/.test(row.id) ||
				!/^[a-f0-9]{64}$/.test(row.verifier) ||
				typeof row.instanceId !== 'string' ||
				!row.instanceId ||
				!Number.isSafeInteger(row.createdAt) ||
				records.has(row.id)
			)
				throw new Error('Paired device registry is invalid.');
			records.set(row.id, {
				id: row.id,
				name: displayName(row.name),
				instanceId: row.instanceId,
				origin: connectionOrigin(row.origin),
				createdAt: row.createdAt,
				verifier: row.verifier,
			});
		}
		this.records = records;
	}
	list(instanceId: string): PairedDevice[] {
		return [...this.records.values()]
			.filter((r) => r.instanceId === instanceId)
			.map(({ verifier: _verifier, ...record }) => record);
	}
	async add(credential: string, name: string, instanceId: string, origin: string): Promise<void> {
		await this.writes.enqueue(this.file ?? 'devices', async () => {
			await this.load();
			if (!validCredential(credential) || !instanceId) throw new Error('invalid-device-credential');
			if (this.records.size >= 128) throw new Error('paired-device-limit');
			const id = credential.split('.')[0];
			if (this.records.has(id)) throw new Error('device-already-paired');
			this.records.set(id, {
				id,
				name: displayName(name),
				instanceId,
				origin: connectionOrigin(origin),
				createdAt: Date.now(),
				verifier: digest(credential),
			});
			try {
				await this.persist();
			} catch (error) {
				this.records.delete(id);
				throw error;
			}
		});
	}
	resolve(credential: unknown, instanceId: string, origin: string): PairedDevice | undefined {
		if (!validCredential(credential)) return;
		const row = this.records.get(credential.split('.')[0]);
		if (
			!row ||
			row.instanceId !== instanceId ||
			row.origin !== origin ||
			!timingSafeEqual(Buffer.from(row.verifier, 'hex'), Buffer.from(digest(credential), 'hex'))
		)
			return;
		const { verifier: _verifier, ...device } = row;
		return device;
	}
	async revoke(id: string): Promise<void> {
		// Close live authorization immediately, including while another disk write is pending.
		this.records.delete(id);
		await this.writes.enqueue(this.file ?? 'devices', async () => {
			await this.load();
			this.records.delete(id);
			await this.persist();
		});
	}
	private async persist(): Promise<void> {
		if (!this.file) return;
		const text = JSON.stringify([...this.records.values()]);
		assertSerializedJsonIsSafe(text, this.file);
		const file = this.file;
		await mkdir(path.dirname(file), { recursive: true });
		await writeFile(file + '.tmp', text, { mode: 0o600 });
		await rename(file + '.tmp', file);
	}
}
