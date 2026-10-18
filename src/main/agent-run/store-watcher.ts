/**
 * Store-file watcher for CLI-origin writes (F3 / ISC-3.1).
 *
 * Capture and the IPC handlers broadcast their own writes, but a CLI process
 * (`pianola orchestrate`, `send`, batch) writes the store files directly. When
 * the app is running, this watches the runs JSON and events JSONL and, on a
 * debounced change, re-reads and broadcasts so the dashboard reflects
 * CLI-origin writes too. Debounced so a burst of CLI writes is one refresh.
 *
 * Best-effort: a watch error is logged and swallowed; it never affects the app.
 */

import * as fs from 'fs';
import * as path from 'path';
import { getConfigDirectory } from '../../cli/services/storage';
import { readAgentRuns, readAgentRunEvents } from '../../cli/services/agent-run-store';
import type { AgentRun } from '../../shared/agent-run';
import { broadcastRunUpdated, broadcastEventAppended } from './broadcast';
import { logger } from '../utils/logger';

const RUNS_FILE = 'maestro-agent-runs.json';
const EVENTS_FILE = 'maestro-agent-run-events.jsonl';
const DEBOUNCE_MS = 150;
const LOG_CONTEXT = '[AgentRunStoreWatcher]';

export interface StoreWatcherHandle {
	stop: () => void;
}

export interface StoreWatcherOptions {
	/**
	 * Called once when the watcher starts, and after each debounced change.
	 * `readRuns` gives the runs in the ledger: after a change, the list the
	 * watcher just read; at the start, a read that is made only if it is
	 * called. So a listener with nothing to do costs no read of the file, and
	 * one that needs the runs does not read them a second time. A throw from
	 * the listener is swallowed.
	 */
	onRunsChanged?: (readRuns: () => AgentRun[]) => void;
}

export function startAgentRunStoreWatcher(options: StoreWatcherOptions = {}): StoreWatcherHandle {
	const dir = getConfigDirectory();
	const notifyRunsChanged = (readRuns: () => AgentRun[]): void => {
		try {
			options.onRunsChanged?.(readRuns);
		} catch (error) {
			logger.warn('store watch listener failed', LOG_CONTEXT, { error: String(error) });
		}
	};
	let timer: ReturnType<typeof setTimeout> | null = null;
	let lastEventCount = safeEventCount();

	const flush = (): void => {
		timer = null;
		try {
			// Broadcast the most-recently-updated run so the renderer coalesces a
			// refresh; the hook debounces and re-lists, so one signal is enough.
			const runs = readAgentRuns();
			if (runs.length > 0) {
				const newest = runs.reduce((a, b) => (a.updatedAt >= b.updatedAt ? a : b));
				broadcastRunUpdated(newest);
			}
			notifyRunsChanged(() => runs);
			const events = readAgentRunEvents();
			if (events.length > lastEventCount) {
				for (const event of events.slice(lastEventCount)) broadcastEventAppended(event);
			}
			lastEventCount = events.length;
		} catch (error) {
			logger.warn('store watch flush failed', LOG_CONTEXT, { error: String(error) });
		}
	};

	const schedule = (): void => {
		if (timer) return;
		timer = setTimeout(flush, DEBOUNCE_MS);
	};

	const watchers: fs.FSWatcher[] = [];
	for (const file of [RUNS_FILE, EVENTS_FILE]) {
		try {
			const watcher = fs.watch(path.join(dir, file), schedule);
			watcher.on('error', (error) =>
				logger.warn('store watcher error', LOG_CONTEXT, { error: String(error) })
			);
			watchers.push(watcher);
		} catch (error) {
			// The file may not exist yet; the directory-level fallback below covers it.
			logger.debug('store file watch skipped', LOG_CONTEXT, { file, error: String(error) });
		}
	}
	// Directory watch catches first-time file creation the per-file watch missed.
	try {
		const dirWatcher = fs.watch(dir, (_event, name) => {
			if (name === RUNS_FILE || name === EVENTS_FILE) schedule();
		});
		dirWatcher.on('error', () => undefined);
		watchers.push(dirWatcher);
	} catch (error) {
		logger.debug('store dir watch skipped', LOG_CONTEXT, { error: String(error) });
	}

	// Whatever changed while the app was not running was never announced.
	notifyRunsChanged(readAgentRuns);

	logger.info('AgentRun store watcher started', LOG_CONTEXT);
	return {
		stop: () => {
			clearTimeout(timer ?? undefined);
			for (const watcher of watchers) {
				try {
					watcher.close();
				} catch {
					// Already closed.
				}
			}
		},
	};
}

function safeEventCount(): number {
	try {
		return readAgentRunEvents().length;
	} catch {
		return 0;
	}
}
