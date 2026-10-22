import { logger } from './logger';

type WatchEvent = {
	type?: string;
	clientId?: string;
	sender?: {
		id: number;
		isDestroyed?: () => boolean;
		once?: (event: string, listener: () => void) => unknown;
	};
};

/** Shared host watchers live until the last renderer/client subscription leaves. */
export class WatcherLeases {
	private readonly resources = new Map<string, Map<string, Set<string>>>();
	private readonly senders = new WeakSet<object>();

	constructor(private readonly close: (resource: string) => Promise<void>) {}

	private owner(event: unknown): string {
		const source = event as WatchEvent;
		if (source?.type === 'bridge' && typeof source.clientId === 'string')
			return `bridge:${source.clientId}`;
		if (!source?.sender || typeof source.sender.id !== 'number' || source.sender.isDestroyed?.()) {
			throw new Error('A live watcher owner is required');
		}
		const owner = `native:${source.sender.id}`;
		if (!this.senders.has(source.sender)) {
			this.senders.add(source.sender);
			source.sender.once?.('destroyed', () => {
				void this.releaseOwner(owner).catch((error) =>
					logger.error('Watcher owner cleanup failed', 'WatcherLeases', error)
				);
			});
		}
		return owner;
	}

	acquire(resource: string, event: unknown, subscriber = ''): void {
		const owner = this.owner(event);
		let owners = this.resources.get(resource);
		if (!owners) this.resources.set(resource, (owners = new Map()));
		let subscribers = owners.get(owner);
		if (!subscribers) owners.set(owner, (subscribers = new Set()));
		subscribers.add(subscriber);
	}

	has(resource: string, event: unknown, subscriber = ''): boolean {
		return this.resources.get(resource)?.get(this.owner(event))?.has(subscriber) ?? false;
	}

	async release(resource: string, event: unknown, subscriber = ''): Promise<void> {
		const owner = this.owner(event);
		const owners = this.resources.get(resource);
		const subscribers = owners?.get(owner);
		if (!subscribers?.delete(subscriber)) return;
		if (!subscribers.size) owners!.delete(owner);
		if (!owners!.size) {
			this.resources.delete(resource);
			await this.close(resource);
		}
	}

	private async releaseOwner(owner: string): Promise<void> {
		const closing: Promise<void>[] = [];
		for (const [resource, owners] of this.resources) {
			if (!owners.delete(owner) || owners.size) continue;
			this.resources.delete(resource);
			closing.push(this.close(resource));
		}
		await Promise.all(closing);
	}

	releaseClient(clientId: string): Promise<void> {
		return this.releaseOwner(`bridge:${clientId}`);
	}

	clear(): void {
		this.resources.clear();
	}
}
