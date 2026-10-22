import { randomUUID } from 'node:crypto';
import type { BootstrapSettings } from '../stores/types';

interface HostIdentityStore {
	get(key: 'maestroRemoteInstanceId'): BootstrapSettings['maestroRemoteInstanceId'];
	set(key: 'maestroRemoteInstanceId', value: string): void;
}

/** Local bootstrap storage follows userData, unlike synchronized installationId. */
export function getOrCreateHostInstanceId(store: HostIdentityStore): string {
	const existing = store.get('maestroRemoteInstanceId');
	if (typeof existing === 'string' && existing.length > 0) return existing;
	const id = randomUUID();
	// Persistence failure must fail the handshake rather than advertise an ephemeral identity.
	store.set('maestroRemoteInstanceId', id);
	return id;
}
