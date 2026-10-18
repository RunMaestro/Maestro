import { EventEmitter } from 'node:events';
import type { HeadlessAgentActivity } from '../../shared/headlessAgentActivity';

const runs = new Map<symbol, string>();
const changes = new EventEmitter();
let revision = 0;

export function getHeadlessAgentActivity(): HeadlessAgentActivity {
	const counts: Record<string, number> = Object.create(null);
	for (const agentId of runs.values()) counts[agentId] = (counts[agentId] ?? 0) + 1;
	return { revision, counts };
}

export function hasHeadlessAgentActivity(agentId: string): boolean {
	for (const target of runs.values()) if (target === agentId) return true;
	return false;
}

/** Called only after spawn, once per provider process. The returned release is idempotent. */
export function trackHeadlessAgentActivity(agentId: string): () => void {
	const key = Symbol();
	runs.set(key, agentId);
	revision++;
	changes.emit('change');
	return () => {
		if (!runs.delete(key)) return;
		revision++;
		changes.emit('change');
	};
}

export function onHeadlessAgentActivityChange(listener: () => void): () => void {
	changes.on('change', listener);
	return () => {
		changes.off('change', listener);
	};
}
