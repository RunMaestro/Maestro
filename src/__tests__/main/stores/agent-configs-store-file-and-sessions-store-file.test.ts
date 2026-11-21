// Source: src/__tests__/main/stores/agent-configs-store-file.test.ts
// Source: src/__tests__/main/stores/sessions-store-file.test.ts
import { describe as describeSourceSuite } from 'vitest';
import { describe } from 'vitest';
import { it } from 'vitest';
import { expect } from 'vitest';
import { beforeEach } from 'vitest';
import { afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AgentConfigsStoreCorruptError } from '../../../main/stores/agent-configs-store-file';
import { agentConfigsStorePath } from '../../../main/stores/agent-configs-store-file';
import { readAgentConfigsStoreFile } from '../../../main/stores/agent-configs-store-file';
import { writeAgentConfigsStoreFile } from '../../../main/stores/agent-configs-store-file';
import { readSessionsStoreFile } from '../../../main/stores/sessions-store-file';
import { SessionsStoreCorruptError } from '../../../main/stores/sessions-store-file';
import { sessionsStorePath } from '../../../main/stores/sessions-store-file';
import { writeSessionsStoreFile } from '../../../main/stores/sessions-store-file';
describeSourceSuite('agent-configs-store-file', () => {
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
});
describeSourceSuite('sessions-store-file', () => {
	let dataDir: string;

	beforeEach(() => {
		dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sessions-store-file-'));
	});

	afterEach(() => {
		fs.rmSync(dataDir, { recursive: true, force: true });
	});

	describe('readSessionsStoreFile', () => {
		it('reads a missing file as empty', () => {
			expect(readSessionsStoreFile(dataDir)).toEqual({ data: undefined, sessions: [] });
		});

		it('returns the sessions and the whole top level', () => {
			fs.writeFileSync(
				sessionsStorePath(dataDir),
				JSON.stringify({ sessions: [{ id: 'a', name: 'A' }], activeSessionId: 'a' })
			);
			const file = readSessionsStoreFile(dataDir);
			expect(file.sessions.map((s) => s.id)).toEqual(['a']);
			expect(file.data?.activeSessionId).toBe('a');
		});

		it('reads a file without a sessions array as no sessions', () => {
			fs.writeFileSync(sessionsStorePath(dataDir), JSON.stringify({ sessions: 'nope' }));
			expect(readSessionsStoreFile(dataDir).sessions).toEqual([]);
		});

		it('throws a typed error for content that is not JSON', () => {
			fs.writeFileSync(sessionsStorePath(dataDir), '{ torn');
			expect(() => readSessionsStoreFile(dataDir)).toThrow(SessionsStoreCorruptError);
			expect(() => readSessionsStoreFile(dataDir)).toThrow(/Could not read maestro-sessions\.json/);
		});

		it('throws a typed error for JSON that is not an object', () => {
			fs.writeFileSync(sessionsStorePath(dataDir), '[]');
			expect(() => readSessionsStoreFile(dataDir)).toThrow(SessionsStoreCorruptError);
		});
	});

	describe('writeSessionsStoreFile', () => {
		it('keeps the top-level keys it was given and leaves no temp file', async () => {
			fs.writeFileSync(
				sessionsStorePath(dataDir),
				JSON.stringify({ sessions: [], activeSessionId: 'x', future: { kept: true } })
			);
			const { data } = readSessionsStoreFile(dataDir);
			await writeSessionsStoreFile(dataDir, {
				...data,
				sessions: [{ id: 'b', name: 'B', toolType: 'codex', cwd: '/p', projectRoot: '/p' }],
			});
			const after = readSessionsStoreFile(dataDir);
			expect(after.sessions.map((s) => s.id)).toEqual(['b']);
			expect(after.data?.activeSessionId).toBe('x');
			expect(after.data?.future).toEqual({ kept: true });
			expect(fs.readdirSync(dataDir)).toEqual(['maestro-sessions.json']);
		});
	});
});
