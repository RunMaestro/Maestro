/**
 * Pianola IPC Handlers
 *
 * Exposes the Pianola rules CRUD and the decision audit log to the renderer.
 * Thin transport that delegates to the main-process store
 * (src/main/pianola/pianola-store-main.ts), which reads/writes the same files
 * the CLI watcher uses.
 *
 * Gated at the handler on `encoreFeatures.pianola`. Pianola can auto-send
 * messages to agents, so when the Encore flag is off every channel throws
 * `'PianolaDisabled'` rather than returning empty data - the renderer needs to
 * distinguish "feature off" from "no rules / no decisions yet". The gate runs
 * OUTSIDE withIpcErrorLogging so the sentinel is not logged as an unexpected
 * IPC failure.
 */

import { ipcMain, type BrowserWindow } from 'electron';
import { withIpcErrorLogging, type CreateHandlerOptions } from '../../utils/ipcHandler';
import {
	readRulesResult,
	writeRules,
	readDecisions,
	readSupervisorTargets,
	readScopeCheckpoint,
	upsertSupervisorTarget,
	removeSupervisorTarget,
	readSuggestions,
	writeSuggestions,
	setProfile,
	type RulesLoadResult,
} from '../../pianola/pianola-store-main';
import {
	validatePianolaSupervisedTarget,
	type PianolaDecisionRecord,
	type PianolaSupervisedTarget,
	validatePianolaRule,
	type PianolaSuggestionsFile,
	type PianolaSuggestionCandidate,
} from '../../../shared/pianola/storage';
import type { PianolaRule } from '../../../shared/pianola/types';
import {
	pianolaScopeConfigurationFingerprint,
	pianolaCoverageRegistryFingerprint,
} from '../../../shared/pianola/pianola-scope-cycle';
import type {
	PianolaScopeCoverage,
	PianolaScopeCheckpoint,
} from '../../../shared/pianola/pianola-scope-checkpoint';
import type { PianolaSupervisor, PianolaSupervisorHealth } from '../../pianola/pianola-supervisor';
import { generateUUID } from '../../../shared/uuid';
import { getActingUser } from '../../web-server/auth/acting-user';
import type { WebServer } from '../../web-server/WebServer';
import { synthesizeSuggestions } from '../../../shared/pianola/pianola-synthesis';
import { settledDecisionPairs } from '../../../shared/pianola/transcript-mining';
import { canonicalJson } from '../../../shared/canonicalJson';
import { captureException } from '../../utils/sentry';
import { readPianolaOwnerIdentity } from '../../../shared/pianola/owner-identity';

const LOG_CONTEXT = '[Pianola]';

/** Snapshot returned by every supervisor channel: persisted targets + live health. */
export interface PianolaSupervisorSnapshot {
	targets: PianolaSupervisedTarget[];
	health: PianolaSupervisorHealth[];
	checkpoints: Array<{
		scopeId: string;
		checkpoint: PianolaScopeCheckpoint | null;
		error?: string;
		coverage?: PianolaScopeCoverage;
	}>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const handlerOpts = (operation: string): Pick<CreateHandlerOptions, 'context' | 'operation'> => ({
	context: LOG_CONTEXT,
	operation,
});

/**
 * Dependencies for Pianola handlers. Only the settings store is needed, for the
 * Encore gate.
 */
export interface PianolaHandlerDependencies {
	settingsStore: {
		get: (key: string) => unknown;
		set?: (key: string, value: unknown) => void;
	};
	getAppWindows?: () => BrowserWindow[];
	/** The desktop supervised daemon; supervisor channels drive its reconcile. */
	supervisor: PianolaSupervisor;
	getWebServer?: () => WebServer | null;
}

/**
 * Returns true only when `encoreFeatures.pianola` is explicitly enabled. Read on
 * every call so a toggle change takes effect without an app restart.
 */
function isPianolaEnabled(settingsStore: { get: (key: string) => unknown }): boolean {
	const ef = (settingsStore.get('encoreFeatures') ?? {}) as Record<string, unknown>;
	return ef.pianola === true;
}

/**
 * Register the Pianola IPC handlers.
 */
export function registerPianolaHandlers(deps: PianolaHandlerDependencies): void {
	const { settingsStore, supervisor } = deps;
	const isNativeOwnerTransport = (event: unknown): boolean => {
		if (!isRecord(event) || event.type === 'bridge' || getActingUser()) return false;
		return (deps.getAppWindows?.() ?? []).some((win) => {
			if (win.isDestroyed() || win.webContents.isDestroyed()) return false;
			return (
				win.webContents.getType() === 'window' &&
				event.sender === win.webContents &&
				event.senderFrame === win.webContents.mainFrame
			);
		});
	};

	/** Current persisted targets + live health, returned by every supervisor channel. */
	const snapshot = (): PianolaSupervisorSnapshot => {
		const targets = readSupervisorTargets();
		const health = supervisor.getHealth();
		const now = Date.now();
		const registryFingerprint = pianolaCoverageRegistryFingerprint(targets);
		return {
			targets,
			health,
			checkpoints: targets
				.filter((target) => target.kind === 'watch-scope')
				.map((target) => {
					let checkpoint: PianolaScopeCheckpoint | null = null;
					let error: string | undefined;
					try {
						checkpoint = readScopeCheckpoint(target.id);
					} catch (cause) {
						error = cause instanceof Error ? cause.message : 'Checkpoint unavailable';
					}
					const worker = health.find((item) => item.id === target.id);
					const configurationFingerprint =
						target.selection && target.managerAgentId
							? pianolaScopeConfigurationFingerprint({
									...target,
									selection: target.selection,
									managerAgentId: target.managerAgentId,
								})
							: null;
					const censusAt = checkpoint?.lastSnapshotAt ?? null;
					const ageMs = censusAt === null ? null : now - censusAt;
					// Three missed polls with a 30s floor; this measures metadata
					// freshness, never answer delivery or recipient acknowledgment.
					const staleAfterMs = Math.max(30_000, (target.intervalSeconds ?? 5) * 3000);
					const fresh =
						ageMs !== null &&
						ageMs >= 0 &&
						ageMs <= staleAfterMs &&
						checkpoint?.configurationFingerprint === configurationFingerprint &&
						checkpoint?.coverageRegistryFingerprint === registryFingerprint &&
						(worker?.startedAt === undefined || censusAt! >= worker.startedAt);
					let status: PianolaScopeCoverage['status'];
					let reason: string;
					let nextActor: PianolaScopeCoverage['nextActor'] = 'operator';
					let nextAction: string;
					if (!target.enabled) {
						status = 'paused';
						reason = 'Scope disabled';
						nextActor = 'none';
						nextAction = 'Explicitly resume the scope to continue monitoring';
					} else if (
						error ||
						checkpoint?.lastCycleError ||
						target.selection?.mode !== 'agents-and-groups' ||
						worker?.state !== 'running'
					) {
						status = 'blocked';
						reason =
							error ??
							checkpoint?.lastCycleError?.reason ??
							(target.selection?.mode !== 'agents-and-groups'
								? 'Legacy scope requires explicit agent/group selection'
								: (worker?.lastError ?? `Worker ${worker?.state ?? 'not registered'}`));
						nextAction = error
							? 'Repair the checkpoint before resuming; preserve uncertain delivery intents'
							: checkpoint?.lastCycleError
								? 'Restore complete native census access; worker retries on its next cycle'
								: 'Restore valid native selection and a running scope worker';
					} else if (!fresh) {
						status = 'stale';
						reason = 'No fresh census for the current configuration and worker';
						nextAction =
							'Obtain a complete native census with the current registry; inspect worker errors if it remains stale';
					} else if (checkpoint?.status !== 'armed') {
						status = 'blocked';
						reason = `Checkpoint ${checkpoint?.status ?? 'missing'}`;
						nextAction = 'Restore the native census and arm the scope through its worker';
					} else {
						status = 'covered';
						reason = 'Fresh native census for current selection';
						nextActor = 'worker';
						nextAction = 'Continue bounded transcript monitoring';
					}
					const tabs: PianolaScopeCoverage['tabs'] = (checkpoint?.tabs ?? []).map((tab) => {
						const observation = tab.coverage;
						const historicalStatus =
							tab.status === 'closed' ? 'closed' : (observation?.status ?? 'stale');
						const overridden = historicalStatus !== 'closed' && status !== 'covered';
						return {
							agentId: tab.agentId,
							tabId: tab.tabId,
							status: overridden ? (status === 'blocked' ? 'suspended' : status) : historicalStatus,
							ownerScopeId: overridden || !fresh ? null : (observation?.ownerScopeId ?? null),
							observedAt: observation?.observedAt ?? null,
							reason: overridden
								? reason
								: (observation?.reason ?? 'Historical tab without current coverage observation'),
							nextActor: overridden ? nextActor : (observation?.nextActor ?? 'operator'),
							nextAction: overridden
								? nextAction
								: (observation?.nextAction ?? 'Obtain a fresh native census'),
							...(observation?.status === 'blocked' ? { error: observation.reason } : {}),
						};
					});
					if (
						status === 'covered' &&
						tabs.some((tab) => tab.status === 'blocked' || tab.status === 'stale')
					) {
						status = 'blocked';
						reason = 'One or more tabs have incomplete or failed coverage';
						nextActor = 'operator';
						nextAction =
							'Resolve the per-agent/tab errors below; healthy tabs continue independently';
					}
					return {
						scopeId: target.id,
						checkpoint,
						...(error ? { error } : {}),
						coverage: {
							configurationFingerprint,
							checkpointFingerprint: checkpoint?.configurationFingerprint ?? null,
							censusAt,
							ageMs,
							staleAfterMs,
							fresh,
							status,
							reason,
							nextActor,
							nextAction,
							tabs,
						},
					};
				}),
		};
	};

	const wrappedGetRules = withIpcErrorLogging(
		handlerOpts('getRules'),
		// Returns { rules, malformed } so the UI can warn before overwriting a
		// corrupt hand-edited file rather than silently showing "no rules".
		async (): Promise<RulesLoadResult> => readRulesResult()
	);
	const wrappedSaveRules = withIpcErrorLogging(
		handlerOpts('saveRules'),
		// writeRules validates the untrusted payload at the persistence boundary.
		async (rules: unknown): Promise<PianolaRule[]> => writeRules(rules)
	);
	const wrappedGetDecisions = withIpcErrorLogging(
		handlerOpts('getDecisions'),
		async (limit?: number): Promise<PianolaDecisionRecord[]> => readDecisions(limit)
	);
	const wrappedGetSuggestions = withIpcErrorLogging(
		handlerOpts('getSuggestions'),
		// Catch up after restart or before the incremental job finishes. The
		// shared store only persists changed review metadata, never live policy.
		async (): Promise<PianolaSuggestionsFile> => writeSuggestions(readSuggestions())
	);
	/** Shared by legacy approval and source-linked accept/edit/reject. No await
	 * occurs between fresh evidence validation and the durable writes. */
	const reviewSuggestion = (
		event: unknown,
		raw: unknown
	): {
		rules: PianolaRule[];
		suggestions: PianolaSuggestionsFile;
	} => {
		if (
			!isRecord(raw) ||
			typeof raw.candidateId !== 'string' ||
			typeof raw.evidenceFingerprint !== 'string' ||
			typeof raw.operation !== 'string' ||
			!['accept', 'edit', 'reject'].includes(raw.operation)
		)
			throw new Error('InvalidSuggestionReview');
		const loaded = readRulesResult();
		if (loaded.malformed) throw new Error('MalformedRulesFile');
		const staged = readSuggestions();
		const candidate = staged.candidates?.find((item) => item.id === raw.candidateId);
		const current = synthesizeSuggestions({
			pairs: settledDecisionPairs(readDecisions()),
			existingRules: loaded.rules,
			learningScope: candidate?.rule.scope === 'group' ? 'group' : 'agent',
			minSamples: settingsStore.get('pianolaLearningMinSamples') as number | undefined,
		}).candidates.find((item) => item.id === raw.candidateId);
		if (
			!candidate ||
			!current ||
			candidate.evidenceFingerprint !== raw.evidenceFingerprint ||
			current.evidenceFingerprint !== raw.evidenceFingerprint ||
			staged.rejections?.some(
				(item) =>
					item.candidateId === candidate.id && item.evidenceFingerprint === raw.evidenceFingerprint
			)
		)
			throw new Error('StaleOrChangedSuggestion');

		// Only a transport-attributed owner review grants learned-rule consent.
		// The caller cannot supply its own human role or reviewer identity.
		const user = getActingUser();
		const bridge = isRecord(event) && event.type === 'bridge';
		const identity = readPianolaOwnerIdentity(settingsStore.get('pianolaLearningIdentity'));
		const confirmed =
			(bridge &&
				user &&
				identity.ownerWebUserId !== undefined &&
				user.id === identity.ownerWebUserId) ||
			(isNativeOwnerTransport(event) && identity.desktopIsOwner);
		if (!confirmed) throw new Error('HumanSuggestionReviewRequired');
		const actorId = user?.id ?? 'desktop';
		const now = Date.now();
		if (raw.operation === 'reject') {
			if (raw.reason !== undefined && typeof raw.reason !== 'string')
				throw new Error('InvalidSuggestionRejection');
			const suggestions = writeSuggestions({
				...staged,
				candidates: staged.candidates!.filter((item) => item.id !== candidate.id),
				rejections: [
					...(staged.rejections ?? []),
					{
						sourceKind: 'native-human-review',
						principal: 'owner',
						candidateId: candidate.id,
						evidenceFingerprint: candidate.evidenceFingerprint,
						candidate,
						rejectedAt: now,
						actorId,
						...(typeof raw.reason === 'string' ? { reason: raw.reason } : {}),
					},
				],
			});
			return { rules: loaded.rules, suggestions };
		}

		let rule = candidate.rule;
		if (raw.operation === 'edit') {
			const edited = validatePianolaRule(raw.rule);
			if (!edited || edited.id !== candidate.id) throw new Error('InvalidSuggestionRule');
			// Answer, description and priority can be edited by Chris. Scope, the
			// exact condition and risk guard retain the evidenced authorization.
			const boundary = (value: PianolaRule): string =>
				canonicalJson([value.scope, value.scopeId ?? null, value.match, value.action]);
			if (boundary(edited) !== boundary(candidate.rule)) throw new Error('BroadenedSuggestionEdit');
			rule = {
				...candidate.rule,
				answer: edited.answer,
				description: edited.description,
				priority: edited.priority,
			};
		}
		const approvedRule = { ...rule, enabled: true, updatedAt: now };
		// Persist the human authorization before activating policy. A failure to
		// write rules leaves an approval receipt and the candidate available to retry;
		// a receipt alone never activates a rule, including after restart.
		const authorized = writeSuggestions({
			...staged,
			approvals: [
				...(staged.approvals ?? []),
				{
					sourceKind: 'native-human-review',
					principal: 'owner',
					candidate,
					rule: approvedRule,
					approvedAt: now,
					actorId,
					edited: raw.operation === 'edit',
				},
			],
		});
		const rules = writeRules([...loaded.rules, approvedRule]);
		let suggestions = authorized;
		try {
			suggestions = writeSuggestions({
				...authorized,
				candidates: authorized.candidates!.filter((item) => item.id !== candidate.id),
			});
		} catch (error) {
			// Authorization and activation succeeded; report cleanup separately.
			void captureException(error, {
				operation: 'prune approved Pianola suggestion',
				ruleId: rule.id,
			});
		}
		return { rules, suggestions };
	};
	const wrappedReviewSuggestion = withIpcErrorLogging(
		handlerOpts('reviewSuggestion'),
		async (event: unknown, payload: unknown) => reviewSuggestion(event, payload)
	);
	const wrappedApplySuggestion = withIpcErrorLogging(
		handlerOpts('applySuggestion'),
		// Approving a suggestion only writes config: an approved rule is appended to
		// the rules file (still subject to decide() at runtime, so high-risk always
		// escalates), and an approved profile draft is persisted. Nothing here ever
		// auto-answers or bypasses the policy.
		async (raw: unknown, event: unknown): Promise<{ rules: PianolaRule[] }> => {
			if (!isRecord(raw)) throw new Error('InvalidSuggestionPayload');
			const loaded = readRulesResult();
			if (loaded.malformed) throw new Error('MalformedRulesFile');
			let rules = loaded.rules;
			if (raw.rule !== undefined) {
				const rule = validatePianolaRule(raw.rule);
				if (!rule) throw new Error('InvalidSuggestionRule');
				const staged = readSuggestions();
				const candidate: PianolaSuggestionCandidate | undefined = staged.candidates?.find(
					(item) => item.id === rule.id
				);
				const policy = (value: PianolaRule): string =>
					canonicalJson([
						value.scope,
						value.scopeId ?? null,
						value.match,
						value.action,
						value.answer ?? null,
					]);
				if (
					!candidate ||
					policy(rule) !== policy(candidate.rule) ||
					rule.createdAt !== candidate.rule.createdAt ||
					rule.updatedAt !== candidate.rule.updatedAt
				)
					throw new Error('StaleOrChangedSuggestion');
				rules = reviewSuggestion(event, {
					operation: 'accept',
					candidateId: candidate.id,
					evidenceFingerprint: candidate.evidenceFingerprint,
				}).rules;
			}
			if (isRecord(raw.profile) && typeof raw.profile.text === 'string') {
				const projectPath =
					typeof raw.profile.projectPath === 'string' ? raw.profile.projectPath : undefined;
				setProfile({ profile: raw.profile.text, updatedAt: Date.now() }, projectPath);
			}
			return { rules };
		}
	);

	const wrappedSupervisorList = withIpcErrorLogging(
		handlerOpts('supervisorList'),
		async (): Promise<PianolaSupervisorSnapshot> => snapshot()
	);
	const wrappedSupervisorAdd = withIpcErrorLogging(
		handlerOpts('supervisorAdd'),
		// Validate the untrusted target at this boundary; fill id/createdAt/enabled
		// when the caller omits them, then upsert and reconcile so the new child
		// spawns without waiting for the file-watch debounce.
		async (raw: unknown): Promise<PianolaSupervisorSnapshot> => {
			const candidate: Record<string, unknown> = isRecord(raw) ? { ...raw } : {};
			if (typeof candidate.id !== 'string' || candidate.id.length === 0) {
				candidate.id = generateUUID();
			}
			if (typeof candidate.createdAt !== 'number') candidate.createdAt = Date.now();
			if (candidate.enabled === undefined) candidate.enabled = true;
			const target = validatePianolaSupervisedTarget(candidate);
			if (!target) throw new Error('InvalidSupervisedTarget');
			upsertSupervisorTarget(target);
			supervisor.reconcile();
			return snapshot();
		}
	);
	const wrappedSupervisorSetEnabled = withIpcErrorLogging(
		handlerOpts('supervisorSetEnabled'),
		async (id: unknown, enabled: unknown): Promise<PianolaSupervisorSnapshot> => {
			if (typeof id !== 'string' || id.length === 0) throw new Error('InvalidTargetId');
			if (typeof enabled !== 'boolean') throw new Error('InvalidEnabledFlag');
			const current = readSupervisorTargets().find((t) => t.id === id);
			if (!current) throw new Error('SupervisedTargetNotFound');
			upsertSupervisorTarget({ ...current, enabled });
			supervisor.reconcile();
			return snapshot();
		}
	);
	const wrappedSupervisorRemove = withIpcErrorLogging(
		handlerOpts('supervisorRemove'),
		async (id: unknown): Promise<PianolaSupervisorSnapshot> => {
			if (typeof id !== 'string' || id.length === 0) throw new Error('InvalidTargetId');
			removeSupervisorTarget(id);
			supervisor.reconcile();
			return snapshot();
		}
	);

	ipcMain.handle('pianola:get-rules', async (event): Promise<RulesLoadResult> => {
		if (!isPianolaEnabled(settingsStore)) throw new Error('PianolaDisabled');
		return wrappedGetRules(event);
	});

	ipcMain.handle('pianola:save-rules', async (event, rules: unknown): Promise<PianolaRule[]> => {
		if (!isPianolaEnabled(settingsStore)) throw new Error('PianolaDisabled');
		return wrappedSaveRules(event, rules);
	});

	ipcMain.handle(
		'pianola:get-decisions',
		async (event, limit?: number): Promise<PianolaDecisionRecord[]> => {
			if (!isPianolaEnabled(settingsStore)) throw new Error('PianolaDisabled');
			return wrappedGetDecisions(event, limit);
		}
	);

	ipcMain.handle('pianola:get-suggestions', async (event): Promise<PianolaSuggestionsFile> => {
		if (!isPianolaEnabled(settingsStore)) throw new Error('PianolaDisabled');
		return wrappedGetSuggestions(event);
	});
	ipcMain.handle('pianola:confirm-desktop-owner', async (event) => {
		if (!isPianolaEnabled(settingsStore)) throw new Error('PianolaDisabled');
		if (!isNativeOwnerTransport(event)) throw new Error('HumanSuggestionReviewRequired');
		const identity = readPianolaOwnerIdentity(settingsStore.get('pianolaLearningIdentity'));
		if (identity.desktopIsOwner) return;
		if (identity.state !== 'available') throw new Error('DesktopOwnerRestricted');
		if (!settingsStore.set) throw new Error('DesktopOwnerSetupUnavailable');
		settingsStore.set('pianolaLearningIdentity', { desktopIsOwner: true });
	});
	ipcMain.handle('pianola:review-suggestion', async (event, payload: unknown) => {
		if (!isPianolaEnabled(settingsStore)) throw new Error('PianolaDisabled');
		return wrappedReviewSuggestion(event, event, payload);
	});

	// Only this explicit human UI action may create human provenance. The CLI
	// manager endpoint cannot choose its actor kind or impersonate a human.
	ipcMain.handle('pianola:resolve-decision', async (_event, payload: unknown) => {
		if (!isPianolaEnabled(settingsStore)) throw new Error('PianolaDisabled');
		const server = deps.getWebServer?.();
		if (!server) throw new Error('Native decision transport unavailable');
		const user = getActingUser();
		const bridge = (_event as unknown as { type?: string }).type === 'bridge';
		const identity = readPianolaOwnerIdentity(settingsStore.get('pianolaLearningIdentity'));
		const actorId = user?.id ?? (bridge ? 'web-owner' : 'desktop');
		// Web binding is explicit; desktop attribution requires a verified native sender.
		const confirmed =
			(bridge &&
				user &&
				identity.ownerWebUserId !== undefined &&
				user.id === identity.ownerWebUserId) ||
			(isNativeOwnerTransport(_event) && identity.desktopIsOwner);
		return server.resolvePianolaHumanDecision(payload, actorId, confirmed ? 'owner' : undefined);
	});

	ipcMain.handle(
		'pianola:apply-suggestion',
		async (event, payload: unknown): Promise<{ rules: PianolaRule[] }> => {
			if (!isPianolaEnabled(settingsStore)) throw new Error('PianolaDisabled');
			return wrappedApplySuggestion(event, payload, event);
		}
	);

	ipcMain.handle('pianola:supervisor-list', async (event): Promise<PianolaSupervisorSnapshot> => {
		if (!isPianolaEnabled(settingsStore)) throw new Error('PianolaDisabled');
		return wrappedSupervisorList(event);
	});

	ipcMain.handle(
		'pianola:supervisor-add',
		async (event, target: unknown): Promise<PianolaSupervisorSnapshot> => {
			if (!isPianolaEnabled(settingsStore)) throw new Error('PianolaDisabled');
			return wrappedSupervisorAdd(event, target);
		}
	);

	ipcMain.handle(
		'pianola:supervisor-set-enabled',
		async (event, id: unknown, enabled: unknown): Promise<PianolaSupervisorSnapshot> => {
			if (!isPianolaEnabled(settingsStore)) throw new Error('PianolaDisabled');
			return wrappedSupervisorSetEnabled(event, id, enabled);
		}
	);

	ipcMain.handle(
		'pianola:supervisor-remove',
		async (event, id: unknown): Promise<PianolaSupervisorSnapshot> => {
			if (!isPianolaEnabled(settingsStore)) throw new Error('PianolaDisabled');
			return wrappedSupervisorRemove(event, id);
		}
	);
}
