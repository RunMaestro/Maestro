/**
 * Pianola main-process storage.
 *
 * Thin wrapper over the shared `createPianolaFsStore` factory: the desktop store
 * reads/writes the Maestro user-data dir with tab-indented JSON. All read /
 * validate / atomic-write / compaction logic is shared with the CLI store so the
 * two can never drift; only the data dir and JSON formatting differ here.
 */

import { app } from 'electron';
import * as path from 'path';
import type {
	RulesLoadResult,
	PianolaPlan,
	PianolaSupervisedTarget,
} from '../../shared/pianola/storage';
import { createPianolaFsStore } from '../../shared/pianola/fs-store';

export type { RulesLoadResult, PianolaPlan, PianolaSupervisedTarget };

/** Resolve the Maestro data dir, matching the CLI's getConfigDir semantics. */
function pianolaDir(): string {
	if (process.env.MAESTRO_USER_DATA) return path.resolve(process.env.MAESTRO_USER_DATA);
	return app.getPath('userData');
}

const store = createPianolaFsStore({
	resolveDir: pianolaDir,
	indent: '\t',
	trailingNewline: false,
});

export const readRulesResult = store.readRulesResult;
export const readRules = store.readRules;
export const writeRules = store.writeRules;
export const appendDecision = store.appendDecision;
export const readDecisions = store.readDecisions;
export const readPlans = store.readPlans;
export const writePlans = store.writePlans;
export const getPlan = store.getPlan;
export const upsertPlan = store.upsertPlan;
export const readSuggestions = store.readSuggestions;
export const writeSuggestions = store.writeSuggestions;
export const readProfiles = store.readProfiles;
export const writeProfiles = store.writeProfiles;
export const getProfile = store.getProfile;
export const setProfile = store.setProfile;
export const supervisorFilePath = store.supervisorFilePath;
export const readSupervisorTargets = store.readSupervisorTargets;
export const writeSupervisorTargets = store.writeSupervisorTargets;
export const upsertSupervisorTarget = store.upsertSupervisorTarget;
export const removeSupervisorTarget = store.removeSupervisorTarget;
