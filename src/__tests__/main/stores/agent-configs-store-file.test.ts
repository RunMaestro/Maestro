/**
 * The one off-Electron reader and writer of `maestro-agent-configs.json`,
 * against a real temp directory.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	AgentConfigsStoreCorruptError,
	agentConfigsStorePath,
	readAgentConfigsStoreFile,
	writeAgentConfigsStoreFile,
} from '../../../main/stores/agent-configs-store-file';

let dataDir: string;

beforeEach(() => {
	dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-configs-store-file-'));
});

afterEach(() => {
	fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('readAgentConfigsStoreFile', () => {
	it('reads a missing file as empty', () => {
		expect(readAgentConfigsStoreFile(dataDir)).toEqual({ data: undefined, configs: {} });
	});

	it('returns the per-provider configs', () => {
		fs.writeFileSync(
			agentConfigsStorePath(dataDir),
			JSON.stringify({ configs: { 'claude-code': { customPath: '/bin/claude' } } })
		);
		expect(readAgentConfigsStoreFile(dataDir).configs).toEqual({
			'claude-code': { customPath: '/bin/claude' },
		});
	});

	it('reads a file without a configs map as no configs', () => {
		fs.writeFileSync(agentConfigsStorePath(dataDir), JSON.stringify({ configs: [] }));
		expect(readAgentConfigsStoreFile(dataDir).configs).toEqual({});
	});

	it('throws a typed error for content that is not a JSON object', () => {
		fs.writeFileSync(agentConfigsStorePath(dataDir), '{ torn');
		expect(() => readAgentConfigsStoreFile(dataDir)).toThrow(AgentConfigsStoreCorruptError);
		fs.writeFileSync(agentConfigsStorePath(dataDir), '"text"');
		expect(() => readAgentConfigsStoreFile(dataDir)).toThrow(/maestro-agent-configs\.json/);
	});
});

describe('writeAgentConfigsStoreFile', () => {
	it('keeps the top-level keys it was given and leaves no temp file', async () => {
		fs.writeFileSync(
			agentConfigsStorePath(dataDir),
			JSON.stringify({ configs: { codex: { customArgs: '-q' } }, future: 1 })
		);
		const { data, configs } = readAgentConfigsStoreFile(dataDir);
		await writeAgentConfigsStoreFile(dataDir, {
			...data,
			configs: { ...configs, codex: { ...configs.codex, customPath: '/bin/codex' } },
		});
		const after = readAgentConfigsStoreFile(dataDir);
		expect(after.configs.codex).toEqual({ customArgs: '-q', customPath: '/bin/codex' });
		expect(after.data?.future).toBe(1);
		expect(fs.readdirSync(dataDir)).toEqual(['maestro-agent-configs.json']);
	});
});
