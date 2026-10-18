/**
 * @file history-file-path.test.ts
 * @description `resolveSessionHistoryFilePath` against a real temp data dir.
 * The system prompt's {{AGENT_HISTORY_PATH}} used to look for `<id>.json`
 * after history moved to `<id>.jsonl`, so every CLI-spawned agent was told it
 * had no history. Real files here so the extension cannot drift again.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveSessionHistoryFilePath } from '../../../cli/services/storage';

describe('resolveSessionHistoryFilePath', () => {
	let dataDir: string;
	let historyDir: string;
	const savedEnv = process.env.MAESTRO_USER_DATA;

	beforeEach(() => {
		dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-cli-history-'));
		historyDir = path.join(dataDir, 'history');
		fs.mkdirSync(historyDir);
		process.env.MAESTRO_USER_DATA = dataDir;
	});

	afterEach(() => {
		if (savedEnv === undefined) delete process.env.MAESTRO_USER_DATA;
		else process.env.MAESTRO_USER_DATA = savedEnv;
		fs.rmSync(dataDir, { recursive: true, force: true });
	});

	it('returns the JSONL file when it exists', () => {
		const file = path.join(historyDir, 'agent-1.jsonl');
		fs.writeFileSync(file, '');
		expect(resolveSessionHistoryFilePath('agent-1')).toBe(file);
	});

	it('falls back to a legacy .json file the app has not migrated yet', () => {
		const file = path.join(historyDir, 'agent-1.json');
		fs.writeFileSync(file, '{"entries":[]}');
		expect(resolveSessionHistoryFilePath('agent-1')).toBe(file);
	});

	it('prefers JSONL when both formats exist', () => {
		fs.writeFileSync(path.join(historyDir, 'agent-1.json'), '{"entries":[]}');
		const jsonl = path.join(historyDir, 'agent-1.jsonl');
		fs.writeFileSync(jsonl, '');
		expect(resolveSessionHistoryFilePath('agent-1')).toBe(jsonl);
	});

	it('returns undefined for an agent with no history yet', () => {
		expect(resolveSessionHistoryFilePath('brand-new')).toBeUndefined();
	});
});
