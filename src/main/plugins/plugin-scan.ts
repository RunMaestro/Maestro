import { Worker } from 'node:worker_threads';
import path from 'node:path';
import type { AuthIdentity } from './authorization-ledger';
import type { SignatureCheck } from './plugin-signature';
export interface PluginFileScan {
	identity: AuthIdentity | null;
	signature: SignatureCheck;
	fingerprint: string;
}
/** Bounded serial file work, freshly recomputed for every call. Never retries on main. */
export class PluginFileScanner {
	private worker?: Worker;
	private nextId = 0;
	private readonly pending = new Map<
		number,
		{ resolve: (result: PluginFileScan) => void; reject: (error: Error) => void }
	>();
	private idle?: ReturnType<typeof setTimeout>;
	constructor(private readonly script = path.join(__dirname, 'plugin-scan-worker.js')) {}
	scan(dir: string, trustedKeys: readonly string[]): Promise<PluginFileScan> {
		if (this.pending.size >= 128)
			return Promise.reject(Error('Plugin verification capacity reached'));
		if (this.idle) clearTimeout(this.idle);
		if (!this.worker) {
			const worker = new Worker(this.script);
			this.worker = worker;
			const fail = () => {
				if (this.worker !== worker) return;
				this.worker = undefined;
				for (const item of this.pending.values())
					item.reject(Error('Plugin verification unavailable'));
				this.pending.clear();
			};
			worker.on('error', fail);
			worker.on('exit', fail);
			worker.on('message', (message: { id: number; result?: PluginFileScan; error?: boolean }) => {
				const item = this.pending.get(message.id);
				if (!item) return;
				this.pending.delete(message.id);
				if (message.error || !message.result) item.reject(Error('Plugin verification unavailable'));
				else item.resolve(message.result);
				if (!this.pending.size)
					this.idle = setTimeout(() => {
						if (this.worker === worker) {
							this.worker = undefined;
							void worker.terminate();
						}
					}, 30000).unref();
			});
			worker.unref();
		}
		const id = ++this.nextId;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			try {
				this.worker!.postMessage({ id, dir, trustedKeys: [...trustedKeys] });
			} catch (error) {
				this.pending.delete(id);
				reject(error);
			}
		});
	}
}
const scanner = new PluginFileScanner();
export const scanPluginFiles = (dir: string, trustedKeys: readonly string[]) =>
	scanner.scan(dir, trustedKeys);
