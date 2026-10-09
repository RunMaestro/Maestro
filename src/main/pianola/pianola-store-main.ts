/**
 * Pianola main-process storage.
 *
 * Thin wrapper over the shared `createPianolaFsStore` factory: the desktop store
 * reads/writes the Maestro user-data dir with tab-indented JSON. All read /
 * validate / atomic-write / compaction logic is shared with the CLI store so the
 * two can never drift; only the data dir and JSON formatting differ here.
 * Locked writes use the async store APIs so contention with CLI writers yields
 * to the Electron event loop instead of blocking desktop IPC.
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
export const writePlansAsync = store.writePlansAsync;
export const updatePlansAsync = store.updatePlansAsync;
export const upsertPlanAsync = store.upsertPlanAsync;
export const readPrograms = store.readPrograms;
export const writePrograms = store.writePrograms;
export const upsertProgram = store.upsertProgram;
export const writeProgramsAsync = store.writeProgramsAsync;
export const updateProgramsAsync = store.updateProgramsAsync;
export const upsertProgramAsync = store.upsertProgramAsync;
export const withProgramLoopLock = store.withProgramLoopLock;
export const readAsks = store.readAsks;
export const writeAsksAsync = store.writeAsksAsync;
export const updateAsksAsync = store.updateAsksAsync;
export const readProgramLoopMemo = store.readProgramLoopMemo;
export const writeProgramLoopMemoAsync = store.writeProgramLoopMemoAsync;
export const updateProgramLoopMemoAsync = store.updateProgramLoopMemoAsync;
export const readSuggestions = store.readSuggestions;
export const writeSuggestions = store.writeSuggestions;
export const readProfiles = store.readProfiles;
export const writeProfiles = store.writeProfiles;
export const getProfile = store.getProfile;
export const setProfile = store.setProfile;
export const supervisorFilePath = store.supervisorFilePath;
export const readSupervisorTargets = store.readSupervisorTargets;
export const writeSupervisorTargetsAsync = store.writeSupervisorTargetsAsync;
export const updateSupervisorTargetsAsync = store.updateSupervisorTargetsAsync;
export const upsertSupervisorTargetAsync = store.upsertSupervisorTargetAsync;
export const removeSupervisorTargetAsync = store.removeSupervisorTargetAsync;
