import { describe, it, expect } from 'vitest';
import { buildDoctorReport, formatDoctorReport, type DoctorDeps, type PathKind } from '../doctor';
import type { MaestroPaths } from '../resolve';

const NOW = Date.parse('2026-10-04T12:00:00Z');
const BOOT = NOW - 3_600_000;

const paths: MaestroPaths = {
	userDataDir: '/data/Maestro',
	productionDataDir: '/data/Maestro',
	bootstrapFile: '/data/Maestro/maestro-bootstrap.json',
	syncDir: '/data/Maestro',
	syncDirSource: 'userData',
	sessionsFile: '/data/Maestro/maestro-sessions.json',
	groupsFile: '/data/Maestro/maestro-groups.json',
	settingsFile: '/data/Maestro/maestro-settings.json',
	agentConfigsFile: '/data/Maestro/maestro-agent-configs.json',
	historyDir: '/data/Maestro/history',
	statsFile: '/data/Maestro/stats.db',
	groupChatsDir: '/data/Maestro/group-chats',
	sessionImagesDir: '/data/Maestro/session-images',
	cliServerFile: '/data/Maestro/cli-server.json',
};

const LOCK = '/data/Maestro/cue-engine.lock';

/** A fake filesystem: path -> contents (a file) or null (a directory). Anything else is missing. */
function makeDeps(
	entries: Record<string, string | null>,
	overrides: Partial<DoctorDeps> = {}
): DoctorDeps {
	return {
		readFile: (p) => {
			const value = entries[p];
			if (typeof value !== 'string') {
				throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
			}
			return value;
		},
		pathKind: (p): PathKind =>
			p in entries ? (entries[p] === null ? 'directory' : 'file') : 'missing',
		isPidAlive: () => true,
		now: () => NOW,
		bootTime: () => BOOT,
		...overrides,
	};
}

const input = {
	paths,
	rule: 'packaged default' as const,
	candidates: ['/data/Maestro', '/data/maestro'],
};

const discovery = (pid = 4242) =>
	JSON.stringify({ port: 7000, token: 'x', pid, startedAt: 1, version: '1.2.3' });

describe('buildDoctorReport', () => {
	it('is ok when the user data directory exists, and reports which stores exist', () => {
		const report = buildDoctorReport(
			input,
			makeDeps({ '/data/Maestro': null, [paths.sessionsFile]: '[]', [paths.historyDir]: null })
		);
		expect(report.ok).toBe(true);
		expect(report.userData).toMatchObject({ kind: 'directory', rule: 'packaged default' });
		const byLabel = Object.fromEntries(report.stores.map((s) => [s.label, s.kind]));
		expect(byLabel.sessions).toBe('file');
		expect(byLabel.history).toBe('directory');
		expect(byLabel.groups).toBe('missing');
	});

	it('is not ok when no data directory exists, and lists every candidate', () => {
		const report = buildDoctorReport(input, makeDeps({}));
		expect(report.ok).toBe(false);
		expect(report.tried.map((t) => t.path)).toEqual(input.candidates);
		const text = formatDoctorReport(report);
		expect(text).toContain('No Maestro data directory found');
		expect(text).toContain('/data/maestro');
	});

	it('is not ok when the path is a file', () => {
		const report = buildDoctorReport(input, makeDeps({ '/data/Maestro': '' }));
		expect(report.ok).toBe(false);
		expect(formatDoctorReport(report)).toContain('notdir');
	});

	it('carries the sync source and a rejected customSyncPath', () => {
		const report = buildDoctorReport(
			{ ...input, paths: { ...paths, customSyncPathRejection: 'it is inside /tmp' } },
			makeDeps({ '/data/Maestro': null })
		);
		expect(report.sync).toMatchObject({ source: 'userData', rejection: 'it is inside /tmp' });
		expect(formatDoctorReport(report)).toContain('customSyncPath ignored: it is inside /tmp');
	});

	describe('desktop app', () => {
		it('is not running without a discovery file or with a corrupt one', () => {
			expect(buildDoctorReport(input, makeDeps({})).desktop).toEqual({ state: 'not-running' });
			const corrupt = makeDeps({ [paths.cliServerFile]: '{oops' });
			expect(buildDoctorReport(input, corrupt).desktop).toEqual({ state: 'not-running' });
		});

		it('is running when the recorded pid is alive', () => {
			const report = buildDoctorReport(input, makeDeps({ [paths.cliServerFile]: discovery() }));
			expect(report.desktop).toMatchObject({ state: 'running', pid: 4242, port: 7000 });
			expect(formatDoctorReport(report)).toContain('running (pid 4242, port 7000, version 1.2.3)');
		});

		it('is stale when the recorded pid is gone', () => {
			const deps = makeDeps({ [paths.cliServerFile]: discovery() }, { isPidAlive: () => false });
			expect(buildDoctorReport(input, deps).desktop).toEqual({ state: 'stale', pid: 4242 });
		});
	});

	describe('cue engine lock', () => {
		const lock = (extra: Record<string, unknown> = {}) =>
			JSON.stringify({
				pid: 99,
				mode: 'standalone',
				startedAt: new Date(NOW - 60_000).toISOString(),
				heartbeatAt: new Date(NOW - 10_000).toISOString(),
				bootTime: BOOT,
				...extra,
			});

		it('is none without a lock file', () => {
			expect(buildDoctorReport(input, makeDeps({})).cueEngine).toEqual({ state: 'none' });
		});

		it('is held for a live pid with a fresh heartbeat in this boot', () => {
			const report = buildDoctorReport(input, makeDeps({ [LOCK]: lock() }));
			expect(report.cueEngine).toMatchObject({ state: 'held', pid: 99, mode: 'standalone' });
		});

		it('is stale when the pid is gone', () => {
			const deps = makeDeps({ [LOCK]: lock() }, { isPidAlive: () => false });
			expect(buildDoctorReport(input, deps).cueEngine).toMatchObject({
				state: 'stale',
				reason: 'process gone',
			});
		});

		it('is stale when written during an earlier boot', () => {
			const deps = makeDeps({ [LOCK]: lock({ bootTime: BOOT - 86_400_000 }) });
			expect(buildDoctorReport(input, deps).cueEngine).toMatchObject({
				state: 'stale',
				reason: 'earlier boot',
			});
		});

		it('is stale when the heartbeat has gone quiet, falling back to startedAt', () => {
			const quiet = lock({ heartbeatAt: new Date(NOW - 600_000).toISOString() });
			expect(buildDoctorReport(input, makeDeps({ [LOCK]: quiet })).cueEngine).toMatchObject({
				state: 'stale',
				reason: 'heartbeat quiet',
			});
			const noBeat = lock({
				heartbeatAt: undefined,
				startedAt: new Date(NOW - 600_000).toISOString(),
			});
			expect(buildDoctorReport(input, makeDeps({ [LOCK]: noBeat })).cueEngine).toMatchObject({
				state: 'stale',
				reason: 'heartbeat quiet',
			});
		});

		it('reads maestro-runtime.lock through the same rule, reporting a TUI holder', () => {
			const runtimeLock = JSON.stringify({
				pid: 812,
				mode: 'tui',
				startedAt: new Date(NOW - 60_000).toISOString(),
				heartbeatAt: new Date(NOW - 10_000).toISOString(),
				bootTime: BOOT,
			});
			const deps = makeDeps({ '/data/Maestro/maestro-runtime.lock': runtimeLock });
			const report = buildDoctorReport(input, deps);
			expect(report.runtime).toMatchObject({ state: 'held', pid: 812, mode: 'tui' });
			expect(report.cueEngine).toEqual({ state: 'none' });
			expect(formatDoctorReport(report)).toContain('held by a tui (pid 812');
		});

		it('reports no runtime lock, and a stale one with its reason', () => {
			expect(buildDoctorReport(input, makeDeps({})).runtime).toEqual({ state: 'none' });
			const deps = makeDeps(
				{
					'/data/Maestro/maestro-runtime.lock': JSON.stringify({
						pid: 5,
						mode: 'host',
						startedAt: new Date(NOW - 60_000).toISOString(),
					}),
				},
				{ isPidAlive: () => false }
			);
			expect(buildDoctorReport(input, deps).runtime).toMatchObject({
				state: 'stale',
				reason: 'process gone',
			});
		});

		it('is unreadable for corrupt JSON or a record without a pid', () => {
			expect(buildDoctorReport(input, makeDeps({ [LOCK]: '{oops' })).cueEngine).toEqual({
				state: 'unreadable',
			});
			expect(
				buildDoctorReport(input, makeDeps({ [LOCK]: JSON.stringify({ mode: 'desktop' }) }))
					.cueEngine
			).toEqual({ state: 'unreadable' });
		});
	});

	it('rethrows a read error that is not a missing file', () => {
		const deps = makeDeps(
			{},
			{
				readFile: () => {
					throw Object.assign(new Error('denied'), { code: 'EACCES' });
				},
			}
		);
		expect(() => buildDoctorReport(input, deps)).toThrow('denied');
	});
});
