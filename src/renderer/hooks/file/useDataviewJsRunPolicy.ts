/**
 * useDataviewJsRunPolicy - what a `dataviewjs` block in a note does (D3, DV-12, DV-14).
 *
 * The decision is `dataviewJsRunPolicy()` (`src/shared/dataview/trust.ts`) over the Encore Feature, the
 * DataviewJS setting, the trust list, the note's vault root, and the browser build. The root comes from
 * main (`dataview:jsRoot`), spelled the way the trust list compares it, and is cached per note at module
 * scope, so a remounted block in a trusted vault repaints its guest instead of flashing the trust prompt.
 * Main is asked only while the policy could be `ask` or `run`.
 */

import {
	dataviewJsRunPolicy,
	type DataviewJsRoot,
	type DataviewJsRunPolicy,
} from '../../../shared/dataview';
import { useSettingsStore } from '../../stores/settingsStore';
import { isWebDesktop } from '../../utils/runtimeContext';
import { useCachedResource } from '../utils/useCachedResource';

export interface DataviewJsRunState {
	policy: DataviewJsRunPolicy;
	/** The note's vault root, once main has named it. */
	root: string | null;
	/** True while main is still naming the root: show a placeholder, neither the prompt nor the guest. */
	resolving: boolean;
	/** Why main could not name the root, when it could not. */
	error: string | null;
}

/** The cache key of a note's vault root. */
export function dataviewJsRootCacheKey(agentId: string, filePath: string): string {
	return JSON.stringify(['dataview:jsRoot', agentId, filePath]);
}

export function useDataviewJsRunPolicy(note: {
	agentId: string;
	filePath: string;
}): DataviewJsRunState {
	const encoreOn = useSettingsStore((s) => s.encoreFeatures?.dataview === true);
	const jsEnabled = useSettingsStore((s) => s.dataviewJsEnabled);
	const trustedRoots = useSettingsStore((s) => s.dataviewJsTrustedRoots);
	const webDesktop = isWebDesktop();
	const needsRoot = encoreOn && jsEnabled && !webDesktop;

	const { agentId, filePath } = note;
	const resource = useCachedResource<DataviewJsRoot>(
		needsRoot ? dataviewJsRootCacheKey(agentId, filePath) : null,
		() => window.maestro.dataview.jsRoot({ agentId, filePath })
	);
	const root = needsRoot ? (resource.data?.root ?? null) : null;

	return {
		policy: dataviewJsRunPolicy({
			encoreOn,
			jsEnabled,
			trustedRoots,
			root,
			isWebDesktop: webDesktop,
		}),
		root,
		resolving: needsRoot && resource.loading,
		error: needsRoot && root === null ? resource.error : null,
	};
}
