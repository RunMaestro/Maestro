/**
 * The capture tool's decisions that do not need a provider: what it accepts,
 * the environment it gives the provider, what it cleans out of a capture, and
 * what it refuses to write.
 *
 * A capture is committed to the repository, so the cleaning and the leak check
 * are the part that must not regress.
 */
import { describe, it, expect } from 'vitest';
import {
	parseArgs,
	cleanEnvironment,
	sanitizeChunk,
	findLeaks,
	describeCommand,
} from '../../../scripts/record-provider-turn.mjs';

const PATHS = { cwd: '/tmp/maestro-turn-abc', realCwd: '/private/tmp/maestro-turn-abc' };

describe('parseArgs', () => {
	it('defaults to the normal-turn prompt and no stop', () => {
		const options = parseArgs(['--agent', 'codex', '--out', 'codex-normal.json']);

		expect(options).toMatchObject({
			agentId: 'codex',
			out: 'codex-normal.json',
			stop: null,
			keepEnv: [],
		});
		expect(options.prompt).toContain('The capital of France is Paris.');
	});

	it('reads a stop, its marker and its delay', () => {
		const options = parseArgs([
			'--agent',
			'codex',
			'--out',
			'out.json',
			'--stop',
			'SIGTERM',
			'--stop-after',
			'item.started',
			'--stop-delay',
			'250',
			'--keep-env',
			'OPENAI_API_KEY',
			'--keep-env',
			'CODEX_HOME',
		]);

		expect(options.stop).toEqual({ signal: 'SIGTERM', after: 'item.started', delayMs: 250 });
		expect(options.keepEnv).toEqual(['OPENAI_API_KEY', 'CODEX_HOME']);
	});

	it.each([
		[['--out', 'x.json'], '--agent is required'],
		[['--agent', 'codex'], '--out is required'],
		[['--agent', 'codex', '--out', 'x.json', '--stop', 'SIGKILL'], 'SIGINT or SIGTERM'],
		[['--agent', 'codex', '--out', 'x.json', '--stop', 'SIGINT'], '--stop needs --stop-after'],
		[['--agent', 'codex', '--out', 'x.json', '--fast'], 'Unknown option: --fast'],
		[['--agent'], '--agent needs a value'],
	])('rejects %j', (argv, message) => {
		expect(parseArgs(argv).error).toContain(message);
	});
});

describe('cleanEnvironment', () => {
	const inherited = {
		HOME: '/home/someone',
		PATH: '/usr/bin',
		LANG: 'en_US.UTF-8',
		OPENAI_API_KEY: 'sk-live',
		CLAUDECODE: '1',
		SHELL_EXPORTED: 'from-the-shell',
	};

	it('keeps what a CLI needs from the shell and drops the rest', () => {
		const env = cleanEnvironment({ ...inherited }, inherited, []);

		expect(env).toEqual({ HOME: '/home/someone', PATH: '/usr/bin', LANG: 'en_US.UTF-8' });
	});

	it('keeps the variables Maestro set on top of what it inherited', () => {
		const planned = { ...inherited, PATH: '/expanded:/usr/bin', MAESTRO_QUERY_SOURCE: 'user' };

		const env = cleanEnvironment(planned, inherited, []);

		expect(env.PATH).toBe('/expanded:/usr/bin');
		expect(env.MAESTRO_QUERY_SOURCE).toBe('user');
		expect(env.SHELL_EXPORTED).toBeUndefined();
	});

	it('keeps a variable the operator names, such as an API key', () => {
		const env = cleanEnvironment({ ...inherited }, inherited, ['OPENAI_API_KEY']);

		expect(env.OPENAI_API_KEY).toBe('sk-live');
		expect(env.CLAUDECODE).toBeUndefined();
	});
});

describe('sanitizeChunk', () => {
	it('points both spellings of the working directory at /project', () => {
		const chunk = '{"cwd":"/private/tmp/maestro-turn-abc","note":"in /tmp/maestro-turn-abc/src"}\n';

		expect(sanitizeChunk(chunk, PATHS)).toBe('{"cwd":"/project","note":"in /project/src"}\n');
	});

	it('trims a Claude-style init event down to what the parser reads', () => {
		const init = {
			type: 'system',
			subtype: 'init',
			session_id: 'sess-1',
			cwd: '/somewhere/else',
			tools: ['Bash', 'mcp__github__create_issue', 'Read'],
			mcp_servers: [{ name: 'github', status: 'connected' }],
			skills: ['deploy'],
			plugins: [{ name: 'team-plugin' }],
			slash_commands: ['compact', 'team-plugin:release', 'clear'],
			memory_paths: { auto: '/somewhere/memory' },
			scratchpadDir: '/somewhere/scratch',
		};

		const cleaned = JSON.parse(sanitizeChunk(`${JSON.stringify(init)}\n`, PATHS));

		expect(cleaned).toEqual({
			type: 'system',
			subtype: 'init',
			session_id: 'sess-1',
			cwd: '/project',
			tools: ['Bash', 'Read'],
			mcp_servers: [],
			skills: [],
			plugins: [],
			slash_commands: ['compact', 'clear'],
		});
	});

	it('keeps chunk boundaries: a line split across two chunks is not parsed or joined', () => {
		const first = '{"type":"system","subtype":"init","cwd":"/tmp/maestro-turn-abc","mcp_ser';
		const second = 'vers":[{"name":"github"}]}\n{"type":"text","text":"done"}\n';

		expect(sanitizeChunk(first, PATHS)).toBe(
			'{"type":"system","subtype":"init","cwd":"/project","mcp_ser'
		);
		expect(sanitizeChunk(second, PATHS)).toBe(second);
	});

	it('replaces em and en dashes with hyphens', () => {
		expect(sanitizeChunk('{"text":"a \u2014 b \u2013 c"}\n', PATHS)).toBe('{"text":"a - b - c"}\n');
	});

	it('leaves everything else byte for byte', () => {
		const chunk = '{"type":"text","part":{"text":"The capital of France is Paris."}}\n';

		expect(sanitizeChunk(chunk, PATHS)).toBe(chunk);
	});
});

describe('findLeaks', () => {
	const who = { username: 'jordan' };

	it('finds nothing in a clean capture', () => {
		const text =
			'{"cwd":"/project","text":"The capital of France is Paris.","bin":"/usr/local/bin/x"}';

		expect(findLeaks(text, who)).toEqual([]);
	});

	it.each([
		[
			'a macOS home path',
			'{"path":"/Users/jordan/.claude/settings.json"}',
			'a home directory path',
		],
		['a Linux home path', '{"path":"/home/jordan/project"}', 'a home directory path'],
		['a Windows home path', '{"path":"C:\\\\Users\\\\jordan\\\\AppData"}', 'a home directory path'],
		['an email address', '{"account":"jordan@example.com"}', 'an email address'],
		['the user name on its own', '{"owner":"jordan"}', 'the local user name'],
	])('reports %s', (_case, text, what) => {
		const leaks = findLeaks(text, who);

		expect(leaks.map((leak) => leak.what)).toContain(what);
		expect(leaks[0].excerpt).toBeTruthy();
	});

	it('does not match the user name inside a longer word', () => {
		expect(findLeaks('{"text":"the jordanian coast"}', who)).toEqual([]);
	});

	it('skips the user name check for a name too short to be meaningful', () => {
		expect(findLeaks('{"text":"an ox"}', { username: 'ox' })).toEqual([]);
	});
});

describe('describeCommand', () => {
	it('records the binary by name, with the prompt and the directory masked', () => {
		const command = describeCommand(
			'/opt/homebrew/bin/codex',
			['exec', '--json', '-C', '/tmp/maestro-turn-abc', '--', 'fix the bug'],
			{ prompt: 'fix the bug', ...PATHS }
		);

		expect(command).toEqual(['codex', 'exec', '--json', '-C', '/project', '--', '<prompt>']);
	});
});
