/**
 * useCapabilitiesPriming.ts
 *
 * Fills the renderer's agent-capability cache for every known agent type once,
 * at app startup.
 *
 * Why this exists: `hasCapabilityCached` is synchronous and cannot fetch, so on
 * a cache miss it falls back to `DEFAULT_CAPABILITIES` - where
 * `supportsBatchMode` is `false`. The cache was only ever populated by
 * `useAgentCapabilities` mounting, and every one of its call sites is scoped to
 * the ACTIVE session. A background dispatch (`maestro-cli dispatch`) to an agent
 * type the user had not opened this renderer session therefore read "never
 * looked it up" as "unsupported" and was silently dropped.
 */

import { useEffect } from 'react';
import { primeCapabilitiesCache } from './useAgentCapabilities';
import { logger } from '../../utils/logger';

/**
 * Prime the agent capabilities cache once on mount.
 *
 * Failures are logged and swallowed - priming is an optimization, and the
 * miss-aware call sites still fetch on demand.
 */
export function useCapabilitiesPriming(): void {
	useEffect(() => {
		let cancelled = false;
		void primeCapabilitiesCache().then((primed) => {
			if (cancelled || primed === 0) return;
			logger.info(`[Capabilities] Primed capability cache for ${primed} agent types`);
		});
		return () => {
			cancelled = true;
		};
	}, []);
}
