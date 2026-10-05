/**
 * The text of a turn: nudge, new-session message, read-only instruction, merged context,
 * command arguments, and the system prompt. Each rule is the composer's, so a test here is a
 * statement about what a desktop turn sends too.
 */
import { describe, it, expect } from 'vitest';
import {
	appendNudgeMessage,
	buildMaestroSystemPrompt,
	buildMessagePrompt,
	expandCommandArguments,
	prependMergedContext,
	READ_ONLY_PLAN_INSTRUCTION,
	resolveSlashCommand,
} from '../../../../shared/maestro-lib/turns/prompt';

const SEP = '\n\n---\n\n';

describe('appendNudgeMessage', () => {
	it('puts the nudge behind the text, after a rule', () => {
		expect(appendNudgeMessage('hello', 'be brief')).toBe(`hello${SEP}be brief`);
	});

	it('leaves the text alone with no nudge', () => {
		expect(appendNudgeMessage('hello')).toBe('hello');
		expect(appendNudgeMessage('hello', '')).toBe('hello');
	});

	it('appends a whitespace-only nudge, as the composer does', () => {
		expect(appendNudgeMessage('hello', ' ')).toBe(`hello${SEP} `);
	});
});

describe('buildMessagePrompt', () => {
	const base = {
		text: 'fix it',
		hasImages: false,
		imageOnlyDefault: 'DESCRIBE',
		hasProviderSession: true,
		readOnly: false,
	};

	it('passes the text through when nothing applies', () => {
		expect(buildMessagePrompt(base)).toBe('fix it');
	});

	it('sends an image-only message as the default prompt', () => {
		expect(buildMessagePrompt({ ...base, text: '  ', hasImages: true })).toBe('DESCRIBE');
	});

	it('keeps the typed text when images come with it', () => {
		expect(buildMessagePrompt({ ...base, hasImages: true })).toBe('fix it');
	});

	it('tests for image-only AFTER the nudge, so a nudge hides it (F5)', () => {
		const text = appendNudgeMessage('', 'be brief');
		expect(buildMessagePrompt({ ...base, text, hasImages: true })).toBe(`${SEP}be brief`);
	});

	it('puts the new-session message in front on the first turn of a provider session', () => {
		expect(
			buildMessagePrompt({ ...base, hasProviderSession: false, newSessionMessage: 'house rules' })
		).toBe(`house rules${SEP}fix it`);
	});

	it('does not repeat the new-session message once the tab has a provider session', () => {
		expect(buildMessagePrompt({ ...base, newSessionMessage: 'house rules' })).toBe('fix it');
	});

	it('skips a blank new-session message', () => {
		expect(
			buildMessagePrompt({ ...base, hasProviderSession: false, newSessionMessage: '  ' })
		).toBe('fix it');
	});

	it('appends the plan instruction on a read-only turn', () => {
		expect(buildMessagePrompt({ ...base, readOnly: true })).toBe(
			`fix it${READ_ONLY_PLAN_INSTRUCTION}`
		);
		expect(READ_ONLY_PLAN_INSTRUCTION).toContain('Do NOT write a plan file');
	});

	it('layers new-session message, text and instruction in that order', () => {
		const out = buildMessagePrompt({
			...base,
			hasProviderSession: false,
			newSessionMessage: 'N',
			readOnly: true,
		});
		expect(out.startsWith(`N${SEP}fix it`)).toBe(true);
		expect(out.endsWith(READ_ONLY_PLAN_INSTRUCTION)).toBe(true);
	});
});

describe('prependMergedContext', () => {
	it('puts the context in front, after a rule', () => {
		expect(prependMergedContext('ask', 'CONTEXT')).toBe(`CONTEXT${SEP}ask`);
	});

	it('is a no-op with no context', () => {
		expect(prependMergedContext('ask')).toBe('ask');
		expect(prependMergedContext('ask', '')).toBe('ask');
	});
});

describe('expandCommandArguments', () => {
	it('replaces every placeholder with the arguments', () => {
		expect(expandCommandArguments('do $ARGUMENTS then $ARGUMENTS', 'x')).toBe('do x then x');
	});

	it('appends the arguments when there is no placeholder', () => {
		expect(expandCommandArguments('do it', 'x y')).toBe('do it\n\nx y');
	});

	it('removes the placeholder when there are no arguments', () => {
		expect(expandCommandArguments('do $ARGUMENTS now', '')).toBe('do  now');
		expect(expandCommandArguments('do $ARGUMENTS now')).toBe('do  now');
	});

	it('leaves a prompt without a placeholder alone when there are no arguments', () => {
		expect(expandCommandArguments('do it')).toBe('do it');
	});

	it('reads a replacement pattern in the arguments as the desktop does (PA4)', () => {
		// The desktop passes the arguments as a replacement STRING, so `$&` expands to the match.
		// Parity means the TUI does the same; fixing it is one change for both surfaces.
		expect(expandCommandArguments('run $ARGUMENTS', 'a$&b')).toBe('run a$ARGUMENTSb');
	});
});

describe('resolveSlashCommand', () => {
	const commands = [
		{ command: '/review', description: 'Review', prompt: 'Review $ARGUMENTS' },
		{ command: '/plain', prompt: 'Plain' },
	];

	it('matches the first word and carries the rest as arguments', () => {
		expect(resolveSlashCommand('/review src/a.ts  and b', commands)).toEqual({
			command: '/review',
			description: 'Review',
			prompt: 'Review $ARGUMENTS',
			args: 'src/a.ts  and b',
		});
	});

	it('matches a bare command with empty arguments', () => {
		expect(resolveSlashCommand('/plain', commands)).toMatchObject({ command: '/plain', args: '' });
	});

	it('falls back to commands the agent discovered, when they carry a prompt', () => {
		const agentCommands = [
			{ command: '/found', description: 'Found', prompt: 'FOUND' },
			{ command: '/noprompt' },
		];
		expect(resolveSlashCommand('/found x', commands, agentCommands)).toMatchObject({
			command: '/found',
			prompt: 'FOUND',
			args: 'x',
		});
		expect(resolveSlashCommand('/noprompt', commands, agentCommands)).toBeUndefined();
	});

	it('prefers a custom command over an agent command of the same name', () => {
		const agentCommands = [{ command: '/review', prompt: 'AGENT' }];
		expect(resolveSlashCommand('/review', commands, agentCommands)?.prompt).toBe(
			'Review $ARGUMENTS'
		);
	});

	it('treats an unmatched slash as plain text, and plain text as plain text', () => {
		expect(resolveSlashCommand('/nope', commands)).toBeUndefined();
		expect(resolveSlashCommand('review this', commands)).toBeUndefined();
	});
});

describe('buildMaestroSystemPrompt', () => {
	const session = { id: 'a-1', name: 'Alpha', toolType: 'claude-code', cwd: '/w' };

	it('fills template variables', () => {
		const out = buildMaestroSystemPrompt({
			template: 'I am {{AGENT_NAME}} ({{AGENT_ID}}) in {{CWD}} on {{GIT_BRANCH}}, tab {{TAB_ID}}',
			session,
			gitBranch: 'main',
			activeTabId: 't-1',
		});
		expect(out).toBe('I am Alpha (a-1) in /w on main, tab t-1');
	});

	it('uses the stated CLI path as a node command, and the injected clock', () => {
		const out = buildMaestroSystemPrompt({
			template: '{{MAESTRO_CLI_PATH}} / {{YEAR}}',
			session,
			maestroCliPath: '/opt/m/maestro-cli.js',
			now: new Date(2031, 0, 2),
		});
		expect(out).toBe('node "/opt/m/maestro-cli.js" / 2031');
	});

	it('fills the history path and conductor profile', () => {
		const out = buildMaestroSystemPrompt({
			template: '{{AGENT_HISTORY_PATH}} | {{CONDUCTOR_PROFILE}}',
			session,
			historyFilePath: '/h/a-1.jsonl',
			conductorProfile: 'Pedram',
		});
		expect(out).toBe('/h/a-1.jsonl | Pedram');
	});

	it('appends the Pianola instructions after a rule', () => {
		expect(buildMaestroSystemPrompt({ template: 'BASE', session, pianolaPrompt: 'MANAGER' })).toBe(
			`BASE${SEP}MANAGER`
		);
	});
});
