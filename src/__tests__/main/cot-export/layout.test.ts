/**
 * Tests for main/cot-export/layout.ts.
 *
 * Every test that writes uses its own fresh directory under the OS temp
 * dir and builds paths with `path.join`. None of them reads or writes the
 * user's real data.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	countTurnFilesOnDay,
	isTurnFileNameOf,
	listTurnFilesOnDay,
	isSameFolder,
	listTurnFiles,
	turnFileFolder,
	turnFilePath,
	validateAgentFolder,
} from '../../../main/cot-export/layout';

describe('turnFilePath', () => {
	const base = path.join(os.tmpdir(), 'agent-log');

	it('buckets by LOCAL time, zero-padded, under the hour the turn started', () => {
		// Built from local components, so the assertion holds in any time zone.
		const start = new Date(2026, 0, 2, 3, 4, 5);
		const file = turnFilePath(base, start, 'tab-12345678-extra', 'turn-abcdefgh-extra');
		expect(file).toBe(path.join(base, '2026', '01', '02', '03', '030405-tab-1234-turn-abc.jsonl'));
	});

	it('cuts the tab id and the turn id to eight characters each', () => {
		const start = new Date(2026, 9, 10, 14, 30, 59);
		const file = turnFilePath(base, start, 'abcdefghijkl', '0123456789ab');
		expect(path.basename(file)).toBe('143059-abcdefgh-01234567.jsonl');
		expect(path.dirname(file)).toBe(path.join(base, '2026', '10', '10', '14'));
	});

	it('names a turn with no tab "notab"', () => {
		const start = new Date(2026, 9, 10, 0, 0, 0);
		const file = turnFilePath(base, start, undefined, 'turn0001-rest');
		expect(path.basename(file)).toBe('000000-notab-turn0001.jsonl');
	});

	it('falls back to "notab" for a tab id with nothing safe in it', () => {
		const start = new Date(2026, 9, 10, 0, 0, 0);
		const file = turnFilePath(base, start, '../..', 'turn0001');
		expect(path.basename(file)).toBe('000000-notab-turn0001.jsonl');
	});

	it('keeps a hostile id inside the hour folder', () => {
		const start = new Date(2026, 9, 10, 9, 8, 7);
		const file = turnFilePath(base, start, '../../etc', '..\\..\\x');
		expect(path.dirname(file)).toBe(path.join(base, '2026', '10', '10', '09'));
		expect(path.basename(file)).not.toMatch(/[\\/]/);
	});

	it('files a turn under the hour it started, not the hour it ends', () => {
		const lateInHour = new Date(2026, 5, 15, 23, 59, 59);
		const file = turnFilePath(base, lateInHour, 'tab', 'turn');
		expect(path.dirname(file)).toBe(path.join(base, '2026', '06', '15', '23'));
	});
});

describe('turnFileFolder', () => {
	it('gives back the agent folder a turn file was built under', () => {
		const base = path.join(os.tmpdir(), 'agent-log');
		const file = turnFilePath(base, new Date(2026, 9, 10, 14, 30, 59), 'tab', 'turn');
		expect(turnFileFolder(file)).toBe(base);
	});

	it('keeps two agent folders apart when one lies inside the other', () => {
		const outer = path.join(os.tmpdir(), 'agent-log');
		const inner = path.join(outer, 'agent-a');
		const start = new Date(2026, 9, 10, 14, 30, 59);
		expect(turnFileFolder(turnFilePath(outer, start, 'tab', 'turn'))).toBe(outer);
		expect(turnFileFolder(turnFilePath(inner, start, 'tab', 'turn'))).toBe(inner);
	});
});

describe('listTurnFiles', () => {
	let folder: string;

	/** Creates an empty turn file and returns its path. */
	const touch = (start: Date, turnId: string): string => {
		const file = turnFilePath(folder, start, 'tab', turnId);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, '');
		return file;
	};

	beforeEach(() => {
		folder = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cot-list-')));
	});

	afterEach(() => {
		fs.rmSync(folder, { recursive: true, force: true });
	});

	it('lists every turn file, newest first by the time the turn started', async () => {
		const oldest = touch(new Date(2025, 11, 31, 23, 59, 59), 'turn-a');
		const earlier = touch(new Date(2026, 9, 10, 9, 0, 0), 'turn-b');
		const later = touch(new Date(2026, 9, 10, 9, 30, 0), 'turn-c');
		const newest = touch(new Date(2026, 9, 10, 14, 0, 0), 'turn-d');
		expect(await listTurnFiles(folder)).toEqual([newest, later, earlier, oldest]);
	});

	it('leaves out everything that is not part of the layout', async () => {
		const turn = touch(new Date(2026, 9, 10, 9, 0, 0), 'turn-a');
		const hourDir = path.dirname(turn);
		fs.writeFileSync(path.join(hourDir, '.maestro-write-probe-1-abc'), '');
		fs.writeFileSync(path.join(hourDir, '.hidden.jsonl'), '');
		fs.writeFileSync(path.join(hourDir, 'notes.txt'), '');
		fs.mkdirSync(path.join(hourDir, 'folder.jsonl'));
		fs.mkdirSync(path.join(folder, 'not-a-year', '10', '10', '09'), { recursive: true });
		fs.writeFileSync(path.join(folder, 'not-a-year', '10', '10', '09', 'stray.jsonl'), '');
		fs.writeFileSync(path.join(folder, 'stray.jsonl'), '');
		expect(await listTurnFiles(folder)).toEqual([turn]);
	});

	it('stops after the newest hour folders that hold a turn file', async () => {
		touch(new Date(2026, 9, 10, 8, 0, 0), 'turn-a');
		const second = touch(new Date(2026, 9, 10, 9, 0, 0), 'turn-b');
		const thirdA = touch(new Date(2026, 9, 10, 10, 0, 0), 'turn-c');
		const thirdB = touch(new Date(2026, 9, 10, 10, 5, 0), 'turn-d');
		// An empty hour folder does not count toward the limit.
		fs.mkdirSync(path.join(folder, '2026', '10', '10', '11'));
		expect(await listTurnFiles(folder, { newestHourFolders: 2 })).toEqual([thirdB, thirdA, second]);
	});

	it('finds nothing in a folder that is empty or does not exist', async () => {
		expect(await listTurnFiles(folder)).toEqual([]);
		expect(await listTurnFiles(path.join(folder, 'missing'))).toEqual([]);
	});
});

describe('countTurnFilesOnDay', () => {
	let folder: string;

	const touch = (start: Date, turnId: string): string => {
		const file = turnFilePath(folder, start, 'tab', turnId);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, '');
		return file;
	};

	beforeEach(() => {
		folder = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cot-count-')));
	});

	afterEach(() => {
		fs.rmSync(folder, { recursive: true, force: true });
	});

	it('counts the turns filed under that LOCAL date, across its hour folders', async () => {
		touch(new Date(2026, 9, 10, 0, 0, 1), 'turn-a');
		touch(new Date(2026, 9, 10, 9, 0, 0), 'turn-b');
		touch(new Date(2026, 9, 10, 9, 30, 0), 'turn-c');
		touch(new Date(2026, 9, 10, 23, 59, 59), 'turn-d');
		// The day before and the day after are other days.
		touch(new Date(2026, 9, 9, 23, 59, 59), 'turn-e');
		touch(new Date(2026, 9, 11, 0, 0, 0), 'turn-f');
		expect(await countTurnFilesOnDay(folder, new Date(2026, 9, 10, 15, 0, 0))).toBe(4);
		expect(await countTurnFilesOnDay(folder, new Date(2026, 9, 9, 1, 0, 0))).toBe(1);
	});

	it('counts only turn files', async () => {
		const turn = touch(new Date(2026, 9, 10, 9, 0, 0), 'turn-a');
		const hourDir = path.dirname(turn);
		fs.writeFileSync(path.join(hourDir, '.maestro-write-probe-1-abc'), '');
		fs.writeFileSync(path.join(hourDir, 'notes.txt'), '');
		fs.mkdirSync(path.join(path.dirname(hourDir), 'not-an-hour'));
		fs.writeFileSync(path.join(path.dirname(hourDir), 'not-an-hour', 'stray.jsonl'), '');
		expect(await countTurnFilesOnDay(folder, new Date(2026, 9, 10))).toBe(1);
	});

	it('counts none for a day, or a folder, that does not exist', async () => {
		expect(await countTurnFilesOnDay(folder, new Date(2026, 9, 10))).toBe(0);
		expect(await countTurnFilesOnDay(path.join(folder, 'missing'), new Date(2026, 9, 10))).toBe(0);
	});
});

describe('isSameFolder', () => {
	const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
	const setPlatform = (value: string): void => {
		Object.defineProperty(process, 'platform', { value, configurable: true });
	};
	const base = path.join(os.tmpdir(), 'Cot-Same');

	afterEach(() => {
		if (realPlatform) Object.defineProperty(process, 'platform', realPlatform);
	});

	it('takes the same path, and another spelling of it, as one folder', () => {
		expect(isSameFolder(base, base)).toBe(true);
		expect(isSameFolder(base, path.join(base, 'logs', '..'))).toBe(true);
		expect(isSameFolder(base, `${base}${path.sep}`)).toBe(true);
	});

	it('keeps a folder apart from one inside it and from one that shares its start', () => {
		expect(isSameFolder(base, path.join(base, 'logs'))).toBe(false);
		expect(isSameFolder(base, `${base}-other`)).toBe(false);
	});

	it('ignores case on macOS and Windows, and not on Linux', () => {
		const shouted = path.join(path.dirname(base), path.basename(base).toUpperCase());
		setPlatform('darwin');
		expect(isSameFolder(base, shouted)).toBe(true);
		setPlatform('win32');
		expect(isSameFolder(base, shouted)).toBe(true);
		setPlatform('linux');
		expect(isSameFolder(base, shouted)).toBe(false);
	});
});

describe('listTurnFilesOnDay and isTurnFileNameOf', () => {
	let folder: string;

	beforeEach(() => {
		folder = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cot-layout-day-')));
	});

	afterEach(() => {
		fs.rmSync(folder, { recursive: true, force: true });
	});

	const touch = (file: string): string => {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, '');
		return file;
	};

	it('lists the turn files of every hour of one local date, and no other', async () => {
		const day = new Date(2026, 9, 10, 12, 0, 0);
		const morning = touch(turnFilePath(folder, new Date(2026, 9, 10, 9, 5, 0), 'tab-1', 'turn-a'));
		const night = touch(
			turnFilePath(folder, new Date(2026, 9, 10, 23, 59, 59), undefined, 'turn-b')
		);
		touch(turnFilePath(folder, new Date(2026, 9, 11, 0, 0, 0), undefined, 'turn-c'));
		touch(turnFilePath(folder, new Date(2026, 9, 9, 23, 0, 0), undefined, 'turn-d'));
		// Not turn files: a dotfile, and a file of another kind.
		touch(path.join(path.dirname(morning), '.probe.jsonl'));
		touch(path.join(path.dirname(morning), 'notes.txt'));

		expect((await listTurnFilesOnDay(folder, day)).sort()).toEqual([morning, night].sort());
		expect(await countTurnFilesOnDay(folder, day)).toBe(2);
	});

	it('lists nothing for a date with no folder', async () => {
		expect(await listTurnFilesOnDay(folder, new Date(2026, 0, 1))).toEqual([]);
	});

	it('knows the file of a turn by its name, whatever time it is filed under', () => {
		const turnId = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
		const here = turnFilePath(folder, new Date(2026, 9, 10, 9, 5, 0), undefined, turnId);
		const there = turnFilePath(folder, new Date(2026, 9, 11, 3, 44, 12), 'tab-9', turnId);
		expect(isTurnFileNameOf(here, turnId)).toBe(true);
		expect(isTurnFileNameOf(there, turnId)).toBe(true);

		const other = turnFilePath(
			folder,
			new Date(2026, 9, 10, 9, 5, 0),
			undefined,
			'ffffffff00000000'
		);
		expect(isTurnFileNameOf(other, turnId)).toBe(false);
		// Only the start of a turn id is in a name, so this alone is not proof.
		expect(isTurnFileNameOf(here, 'a1b2c3d4-another-turn')).toBe(true);
	});
});

describe('validateAgentFolder', () => {
	let sandbox: string;
	let workspace: string;
	let userData: string;
	let home: string;

	const context = (extra: string[] = []) => ({
		agentDirs: [workspace, ...extra],
		userDataPath: userData,
		homeDir: home,
	});

	beforeEach(() => {
		sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cot-layout-')));
		workspace = path.join(sandbox, 'workspace');
		userData = path.join(sandbox, 'userdata');
		home = path.join(sandbox, 'home');
		fs.mkdirSync(workspace);
		fs.mkdirSync(userData);
		fs.mkdirSync(home);
	});

	afterEach(() => {
		fs.rmSync(sandbox, { recursive: true, force: true });
	});

	it('accepts a folder outside every workspace and returns its real path', () => {
		const target = path.join(sandbox, 'logs', 'agent-a');
		const result = validateAgentFolder(target, context());
		expect(result).toEqual({ ok: true, resolved: target });
		expect(fs.statSync(target).isDirectory()).toBe(true);
	});

	it('accepts a folder inside the home folder', () => {
		const target = path.join(home, 'cot-logs');
		const result = validateAgentFolder(target, context());
		expect(result.ok).toBe(true);
	});

	it('leaves an accepted folder free of the probe file', () => {
		const target = path.join(sandbox, 'logs');
		expect(validateAgentFolder(target, context()).ok).toBe(true);
		expect(fs.readdirSync(target)).toEqual([]);
	});

	it('rejects a relative path', () => {
		const result = validateAgentFolder(path.join('relative', 'logs'), context());
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toMatch(/absolute/i);
	});

	it('rejects an empty path', () => {
		const result = validateAgentFolder('   ', context());
		expect(result.ok).toBe(false);
	});

	it('rejects the root of the file system', () => {
		const root = path.parse(os.tmpdir()).root;
		const result = validateAgentFolder(root, context());
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toMatch(/root/i);
	});

	it('rejects the home folder itself', () => {
		const result = validateAgentFolder(home, context());
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toMatch(/home/i);
	});

	it('rejects a folder equal to an agent cwd', () => {
		const result = validateAgentFolder(workspace, context());
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toMatch(/workspace/i);
	});

	it('rejects a folder inside an agent cwd and does not create it', () => {
		const target = path.join(workspace, 'logs', 'deep');
		const result = validateAgentFolder(target, context());
		expect(result.ok).toBe(false);
		expect(fs.existsSync(target)).toBe(false);
	});

	it("rejects a folder inside ANOTHER agent's projectRoot", () => {
		const otherRoot = path.join(sandbox, 'other-project');
		fs.mkdirSync(otherRoot);
		const result = validateAgentFolder(path.join(otherRoot, 'logs'), context([otherRoot]));
		expect(result.ok).toBe(false);
	});

	it('names the agent whose workspace holds the folder', () => {
		const named = {
			agentDirs: [{ path: workspace, agentName: 'Pianola' }],
			userDataPath: userData,
			homeDir: home,
		};
		const inside = validateAgentFolder(path.join(workspace, 'logs'), named);
		expect(inside.ok).toBe(false);
		if (!inside.ok) {
			expect(inside.reason).toBe(
				`The folder is inside the workspace of Pianola (${workspace}), where that agent could read it.`
			);
		}
		const around = validateAgentFolder(sandbox, {
			...named,
			userDataPath: path.join(path.dirname(sandbox), 'cot-layout-elsewhere', 'data'),
		});
		expect(around.ok).toBe(false);
		if (!around.ok) expect(around.reason).toMatch(/contains the workspace of Pianola/);
	});

	it('lets a folder inside the home folder through when an agent works in the home folder', () => {
		const homeAgent = {
			agentDirs: [workspace, { path: home, agentName: 'Pianola' }],
			userDataPath: userData,
			homeDir: home,
		};
		const target = path.join(home, 'Pedsidian-Audit');
		expect(validateAgentFolder(target, homeAgent)).toEqual({ ok: true, resolved: target });
		// The home folder itself is still refused.
		expect(validateAgentFolder(home, homeAgent).ok).toBe(false);
		// A narrower workspace inside the home folder still fences off its own folders.
		const project = path.join(home, 'project');
		fs.mkdirSync(project);
		const nested = validateAgentFolder(path.join(project, 'logs'), {
			...homeAgent,
			agentDirs: [...homeAgent.agentDirs, project],
		});
		expect(nested.ok).toBe(false);
	});

	it('does not treat a sibling with a shared name prefix as inside', () => {
		const sibling = path.join(sandbox, 'workspace-logs');
		const result = validateAgentFolder(sibling, context());
		expect(result).toEqual({ ok: true, resolved: sibling });
	});

	it('rejects a folder equal to or inside the Maestro data folder', () => {
		expect(validateAgentFolder(userData, context()).ok).toBe(false);
		const inside = validateAgentFolder(path.join(userData, 'logs'), context());
		expect(inside.ok).toBe(false);
		if (!inside.ok) expect(inside.reason).toMatch(/data folder/i);
	});

	it('rejects a folder that contains an agent workspace', () => {
		fs.mkdirSync(path.join(workspace, 'app'), { recursive: true });
		// The data folder lies somewhere else, so only the workspace is in the way.
		const elsewhere = path.join(path.dirname(sandbox), 'cot-layout-elsewhere', 'data');
		const withWorkspace = (dirs: string[]) => ({
			agentDirs: dirs,
			userDataPath: elsewhere,
			homeDir: home,
		});

		// `sandbox` holds `workspace`: the year folders would lie right beside it.
		const parent = validateAgentFolder(sandbox, withWorkspace([workspace]));
		expect(parent.ok).toBe(false);
		if (!parent.ok) expect(parent.reason).toMatch(/contains an agent workspace/);

		// A workspace deeper down is contained just the same.
		const deeper = validateAgentFolder(sandbox, withWorkspace([path.join(workspace, 'app')]));
		expect(deeper.ok).toBe(false);
		// With no workspace under it, the same folder is an ordinary one.
		expect(validateAgentFolder(sandbox, withWorkspace([])).ok).toBe(true);
	});

	it('rejects a folder that contains the Maestro data folder, or the folder its agent list was moved to', () => {
		const noWorkspaces = { agentDirs: [], userDataPath: userData, homeDir: home };
		const parent = validateAgentFolder(sandbox, noWorkspaces);
		expect(parent.ok).toBe(false);
		if (!parent.ok) expect(parent.reason).toMatch(/contains the Maestro data folder/);

		const synced = path.join(sandbox, 'cloud', 'maestro');
		const moved = { agentDirs: [], userDataPath: path.join(home, 'data'), homeDir: home };
		expect(
			validateAgentFolder(path.join(sandbox, 'cloud'), { ...moved, syncPath: synced }).ok
		).toBe(false);
		// With nothing moved there, the same folder is an ordinary one.
		expect(validateAgentFolder(path.join(sandbox, 'cloud'), moved).ok).toBe(true);
	});

	it('accepts a folder that lies beside a workspace and beside the data folder', () => {
		expect(validateAgentFolder(path.join(sandbox, 'logs'), context()).ok).toBe(true);
		// A name that only starts like the workspace's is another folder.
		expect(validateAgentFolder(`${workspace}-logs`, context()).ok).toBe(true);
	});

	it('rejects a folder equal to or inside the folder the agent list was moved to', () => {
		const synced = path.join(sandbox, 'synced');
		const moved = { ...context(), syncPath: synced };
		expect(validateAgentFolder(synced, moved).ok).toBe(false);
		const inside = validateAgentFolder(path.join(synced, 'logs'), moved);
		expect(inside.ok).toBe(false);
		if (!inside.ok) expect(inside.reason).toMatch(/data folder/i);
		// With nothing moved, the same folder is an ordinary one.
		expect(validateAgentFolder(path.join(synced, 'logs'), context()).ok).toBe(true);
	});

	it('rejects a symlink that points into an agent cwd', (ctx) => {
		const link = path.join(sandbox, 'innocent-link');
		try {
			fs.symlinkSync(workspace, link, 'dir');
		} catch {
			// Windows without the symlink privilege cannot build this fixture.
			ctx.skip();
			return;
		}
		const result = validateAgentFolder(link, context());
		expect(result.ok).toBe(false);
		const through = validateAgentFolder(path.join(link, 'logs'), context());
		expect(through.ok).toBe(false);
		expect(fs.existsSync(path.join(workspace, 'logs'))).toBe(false);
	});

	it('returns the real path when the folder is reached through a symlink', (ctx) => {
		const realLogs = path.join(sandbox, 'real-logs');
		fs.mkdirSync(realLogs);
		const link = path.join(sandbox, 'logs-link');
		try {
			fs.symlinkSync(realLogs, link, 'dir');
		} catch {
			ctx.skip();
			return;
		}
		const result = validateAgentFolder(link, context());
		expect(result).toEqual({ ok: true, resolved: realLogs });
	});

	it('rejects a path that is a file', () => {
		const file = path.join(sandbox, 'a-file');
		fs.writeFileSync(file, 'x');
		const result = validateAgentFolder(file, context());
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toMatch(/file/i);
	});

	it('rejects a folder that is not writable', (ctx) => {
		const getuid = (process as NodeJS.Process & { getuid?: () => number }).getuid;
		if (process.platform === 'win32' || getuid?.() === 0) {
			// Windows ignores mode bits, and root writes anywhere.
			ctx.skip();
			return;
		}
		const readOnly = path.join(sandbox, 'read-only');
		fs.mkdirSync(readOnly);
		fs.chmodSync(readOnly, 0o500);
		try {
			const result = validateAgentFolder(readOnly, context());
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.reason).toMatch(/write/i);
		} finally {
			fs.chmodSync(readOnly, 0o700);
		}
	});

	describe('case-insensitive platforms', () => {
		const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');

		afterEach(() => {
			if (realPlatform) Object.defineProperty(process, 'platform', realPlatform);
		});

		it('treats a differently-cased path as the same workspace on macOS', () => {
			Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
			const shouted = path.join(path.dirname(workspace), path.basename(workspace).toUpperCase());
			const result = validateAgentFolder(path.join(shouted, 'logs'), context());
			expect(result.ok).toBe(false);
		});

		it('treats a differently-cased path as the same workspace on Windows', () => {
			Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
			const shouted = path.join(path.dirname(workspace), path.basename(workspace).toUpperCase());
			const result = validateAgentFolder(path.join(shouted, 'logs'), context());
			expect(result.ok).toBe(false);
		});
	});
});
