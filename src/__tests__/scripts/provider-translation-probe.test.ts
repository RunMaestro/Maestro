// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	link,
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	rm,
	stat,
	symlink,
	utimes,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
	extractNativeConversation,
	parseNativeLines,
} from '../../shared/maestro-lib/translation/native-records';
import {
	formatProbeReport,
	parseProbeArgs,
	probeTranscripts,
	writeProbeScratchFile,
} from '../../../scripts/provider-translation-probe.mjs';

describe('provider translation probe', () => {
	let home: string;
	beforeEach(async () => {
		home = await mkdtemp(path.join(tmpdir(), 'translation-probe-'));
	});
	afterEach(async () => {
		await rm(home, { recursive: true, force: true });
	});

	async function transcript(relative: string, rows: unknown[], modified = 1000) {
		const file = path.join(home, relative);
		await mkdir(path.dirname(file), { recursive: true });
		await writeFile(file, rows.map((row) => JSON.stringify(row)).join('\n'));
		await utimes(file, modified, modified);
		return file;
	}
	const message = {
		type: 'user',
		uuid: 'user-1',
		cwd: path.join(tmpdir(), 'project'),
		message: { role: 'user', content: 'PRIVATE-MESSAGE-SENTINEL' },
	};
	const run = (limit = 300) =>
		probeTranscripts({ home, limit, extractNativeConversation, parseNativeLines });

	it('defaults to 300 and validates CLI options', () => {
		expect(parseProbeArgs([])).toEqual({ limit: 300, json: undefined });
		expect(parseProbeArgs(['--limit', '12', '--json', '.maestro/scratch/result.json'])).toEqual({
			limit: 12,
			json: '.maestro/scratch/result.json',
		});
		for (const args of [
			['--limit'],
			['--limit', '0'],
			['--limit', '-1'],
			['--limit', '1.5'],
			['--limit', 'Infinity'],
			['--limit', '9007199254740992'],
			['--json'],
			['--unknown', '1'],
		]) {
			expect(() => parseProbeArgs(args)).toThrow();
		}
	});

	it('handles missing provider homes without creating them', async () => {
		const report = await run();
		for (const provider of ['claude-code', 'codex']) {
			expect(report.providers[provider]).toMatchObject({ sampled: 0, clean: 0, blocked: 0 });
		}
		expect(await readdir(home)).toEqual([]);
	});

	it('samples newest files across Claude accounts, skips subagents, and finds nested Codex rollouts', async () => {
		await transcript('.claude/projects/project/old.jsonl', [
			{ type: 'user', message: message.message },
		]);
		await transcript(
			'.claude-alt/projects/project/new.jsonl',
			[{ type: 'system', sessionId: 'new' }, message],
			2000
		);
		await transcript('.claude/projects/project/subagents/agent.jsonl', [message], 3000);
		await transcript(
			'.codex/sessions/2026/10/17/rollout-recent.jsonl',
			[
				{ type: 'session_meta', payload: { cwd: message.cwd, id: 'codex-session' } },
				{
					type: 'response_item',
					payload: {
						type: 'message',
						role: 'user',
						content: [{ type: 'input_text', text: 'PRIVATE-MESSAGE-SENTINEL' }],
					},
				},
			],
			2000
		);
		await transcript('.codex/sessions/ignore.jsonl', [], 3000);
		const report = await run(1);
		expect(report.providers['claude-code']).toMatchObject({ sampled: 1, clean: 1, blocked: 0 });
		expect(report.providers.codex).toMatchObject({ sampled: 1, clean: 1, blocked: 0 });
		const all = await run();
		expect(all.providers['claude-code'].sampled).toBe(2);
		expect(all.providers.codex.sampled).toBe(1);
	});

	it('counts each code once per file and caps examples, without leaking content or modifying inputs', async () => {
		const files: string[] = [];
		for (let index = 0; index < 4; index++) {
			files.push(
				await transcript(`.claude/projects/project/session-${index}.jsonl`, [
					message,
					{ ...message, uuid: 'other-1', cwd: path.join(tmpdir(), 'other-project') },
					{ ...message, uuid: 'other-2', cwd: path.join(tmpdir(), 'other-project') },
					{ type: 'attachment', uuid: 'attachment-1', content: 'PRIVATE-MESSAGE-SENTINEL' },
					{ type: 'attachment', uuid: 'attachment-2', content: 'PRIVATE-MESSAGE-SENTINEL' },
					null,
					null,
				])
			);
		}
		const original = await Promise.all(
			files.map(async (file) => ({ bytes: await readFile(file), metadata: await stat(file) }))
		);
		const report = await run();
		const claude = report.providers['claude-code'];
		expect(claude).toMatchObject({
			sampled: 4,
			clean: 0,
			blocked: 4,
			blockCodes: { 'malformed-native-record': 4 },
			warningCodes: {},
			infoCodes: { 'native-cwd-drift': 4, 'native-attachment-state': 4 },
		});
		expect(claude.examples['malformed-native-record']).toHaveLength(3);
		for (const file of claude.examples['malformed-native-record'])
			expect(file.startsWith(path.join('~', '.claude'))).toBe(true);
		for (const output of [formatProbeReport(report), JSON.stringify(report)]) {
			expect(output).not.toContain('PRIVATE-MESSAGE-SENTINEL');
			expect(output).not.toContain(home);
		}
		for (let index = 0; index < files.length; index++) {
			expect(await readFile(files[index])).toEqual(original[index].bytes);
			expect((await stat(files[index])).mtimeMs).toBe(original[index].metadata.mtimeMs);
		}
	});

	it('counts warnings and future info diagnostics by file while treating files without blocks as clean', async () => {
		await transcript('.claude/projects/project/session.jsonl', [message]);
		const report = await probeTranscripts({
			home,
			parseNativeLines,
			extractNativeConversation: () => ({
				limitations: [
					{ code: 'runtime-state', severity: 'warning', message: 'PRIVATE-MESSAGE-SENTINEL' },
					{ code: 'runtime-state', severity: 'warning' },
					{ code: 'archived-state', severity: 'info' },
					{ code: 'archived-state', severity: 'info' },
				],
			}),
		});
		expect(report.providers['claude-code']).toMatchObject({
			sampled: 1,
			clean: 1,
			blocked: 0,
			warningCodes: { 'runtime-state': 1 },
			infoCodes: { 'archived-state': 1 },
		});
		expect(formatProbeReport(report)).not.toContain('PRIVATE-MESSAGE-SENTINEL');
	});

	it('blocks missing metadata and preserves the real extractor malformed-record diagnosis', async () => {
		await transcript('.claude/projects/project/missing.jsonl', [
			{ type: 'user', message: message.message },
		]);
		const malformed = await transcript('.claude/projects/project/malformed.jsonl', [message]);
		await writeFile(malformed, `${JSON.stringify(message)}\n{PRIVATE-MESSAGE-SENTINEL`);
		await transcript('.codex/sessions/rollout-missing.jsonl', [
			{ type: 'session_meta', payload: { cwd: message.cwd } },
		]);
		const report = await run();
		expect(report.providers['claude-code']).toMatchObject({
			sampled: 2,
			blocked: 2,
			blockCodes: { 'probe-missing-identity': 1, 'malformed-native-record': 1 },
		});
		expect(report.providers.codex.blockCodes['probe-missing-identity']).toBe(1);
		expect(formatProbeReport(report)).not.toContain('PRIVATE-MESSAGE-SENTINEL');
	});

	it('turns extraction exceptions into blocks without exposing their messages', async () => {
		await transcript('.claude/projects/project/session.jsonl', [message]);
		const report = await probeTranscripts({
			home,
			parseNativeLines,
			extractNativeConversation: () => {
				throw new Error('PRIVATE-MESSAGE-SENTINEL');
			},
		});
		expect(report.providers['claude-code'].blockCodes).toEqual({ 'probe-extraction-error': 1 });
		expect(formatProbeReport(report)).not.toContain('PRIVATE-MESSAGE-SENTINEL');
	});

	it('confines writes to scratch, including traversal, sibling paths, symlinks and hard links', async () => {
		const output = '.maestro/scratch/probe/result.json';
		await writeProbeScratchFile(home, output, 'first');
		await writeProbeScratchFile(home, output, 'second');
		expect(await readFile(path.join(home, output), 'utf8')).toBe('second');
		for (const target of [
			'elsewhere.json',
			'.maestro/scratch/../outside.json',
			'.maestro/scratch-sibling/result.json',
			'.maestro/scratch',
		]) {
			await expect(writeProbeScratchFile(home, target, 'bad')).rejects.toThrow(
				'inside .maestro/scratch/'
			);
		}
		const outside = path.join(home, 'outside');
		await mkdir(outside);
		await symlink(outside, path.join(home, '.maestro/scratch/link'), 'dir');
		await expect(
			writeProbeScratchFile(home, '.maestro/scratch/link/result.json', 'bad')
		).rejects.toThrow('symlinks');
		expect(await readdir(outside)).toEqual([]);
		const privateFile = path.join(outside, 'private.json');
		await writeFile(privateFile, 'untouched');
		await symlink(privateFile, path.join(home, '.maestro/scratch/symlink.json'));
		await expect(
			writeProbeScratchFile(home, '.maestro/scratch/symlink.json', 'bad')
		).rejects.toThrow();
		await link(privateFile, path.join(home, '.maestro/scratch/hardlink.json'));
		await expect(
			writeProbeScratchFile(home, '.maestro/scratch/hardlink.json', 'bad')
		).rejects.toThrow('hard links');
		expect(await readFile(privateFile, 'utf8')).toBe('untouched');
	});
});
