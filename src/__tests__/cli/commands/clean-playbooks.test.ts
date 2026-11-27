/**
 * @file clean-playbooks.test.ts
 * @description `maestro-cli clean playbooks` removes nothing it cannot prove is orphaned.
 *
 * A playbook is an orphan when its agent is not in the list the CLI read, and a removed file
 * does not come back. Before the guard, a custom Storage Location whose folder was missing made
 * `resolveSyncDir()` fall back to the data folder without a word, the agent list read empty (or
 * old), and every playbook was removed (#14). These cases run the real command over a real data
 * folder in a temp directory that `MAESTRO_USER_DATA` points at, so the whole chain is covered:
 * the bootstrap file, `resolveSyncDir()`, `readSessions()`, the refusal and the deletes. Nothing
 * here is mocked except the console and `process.exit`, and nothing can reach the real data
 * folder, because the env var wins over every platform default.
 */

import {
	describe,
	it,
	expect,
	vi,
	beforeAll,
	beforeEach,
	afterEach,
	type MockInstance,
} from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { cleanPlaybooks } from '../../../cli/commands/clean-playbooks';
import { readSessionsWithSyncResolution } from '../../../cli/services/storage';

/**
 * A Storage Location the desktop would accept by every rule (absolute, no traversal, not a
 * system folder) but that does not exist: the unmounted-drive case. It is only ever named in the
 * bootstrap file, never created.
 */
const MISSING_LOCATION = path.join(
	path.parse(os.tmpdir()).root,
	'maestro-clean-playbooks-test',
	'Storage'
);

let tmp: string;
let dataDir: string;
let savedUserData: string | undefined;
let logSpy: MockInstance;
let errorSpy: MockInstance;
let exitSpy: MockInstance;

beforeAll(() => {
	// A machine that has this folder would turn the missing-location cases into something else.
	expect(fs.existsSync(MISSING_LOCATION)).toBe(false);
});

beforeEach(() => {
	tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clean-playbooks-')));
	dataDir = path.join(tmp, 'Maestro');
	fs.mkdirSync(path.join(dataDir, 'playbooks'), { recursive: true });
	savedUserData = process.env.MAESTRO_USER_DATA;
	process.env.MAESTRO_USER_DATA = dataDir;
	logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
	// The shared Storage Location rule logs each path it refuses, so this is not only the refusal.
	errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
	exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
		throw new Error('__exit__');
	});
});

afterEach(() => {
	vi.restoreAllMocks();
	if (savedUserData === undefined) delete process.env.MAESTRO_USER_DATA;
	else process.env.MAESTRO_USER_DATA = savedUserData;
	fs.rmSync(tmp, { recursive: true, force: true });
});

/** The agent list the CLI reads, in the data folder. */
function writeAgents(...ids: string[]): void {
	const sessions = ids.map((id) => ({
		id,
		name: `Agent ${id}`,
		toolType: 'claude-code',
		cwd: tmp,
	}));
	fs.writeFileSync(path.join(dataDir, 'maestro-sessions.json'), JSON.stringify({ sessions }));
}

/** A playbook file for an agent; returns its path. */
function writePlaybook(agentId: string): string {
	const file = path.join(dataDir, 'playbooks', `${agentId}.json`);
	fs.writeFileSync(file, JSON.stringify({ playbooks: [] }));
	return file;
}

/** The settings name a Storage Location, as the desktop records it. */
function nameStorageLocation(customSyncPath: string): void {
	fs.writeFileSync(
		path.join(dataDir, 'maestro-bootstrap.json'),
		JSON.stringify({ customSyncPath })
	);
}

const printed = (spy: MockInstance): string =>
	spy.mock.calls.map((call) => String(call[0])).join('\n');

/** The last thing written to stderr: the refusal, after any line the Storage Location rule logged. */
const lastError = (): string => String(errorSpy.mock.calls[errorSpy.mock.calls.length - 1]?.[0]);

/** Run the command, expect it to refuse (exit 1), and return the refusal text. */
function runRefused(options: Parameters<typeof cleanPlaybooks>[0] = {}): string {
	expect(() => cleanPlaybooks(options)).toThrow('__exit__');
	expect(exitSpy).toHaveBeenCalledTimes(1);
	expect(exitSpy).toHaveBeenCalledWith(1);
	return lastError();
}

describe('clean playbooks: normal cleanup', () => {
	it('removes the playbooks of deleted agents and keeps the live ones', () => {
		writeAgents('live-agent');
		const live = writePlaybook('live-agent');
		const gone = writePlaybook('gone-agent');

		cleanPlaybooks({});

		expect(fs.existsSync(live)).toBe(true);
		expect(fs.existsSync(gone)).toBe(false);
		expect(printed(logSpy)).toContain('Removed 1 orphaned playbook file(s)');
		expect(exitSpy).not.toHaveBeenCalled();
	});

	it('prints the count as JSON', () => {
		writeAgents('live-agent');
		writePlaybook('live-agent');
		writePlaybook('gone-agent');

		cleanPlaybooks({ json: true });

		expect(JSON.parse(printed(logSpy))).toMatchObject({ count: 1 });
	});

	it('with --dry-run lists the orphans and removes nothing', () => {
		writeAgents('live-agent');
		const live = writePlaybook('live-agent');
		const gone = writePlaybook('gone-agent');

		cleanPlaybooks({ dryRun: true });

		expect(fs.existsSync(live)).toBe(true);
		expect(fs.existsSync(gone)).toBe(true);
		expect(printed(logSpy)).toContain('Would remove 1 orphaned playbook file(s)');
		expect(printed(logSpy)).toContain(gone);
		expect(exitSpy).not.toHaveBeenCalled();
	});

	it('with --dry-run --json lists the orphans as JSON', () => {
		writeAgents('live-agent');
		writePlaybook('live-agent');
		const gone = writePlaybook('gone-agent');

		cleanPlaybooks({ dryRun: true, json: true });

		expect(JSON.parse(printed(logSpy))).toMatchObject({
			dryRun: true,
			count: 1,
			wouldRemove: [{ sessionId: 'gone-agent', filePath: gone }],
		});
	});

	it('says so when no playbook is orphaned', () => {
		writeAgents('live-agent');
		const live = writePlaybook('live-agent');

		cleanPlaybooks({});

		expect(fs.existsSync(live)).toBe(true);
		expect(printed(logSpy)).toContain('No orphaned playbooks found');
		expect(exitSpy).not.toHaveBeenCalled();
	});

	it('is not an error when there is no playbooks folder at all', () => {
		fs.rmSync(path.join(dataDir, 'playbooks'), { recursive: true });

		cleanPlaybooks({});

		expect(printed(logSpy)).toContain('No orphaned playbooks found');
		expect(exitSpy).not.toHaveBeenCalled();
	});
});

describe('clean playbooks: an empty agent list', () => {
	it('refuses, exits 1 and removes nothing when no agent file exists', () => {
		const first = writePlaybook('agent-one');
		const second = writePlaybook('agent-two');

		const refusal = runRefused();

		expect(refusal).toContain('Nothing was removed');
		expect(refusal).toContain('found no agents');
		expect(refusal).toContain(dataDir);
		expect(refusal).toContain('all 2 playbook file(s)');
		expect(refusal).toContain('MAESTRO_USER_DATA');
		expect(refusal).toContain('--force');
		expect(fs.existsSync(first)).toBe(true);
		expect(fs.existsSync(second)).toBe(true);
	});

	it('refuses when the agent file holds an empty list', () => {
		writeAgents();
		const playbook = writePlaybook('agent-one');

		runRefused();

		expect(fs.existsSync(playbook)).toBe(true);
	});

	it('refuses a --dry-run too, and lists nothing', () => {
		const playbook = writePlaybook('agent-one');

		const refusal = runRefused({ dryRun: true });

		expect(refusal).toContain('found no agents');
		expect(printed(logSpy)).not.toContain('Would remove');
		expect(fs.existsSync(playbook)).toBe(true);
	});

	it('refuses with a JSON error on stderr and prints nothing on stdout', () => {
		const playbook = writePlaybook('agent-one');

		const refusal = runRefused({ json: true });

		expect(JSON.parse(refusal).error).toContain('found no agents');
		expect(logSpy).not.toHaveBeenCalled();
		expect(fs.existsSync(playbook)).toBe(true);
	});

	it('removes everything with --force', () => {
		const first = writePlaybook('agent-one');
		const second = writePlaybook('agent-two');

		cleanPlaybooks({ force: true });

		expect(fs.existsSync(first)).toBe(false);
		expect(fs.existsSync(second)).toBe(false);
		expect(printed(logSpy)).toContain('Removed 2 orphaned playbook file(s)');
		expect(exitSpy).not.toHaveBeenCalled();
	});

	it('with --force --dry-run lists everything and removes nothing', () => {
		const first = writePlaybook('agent-one');
		const second = writePlaybook('agent-two');

		cleanPlaybooks({ force: true, dryRun: true });

		expect(fs.existsSync(first)).toBe(true);
		expect(fs.existsSync(second)).toBe(true);
		expect(printed(logSpy)).toContain('Would remove 2 orphaned playbook file(s)');
		expect(exitSpy).not.toHaveBeenCalled();
	});

	it('does not stop a cleanup that has nothing to remove', () => {
		cleanPlaybooks({});

		expect(printed(logSpy)).toContain('No orphaned playbooks found');
		expect(exitSpy).not.toHaveBeenCalled();
	});

	it('leaves --force harmless when the agent list is not empty', () => {
		writeAgents('live-agent');
		const live = writePlaybook('live-agent');
		const gone = writePlaybook('gone-agent');

		cleanPlaybooks({ force: true });

		expect(fs.existsSync(live)).toBe(true);
		expect(fs.existsSync(gone)).toBe(false);
	});
});

describe('clean playbooks: a Storage Location that is not in use', () => {
	it('refuses when its folder is missing, even though the data folder lists an agent', () => {
		// The app keeps the agents created since the move in the missing folder. The data folder
		// holds an old copy that lists one agent, so the list is not empty and only the location
		// check can stop the removal of the newer agent's playbook.
		nameStorageLocation(MISSING_LOCATION);
		writeAgents('old-agent');
		const old = writePlaybook('old-agent');
		const newer = writePlaybook('agent-created-after-the-move');

		const refusal = runRefused();

		expect(refusal).toContain('Nothing was removed');
		expect(refusal).toContain('Storage Location');
		expect(refusal).toContain(`Custom sync path does not exist: ${MISSING_LOCATION}`);
		expect(refusal).toContain(dataDir);
		expect(refusal).toContain('Use Default');
		expect(fs.existsSync(old)).toBe(true);
		expect(fs.existsSync(newer)).toBe(true);
	});

	it('refuses a --dry-run too, and lists nothing', () => {
		nameStorageLocation(MISSING_LOCATION);
		writeAgents('old-agent');
		const newer = writePlaybook('agent-created-after-the-move');

		const refusal = runRefused({ dryRun: true });

		expect(refusal).toContain(`Custom sync path does not exist: ${MISSING_LOCATION}`);
		expect(printed(logSpy)).not.toContain('Would remove');
		expect(fs.existsSync(newer)).toBe(true);
	});

	it('refuses with a JSON error on stderr', () => {
		nameStorageLocation(MISSING_LOCATION);
		const playbook = writePlaybook('agent-one');

		const refusal = runRefused({ json: true });

		expect(JSON.parse(refusal).error).toContain(
			`Custom sync path does not exist: ${MISSING_LOCATION}`
		);
		expect(logSpy).not.toHaveBeenCalled();
		expect(fs.existsSync(playbook)).toBe(true);
	});

	it('is not overridden by --force, with an empty list or a stale one', () => {
		nameStorageLocation(MISSING_LOCATION);
		const first = writePlaybook('agent-one');

		// Empty list: --force settles the empty-list check, and the location check still stops it.
		const refusal = runRefused({ force: true });
		expect(refusal).toContain(`Custom sync path does not exist: ${MISSING_LOCATION}`);
		expect(refusal).toContain('--force does not override');
		expect(fs.existsSync(first)).toBe(true);

		// Stale list: the same, with an agent in the data folder's copy.
		exitSpy.mockClear();
		writeAgents('old-agent');
		runRefused({ force: true, dryRun: true });
		expect(fs.existsSync(first)).toBe(true);
	});

	it('refuses a location the desktop would reject, with the reason', () => {
		nameStorageLocation('relative/sync');
		const playbook = writePlaybook('agent-one');

		const refusal = runRefused();

		expect(refusal).toContain('Custom sync path must be absolute: relative/sync');
		expect(fs.existsSync(playbook)).toBe(true);
	});

	it('does not stop a cleanup that has nothing to remove', () => {
		nameStorageLocation(MISSING_LOCATION);
		writeAgents('old-agent');
		const old = writePlaybook('old-agent');

		cleanPlaybooks({});

		expect(fs.existsSync(old)).toBe(true);
		expect(printed(logSpy)).toContain('No orphaned playbooks found');
		expect(exitSpy).not.toHaveBeenCalled();
	});

	it('reads a bootstrap file that names no location as the default one', () => {
		fs.writeFileSync(path.join(dataDir, 'maestro-bootstrap.json'), JSON.stringify({}));
		writeAgents('live-agent');
		const gone = writePlaybook('gone-agent');

		cleanPlaybooks({});

		expect(fs.existsSync(gone)).toBe(false);
		expect(exitSpy).not.toHaveBeenCalled();
	});

	it('captures sessions and sync fallback status in one resolution pass', () => {
		// Create the late-mount parent outside `/tmp` and `/var`, which `isValidSyncPath()`
		// rejects as sensitive directories on Linux before checking whether the folder exists.
		const lateMountParent = fs.mkdtempSync(path.join(os.homedir(), '.maestro-clean-playbooks-'));
		const lateMount = path.join(lateMountParent, 'Storage');
		try {
			nameStorageLocation(lateMount);
			writeAgents('old-agent');

			const scan = readSessionsWithSyncResolution();
			expect(scan.sessions.map((s) => s.id)).toEqual(['old-agent']);
			expect(scan.syncDir).toBe(dataDir);
			expect(scan.fallbackReason).toContain(`Custom sync path does not exist: ${lateMount}`);

			// Even if the custom sync folder appears right after reading, the captured scan
			// preserves the fallback status of the sessions that were actually read.
			fs.mkdirSync(lateMount, { recursive: true });
			expect(scan.fallbackReason).toContain(`Custom sync path does not exist: ${lateMount}`);
		} finally {
			fs.rmSync(lateMountParent, { recursive: true, force: true });
		}
	});
});
