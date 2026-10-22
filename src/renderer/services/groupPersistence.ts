/**
 * Writing the group list to disk, and waiting for it.
 *
 * The store's own persistence runs from a React effect, so it lands after a
 * remote listener has already answered its caller. A CLI that verifies its
 * write by reading `maestro-groups.json` back would then see the pre-update
 * list and report a false mismatch. Flushing before responding makes the
 * readback deterministic; the effect's later write is the same data and is
 * idempotent.
 */

import type { Group } from '../../shared/types';
import { logger } from '../utils/logger';

export async function flushGroupsToDisk(groups: Group[]): Promise<void> {
	try {
		await window.maestro.groups.setAll(groups);
	} catch (error) {
		logger.error('[Remote] Failed to persist group change:', undefined, error);
	}
}
