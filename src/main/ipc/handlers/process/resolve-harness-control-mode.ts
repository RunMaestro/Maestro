import Store from 'electron-store';
import {
	resolveHarnessControlMode,
	type HarnessControlMode,
} from '../../../../shared/maestro-lib/providers/native-control';
import type { SpawnProcessConfig } from './spawn-types';
import { findOwningSessionRecord } from './resolve-claude-spawn-context';

/** The persisted agent's choice wins over stale inline spawn data. */
export function resolveHarnessControlSpawnMode(
	config: Pick<SpawnProcessConfig, 'toolType' | 'harnessControlMode'>,
	baseSessionId: string,
	sessionsStore: Store<{ sessions: unknown[] }>,
	processSessionId = baseSessionId
): HarnessControlMode {
	const sessions = sessionsStore.get('sessions', []) as Array<{
		id?: string;
		harnessControlMode?: unknown;
	}>;
	const persisted = findOwningSessionRecord(sessions, processSessionId, baseSessionId) as
		| { harnessControlMode?: unknown }
		| undefined;
	return resolveHarnessControlMode({
		toolType: config.toolType,
		harnessControlMode: persisted ? persisted.harnessControlMode : config.harnessControlMode,
	});
}
