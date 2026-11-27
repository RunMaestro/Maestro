/**
 * A prompt customizations file that is not valid JSON must not stop the app (RC-F18).
 *
 * `core-prompts-customizations.json` is an overlay on the bundled prompts. It used to be parsed
 * with a bare `JSON.parse`, so a torn or empty file made `initializePrompts()` throw, and the
 * startup code answers every throw with "reinstall the application" and a quit. Nothing on the
 * restart path repairs the file, so the app never started again.
 *
 * These run the real prompt manager over a real temp data folder and the real bundled prompts in
 * `src/prompts`. Only the logger, Sentry and the app path are replaced. The startup code quits
 * only when `initializePrompts()` rejects, so "no quit" is "it resolves".
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CORE_PROMPTS } from '../../shared/promptDefinitions';

const mocks = vi.hoisted(() => ({
	userData: '',
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
	captureMessage: vi.fn(async (..._args: unknown[]) => {}),
	captureException: vi.fn(async (..._args: unknown[]) => {}),
}));

vi.mock('electron', () => ({
	app: { getPath: () => mocks.userData, isPackaged: false },
}));

vi.mock('../../main/utils/logger', () => ({ logger: mocks.logger }));

vi.mock('../../main/utils/sentry', () => ({
	captureMessage: mocks.captureMessage,
	captureException: mocks.captureException,
}));

const LOG_CONTEXT = '[PromptManager]';
const CUSTOMIZATIONS_FILE = 'core-prompts-customizations.json';
const BUNDLED_DIR = path.resolve(__dirname, '..', '..', 'prompts');
const PROMPT = CORE_PROMPTS[0];
const PRIVATE_TEXT = 'PRIVATE-EDIT-MARKER the user wrote this';

function customizationsPath(): string {
	return path.join(mocks.userData, CUSTOMIZATIONS_FILE);
}

/** The sidecars a recovery left in the data folder, oldest first. */
function sidecars(): string[] {
	return fs
		.readdirSync(mocks.userData)
		.filter((name) => name.startsWith('core-prompts-customizations.corrupt-'))
		.sort();
}

function readSidecar(name: string): string {
	return fs.readFileSync(path.join(mocks.userData, name), 'utf-8');
}

/** A real customizations document cut off in the middle, as a crash or a sync client leaves it. */
function tornDocument(): string {
	const whole = JSON.stringify(
		{ prompts: { [PROMPT.id]: { content: PRIVATE_TEXT, isModified: true, originalHash: 'abc' } } },
		null,
		2
	);
	const torn = whole.slice(0, whole.length - 20);
	expect(() => JSON.parse(torn)).toThrow(SyntaxError);
	return torn;
}

/** A fresh copy of the module, as at the next launch: no cache, not initialized. */
async function loadPromptManager() {
	vi.resetModules();
	return import('../../main/prompt-manager');
}

/** Make one bundled prompt unreadable, as if the install lost it. Every other read is real. */
function loseBundledFile(filename: string): void {
	const realReadFile = fs.promises.readFile.bind(fs.promises) as (
		...args: unknown[]
	) => Promise<unknown>;
	vi.spyOn(fs.promises, 'readFile').mockImplementation(((file: unknown, ...rest: unknown[]) => {
		if (path.basename(String(file)) === filename) {
			return Promise.reject(
				Object.assign(new Error(`ENOENT: no such file or directory, open '${String(file)}'`), {
					code: 'ENOENT',
				})
			);
		}
		return realReadFile(file, ...rest);
	}) as never);
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.userData = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-prompt-customizations-'));
});

afterEach(() => {
	vi.restoreAllMocks();
	fs.rmSync(mocks.userData, { recursive: true, force: true });
});

describe('a customizations file that is not valid JSON', () => {
	it('is moved aside with its bytes intact, and the app starts on the bundled prompts', async () => {
		const torn = tornDocument();
		fs.writeFileSync(customizationsPath(), torn, 'utf-8');
		const { initializePrompts, getAllPrompts } = await loadPromptManager();

		await expect(initializePrompts()).resolves.toBeUndefined();

		// Out of the way, so the next start reads no file at all...
		expect(fs.existsSync(customizationsPath())).toBe(false);
		// ...and the user's bytes are still on disk, under a name that says what happened.
		const preserved = sidecars();
		expect(preserved).toHaveLength(1);
		expect(readSidecar(preserved[0])).toBe(torn);

		// Every prompt is the bundled file; none is a customization.
		const all = getAllPrompts();
		expect(all).toHaveLength(CORE_PROMPTS.length);
		expect(all.some((p) => p.isModified)).toBe(false);
		expect(all.find((p) => p.id === PROMPT.id)?.content).toBe(
			fs.readFileSync(path.join(BUNDLED_DIR, PROMPT.filename), 'utf-8')
		);
	});

	it('logs a warning that names the sidecar', async () => {
		fs.writeFileSync(customizationsPath(), tornDocument(), 'utf-8');
		const { initializePrompts } = await loadPromptManager();

		await initializePrompts();

		const [sidecar] = sidecars();
		expect(mocks.logger.warn).toHaveBeenCalledWith(
			expect.stringContaining(`${CUSTOMIZATIONS_FILE} is not valid JSON`),
			LOG_CONTEXT
		);
		expect(mocks.logger.warn).toHaveBeenCalledWith(expect.stringContaining(sidecar), LOG_CONTEXT);
		expect(mocks.logger.error).not.toHaveBeenCalled();
	});

	it('is reported to Sentry once, with none of the file text and no path', async () => {
		const torn = tornDocument();
		fs.writeFileSync(customizationsPath(), torn, 'utf-8');
		const { initializePrompts } = await loadPromptManager();

		await initializePrompts();

		expect(mocks.captureMessage).toHaveBeenCalledTimes(1);
		expect(mocks.captureMessage).toHaveBeenCalledWith(
			expect.stringContaining('not valid JSON'),
			'warning',
			{
				operation: 'prompts:loadCustomizations',
				file: CUSTOMIZATIONS_FILE,
				byteLength: Buffer.byteLength(torn, 'utf-8'),
				quarantined: true,
			}
		);
		expect(mocks.captureException).not.toHaveBeenCalled();
		// A parse error quotes the text around the failure, and that text is the user's prompt.
		const reported = JSON.stringify(mocks.captureMessage.mock.calls);
		expect(reported).not.toContain('PRIVATE-EDIT-MARKER');
		expect(reported).not.toContain(path.basename(mocks.userData));
	});

	it('does not repeat on the next start', async () => {
		fs.writeFileSync(customizationsPath(), tornDocument(), 'utf-8');
		const first = await loadPromptManager();
		await first.initializePrompts();
		vi.clearAllMocks();

		const second = await loadPromptManager();
		await expect(second.initializePrompts()).resolves.toBeUndefined();

		expect(sidecars()).toHaveLength(1);
		expect(mocks.logger.warn).not.toHaveBeenCalled();
		expect(mocks.captureMessage).not.toHaveBeenCalled();
	});

	it.each([
		['an empty file', ''],
		['only whitespace', ' \n\t\n'],
		['text that is not JSON', 'not json at all'],
		['a write cut off inside a key', '{"prompts": {"wizard-system": {"con'],
		['a file of NUL bytes', String.fromCodePoint(0).repeat(64)],
		['a page a sync client left behind', '<html><body>conflict</body></html>'],
	])('is recovered when it holds %s', async (_label, content) => {
		fs.writeFileSync(customizationsPath(), content, 'utf-8');
		const { initializePrompts, getAllPrompts } = await loadPromptManager();

		await expect(initializePrompts()).resolves.toBeUndefined();

		expect(fs.existsSync(customizationsPath())).toBe(false);
		const preserved = sidecars();
		expect(preserved).toHaveLength(1);
		expect(readSidecar(preserved[0])).toBe(content);
		expect(getAllPrompts().some((p) => p.isModified)).toBe(false);
	});

	it('still starts when it cannot be moved aside, and says so', async () => {
		const torn = tornDocument();
		fs.writeFileSync(customizationsPath(), torn, 'utf-8');
		// Neither linking, renaming, nor copying works (a read-only volume, a sync client holding a lock).
		vi.spyOn(fs, 'linkSync').mockImplementation(() => {
			throw new Error('EACCES: permission denied, link');
		});
		vi.spyOn(fs, 'renameSync').mockImplementation(() => {
			throw new Error('EACCES: permission denied, rename');
		});
		vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {
			throw new Error('ENOSPC: no space left on device, write');
		});
		const { initializePrompts, getAllPrompts } = await loadPromptManager();

		await expect(initializePrompts()).resolves.toBeUndefined();

		expect(getAllPrompts().some((p) => p.isModified)).toBe(false);
		expect(mocks.logger.warn).toHaveBeenCalledWith(
			expect.stringContaining('Could not move it aside'),
			LOG_CONTEXT
		);
		expect(mocks.captureMessage).toHaveBeenCalledWith(
			expect.any(String),
			'warning',
			expect.objectContaining({ quarantined: false })
		);
	});

	it('falls back to an independent copy when unlinking the original fails so saving does not overwrite the sidecar', async () => {
		const torn = tornDocument();
		const target = customizationsPath();
		fs.writeFileSync(target, torn, 'utf-8');
		const origUnlink = fs.unlinkSync;
		vi.spyOn(fs, 'unlinkSync').mockImplementation((p) => {
			if (String(p) === target) {
				throw new Error('EBUSY: resource busy or locked');
			}
			return origUnlink(p);
		});
		const { initializePrompts, savePrompt } = await loadPromptManager();
		await initializePrompts();

		const preserved = sidecars();
		expect(preserved).toHaveLength(1);
		await savePrompt(PROMPT.id, 'new saved content');

		// The sidecar must keep the original corrupt bytes, not the newly saved JSON.
		expect(readSidecar(preserved[0])).toBe(torn);
	});

	it('lets the user customize again afterwards, and leaves the preserved copy alone', async () => {
		const torn = tornDocument();
		fs.writeFileSync(customizationsPath(), torn, 'utf-8');
		const { initializePrompts, savePrompt, getAllPrompts } = await loadPromptManager();
		await initializePrompts();

		await savePrompt(PROMPT.id, 'a fresh edit');

		const saved = JSON.parse(fs.readFileSync(customizationsPath(), 'utf-8'));
		expect(Object.keys(saved.prompts)).toEqual([PROMPT.id]);
		expect(saved.prompts[PROMPT.id]).toMatchObject({ content: 'a fresh edit', isModified: true });
		expect(getAllPrompts().find((p) => p.id === PROMPT.id)?.content).toBe('a fresh edit');
		const preserved = sidecars();
		expect(preserved).toHaveLength(1);
		expect(readSidecar(preserved[0])).toBe(torn);
	});

	it('is recovered when it is torn while the app runs, so a save does not fail on it', async () => {
		const { initializePrompts, savePrompt } = await loadPromptManager();
		await initializePrompts();
		const torn = tornDocument();
		fs.writeFileSync(customizationsPath(), torn, 'utf-8');

		await expect(savePrompt(PROMPT.id, 'an edit')).resolves.toBeUndefined();

		const saved = JSON.parse(fs.readFileSync(customizationsPath(), 'utf-8'));
		expect(saved.prompts[PROMPT.id].content).toBe('an edit');
		const preserved = sidecars();
		expect(preserved).toHaveLength(1);
		expect(readSidecar(preserved[0])).toBe(torn);
	});
});

describe('a customizations file that is fine or cannot be read', () => {
	it('loads a healthy file as before, byte order mark included, and leaves it in place', async () => {
		const healthy = JSON.stringify({
			prompts: { [PROMPT.id]: { content: 'my edit', isModified: true, originalHash: 'baseline' } },
		});
		fs.writeFileSync(customizationsPath(), `${String.fromCodePoint(0xfeff)}${healthy}`, 'utf-8');
		const { initializePrompts, getAllPrompts } = await loadPromptManager();

		await initializePrompts();

		const prompt = getAllPrompts().find((p) => p.id === PROMPT.id);
		expect(prompt?.isModified).toBe(true);
		expect(prompt?.content).toBe('my edit');
		expect(fs.existsSync(customizationsPath())).toBe(true);
		expect(sidecars()).toHaveLength(0);
		expect(mocks.logger.warn).not.toHaveBeenCalled();
		expect(mocks.captureMessage).not.toHaveBeenCalled();
	});

	it('starts on the bundled prompts when there is no file', async () => {
		const { initializePrompts, getAllPrompts } = await loadPromptManager();

		await expect(initializePrompts()).resolves.toBeUndefined();

		expect(getAllPrompts().some((p) => p.isModified)).toBe(false);
		expect(sidecars()).toHaveLength(0);
		expect(mocks.captureMessage).not.toHaveBeenCalled();
	});

	it('still stops startup when the file cannot be read at all', async () => {
		// A folder where the file should be: the read fails, and that is not a parse failure.
		fs.mkdirSync(customizationsPath());
		const { initializePrompts } = await loadPromptManager();

		await expect(initializePrompts()).rejects.toThrow();

		expect(mocks.logger.error).toHaveBeenCalledWith(
			expect.stringContaining('Failed to load prompt customizations'),
			LOG_CONTEXT
		);
		expect(fs.statSync(customizationsPath()).isDirectory()).toBe(true);
		expect(sidecars()).toHaveLength(0);
		expect(mocks.captureMessage).not.toHaveBeenCalled();
	});
});

describe('a BUNDLED prompt that is missing', () => {
	it.each([
		['no customizations file', null],
		['a torn customizations file', '{"prompts": {"wizard-system": {"con'],
	])('still takes the old path with %s', async (_label, customizations) => {
		if (customizations !== null) fs.writeFileSync(customizationsPath(), customizations, 'utf-8');
		loseBundledFile(PROMPT.filename);
		const { initializePrompts } = await loadPromptManager();

		// The startup code answers this rejection with the reinstall dialog and a quit.
		await expect(initializePrompts()).rejects.toThrow(
			`Failed to load required prompt: ${PROMPT.id}`
		);

		expect(mocks.logger.error).toHaveBeenCalledWith(
			expect.stringContaining(`Failed to load prompt ${PROMPT.id}`),
			LOG_CONTEXT
		);
	});
});
