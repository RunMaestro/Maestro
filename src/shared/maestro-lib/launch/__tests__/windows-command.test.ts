/**
 * @file windows-command.test.ts
 * @description Tests for the Windows command rules extracted from
 * ChildProcessSpawner into maestro-lib (launch/windows-command.ts).
 *
 * The rules decide whether an agent binary can only be launched through a shell
 * on Windows, and how its path is quoted for cmd.exe. ChildProcessSpawner's own
 * tests still cover the spawn itself; these pin each rule and its order.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { quoteCommandForCmdShell, windowsShellReason } from '../windows-command';

describe('windowsShellReason', () => {
	let dir: string;
	let shebangScript: string;
	let plainFile: string;

	beforeAll(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-lib-windows-command-'));
		shebangScript = path.join(dir, 'opencode');
		fs.writeFileSync(shebangScript, '#!/usr/bin/env node\nconsole.log("hi");\n');
		plainFile = path.join(dir, 'agent');
		fs.writeFileSync(plainFile, 'not a script\n');
	});

	afterAll(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('needs a shell for a bare .exe name, so PATH resolution happens', () => {
		expect(windowsShellReason('claude.exe')).toEqual({ reason: 'bare-exe' });
		expect(windowsShellReason('CLAUDE.EXE')).toEqual({ reason: 'bare-exe' });
	});

	it('does not need a shell for an .exe given with a path', () => {
		expect(windowsShellReason('C:\\Program Files\\Claude\\claude.exe')).toEqual({ reason: null });
	});

	it('needs a shell for a .cmd or .bat file, with or without a path', () => {
		expect(windowsShellReason('claude.cmd')).toEqual({ reason: 'batch-file' });
		expect(windowsShellReason('agent.bat')).toEqual({ reason: 'batch-file' });
		expect(windowsShellReason('C:\\npm\\codex.CMD')).toEqual({ reason: 'batch-file' });
	});

	it('needs a shell for an extensionless script that starts with #!, and reports its first line', () => {
		expect(windowsShellReason(shebangScript)).toEqual({
			reason: 'shebang-script',
			shebang: '#!/usr/bin/env node',
		});
	});

	it('leaves an extensionless file without #! alone', () => {
		expect(windowsShellReason(plainFile)).toEqual({ reason: null });
	});

	it('leaves an unreadable extensionless path alone instead of throwing', () => {
		expect(windowsShellReason(path.join(dir, 'missing-agent'))).toEqual({ reason: null });
	});

	it('does not read a bare extensionless name from disk', () => {
		expect(windowsShellReason('opencode')).toEqual({ reason: null });
	});
});

describe('quoteCommandForCmdShell', () => {
	it('quotes a path that contains spaces', () => {
		const cmdPath = 'C:\\Users\\First Last\\AppData\\Roaming\\npm\\claude.cmd';
		expect(quoteCommandForCmdShell(cmdPath)).toBe(`"${cmdPath}"`);
	});

	it('leaves a path without spaces unchanged', () => {
		expect(quoteCommandForCmdShell('C:\\npm\\claude.cmd')).toBe('C:\\npm\\claude.cmd');
	});

	it('does not quote a path that is already quoted', () => {
		const quoted = '"C:\\Program Files\\agent.cmd"';
		expect(quoteCommandForCmdShell(quoted)).toBe(quoted);
	});
});
