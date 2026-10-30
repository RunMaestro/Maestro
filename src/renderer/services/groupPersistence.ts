import { useSessionStore } from '../stores/sessionStore';
import { logger } from '../utils/logger';

let pending: Promise<boolean> = Promise.resolve(true);

/** Serialize effect and command flushes; only acknowledged snapshots become baselines. */
export function flushGroupsToDisk(): Promise<boolean> {
	pending = pending.then(async () => {
		const { groups, groupsLoaded, groupPersistenceBaseline } = useSessionStore.getState();
		if (!groupsLoaded) return false;
		if (groups === groupPersistenceBaseline) return true;
		try {
			if (!(await window.maestro.groups.setAll(groups, groupPersistenceBaseline))) {
				throw new Error('Host rejected group persistence');
			}
			useSessionStore.setState({ groupPersistenceBaseline: groups });
			return true;
		} catch (error) {
			logger.error('Failed to persist group changes:', undefined, error);
			return false;
		}
	});
	return pending;
}
