/**
 * Tests for src/shared/shellTemplateVariables.ts
 *
 * Template values reach a shell command as data: each placeholder becomes a
 * quoted parameter expansion and the value rides in an environment variable,
 * so text from a pull request or a webhook never parses as shell syntax.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	SHELL_TEMPLATE_ENV_PREFIX,
	ShellTemplateError,
	substituteShellTemplateVariables,
} from '../../shared/shellTemplateVariables';
import type { TemplateContext } from '../../shared/templateVariables';
import {
	buildRemoteCommand,
	wrapRemoteCommandWithPath,
} from '../../shared/maestro-lib/launch/ssh-command-builder';

function contextWith(
	cue: NonNullable<TemplateContext['cue']>,
	overrides: Partial<TemplateContext> = {}
): TemplateContext {
	return {
		session: { id: 'session-1', name: 'Test', toolType: 'claude-code', cwd: '/projects/test' },
		cue,
		...overrides,
	};
}

const TITLE = `${SHELL_TEMPLATE_ENV_PREFIX}CUE_GH_TITLE`;
const titled = (ghTitle: string) => contextWith({ ghTitle });

describe('substituteShellTemplateVariables', () => {
	it('keeps the text the author wrote and moves the value into the environment', () => {
		const result = substituteShellTemplateVariables(
			'gh pr view {{CUE_GH_NUMBER}} --json title | jq .title',
			contextWith({ ghNumber: '42' })
		);
		expect(result.command).toBe(
			'gh pr view "${MAESTRO_VAR_CUE_GH_NUMBER}" --json title | jq .title'
		);
		expect(result.env).toEqual({ MAESTRO_VAR_CUE_GH_NUMBER: '42' });
	});

	it.each([
		['unquoted', 'echo {{CUE_GH_TITLE}}', `echo "\${${TITLE}}"`],
		['inside double quotes', 'echo "Title: {{CUE_GH_TITLE}}!"', `echo "Title: \${${TITLE}}!"`],
		['inside single quotes', "echo 'Title: {{CUE_GH_TITLE}}'", `echo 'Title: '"\${${TITLE}}"''`],
		["inside $'...'", "echo $'Title: {{CUE_GH_TITLE}}'", `echo $'Title: '"\${${TITLE}}"$''`],
		[
			'after an apostrophe inside double quotes',
			`echo "it's {{CUE_GH_TITLE}}"`,
			`echo "it's \${${TITLE}}"`,
		],
		[
			'after double quotes inside single quotes',
			`echo 'say "hi"' {{CUE_GH_TITLE}}`,
			`echo 'say "hi"' "\${${TITLE}}"`,
		],
		[
			'after escaped double quotes',
			'echo "a \\"b\\" {{CUE_GH_TITLE}}"',
			`echo "a \\"b\\" \${${TITLE}}"`,
		],
		['after an escaped single quote', "echo \\'{{CUE_GH_TITLE}}", `echo \\'"\${${TITLE}}"`],
		['after a here-string', 'cat <<< {{CUE_GH_TITLE}}', `cat <<< "\${${TITLE}}"`],
		['after an input redirect', 'wc -l <{{CUE_GH_TITLE}}', `wc -l <"\${${TITLE}}"`],
	])('quotes the expansion for a placeholder %s', (_where, template, command) => {
		const result = substituteShellTemplateVariables(template, titled('hello'));
		expect(result.command).toBe(command);
		expect(result.env).toEqual({ [TITLE]: 'hello' });
	});

	it('reuses one variable for a placeholder written twice, in either case', () => {
		const result = substituteShellTemplateVariables(
			'echo {{CUE_GH_TITLE}} "{{cue_gh_title}}"',
			titled('x')
		);
		expect(result.command).toBe(`echo "\${${TITLE}}" "\${${TITLE}}"`);
		expect(result.env).toEqual({ [TITLE]: 'x' });
	});

	it('leaves unknown placeholders literal', () => {
		const result = substituteShellTemplateVariables('echo {{NOT_A_VARIABLE}}', titled('x'));
		expect(result).toEqual({ command: 'echo {{NOT_A_VARIABLE}}', env: {} });
	});

	it('writes an empty value as one empty word, or as nothing inside quotes', () => {
		const result = substituteShellTemplateVariables(
			`printf x {{CUE_GH_BODY}} "[{{CUE_GH_BODY}}]" '[{{CUE_GH_BODY}}]'`,
			contextWith({ ghBody: '' })
		);
		expect(result).toEqual({ command: `printf x '' "[]" '[]'`, env: {} });
	});

	it('leaves a placeholder in a comment as written, but not a # inside a word', () => {
		const comment = substituteShellTemplateVariables(
			'echo hi # about {{CUE_GH_TITLE}}',
			titled('x\ntouch /tmp/pwned')
		);
		expect(comment).toEqual({ command: 'echo hi # about {{CUE_GH_TITLE}}', env: {} });

		const word = substituteShellTemplateVariables('echo a#{{CUE_GH_TITLE}}', titled('x'));
		expect(word.command).toBe(`echo a#"\${${TITLE}}"`);
	});

	it('inserts {{MAESTRO_CLI_PATH}} as the command Maestro wrote for it', () => {
		const result = substituteShellTemplateVariables(
			'{{MAESTRO_CLI_PATH}} send agent-1 {{CUE_GH_TITLE}}',
			contextWith({ ghTitle: 'x' }, { maestroCliPath: '/opt/maestro/maestro-cli.js' })
		);
		expect(result.command).toBe(`node "/opt/maestro/maestro-cli.js" send agent-1 "\${${TITLE}}"`);
	});

	it('keeps a backslash written right before a placeholder literal', () => {
		const result = substituteShellTemplateVariables(
			'echo \\{{CUE_GH_TITLE}} "\\{{CUE_GH_TITLE}}"',
			titled('x')
		);
		expect(result.command).toBe(`echo \\\\"\${${TITLE}}" "\\\\\${${TITLE}}"`);
	});

	it('names a dynamic variable by its sanitized name, without collisions', () => {
		const result = substituteShellTemplateVariables(
			'echo {{CUE_OUTPUT_MY-AGENT}} {{CUE_OUTPUT_MY_AGENT}}',
			// The context builder adds `output_<name>` keys the static type does not list.
			contextWith({
				eventType: 'agent.completed',
				'output_my-agent': 'dash',
				output_my_agent: 'underscore',
			} as NonNullable<TemplateContext['cue']>)
		);
		expect(result.command).toBe(
			'echo "${MAESTRO_VAR_CUE_OUTPUT_MY_AGENT}" "${MAESTRO_VAR_CUE_OUTPUT_MY_AGENT_2}"'
		);
		expect(result.env).toEqual({
			MAESTRO_VAR_CUE_OUTPUT_MY_AGENT: 'dash',
			MAESTRO_VAR_CUE_OUTPUT_MY_AGENT_2: 'underscore',
		});
	});

	describe('heredocs', () => {
		it('expands bare inside an unquoted heredoc, where quotes are text', () => {
			const template = [
				'cat <<EOF | tee out.txt',
				`it's "{{CUE_GH_TITLE}}"`,
				'EOF',
				'echo {{CUE_GH_TITLE}}',
			].join('\n');
			const result = substituteShellTemplateVariables(template, titled('x'));
			expect(result.command).toBe(
				['cat <<EOF | tee out.txt', `it's "\${${TITLE}}"`, 'EOF', `echo "\${${TITLE}}"`].join('\n')
			);
		});

		it('ends a <<- body at a tab-indented delimiter, and reads two bodies in order', () => {
			const template = [
				'cat <<-END <<TWO',
				'\t{{CUE_GH_TITLE}}',
				'\tEND',
				"'{{CUE_GH_TITLE}}'",
				'TWO',
				"echo '{{CUE_GH_TITLE}}'",
			].join('\n');
			const result = substituteShellTemplateVariables(template, titled('x'));
			expect(result.command).toBe(
				[
					'cat <<-END <<TWO',
					`\t\${${TITLE}}`,
					'\tEND',
					`'\${${TITLE}}'`,
					'TWO',
					`echo ''"\${${TITLE}}"''`,
				].join('\n')
			);
		});

		it.each([["<<'EOF'"], ['<<"EOF"'], ['<<\\EOF'], ["<<-'EOF'"]])(
			'refuses a placeholder inside a quoted heredoc (%s)',
			(operator) => {
				const template = `cat ${operator}\n{{CUE_GH_TITLE}}\nEOF`;
				expect(() => substituteShellTemplateVariables(template, titled('x'))).toThrow(
					ShellTemplateError
				);
				expect(() => substituteShellTemplateVariables(template, titled('x'))).toThrow(
					/\{\{CUE_GH_TITLE\}\} is inside a quoted heredoc/
				);
			}
		);

		it('accepts a placeholder after a quoted heredoc ends', () => {
			const result = substituteShellTemplateVariables(
				"cat <<'EOF'\nliteral $HOME\nEOF\necho {{CUE_GH_TITLE}}",
				titled('x')
			);
			expect(result.command).toBe(`cat <<'EOF'\nliteral $HOME\nEOF\necho "\${${TITLE}}"`);
		});

		it.each([['cat <<{{CUE_GH_TITLE}}'], ['cat <<EOF{{CUE_GH_TITLE}}']])(
			'refuses a placeholder in a heredoc delimiter (%s)',
			(template) => {
				expect(() => substituteShellTemplateVariables(template, titled('x'))).toThrow(
					/part of a heredoc delimiter/
				);
			}
		);

		it('refuses {{MAESTRO_CLI_PATH}} inside a quoted heredoc too', () => {
			const template = "cat <<'EOF'\n{{MAESTRO_CLI_PATH}}\nEOF";
			expect(() =>
				substituteShellTemplateVariables(
					template,
					contextWith({}, { maestroCliPath: '/opt/maestro/maestro-cli.js' })
				)
			).toThrow(/\{\{MAESTRO_CLI_PATH\}\} is inside a quoted heredoc/);
		});

		it('does not end an unquoted heredoc on a line continued by a trailing backslash', () => {
			const template = [
				'cat <<EOF',
				'prefix \\',
				'EOF',
				'still-body {{CUE_GH_TITLE}}',
				'EOF',
				'echo {{CUE_GH_TITLE}}',
			].join('\n');
			const result = substituteShellTemplateVariables(template, titled('x'));
			expect(result.command).toBe(
				[
					'cat <<EOF',
					'prefix \\',
					'EOF',
					`still-body \${${TITLE}}`,
					'EOF',
					`echo "\${${TITLE}}"`,
				].join('\n')
			);
		});
	});

	describe('arithmetic contexts', () => {
		it.each([
			['$(( ... ))', 'echo $(( {{CUE_GH_TITLE}} + 1 ))'],
			['tight $((...))', 'echo $(({{CUE_GH_TITLE}}))'],
			['double-quoted "$(( ... ))"', 'echo "$(( {{CUE_GH_TITLE}} + 1 ))"'],
			['Bash (( ... )) command', 'if (( {{CUE_GH_TITLE}} > 0 )); then echo ok; fi'],
			['unquoted heredoc $(( ... ))', 'cat <<EOF\n$(( {{CUE_GH_TITLE}} + 1 ))\nEOF'],
		])('refuses a placeholder inside %s', (_label, template) => {
			expect(() => substituteShellTemplateVariables(template, titled('a[$(id)]'))).toThrow(
				ShellTemplateError
			);
			expect(() => substituteShellTemplateVariables(template, titled('a[$(id)]'))).toThrow(
				/shell arithmetic expression/
			);
		});

		it('does not treat << inside $(( ... )) or (( ... )) as a heredoc', () => {
			const arithExpansion = substituteShellTemplateVariables(
				'echo $(( 1 << 2 ))\necho {{CUE_GH_TITLE}}',
				titled('hello')
			);
			expect(arithExpansion.command).toBe(`echo $(( 1 << 2 ))\necho "\${${TITLE}}"`);

			const arithCmd = substituteShellTemplateVariables(
				'(( x = 1 << 2 ))\necho {{CUE_GH_TITLE}}',
				titled('hello')
			);
			expect(arithCmd.command).toBe(`(( x = 1 << 2 ))\necho "\${${TITLE}}"`);
		});

		it('still treats grouped subshells ((a && b) || c) as normal commands, not arithmetic', () => {
			const result = substituteShellTemplateVariables(
				'((true && echo {{CUE_GH_TITLE}}) || echo fallback)',
				titled('ok')
			);
			expect(result.command).toBe(`((true && echo "\${${TITLE}}") || echo fallback)`);
		});
	});
});

/**
 * The commands run in a real shell, the way Cue runs them: locally through
 * `/bin/sh -c` with the values in the environment, and over SSH as the remote
 * command line `buildRemoteCommand` builds (the values exported in front of
 * `bash -c`), wrapped exactly as `buildSshCommand` hands it to the remote.
 */
describe.skipIf(process.platform === 'win32')(
	'substituteShellTemplateVariables in a real shell',
	() => {
		let scratch: string;
		let marker: string;

		beforeAll(() => {
			scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-shell-template-'));
			marker = path.join(scratch, 'pwned');
		});

		afterAll(() => {
			fs.rmSync(scratch, { recursive: true, force: true });
		});

		const payloads = (): Array<[string, string]> => [
			['a title that closes a quote and starts a command', `"; touch ${marker} #`],
			['command substitution', `$(touch ${marker})`],
			['backticks', `\`touch ${marker}\``],
			['a single quote and a newline', `it's\n'; touch ${marker}; '`],
		];

		const templates = [
			'printf "[%s]" {{CUE_GH_TITLE}}',
			'printf "[%s]" "{{CUE_GH_TITLE}}"',
			"printf '[%s]' '{{CUE_GH_TITLE}}'",
		];

		function runLocal(command: string, env: Record<string, string>) {
			return spawnSync('/bin/sh', ['-c', command], {
				encoding: 'utf8',
				env: { PATH: '/usr/bin:/bin', ...env },
			});
		}

		function runOverSsh(command: string, env: Record<string, string>) {
			const remoteCommand = buildRemoteCommand({ command: 'bash', args: ['-c', command], env });
			return spawnSync('/bin/sh', ['-c', wrapRemoteCommandWithPath(remoteCommand)], {
				encoding: 'utf8',
				env: { PATH: '/usr/bin:/bin', HOME: scratch },
			});
		}

		for (const template of templates) {
			it(`keeps every payload one literal argument, locally and over SSH: ${template}`, () => {
				for (const [, payload] of payloads()) {
					const { command, env } = substituteShellTemplateVariables(template, titled(payload));
					expect(command).not.toContain(marker);

					for (const run of [runLocal, runOverSsh]) {
						const result = run(command, env);
						expect(result.stderr).toBe('');
						expect(result.status).toBe(0);
						// printf repeats its format per argument: one `[...]` means one word.
						expect(result.stdout).toBe(`[${payload}]`);
						expect(fs.existsSync(marker)).toBe(false);
					}
				}
			});
		}

		it('keeps a value with a delimiter line inside its heredoc', () => {
			const payload = `$(id)\nEOF\ntouch ${marker}`;
			const { command, env } = substituteShellTemplateVariables(
				'cat <<EOF\nTitle: {{CUE_GH_TITLE}}\nEOF',
				titled(payload)
			);
			for (const run of [runLocal, runOverSsh]) {
				const result = run(command, env);
				expect(result.status).toBe(0);
				expect(result.stdout).toBe(`Title: ${payload}\n`);
				expect(fs.existsSync(marker)).toBe(false);
			}
		});
	}
);
