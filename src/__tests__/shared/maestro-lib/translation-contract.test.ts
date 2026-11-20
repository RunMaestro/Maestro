import { describe, it, expect } from 'vitest';
import { buildAgentEnvironment } from '../../../shared/maestro-lib/launch/env';
import { resolveAgentAccountKey } from '../../../shared/providerProfiles';
import { canonicalJson } from '../../../shared/canonicalJson';
import {
	nativeRecordKey,
	translationArtifact,
	translationHash,
} from '../../../shared/maestro-lib/translation/identity';
import { CodexAppServerRpc } from '../../../shared/maestro-lib/codex/rpc-client';
import { CodexAppServerRpc as MainRpc } from '../../../main/codex-app-server/rpc-client';
import { isCodexResponse } from '../../../shared/maestro-lib/codex/protocol';
import { answerCodexServerRequest } from '../../../shared/maestro-lib/codex/server-requests';
import {
	TRANSLATION_DIRECTIONS,
	TRANSLATION_PROVIDER_VERSIONS,
	translationVersionLimitation,
} from '../../../shared/maestro-lib/translation/support';
import {
	claudeTranslationAdapter,
	codexTranslationAdapter,
} from '../../../shared/maestro-lib/translation/adapters';
import {
	TranslationRegistry,
	planTranslation,
} from '../../../shared/maestro-lib/translation/registry';

describe('translation evidence contract', () => {
	it.each([
		['2.1.295', 'block'],
		['2.1.296-rc.1', 'block'],
		['2.1.296', undefined],
		['2.1.297-rc.1', 'warning'],
		['2.1.296+build.1', 'warning'],
		['2.1.301', 'warning'],
		['3.0.0', 'warning'],
		['invalid', 'block'],
		['2.1.296-garbage!', 'block'],
		['2.1', 'block'],
	] as const)('enforces strict semantic version coverage for %s', (version, severity) => {
		const limitation = translationVersionLimitation(
			'claude-code',
			version,
			TRANSLATION_PROVIDER_VERSIONS['claude-code']
		);
		expect(limitation?.severity).toBe(severity);
	});
	it.each([
		['2.1.296', '0.162.1', 'verified'],
		['2.1.297', '0.162.1', 'unverified'],
		['2.1.296', '0.162.2', 'unverified'],
		['2.1.301', '0.163.0', 'unverified'],
	] as const)(
		'bounds native certification to tested versions %s -> %s',
		(sourceVersion, destinationVersion, verification) => {
			const registry = new TranslationRegistry();
			registry.register(claudeTranslationAdapter);
			registry.register(codexTranslationAdapter);
			registry.declareDirection({
				...TRANSLATION_DIRECTIONS[0],
				verification: 'verified',
				evidence: {
					nativeResume: 'synthetic resume evidence',
					roundTrip: 'synthetic round-trip evidence',
					resources: 'synthetic resource evidence',
					payloadClasses: ['conversation'],
				},
			});
			const source = {
				provider: 'claude-code' as const,
				version: sourceVersion,
				accountRoot: '/isolated/claude',
				projectRoot: '/isolated/project',
			};
			const destination = {
				...source,
				provider: 'codex' as const,
				version: destinationVersion,
				accountRoot: '/isolated/codex',
			};
			const plan = planTranslation({
				agentId: 'a',
				source,
				destination,
				registry,
				conversations: [],
				scope: { projectKnowledge: true, selectedUserResources: [] },
			});
			expect(registry.direction(source, destination)?.verification).toBe(verification);
			expect(plan.status).toBe('ready');
			expect(plan.verification).toBe(verification);
			if (verification === 'verified') expect(plan.limitations).toEqual([]);
			else {
				expect(plan.limitations).toEqual(
					expect.arrayContaining([
						expect.objectContaining({ code: 'untested-version', severity: 'warning' }),
						expect.objectContaining({ code: 'unverified-native-resume', severity: 'warning' }),
					])
				);
			}
		}
	);
	it('resolves the migration account through the launch environment including explicit unset values', () => {
		const env = buildAgentEnvironment({
			surface: 'desktop',
			globalShellEnvVars: { CODEX_HOME: '/global/account' },
			sessionCustomEnvVars: { CODEX_HOME: ' ' },
		});
		expect(resolveAgentAccountKey('codex', env as Record<string, string>, '/isolated')).toBe(
			'/isolated/.codex'
		);
	});
	it('archives byte-exact evidence separately from deterministic semantic identity', () => {
		const bytes = Buffer.from('opaque\r\nunknown\n');
		const artifact = translationArtifact(
			'transcript',
			'/isolated/source.jsonl',
			'source.jsonl',
			bytes
		);
		expect(Buffer.from(artifact.bytesBase64, 'base64')).toEqual(bytes);
		expect(artifact.sha256).toBe(translationHash(bytes));
		expect(canonicalJson({ b: 2, a: 1 })).toBe(canonicalJson({ a: 1, b: 2 }));
	});
	it('separates accounts and repeated events', () => {
		const identity = {
			provider: 'codex' as const,
			version: '0.162.1',
			accountRoot: '/one',
			projectRoot: '/project',
		};
		expect(nativeRecordKey(identity, 's', '1')).not.toBe(nativeRecordKey(identity, 's', '2'));
		expect(nativeRecordKey(identity, 's', '1')).not.toBe(
			nativeRecordKey({ ...identity, accountRoot: '/two' }, 's', '1')
		);
	});
	it('keeps desktop and translation on one RPC implementation and denies tool execution', async () => {
		expect(MainRpc).toBe(CodexAppServerRpc);
		const rpc = new CodexAppServerRpc(() => {});
		const pending = rpc.request('thread/read');
		const response = { id: 1, result: { thread: { id: 'native' } } };
		expect(isCodexResponse(response)).toBe(true);
		rpc.handleResponse(response);
		await expect(pending).resolves.toEqual(response.result);
		expect(
			answerCodexServerRequest({ id: 1, method: 'item/tool/call' }, { grantApprovals: false })
		).toEqual({ result: { success: false, contentItems: [] } });
	});
});
