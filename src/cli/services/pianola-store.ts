/**
 * Pianola CLI storage.
 *
 * Thin wrapper over the shared `createPianolaFsStore` factory: the CLI store
 * reads/writes the Maestro config dir with 2-space-indented JSON. All read /
 * validate / atomic-write / compaction logic is shared with the desktop store so
 * the two can never drift; only the data dir and JSON formatting differ here.
 */

import { getConfigDirectory } from './storage';
import type {
	RulesLoadResult,
	PianolaProfiles,
	PianolaProfileEntry,
	PianolaPlan,
	PianolaSupervisedTarget,
} from '../../shared/pianola/storage';
import { createPianolaFsStore } from '../../shared/pianola/fs-store';

export type { RulesLoadResult, PianolaProfiles, PianolaProfileEntry, PianolaPlan };
export type { PianolaSupervisedTarget };

const store = createPianolaFsStore({
	resolveDir: () => getConfigDirectory(),
	indent: 2,
	trailingNewline: true,
});

export const readPianolaRulesResult = store.readRulesResult;
export const readPianolaRules = store.readRules;
export const writePianolaRules = store.writeRules;
export const appendPianolaDecision = store.appendDecision;
export const readPianolaDecisions = store.readDecisions;
export const readPianolaProfiles = store.readProfiles;
export const writePianolaProfiles = store.writeProfiles;
export const readPianolaSuggestions = store.readSuggestions;
export const writePianolaSuggestions = store.writeSuggestions;
export const getPianolaProfile = store.getProfile;
export const setPianolaProfile = store.setProfile;
export const readPianolaPlans = store.readPlans;
export const writePianolaPlans = store.writePlans;
export const getPianolaPlan = store.getPlan;
export const upsertPianolaPlan = store.upsertPlan;
export const readPianolaSupervisorTargets = store.readSupervisorTargets;
export const writePianolaSupervisorTargets = store.writeSupervisorTargets;
export const upsertPianolaSupervisorTarget = store.upsertSupervisorTarget;
export const removePianolaSupervisorTarget = store.removeSupervisorTarget;
