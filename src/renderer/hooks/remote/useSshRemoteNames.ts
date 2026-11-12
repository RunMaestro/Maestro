import { useEffect, useState } from 'react';
import { ipcCache } from '../../services/ipcWrapper';
import { logger } from '../../utils/logger';

/** Shared cache key with {@link useSshRemotes} so both share one IPC round trip. */
const SSH_CONFIGS_CACHE_KEY = 'ssh-configs';
const SSH_CONFIGS_TTL_MS = 30000;

const EMPTY_NAMES: ReadonlyMap<string, string> = new Map();

/**
 * Remote id -> display name, for surfaces that label MANY agents at once (the
 * `@` mention picker, agent lists) and only need the name.
 *
 * {@link useSshRemotes} is the full CRUD hook and `useSshRemoteName` resolves a
 * SINGLE session's remote; neither fits a list, where one lookup table beats N
 * per-row fetches. This reads through the same `ssh-configs` ipcCache entry, so
 * mounting it alongside those hooks costs no extra IPC.
 *
 * Returns an empty map until the configs load. Callers should render a neutral
 * "SSH" label in that window rather than treating the agent as local.
 */
export function useSshRemoteNames(): ReadonlyMap<string, string> {
	const [names, setNames] = useState<ReadonlyMap<string, string>>(EMPTY_NAMES);

	useEffect(() => {
		let mounted = true;

		ipcCache
			.getOrFetch(
				SSH_CONFIGS_CACHE_KEY,
				() => window.maestro.sshRemote.getConfigs(),
				SSH_CONFIGS_TTL_MS
			)
			.then((result) => {
				if (!mounted) return;
				if (!result.success || !result.configs) return;
				setNames(new Map(result.configs.map((c) => [c.id, c.name])));
			})
			.catch((error) => {
				// Non-fatal: rows fall back to the generic "SSH" label.
				logger.error('[useSshRemoteNames] Failed to load SSH remote configs:', undefined, error);
			});

		return () => {
			mounted = false;
		};
	}, []);

	return names;
}
