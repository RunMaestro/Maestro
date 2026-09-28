#!/usr/bin/env node
/**
 * Repair Auto Run durations that the old visibility-gated clock under-recorded.
 *
 * `useTimeTracking` used to stop counting whenever the Maestro window was
 * hidden, which in Electron on macOS includes "minimized" and "fully covered by
 * another app". The agent runs in its own process and keeps working, so what
 * got written into `auto_run_sessions.duration` was the user's attention rather
 * than the run's length. Unattended runs - the ones whose duration matters
 * most - came out shortest, and some came out as exactly zero.
 *
 * The clock is fixed going forward. This repairs what is already on disk.
 *
 * ## Where the replacement number comes from
 *
 * Each session's own tasks are timestamped independently in `auto_run_tasks`
 * (`start_time` + `duration` per task), and those were never visibility-gated.
 * So a session's real span is:
 *
 *     max(task.start_time + task.duration) - session.start_time
 *
 * That is a FLOOR, not the exact figure: it ends at the last task the run
 * recorded, so anything after it (the final synopsis, a task that failed before
 * it could be written) is not counted. Under-repairing is the right direction
 * for a number that also feeds a public leaderboard.
 *
 * Two deliberate limits:
 *
 * - A session is only ever raised, never lowered. If the stored duration is
 *   already longer than its tasks imply, the tasks are the incomplete record
 *   and the stored value stands.
 * - A session with no task rows at all cannot be repaired by this method and is
 *   left alone. The script reports how many, so the gap is visible rather than
 *   silently rounded away.
 *
 * ## Usage
 *
 *   node scripts/repair-autorun-durations.mjs             # dry run, prints a report
 *   node scripts/repair-autorun-durations.mjs --apply     # writes, after a backup
 *   node scripts/repair-autorun-durations.mjs --db <path> # non-default location
 *
 * Quit Maestro before `--apply`. The app holds the database open and caches
 * aggregates; repairing underneath a live process means the running app keeps
 * serving the old numbers until it is restarted anyway.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const APPLY = process.argv.includes('--apply');
const dbFlag = process.argv.indexOf('--db');
const DB =
	dbFlag !== -1 && process.argv[dbFlag + 1]
		? process.argv[dbFlag + 1]
		: path.join(homedir(), 'Library', 'Application Support', 'maestro', 'stats.db');

/** Run one statement through the sqlite3 CLI and return stdout. */
function sql(query, { readonly = true } = {}) {
	// `file:...?mode=ro` keeps a dry run from taking a write lock on a database
	// the app may still have open.
	const target = readonly ? `file:${DB}?mode=ro` : DB;
	return execFileSync('sqlite3', ['-cmd', '.timeout 5000', target, query], {
		encoding: 'utf8',
		maxBuffer: 64 * 1024 * 1024,
	});
}

function hours(ms) {
	return (ms / 3_600_000).toFixed(2) + 'h';
}

if (!existsSync(DB)) {
	console.error(`No stats database at ${DB}`);
	process.exit(1);
}

// One row per session that HAS tasks, with the span its tasks imply.
const rows = sql(`
	SELECT s.id, s.duration, MAX(t.start_time + t.duration) - s.start_time AS wall,
	       date(s.start_time / 1000, 'unixepoch'), COALESCE(s.document_path, '')
	FROM auto_run_sessions s
	JOIN auto_run_tasks t ON t.auto_run_session_id = s.id
	GROUP BY s.id
	ORDER BY wall DESC
`)
	.trim()
	.split('\n')
	.filter(Boolean)
	.map((line) => {
		const [id, duration, wall, day, doc] = line.split('|');
		return {
			id,
			duration: Number(duration),
			wall: Number(wall),
			day,
			doc: (doc.split('/').pop() || '').slice(0, 34),
		};
	});

const repairs = rows.filter((r) => r.wall > r.duration);
const gained = repairs.reduce((sum, r) => sum + (r.wall - r.duration), 0);
const zeros = repairs.filter((r) => r.duration === 0).length;

const noTasks = Number(
	sql(`
	SELECT COUNT(*) FROM auto_run_sessions s
	WHERE NOT EXISTS (SELECT 1 FROM auto_run_tasks t WHERE t.auto_run_session_id = s.id)
`).trim()
);

console.log(`Database: ${DB}`);
console.log(`Sessions with tasks: ${rows.length}`);
console.log(`Under-recorded:      ${repairs.length}  (${zeros} of them recorded as zero)`);
console.log(`Time to restore:     ${hours(gained)}`);
console.log(`Unrepairable:        ${noTasks} sessions have no task rows\n`);

console.log('Largest corrections:');
for (const r of repairs.slice(0, 10)) {
	console.log(
		`  ${r.day}  ${hours(r.duration).padStart(8)} -> ${hours(r.wall).padStart(8)}   ${r.doc}`
	);
}

if (!APPLY) {
	console.log('\nDry run. Re-run with --apply to write these corrections.');
	process.exit(0);
}

const backup = `${DB}.backup.pre-duration-repair.${Date.now()}`;
copyFileSync(DB, backup);
console.log(`\nBacked up to ${backup}`);

// One UPDATE over the join rather than a statement per row: the whole repair is
// a single transaction, so an interrupted run leaves the database untouched
// instead of half-corrected.
sql(
	`
	BEGIN IMMEDIATE;
	UPDATE auto_run_sessions AS s
	SET duration = (
		SELECT MAX(t.start_time + t.duration) - s.start_time
		FROM auto_run_tasks t WHERE t.auto_run_session_id = s.id
	)
	WHERE EXISTS (SELECT 1 FROM auto_run_tasks t WHERE t.auto_run_session_id = s.id)
	  AND (SELECT MAX(t.start_time + t.duration) - s.start_time
	       FROM auto_run_tasks t WHERE t.auto_run_session_id = s.id) > s.duration;
	COMMIT;
`,
	{ readonly: false }
);

const longest = Number(sql(`SELECT MAX(duration) FROM auto_run_sessions`).trim());
console.log(`Repaired ${repairs.length} sessions. Longest run is now ${hours(longest)}.`);
