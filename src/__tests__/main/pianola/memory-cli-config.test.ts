// @vitest-environment node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { MemoryEngine } from '../../../main/pianola/memory-engine';
import { readMemoryCliEnvironments } from '../../../main/pianola/memory-provider-discovery';
import type { MemoryCliProviderInfo } from '../../../shared/pianola/memory';
import type { getAgentConfigsStore } from '../../../main/stores';

const directories: string[] = [];
const engines: MemoryEngine[] = [];
afterEach(async () => {
	for (const engine of engines.splice(0)) if (engine.database.db.open) engine.database.close();
	await Promise.all(
		directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true }))
	);
});

const CLAUDE_PATH = path.resolve('tools/claude.exe');
const CODEX_PATH = path.resolve('tools/codex.cmd');
const FAKE_PATH = path.resolve('fake.exe');
const providers: MemoryCliProviderInfo[] = [
	{ id: 'claude-code', name: 'Claude Code', path: CLAUDE_PATH, model: 'sonnet' },
	{ id: 'codex', name: 'Codex', path: CODEX_PATH, model: 'gpt-test' },
];

it('resolves the effective CLI configuration for partial provider and path updates', async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pianola-cli-config-'));
	directories.push(directory);
	const engine = new MemoryEngine(directory, () => true, { cliProviders: () => providers });
	engines.push(engine);
	await engine.request({
		action: 'configure',
		config: { enabled: false, mode: 'cli', cliProvider: 'claude-code', cliPath: FAKE_PATH },
	});
	expect(engine.database.config()).toMatchObject({
		cliProvider: 'claude-code',
		cliPath: CLAUDE_PATH,
		model: 'sonnet',
		inputPrice: 0,
		outputPrice: 0,
	});
	await engine.request({ action: 'configure', config: { cliProvider: 'codex' } });
	expect(engine.database.config()).toMatchObject({
		cliProvider: 'codex',
		cliPath: CODEX_PATH,
		model: 'gpt-test',
	});
	await engine.request({
		action: 'configure',
		config: { cliProvider: 'claude-code', model: 'custom-model' },
	});
	expect(engine.database.config()).toMatchObject({
		cliProvider: 'claude-code',
		cliPath: CLAUDE_PATH,
		model: 'custom-model',
	});
	await engine.request({ action: 'configure', config: { cliPath: FAKE_PATH } });
	expect(engine.database.config()).toMatchObject({
		cliProvider: 'claude-code',
		cliPath: CLAUDE_PATH,
		model: 'custom-model',
	});
});

it('loads provider account selectors from Maestro settings without exposing them in discovery', () => {
	const store = {
		get: () => ({
			codex: { customEnvVars: { CODEX_HOME: 'D:\\codex-account', EMPTY_SETTING: '' } },
		}),
	} as unknown as ReturnType<typeof getAgentConfigsStore>;
	const environments = readMemoryCliEnvironments(store);
	expect(environments.codex).toMatchObject({ CODEX_HOME: 'D:\\codex-account', EMPTY_SETTING: '' });
	expect(providers[1]).not.toHaveProperty('env');
});
