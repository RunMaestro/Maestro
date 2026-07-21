/**
 * Tests for the TTSR rule/settings IPC handlers.
 *
 * Runs against a real temp project rather than an fs mock: these handlers are a
 * thin transport, so the behaviour worth testing is the round-trip through the
 * repository (path containment, YAML merge, cache invalidation), which a mock
 * would only re-implement.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { ipcMain } from 'electron';
import { registerTtsrHandlers } from '../../../../main/ipc/handlers/ttsr';
import { TTSR_CONFIG_PATH, TTSR_RULES_DIR } from '../../../../shared/maestro-paths';
import type { TtsrRuleListResult, TtsrRuleValidation } from '../../../../shared/ttsr-types';

vi.mock('electron', () => ({
	ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
	app: { getPath: vi.fn(() => '/tmp') },
}));

vi.mock('../../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/** `withIpcErrorLogging` hands the registered handler `(event, ...args)`. */
type Handler = (event: unknown, args: Record<string, unknown>) => Promise<unknown>;

let projectRoot: string;
let handlers: Map<string, Handler>;
let onRulesChanged: ReturnType<typeof vi.fn>;

const RULE = [
	'---',
	'description: Stop force-pushes',
	"condition: 'git push .*--force'",
	'scope: [tool:bash]',
	'---',
	'Do not force-push a shared branch.',
].join('\n');

function call<T>(channel: string, args: Record<string, unknown> = {}): Promise<T> {
	const handler = handlers.get(channel);
	if (!handler) throw new Error(`no handler registered for ${channel}`);
	return handler(null, args) as Promise<T>;
}

function writeRuleFile(filename: string, content: string): void {
	const dir = path.join(projectRoot, TTSR_RULES_DIR);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, filename), content, 'utf-8');
}

function readConfig(): Record<string, unknown> {
	const raw = fs.readFileSync(path.join(projectRoot, TTSR_CONFIG_PATH), 'utf-8');
	return yaml.load(raw) as Record<string, unknown>;
}

beforeEach(() => {
	vi.clearAllMocks();
	projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ttsr-ipc-'));
	handlers = new Map();
	vi.mocked(ipcMain.handle).mockImplementation(((channel: string, handler: Handler) => {
		handlers.set(channel, handler);
	}) as never);
	onRulesChanged = vi.fn();
	registerTtsrHandlers({ onRulesChanged });
});

afterEach(() => {
	fs.rmSync(projectRoot, { recursive: true, force: true });
});

describe('ttsr:listRules', () => {
	it('returns normalized rules without the compiled regexes', async () => {
		writeRuleFile('no-force-push.md', RULE);

		const result = await call<TtsrRuleListResult>('ttsr:listRules', { projectRoot });

		expect(result.rules).toHaveLength(1);
		expect(result.rules[0]).toMatchObject({
			name: 'no-force-push',
			description: 'Stop force-pushes',
			scope: ['tool:bash'],
			path: `${TTSR_RULES_DIR}/no-force-push.md`,
		});
		// RegExp does not survive structured cloning over the IPC boundary.
		expect(result.rules[0]).not.toHaveProperty('compiledCondition');
		expect(result.configExists).toBe(true);
	});

	it('reports an empty project without erroring', async () => {
		const result = await call<TtsrRuleListResult>('ttsr:listRules', { projectRoot });

		expect(result.rules).toEqual([]);
		expect(result.configExists).toBe(false);
		expect(result.errors).toEqual([]);
	});

	it('surfaces load warnings so a rule that can never fire is visible', async () => {
		writeRuleFile(
			'broken.md',
			['---', 'description: Bad regex', "condition: '(unclosed'", '---', 'Body.'].join('\n')
		);

		const result = await call<TtsrRuleListResult>('ttsr:listRules', { projectRoot });

		expect(result.warnings.join('\n')).toContain('invalid regex');
	});
});

describe('ttsr rule writes', () => {
	it('writes a rule and invalidates the runtime cache', async () => {
		await call('ttsr:writeRule', {
			projectRoot,
			path: `${TTSR_RULES_DIR}/no-force-push.md`,
			content: RULE,
		});

		const onDisk = fs.readFileSync(
			path.join(projectRoot, TTSR_RULES_DIR, 'no-force-push.md'),
			'utf-8'
		);
		expect(onDisk).toBe(RULE);
		// The file watcher would also catch this, a debounce later; the user just
		// clicked something, so the list must not lie in the meantime.
		expect(onRulesChanged).toHaveBeenCalledWith(projectRoot);
	});

	it('refuses a path that escapes the rules directory', async () => {
		await expect(
			call('ttsr:writeRule', { projectRoot, path: '../../evil.md', content: RULE })
		).rejects.toThrow();
		expect(onRulesChanged).not.toHaveBeenCalled();
	});

	it('deletes a rule and reports when there was nothing to delete', async () => {
		writeRuleFile('no-force-push.md', RULE);

		const removed = await call<{ deleted: boolean }>('ttsr:deleteRule', {
			projectRoot,
			path: `${TTSR_RULES_DIR}/no-force-push.md`,
		});
		expect(removed.deleted).toBe(true);

		const again = await call<{ deleted: boolean }>('ttsr:deleteRule', {
			projectRoot,
			path: `${TTSR_RULES_DIR}/no-force-push.md`,
		});
		expect(again.deleted).toBe(false);
	});
});

describe('ttsr:validateRule', () => {
	it('reports what the loader would make of a draft without writing it', async () => {
		const result = await call<TtsrRuleValidation>('ttsr:validateRule', { content: RULE });

		expect(result.valid).toBe(true);
		// Defaults the editor should show back to the user.
		expect(result.rule?.interruptMode).toBe('always');
		expect(result.rule?.repeatGap).toBe(3);
		expect(fs.existsSync(path.join(projectRoot, TTSR_RULES_DIR))).toBe(false);
	});

	it('reports an unusable draft as invalid with a reason', async () => {
		const result = await call<TtsrRuleValidation>('ttsr:validateRule', {
			content: 'no frontmatter here',
		});

		expect(result.valid).toBe(false);
		expect(result.rule).toBeNull();
		expect(result.warnings.join('\n')).toContain('frontmatter');
	});
});

describe('ttsr project settings', () => {
	it('creates the config file on first write', async () => {
		await call('ttsr:writeProjectSettings', { projectRoot, settings: { enabled: false } });

		expect(readConfig()).toEqual({ enabled: false });
		expect(onRulesChanged).toHaveBeenCalledWith(projectRoot);
	});

	it('merges into an existing file instead of clobbering unknown keys', async () => {
		fs.mkdirSync(path.join(projectRoot, '.maestro'), { recursive: true });
		fs.writeFileSync(
			path.join(projectRoot, TTSR_CONFIG_PATH),
			'enabled: true\nsomeFutureKey: keep-me\n',
			'utf-8'
		);

		await call('ttsr:writeProjectSettings', { projectRoot, settings: { contextMode: 'discard' } });

		// A user's hand-written config must survive them flicking a toggle.
		expect(readConfig()).toEqual({
			enabled: true,
			someFutureKey: 'keep-me',
			contextMode: 'discard',
		});
	});

	it('clears a key when the setting is undefined, handing it back to the global default', async () => {
		await call('ttsr:writeProjectSettings', { projectRoot, settings: { contextMode: 'discard' } });
		expect(readConfig().contextMode).toBe('discard');

		await call('ttsr:writeProjectSettings', { projectRoot, settings: { contextMode: undefined } });

		expect(readConfig()).not.toHaveProperty('contextMode');
		// And the loader now reports "unset" rather than a pinned value.
		const result = await call<TtsrRuleListResult>('ttsr:listRules', { projectRoot });
		expect(result.settings.contextMode).toBeUndefined();
	});

	it('round-trips through readProjectSettings', async () => {
		await call('ttsr:writeProjectSettings', {
			projectRoot,
			settings: { enabled: false, disabledRules: ['noisy-rule'] },
		});

		const settings = await call<{ enabled: boolean; disabledRules: string[] }>(
			'ttsr:readProjectSettings',
			{ projectRoot }
		);

		expect(settings).toMatchObject({ enabled: false, disabledRules: ['noisy-rule'] });
	});
});
