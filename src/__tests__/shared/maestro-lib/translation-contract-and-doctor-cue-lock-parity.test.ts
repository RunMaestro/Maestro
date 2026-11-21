import { describe as __maestroMicrobenchDescribe } from 'vitest';
import { describe } from 'vitest';
import { it } from 'vitest';
import { expect } from 'vitest';
import { buildAgentEnvironment } from '../../../shared/maestro-lib/launch/env';
import { resolveAgentAccountKey } from '../../../shared/providerProfiles';
import { canonicalJson } from '../../../shared/canonicalJson';
import { nativeRecordKey } from '../../../shared/maestro-lib/translation/identity';
import { translationArtifact } from '../../../shared/maestro-lib/translation/identity';
import { translationHash } from '../../../shared/maestro-lib/translation/identity';
import { CodexAppServerRpc } from '../../../shared/maestro-lib/codex/rpc-client';
import { CodexAppServerRpc as MainRpc } from '../../../main/codex-app-server/rpc-client';
import { isCodexResponse } from '../../../shared/maestro-lib/codex/protocol';
import { answerCodexServerRequest } from '../../../shared/maestro-lib/codex/server-requests';
import { CUE_ENGINE_LOCK_SPEC } from '../../../shared/maestro-lib/runtime/lock';
import { CUE_ENGINE_LOCK_HEARTBEAT_MS } from '../../../main/cue/cue-engine-lock';
import { CUE_ENGINE_LOCK_STALE_MS } from '../../../main/cue/cue-engine-lock';
import { reconcileConversation } from '../../../shared/maestro-lib/translation/reconcile';
import { reconcileResource } from '../../../shared/maestro-lib/translation/reconcile';
import { extractNativeConversation } from '../../../shared/maestro-lib/translation/native-records';
import { planTranslation } from '../../../shared/maestro-lib/translation/registry';
import { TranslationRegistry } from '../../../shared/maestro-lib/translation/registry';
import type { TranslationCheckpoint } from '../../../shared/maestro-lib/translation/types';
import { validateAcceptanceInputs } from '../../../../scripts/provider-translation-acceptance/driver';
__maestroMicrobenchDescribe('translation-contract', () => {
	describe('translation evidence contract', () => {
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
});
__maestroMicrobenchDescribe('doctor-cue-lock-parity', () => {
	/**
	 * The TUI doctor reads `cue-engine.lock` without importing `src/main`, so the
	 * engine's lock parameters live in the library (`CUE_ENGINE_LOCK_SPEC`) and the
	 * engine's exports derive from them. This fails if the engine ever stops doing so,
	 * or if the file the engine writes is renamed.
	 */
	describe('doctor / cue-engine-lock parity', () => {
		it('uses the same staleness window and heartbeat as the engine', () => {
			expect(CUE_ENGINE_LOCK_SPEC.staleMs).toBe(CUE_ENGINE_LOCK_STALE_MS);
			expect(CUE_ENGINE_LOCK_SPEC.heartbeatMs).toBe(CUE_ENGINE_LOCK_HEARTBEAT_MS);
		});

		it('reads the file the engine writes', () => {
			expect(CUE_ENGINE_LOCK_SPEC.fileName).toBe('cue-engine.lock');
		});
	});
});
__maestroMicrobenchDescribe('translation-reconcile', () => {
	const identity = {
		provider: 'claude-code' as const,
		version: '2.1.296',
		accountRoot: '/isolated/claude',
		projectRoot: '/project',
	};
	const read = (id: string, text = 'same') =>
		extractNativeConversation(
			identity,
			't',
			's',
			Buffer.from(
				JSON.stringify({ uuid: id, type: 'user', message: { role: 'user', content: text } })
			)
		);
	const empty = (): TranslationCheckpoint => ({
		observed: {},
		lineage: {},
		conversations: [],
		resources: [],
		resourceBases: {},
		providerRoots: {},
	});
	describe('reversible translation planning', () => {
		it('uses origin identity across A -> B -> A -> B, preserving repeated text', () => {
			let checkpoint = empty();
			checkpoint.conversations = [read('one')];
			for (const provider of ['codex', 'claude-code', 'codex'] as const) {
				const incoming = read('native-' + provider);
				incoming.identity = { ...identity, provider };
				incoming.nativeSessionId = provider;
				checkpoint.lineage[
					nativeRecordKey(incoming.identity, provider, incoming.records[0].nativeId)
				] = checkpoint.conversations[0].records[0].origin;
				const result = reconcileConversation(incoming, checkpoint);
				expect(result.newRecords).toBe(0);
				expect(result.conversation.records).toHaveLength(1);
				checkpoint.conversations = [result.conversation];
			}
			const second = reconcileConversation(read('two'), checkpoint);
			expect(second.conversation.records).toHaveLength(2);
		});
		it('blocks edits and truncation rather than text-deduplicating', () => {
			const checkpoint = empty();
			const initial = read('one');
			checkpoint.conversations = [initial];
			checkpoint.observed[nativeRecordKey(identity, 's', 'one')] = initial.records[0].semanticHash;
			expect(reconcileConversation(read('one', 'edited'), checkpoint).limitations).toMatchObject([
				{ code: 'edited-native-record' },
			]);
			expect(reconcileConversation(read('two'), checkpoint).limitations).toMatchObject([
				{ code: 'truncated-native-history' },
			]);
		});
		it('retains conflicting variants and deletion tombstones', () => {
			expect(reconcileResource('base', 'source', 'destination')).toEqual({
				state: 'conflict',
				value: 'base',
				variants: ['source', 'destination'],
			});
			expect(reconcileResource('base', null, 'base')).toEqual({ state: 'source', value: null });
			expect(reconcileResource('base', 'base', 'changed')).toEqual({
				state: 'destination',
				value: 'changed',
			});
		});
		it('requires directional native evidence instead of resume capability flags', () => {
			const registry = new TranslationRegistry();
			expect(() =>
				registry.declareDirection({
					source: 'claude-code',
					destination: 'codex',
					sourceVersions: ['2.1.296'],
					destinationVersions: ['0.162.1'],
					verification: 'verified',
				})
			).toThrow('certification requires');
		});

		it('keeps same-provider requests no-op and unknown providers blocked', () => {
			const options = {
				agentId: 'a',
				source: identity,
				destination: identity,
				scope: { projectKnowledge: true as const, selectedUserResources: [] },
				conversations: [read('one')],
				registry: new TranslationRegistry(),
			};
			expect(planTranslation(options).status).toBe('noop');
			const plan = planTranslation({ ...options, destination: { ...identity, provider: 'codex' } });
			expect(plan.status).toBe('blocked');
			expect(plan.verification).toBe('unverified');
		});
	});
});
__maestroMicrobenchDescribe('translation-acceptance-inputs', () => {
	describe('prepared acceptance authorization', () => {
		it('requires explicit opt-in and refuses credentials outside checkout scratch', () => {
			const workspace = '/isolated/project';
			expect(() => validateAcceptanceInputs(workspace, [])).toThrow('explicit opt-in');
			const args = [
				'--execute-isolated-acceptance',
				'--claude-auth',
				'/default/.claude/credentials',
				'--codex-auth',
				'/isolated/project/.maestro/scratch/auth.json',
				'--recall-question',
				'Recall a synthetic fact',
				'--expected-recall',
				'azure kite',
			];
			expect(() => validateAcceptanceInputs(workspace, args)).toThrow('checkout scratch');
			args[2] = '/isolated/project/.maestro/scratch/claude.json';
			expect(validateAcceptanceInputs(workspace, args).expected).toBe('azure kite');
			expect(() => validateAcceptanceInputs(workspace, args.slice(0, -2))).toThrow(
				'--expected-recall'
			);
		});
	});
});
