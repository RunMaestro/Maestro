import { Worker } from 'node:worker_threads';
import path from 'node:path';
import { app } from 'electron';
import type { MemoryRequest, MemoryState } from '../../shared/pianola/memory';
import { getActingUser } from '../web-server/auth/acting-user';
import { getProviderAccountDirs } from '../agents/provider-account-dirs';
import { defaultHistoryRoots } from '../storage/historical-inventory';
interface PendingMemoryRequest {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
}
export class PianolaMemoryHost {
	private worker: Worker | null = null;
	private sequence = 0;
	private pending = new Map<number, PendingMemoryRequest>();
	constructor(private readonly enabled: () => boolean) {}
	reconcile() {
		this.worker?.postMessage({ featureEnabled: this.enabled() });
	}
	private connect() {
		if (this.worker) return this.worker;
		const worker = new Worker(path.join(__dirname, 'memory-worker.js'), {
			workerData: { directory: app.getPath('userData'), featureEnabled: this.enabled() },
		});
		worker.on('message', (message: { id: number; result?: unknown; error?: string }) => {
			const pending = this.pending.get(message.id);
			if (!pending) return;
			clearTimeout(pending.timer);
			this.pending.delete(message.id);
			if (message.error) pending.reject(new Error(message.error));
			else pending.resolve(message.result);
		});
		const fail = (error: Error) => {
			for (const p of this.pending.values()) {
				clearTimeout(p.timer);
				p.reject(error);
			}
			this.pending.clear();
			this.worker = null;
		};
		worker.on('error', fail);
		worker.on('exit', (code) => {
			if (this.worker === worker) fail(new Error('Memory worker exited: ' + code));
		});
		this.worker = worker;
		return worker;
	}
	async request(request: MemoryRequest): Promise<unknown> {
		// The desktop owns this bank. Authenticated browser accounts cannot read or change another person's history.
		if (getActingUser()) throw new Error('This memory bank is private to the desktop owner');
		if (!this.enabled()) throw new Error('PianolaDisabled');
		const result = await this.send(request);
		if (request.action === 'status') {
			const state = result as MemoryState;
			if (!state.config.roots.some((r) => r.enabled)) {
				const roots = defaultHistoryRoots();
				for (const provider of ['claude-code', 'codex', 'copilot-cli']) {
					const accounts = await getProviderAccountDirs(provider);
					for (const account of accounts)
						if (
							!roots.some(
								(r) => r.provider === provider && path.resolve(r.path) === path.resolve(account)
							)
						)
							roots.push({
								provider,
								path: account,
								userId: null,
								authorship: 'unknown',
								enabled: false,
							});
				}
				return {
					...state,
					config: {
						...state.config,
						roots: [
							...state.config.roots,
							...roots.filter(
								(r) =>
									!state.config.roots.some(
										(old) =>
											old.provider === r.provider && path.resolve(old.path) === path.resolve(r.path)
									)
							),
						],
					},
				};
			}
		}
		return result;
	}
	private send(request: MemoryRequest) {
		const worker = this.connect();
		const id = ++this.sequence;
		return new Promise<unknown>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error('Memory operation timed out; inspect processing status before retrying'));
			}, 300000);
			this.pending.set(id, { resolve, reject, timer });
			worker.postMessage({ id, request });
		});
	}
	async stop() {
		if (this.worker) {
			const worker = this.worker;
			// A failed/timed-out drain is not permission to kill a sender or claim completion.
			await this.send({ action: 'transport-drain' });
			for (const request of this.pending.values()) {
				clearTimeout(request.timer);
				request.reject(new Error('Memory worker stopped'));
			}
			this.pending.clear();
			this.worker = null;
			await worker.terminate();
		}
	}
}
let host: PianolaMemoryHost | null = null;
export function initializePianolaMemory(enabled: () => boolean) {
	host = new PianolaMemoryHost(enabled);
	return host;
}
export function getPianolaMemory() {
	if (!host) throw new Error('Pianola memory host is not initialized');
	return host;
}
