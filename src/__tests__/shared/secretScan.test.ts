import { describe, it, expect } from 'vitest';
import {
	ALLOW_SECRETS_FLAG,
	describeSecretFinding,
	isSecretScreenRefusal,
	scanForSecrets,
	secretScreenRefusal,
	secretScreenReportLines,
	secretScreenSystemOneRequest,
	secretScreenVerdictFromSystemOne,
	SECRET_SCREEN_FLAG_PROBABILITY,
	SECRET_SCREEN_QUESTION_ID,
	SECRETS_FOUND_CODE,
	shannonEntropy,
	type SecretFinding,
} from '../../shared/secretScan';
import { maskEnvValue } from '../../shared/agentEnvironment';
import {
	redactSystemOneRequest,
	systemOneQuestionsProblem,
	systemOneStateProblem,
} from '../../shared/local-models/system-one';

/**
 * Fixtures are assembled at runtime, never written out whole. A literal token
 * in this file would be exactly what a repository secret scanner (and this
 * module) exists to stop, and would block the push that carries the test.
 */
const body = (seed: string, length: number): string =>
	seed.repeat(Math.ceil(length / seed.length)).slice(0, length);

const FIXTURES = {
	// AWS's own documented example key.
	aws: ['AKIA', 'IOSFODNN7EXAMPLE'].join(''),
	awsSession: ['ASIA', body('Q7ZK2M9X', 16)].join(''),
	githubClassic: ['ghp', body('a1B2c3D4e5', 36)].join('_'),
	githubOauth: ['gho', body('Z9y8X7w6V5', 36)].join('_'),
	githubFineGrained: ['github', 'pat', body('11ABCDEFG0', 22), body('k3J8m2Q9x7', 59)].join('_'),
	anthropic: ['sk', 'ant', 'api03', body('Xy7Kq2Lm9P', 40)].join('-'),
	openaiProject: ['sk', 'proj', body('Tn4Vb8Zc1R', 48)].join('-'),
	openaiLegacy: ['sk', body('q9W3e7R1t5', 48)].join('-'),
	slack: ['xoxb', '1234567890', '0987654321', body('AbCdEfGh', 24)].join('-'),
	pemHeader: ['-----BEGIN', 'RSA', 'PRIVATE', 'KEY-----'].join(' '),
	pemFooter: ['-----END', 'RSA', 'PRIVATE', 'KEY-----'].join(' '),
	pemBody: body('MIIEvQIBADANBgkqhkiG9w0BAQEFAASC', 128),
	generic: body('f3A9c1E7b5D2', 32),
};

const kinds = (findings: SecretFinding[]): string[] => findings.map((finding) => finding.kind);

describe('scanForSecrets', () => {
	it('returns nothing for empty and ordinary text', () => {
		expect(scanForSecrets('')).toEqual([]);
		expect(
			scanForSecrets('The build failed on line 12.\nRetry with `npm run build` after a clean.')
		).toEqual([]);
	});

	describe('provider tokens', () => {
		it.each([
			['aws-access-key', FIXTURES.aws],
			['aws-access-key', FIXTURES.awsSession],
			['github-token', FIXTURES.githubClassic],
			['github-token', FIXTURES.githubOauth],
			['github-token', FIXTURES.githubFineGrained],
			['anthropic-key', FIXTURES.anthropic],
			['openai-key', FIXTURES.openaiProject],
			['openai-key', FIXTURES.openaiLegacy],
			['slack-token', FIXTURES.slack],
		])('finds a %s', (kind, token) => {
			const findings = scanForSecrets(`first line\nexport VALUE=${token}\nlast line`);
			expect(findings).toHaveLength(1);
			expect(findings[0]).toMatchObject({ kind, line: 2, preview: maskEnvValue(token) });
		});

		it('never returns the secret itself', () => {
			const findings = scanForSecrets(`key ${FIXTURES.githubClassic}`);
			expect(JSON.stringify(findings)).not.toContain(FIXTURES.githubClassic);
			// maskEnvValue keeps the last four characters and nothing else.
			expect(findings[0].preview).toBe(`••••••••${FIXTURES.githubClassic.slice(-4)}`);
		});

		it('labels an Anthropic key as Anthropic, not as an OpenAI key', () => {
			expect(kinds(scanForSecrets(FIXTURES.anthropic))).toEqual(['anthropic-key']);
		});

		it('reports several different secrets in document order', () => {
			const findings = scanForSecrets(
				[
					`a ${FIXTURES.slack}`,
					'nothing here',
					`b ${FIXTURES.aws}`,
					`c ${FIXTURES.anthropic}`,
				].join('\n')
			);
			expect(findings.map((finding) => [finding.kind, finding.line])).toEqual([
				['slack-token', 1],
				['aws-access-key', 3],
				['anthropic-key', 4],
			]);
		});

		it('folds a repeated value into one finding with a count', () => {
			const findings = scanForSecrets(
				`${FIXTURES.aws}\nagain ${FIXTURES.aws}\nand again ${FIXTURES.aws}`
			);
			expect(findings).toEqual([
				{ kind: 'aws-access-key', line: 1, preview: maskEnvValue(FIXTURES.aws), occurrences: 3 },
			]);
		});

		it.each([
			['a short sk- word', 'the sk-learn package and sk-12345 ticket'],
			['a too-short GitHub prefix', 'ghp_abc123 is not a token'],
			['an AKIA word that is too short', 'AKIA1234 and AKIAIOSFODNN7 are not keys'],
			['a lowercase AWS lookalike', 'akiaiosfodnn7example'],
			['a slack-looking word', 'xoxb-short and the word xoxo'],
			['a git sha', 'commit 4a2730b70c1e9f8d7a6b5c4d3e2f1a0b9c8d7e6f'],
			['a uuid', 'session 8535e0e3-1b2c-4d5e-9f80-a1b2c3d4e5f6'],
		])('does not flag %s', (_name, text) => {
			expect(scanForSecrets(text)).toEqual([]);
		});
	});

	describe('private keys', () => {
		it('finds a PEM block and masks its body', () => {
			const pem = [FIXTURES.pemHeader, FIXTURES.pemBody.slice(0, 64), FIXTURES.pemBody.slice(64)];
			const findings = scanForSecrets(['intro', ...pem, FIXTURES.pemFooter].join('\n'));
			expect(findings).toHaveLength(1);
			expect(findings[0].kind).toBe('private-key');
			expect(findings[0].line).toBe(2);
			expect(findings[0].preview).toBe(`${FIXTURES.pemHeader} ${maskEnvValue(FIXTURES.pemBody)}`);
			expect(findings[0].preview).not.toContain(FIXTURES.pemBody.slice(0, 32));
		});

		it('finds a key whose newlines are escaped inside JSON', () => {
			const escaped = `{"private_key": "${FIXTURES.pemHeader}\\n${FIXTURES.pemBody}\\n${FIXTURES.pemFooter}\\n"}`;
			const findings = scanForSecrets(escaped);
			expect(kinds(findings)).toEqual(['private-key']);
		});

		it.each([
			['OPENSSH', ['-----BEGIN', 'OPENSSH', 'PRIVATE', 'KEY-----'].join(' ')],
			['PKCS8', ['-----BEGIN', 'PRIVATE', 'KEY-----'].join(' ')],
			['PGP', ['-----BEGIN', 'PGP', 'PRIVATE', 'KEY', 'BLOCK-----'].join(' ')],
		])('finds a %s header', (_name, header) => {
			expect(kinds(scanForSecrets(`${header}\n${FIXTURES.pemBody}`))).toEqual(['private-key']);
		});

		it('does not flag a public key or a certificate', () => {
			const publicKey = ['-----BEGIN', 'PUBLIC', 'KEY-----'].join(' ');
			const certificate = ['-----BEGIN', 'CERTIFICATE-----'].join(' ');
			expect(scanForSecrets(`${publicKey}\n${FIXTURES.pemBody}`)).toEqual([]);
			expect(scanForSecrets(`${certificate}\n${FIXTURES.pemBody}`)).toEqual([]);
		});
	});

	describe('generic credentials', () => {
		it.each([
			['an assignment', `api_key=${FIXTURES.generic}`],
			['a quoted JSON value', `"apiKey": "${FIXTURES.generic}"`],
			['a prefixed name', `export STRIPE_SECRET_KEY='${FIXTURES.generic}'`],
			['a YAML value', `password: ${FIXTURES.generic}`],
			['a token header', `X-Auth-Token: ${FIXTURES.generic}`],
		])('finds %s', (_name, text) => {
			const findings = scanForSecrets(text);
			expect(findings).toHaveLength(1);
			expect(findings[0]).toMatchObject({
				kind: 'generic-api-key',
				preview: maskEnvValue(FIXTURES.generic),
			});
			expect(findings[0].name).toBeTruthy();
		});

		it.each([
			['a placeholder', 'api_key=your_api_key_goes_here_1234'],
			['a variable reference', 'token = someLongVariableNameForTheToken'],
			['a dotted code reference', 'api_key: process.env.OPENAI_API_KEY_V2'],
			['a path', 'token_path=/Users/someone/.config/tool/token1234.json'],
			['a number', 'max_tokens=1234567890123456'],
			['a repeated character', 'secret=aaaaaaaaaaaaaaaaaaaaaaaa1'],
			['a short value', 'password=hunter2'],
			['a redacted value', 'api_key=[redacted]'],
			['prose about tokens', 'The token count was high and the secret is to cache prompts.'],
			['a low-entropy word value', 'password=passwordpassword1'],
		])('does not flag %s', (_name, text) => {
			expect(scanForSecrets(text)).toEqual([]);
		});

		it('does not report a provider token twice when it sits in an assignment', () => {
			const findings = scanForSecrets(`GITHUB_TOKEN=${FIXTURES.githubClassic}`);
			expect(kinds(findings)).toEqual(['github-token']);
		});
	});

	describe('configured environment values', () => {
		const value = 'correct-horse-battery-staple';

		it('finds the value of a secret-named variable and names it', () => {
			const findings = scanForSecrets(`line one\nthe db said ${value} was wrong`, {
				env: { DB_PASSWORD: value, EDITOR: 'vim' },
			});
			expect(findings).toEqual([
				{ kind: 'env-var-value', line: 2, preview: maskEnvValue(value), name: 'DB_PASSWORD' },
			]);
		});

		it('accepts entries, so one name can carry several values', () => {
			const other = 'another-agent-own-credential';
			const findings = scanForSecrets(`${value}\n${other}`, {
				env: [
					['API_TOKEN', value],
					['API_TOKEN', other],
					['API_TOKEN', undefined],
				],
			});
			expect(findings.map((finding) => [finding.name, finding.line])).toEqual([
				['API_TOKEN', 1],
				['API_TOKEN', 2],
			]);
		});

		it.each([
			['a variable whose name is not secret', { PROJECT_NAME: value }],
			['a value too short to be one', { API_TOKEN: 'dev' }],
			['a path, which names a location', { SSH_AUTH_SOCK: '/private/tmp/agent.1234/Listeners' }],
			['a number', { SESSION_TIMEOUT: '1234567890' }],
			['an exception such as a key path', { TLS_KEY_PATH: 'relative/key/file.pem' }],
			['a blank value', { API_TOKEN: '   ' }],
		])('ignores %s', (_name, env) => {
			const text = Object.values(env).join('\n');
			expect(scanForSecrets(`${text}\n${value}`, { env })).toEqual([]);
		});

		it('keeps the provider label when a configured value is also a known token shape', () => {
			const findings = scanForSecrets(FIXTURES.anthropic, {
				env: { ANTHROPIC_API_KEY: FIXTURES.anthropic },
			});
			expect(kinds(findings)).toEqual(['anthropic-key']);
		});
	});

	it('stamps the source on every finding', () => {
		const findings = scanForSecrets(`${FIXTURES.aws}\n${FIXTURES.slack}`, { source: 'logs.json' });
		expect(findings.map((finding) => finding.source)).toEqual(['logs.json', 'logs.json']);
	});

	it('counts lines across CRLF text', () => {
		const findings = scanForSecrets(`one\r\ntwo\r\n${FIXTURES.aws}`);
		expect(findings[0].line).toBe(3);
	});

	it('stays fast on a long line with no secret in it', () => {
		const long = `${'a-b.c_d'.repeat(40_000)} token`;
		const started = Date.now();
		expect(scanForSecrets(long)).toEqual([]);
		expect(Date.now() - started).toBeLessThan(2000);
	});
});

describe('shannonEntropy', () => {
	it('is zero for empty and single-character strings', () => {
		expect(shannonEntropy('')).toBe(0);
		expect(shannonEntropy('aaaa')).toBe(0);
	});

	it('is higher for random text than for a word', () => {
		expect(shannonEntropy(FIXTURES.generic)).toBeGreaterThan(shannonEntropy('passwordpassword'));
	});
});

describe('describeSecretFinding', () => {
	it('names the kind, the masked value, and where it is', () => {
		expect(
			describeSecretFinding({
				kind: 'github-token',
				line: 12,
				preview: '••••••••abcd',
				source: 'logs.json',
			})
		).toBe('GitHub token ••••••••abcd (logs.json, line 12)');
	});

	it('names the variable for a configured or generic credential', () => {
		expect(
			describeSecretFinding({
				kind: 'env-var-value',
				line: 3,
				preview: '••••••••aple',
				name: 'DB_PASSWORD',
				occurrences: 2,
			})
		).toBe('Configured secret DB_PASSWORD ••••••••aple (line 3, 2 times)');
	});

	it('names the model and leaves the line out for a model verdict', () => {
		expect(
			describeSecretFinding({
				kind: 'model-flagged',
				line: 0,
				preview: 'MALICIOUS 0.97',
				name: 'Llama Prompt Guard 2 22M',
			})
		).toBe('Flagged by model (Llama Prompt Guard 2 22M) MALICIOUS 0.97');
	});
});

describe('secretScreenRefusal', () => {
	const findings: SecretFinding[] = [{ kind: 'aws-access-key', line: 1, preview: '••••••••MPLE' }];

	it('builds the refusal every publishing path returns', () => {
		expect(secretScreenRefusal(findings, 'the gist')).toEqual({
			success: false,
			error: 'Found 1 possible secret in the gist. Nothing was sent.',
			code: SECRETS_FOUND_CODE,
			secretFindings: findings,
		});
	});

	it('pluralizes and carries the model note', () => {
		const refusal = secretScreenRefusal([...findings, ...findings], 'the feedback', 'model down');
		expect(refusal.error).toBe('Found 2 possible secrets in the feedback. Nothing was sent.');
		expect(refusal.secretScreenNote).toBe('model down');
	});

	it('is recognized by isSecretScreenRefusal, and an ordinary failure is not', () => {
		expect(isSecretScreenRefusal(secretScreenRefusal(findings, 'the gist'))).toBe(true);
		expect(isSecretScreenRefusal({ secretFindings: [] })).toBe(false);
		expect(isSecretScreenRefusal({})).toBe(false);
		expect(isSecretScreenRefusal(null)).toBe(false);
		expect(isSecretScreenRefusal(undefined)).toBe(false);
	});
});

describe('secretScreenReportLines', () => {
	it('lists each finding, then the note, then how to send it anyway', () => {
		const lines = secretScreenReportLines({
			secretFindings: [
				{ kind: 'slack-token', line: 4, preview: '••••••••wxyz', source: 'Actual' },
				{ kind: 'private-key', line: 9, preview: '-----BEGIN PRIVATE KEY-----' },
			],
			secretScreenNote: 'Secret screen model did not run.',
		});
		expect(lines).toEqual([
			'  - Slack token ••••••••wxyz (Actual, line 4)',
			'  - Private key -----BEGIN PRIVATE KEY----- (line 9)',
			'Note: Secret screen model did not run.',
			`Remove them, or re-run with ${ALLOW_SECRETS_FLAG} to send it anyway.`,
		]);
	});
});

describe('the model pass on System One', () => {
	const JEV = 'Jev (TypeSafe cloud)';
	const noul = (probability: number) => ({
		[SECRET_SCREEN_QUESTION_ID]: { type: 'noul' as const, probability },
	});

	it('asks one yes or no about the content, as a request an engine accepts', () => {
		const request = secretScreenSystemOneRequest({ text: 'db password is hunter2-prod' });
		expect(request.state).toBe('db password is hunter2-prod');
		expect(systemOneStateProblem(request.state)).toBeNull();
		expect(systemOneQuestionsProblem(request.questions)).toBeNull();
		expect(Object.keys(request.questions)).toEqual([SECRET_SCREEN_QUESTION_ID]);
		expect(request.questions[SECRET_SCREEN_QUESTION_ID].type).toBe('noul');
	});

	it('tells the engine a redaction marker is not a finding, since a known secret never reaches it', () => {
		const request = secretScreenSystemOneRequest({ text: `token ${FIXTURES.githubClassic}` });
		const sent = redactSystemOneRequest(request.state, request.questions);
		expect(sent.redacted).toBe(true);
		expect(sent.state).toBe('token [REDACTED_API_KEY]');
		const question = sent.questions[SECRET_SCREEN_QUESTION_ID];
		expect(question.type === 'noul' && question.criteria?.false).toContain('[REDACTED_API_KEY]');
	});

	it('flags at the midpoint and above, naming the engine and its probability', () => {
		expect(SECRET_SCREEN_FLAG_PROBABILITY).toBe(0.5);
		expect(secretScreenVerdictFromSystemOne(noul(0.934), JEV)).toEqual({
			finding: { kind: 'model-flagged', line: 0, preview: 'secret 0.93', name: JEV },
		});
		expect(secretScreenVerdictFromSystemOne(noul(0.5), JEV)?.finding).not.toBeNull();
		expect(secretScreenVerdictFromSystemOne(noul(0.49), JEV)).toEqual({ finding: null });
	});

	it('describes its finding the way a classifier finding is described', () => {
		const verdict = secretScreenVerdictFromSystemOne(noul(0.934), JEV);
		expect(describeSecretFinding(verdict!.finding!)).toBe(`Flagged by model (${JEV}) secret 0.93`);
	});

	it('has no verdict when the answers hold no yes or no for its question', () => {
		expect(secretScreenVerdictFromSystemOne({}, JEV)).toBeNull();
		expect(
			secretScreenVerdictFromSystemOne(
				{ [SECRET_SCREEN_QUESTION_ID]: { type: 'score', score: 1 } },
				JEV
			)
		).toBeNull();
	});
});
