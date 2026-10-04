import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	AGENTS_PANE_DEFAULT_WIDTH,
	AGENTS_PANE_MAX_WIDTH,
	AGENTS_PANE_MIN_WIDTH,
	loadTuiState,
	normalizeViewState,
	saveTuiViewState,
	tuiStateFilePath,
} from '../view-state';

describe('TUI view state store', () => {
	let dir: string;
	let file: string;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-tui-state-'));
		file = tuiStateFilePath(dir);
	});

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('lives beside the desktop stores, under its own name', () => {
		expect(path.basename(file)).toBe('maestro-tui.json');
	});

	it('reads a missing file as defaults without creating it', () => {
		const loaded = loadTuiState(file);
		expect(loaded.status).toBe('missing');
		expect(loaded.view.agentsPaneWidth).toBe(AGENTS_PANE_DEFAULT_WIDTH);
		expect(fs.existsSync(file)).toBe(false);
	});

	it('keeps keys it does not own when saving view state', () => {
		fs.writeFileSync(file, JSON.stringify({ keymap: { quit: 'x' }, futureKey: [1, 2] }));
		const loaded = loadTuiState(file);
		expect(
			saveTuiViewState(file, loaded.document, {
				collapsedSections: { a: true },
				agentsPaneWidth: 30,
			})
		).toBe(true);
		const saved = JSON.parse(fs.readFileSync(file, 'utf-8'));
		expect(saved).toEqual({
			keymap: { quit: 'x' },
			futureKey: [1, 2],
			view: { collapsedSections: { a: true }, agentsPaneWidth: 30 },
		});
		expect(loadTuiState(file).view.collapsedSections).toEqual({ a: true });
		expect(fs.readdirSync(dir)).toEqual(['maestro-tui.json']);
	});

	it('reports a file that is not a JSON object as corrupt', () => {
		fs.writeFileSync(file, '[1, 2]');
		expect(loadTuiState(file).status).toBe('corrupt');
		fs.writeFileSync(file, '{ nope');
		expect(loadTuiState(file).status).toBe('corrupt');
	});

	it('returns false, not a throw, when the directory is gone', () => {
		fs.rmSync(dir, { recursive: true, force: true });
		expect(saveTuiViewState(file, {}, { collapsedSections: {}, agentsPaneWidth: 28 })).toBe(false);
		expect(fs.existsSync(dir)).toBe(false);
	});

	it('normalizes a hand-edited view: wrong types dropped, width clamped', () => {
		expect(
			normalizeViewState({
				selectedAgentId: 7,
				collapsedSections: { ok: true, bad: 'yes' },
				agentsPaneWidth: 500,
			})
		).toEqual({ collapsedSections: { ok: true }, agentsPaneWidth: AGENTS_PANE_MAX_WIDTH });
		expect(normalizeViewState({ agentsPaneWidth: 2 }).agentsPaneWidth).toBe(AGENTS_PANE_MIN_WIDTH);
		expect(normalizeViewState('nonsense').agentsPaneWidth).toBe(AGENTS_PANE_DEFAULT_WIDTH);
	});
});
