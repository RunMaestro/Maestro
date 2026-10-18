/**
 * Chain of thought export: the app's one writer, and what is bound to it.
 *
 * A chain has one head, and the writer holds it in memory between writes. Two
 * writers on one chain would each seal against a head the other has moved
 * past, and the chain would fork at the first record. So everything in the
 * app that writes a record, or checks a chain against the disk, goes through
 * the writer made here, bound to the app's one store.
 *
 * This feature is hidden from agents on purpose. Read the header of
 * `src/shared/cotExport/types.ts` before you change or expose anything here.
 */

import type { AgentRun } from '../../shared/agent-run';
import type { CueRunTranscript } from '../cue/cue-executor';
import { getSessionsStore } from '../stores/getters';
import { getCotConfigStore } from './config-store';
import { createCueRunCapture } from './cue-capture';
import type { CotCueRunCapture } from './cue-capture';
import { createCotLedgerRecorder } from './ledger-runs';
import type { CotLedgerRecorder } from './ledger-runs';
import { createCotWriter } from './writer';
import type { CotWriter } from './writer';

let _writer: CotWriter | null = null;

/**
 * The app's one writer, made at the first call.
 *
 * It makes the app's store, so the rule of `getCotConfigStore` holds here
 * too: do not call this before the app's `ready` event.
 *
 * A record that lands moves the stored head of its chain and the time of the
 * agent's last write. A record that is lost is kept as the agent's last error.
 */
export function getCotWriter(): CotWriter {
	if (_writer === null) {
		const store = getCotConfigStore();
		_writer = createCotWriter({
			getChainState: (agentId, folder) => store.getChainState(agentId, folder),
			onHeadAdvanced: (agentId, state) => {
				store.setChainHead(agentId, state);
				store.recordWrite(agentId, Date.now());
			},
			onError: (agentId, error) => store.recordError(agentId, error.message, Date.now()),
			now: Date.now,
		});
	}
	return _writer;
}

/** Drops the app's writer so the next call makes a new one. For tests. */
export function __resetCotWriterForTests(): void {
	_writer = null;
	_cueCapture = null;
	_ledgerRecorder = null;
}

let _cueCapture: CotCueRunCapture | null = null;

/** The Cue capture bound to the app's store and its one writer, made at first use. */
function getCueRunCapture(): CotCueRunCapture {
	if (_cueCapture === null) {
		const store = getCotConfigStore();
		_cueCapture = createCueRunCapture({
			isEnabled: (agentId) => store.isEnabled(agentId),
			getFolder: (agentId) => store.getAgentConfig(agentId).folder,
			// The writer the process listener writes through: two writers on one
			// chain would fork it at the first record.
			writer: getCotWriter(),
			onError: (agentId, error) => {
				if (agentId !== null) store.recordError(agentId, error.message, Date.now());
			},
		});
	}
	return _cueCapture;
}

/**
 * The `onRunTranscript` callback for the Cue run of `agentId` that is being
 * dispatched, or undefined when the run is not recorded. Never throws: a run
 * goes on without its record. Do not call it before the app's `ready` event.
 */
export function beginCueRunCapture(agentId: string): ((run: CueRunTranscript) => void) | undefined {
	try {
		return getCueRunCapture().begin(agentId);
	} catch {
		return undefined;
	}
}

let _ledgerRecorder: CotLedgerRecorder | null = null;

/** The provider an agent runs, from the agent list, or null for an agent that is gone. */
function toolTypeOf(agentId: string): string | null {
	const sessions: unknown = getSessionsStore().get('sessions', []);
	if (!Array.isArray(sessions)) return null;
	for (const session of sessions as Array<{ id?: unknown; toolType?: unknown } | null>) {
		if (session?.id === agentId) {
			return typeof session.toolType === 'string' ? session.toolType : null;
		}
	}
	return null;
}

/** The ledger recorder bound to the app's store and its one writer, made at first use. */
function getLedgerRecorder(): CotLedgerRecorder {
	if (_ledgerRecorder === null) {
		const store = getCotConfigStore();
		_ledgerRecorder = createCotLedgerRecorder({
			listEnabledAgents: () => store.listEnabledAgents(),
			getFolders: (agentId) => {
				const { current, past } = store.getChains(agentId);
				// With no current folder there is nowhere to write, so none is given.
				return current ? [current.folder, ...past.map((chain) => chain.folder)] : [];
			},
			getToolType: toolTypeOf,
			getSince: (agentId) => store.getLedgerSince(agentId),
			writer: getCotWriter(),
			onError: (agentId, error) => {
				if (agentId !== null) store.recordError(agentId, error.message, Date.now());
			},
		});
	}
	return _ledgerRecorder;
}

/**
 * Takes into the log the turns the command line ran outside the app (see
 * `ledger-runs.ts`). Call it when the run ledger changed, and once after the
 * app has started. `readRuns` gives the ledger, and is called only when some
 * agent is recorded. It never throws, and the work is not waited for. Do not
 * call it before the app's `ready` event.
 */
export function recordCommandLineRuns(readRuns: () => AgentRun[]): void {
	try {
		void getLedgerRecorder().recordPending(readRuns);
	} catch {
		// The store could not be made. A turn goes on without its record.
	}
}
