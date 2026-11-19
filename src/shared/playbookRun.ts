/**
 * What a saved playbook record turns into when it runs: the loop ceiling an
 * import applies, and the `BatchRunPlaybook` block a `BatchRunConfig` carries
 * so the Auto Run engine can resolve the playbook's `[NAME]` parameters and
 * name the playbook in its stats row.
 *
 * Shared by the marketplace import (main), the Auto Run panel's Go button, and
 * the Playbook Exchange's Run button, so the three never disagree on what a
 * run of a given record means.
 */

import type { PlaybookParamValues } from './playbookParams';
import type { BatchRunPlaybook, Playbook } from './types';

/**
 * The loop ceiling an imported playbook gets when its manifest asks for
 * unlimited loops (`maxLoops: null`). One click must never start an unbounded
 * run on someone else's documents; the user can raise it before Run.
 */
export const IMPORTED_MAX_LOOPS_CEILING = 10;

/**
 * The `maxLoops` an import stores. A looping playbook with no finite bound
 * (`null`, `undefined`, zero, or a negative number) is capped at
 * `IMPORTED_MAX_LOOPS_CEILING`. A non-looping playbook keeps what it shipped,
 * since its bound is never read.
 */
export function clampImportedMaxLoops(
	loopEnabled: boolean,
	maxLoops: number | null | undefined
): number | null | undefined {
	if (!loopEnabled) return maxLoops;
	if (typeof maxLoops === 'number' && Number.isFinite(maxLoops) && maxLoops > 0) return maxLoops;
	return IMPORTED_MAX_LOOPS_CEILING;
}

/** True when the manifest's loop bound is one `clampImportedMaxLoops` replaces. */
export function isUnboundedLoop(
	loopEnabled: boolean,
	maxLoops: number | null | undefined
): boolean {
	return clampImportedMaxLoops(loopEnabled, maxLoops) !== maxLoops;
}

/**
 * The `playbook` block of a `BatchRunConfig` for a saved record.
 *
 * @param ownerSessionId The agent whose playbook store holds the record.
 * @param parameterValues The answers the run resolves with, when the launcher
 *   has fresher ones than the record (the Exchange's sheet adds its Detected
 *   proposals). Defaults to the record's stored answers.
 */
export function toBatchRunPlaybook(
	playbook: Playbook,
	ownerSessionId: string,
	parameterValues: PlaybookParamValues | undefined = playbook.parameterValues
): BatchRunPlaybook {
	return {
		id: playbook.id,
		ownerSessionId,
		...(playbook.provenance?.marketplaceId && {
			marketplaceId: playbook.provenance.marketplaceId,
		}),
		...(playbook.provenance?.sourceVersion && {
			sourceVersion: playbook.provenance.sourceVersion,
		}),
		...(playbook.parameterOverlay && { parameterOverlay: playbook.parameterOverlay }),
		...(parameterValues && { parameterValues }),
	};
}
