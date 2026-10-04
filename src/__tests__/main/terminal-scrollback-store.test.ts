import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { userDataDir } = vi.hoisted(() => ({ userDataDir: { current: '' } }));

vi.mock('electron', () => ({
	app: { getPath: () => userDataDir.current },
}));

import {
	loadTerminalScrollback,
	pruneTerminalScrollback,
	saveTerminalScrollback,
} from '../../main/terminal-scrollback-store';
import { TERMINAL_SCROLLBACK_MAX_CHARS } from '../../shared/terminalScrollback';

const KEY_A = 'agent-1-terminal-tab-a';
const KEY_B = 'agent-1-terminal-tab-b';

function scrollbackFiles(): string[] {
	const dir = path.join(userDataDir.current, 'terminal-scrollback');
	return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
}

describe('terminal-scrollback-store', () => {
	beforeEach(() => {
		userDataDir.current = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-scrollback-'));
	});

	afterEach(() => {
		fs.rmSync(userDataDir.current, { recursive: true, force: true });
	});

	it('round-trips a snapshot', async () => {
		await expect(saveTerminalScrollback(KEY_A, '\x1b[32mhello\x1b[0m')).resolves.toBe(true);
		await expect(loadTerminalScrollback(KEY_A)).resolves.toBe('\x1b[32mhello\x1b[0m');
	});

	it('loads null when nothing was saved', async () => {
		await expect(loadTerminalScrollback(KEY_A)).resolves.toBeNull();
	});

	it('removes the snapshot when saved empty', async () => {
		await saveTerminalScrollback(KEY_A, 'history');
		await saveTerminalScrollback(KEY_A, '');
		await expect(loadTerminalScrollback(KEY_A)).resolves.toBeNull();
		expect(scrollbackFiles()).toEqual([]);
	});

	it('refuses a key that could escape the store directory', async () => {
		await expect(saveTerminalScrollback('../evil', 'x')).resolves.toBe(false);
		await expect(loadTerminalScrollback('../evil')).resolves.toBeNull();
		expect(fs.existsSync(path.join(userDataDir.current, 'evil.ansi'))).toBe(false);
	});

	it('refuses a snapshot over the size cap', async () => {
		const oversized = 'x'.repeat(TERMINAL_SCROLLBACK_MAX_CHARS + 1);
		await expect(saveTerminalScrollback(KEY_A, oversized)).resolves.toBe(false);
		expect(scrollbackFiles()).toEqual([]);
	});

	it('prunes snapshots for tabs that no longer exist, plus orphaned temp files', async () => {
		await saveTerminalScrollback(KEY_A, 'keep me');
		await saveTerminalScrollback(KEY_B, 'closed tab');
		const dir = path.join(userDataDir.current, 'terminal-scrollback');
		fs.writeFileSync(path.join(dir, `${KEY_A}.ansi.tmp`), 'in-flight write');
		fs.writeFileSync(path.join(dir, `${KEY_B}.ansi.tmp`), 'crash leftover');

		await expect(pruneTerminalScrollback([KEY_A])).resolves.toBe(2);
		expect(scrollbackFiles()).toEqual([`${KEY_A}.ansi`, `${KEY_A}.ansi.tmp`]);
		await expect(loadTerminalScrollback(KEY_A)).resolves.toBe('keep me');
	});

	it('prunes nothing when the store directory does not exist yet', async () => {
		await expect(pruneTerminalScrollback([])).resolves.toBe(0);
	});
});
