import { Worker } from 'node:worker_threads';
import path from 'node:path';
import type { HostReceiptLedgerLimits } from './host-receipt-ledger';
/** Serialized, bounded host-private worker transport. No synchronous fallback. */
export class HostReceiptLedgerClient {
	private worker?: Worker;
	private seq = 0;
	private readonly pending = new Map<
		number,
		{ resolve: (value: unknown) => void; reject: (error: Error) => void }
	>();
	private idle?: ReturnType<typeof setTimeout>;
	constructor(
		private readonly baseDir: string,
		private readonly limits?: Partial<HostReceiptLedgerLimits>,
		private readonly script = path.join(__dirname, 'relay-ledger-worker.js'),
		private readonly workerOptions: Record<string, unknown> = {}
	) {}
	protected call<T>(method: string, ...args: unknown[]): Promise<T> {
		if (this.pending.size >= 128)
			return Promise.reject(Error('Host receipt queue capacity reached'));
		if (this.idle) clearTimeout(this.idle);
		if (!this.worker) {
			const worker = new Worker(this.script, {
				workerData: { ...this.workerOptions, baseDir: this.baseDir, limits: this.limits },
			});
			this.worker = worker;
			const fail = () => {
				if (this.worker !== worker) return;
				this.worker = undefined;
				for (const item of this.pending.values())
					item.reject(Error('Host receipt worker unavailable; execution state retained'));
				this.pending.clear();
			};
			worker.on('error', fail);
			worker.on('exit', fail);
			worker.on('message', (response: { id: number; value: unknown; error?: string }) => {
				const item = this.pending.get(response.id);
				if (!item) return;
				this.pending.delete(response.id);
				if (response.error) item.reject(Error(response.error));
				else item.resolve(response.value);
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
		const id = ++this.seq;
		return new Promise<T>((resolve, reject) => {
			this.pending.set(id, { resolve: (value) => resolve(value as T), reject });
			try {
				this.worker!.postMessage({ id, method, args });
			} catch (error) {
				this.pending.delete(id);
				reject(error);
			}
		});
	}
	async dispose(): Promise<void> {
		if (this.idle) clearTimeout(this.idle);
		const worker = this.worker;
		this.worker = undefined;
		for (const item of this.pending.values())
			item.reject(Error('Host receipt worker closed; execution state retained'));
		this.pending.clear();
		await worker?.terminate();
	}
}
