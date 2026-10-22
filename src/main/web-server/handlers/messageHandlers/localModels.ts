/**
 * Local Models WebSocket message handlers.
 *
 * Handles: local_models_list, local_models_download, local_models_pause,
 * local_models_cancel, local_models_verify, local_models_remove,
 * local_models_hf_add, local_models_hf_remove,
 * local_models_endpoints_detect, local_models_endpoint_models,
 * local_models_endpoint_test, local_models_run_task, local_models_task_readiness, local_models_git_draft,
 * local_models_semantic_index_status, local_models_search,
 * local_models_tab_cleanup, local_models_transcribe, local_models_proxy_status,
 * local_models_proxy_block, local_models_runtimes_list,
 * local_models_runtime_install, local_models_server_status,
 * local_models_server_start, local_models_server_stop, local_models_server_set,
 * local_models_server_key, local_models_server_ensure,
 * local_models_run_on_test, local_models_tier_options, system_one_status,
 * system_one_set, system_one_key_set, system_one_key_clear, system_one_test,
 * system_one_ledger, system_one_agent_request, system_one_usage,
 * system_one_access, model_route_turn, model_route_correct, notify_speak.
 * These are the CLI's route to the same service functions the `localModels:*`
 * IPC channels call, so
 * `maestro-cli models install` and Settings' Download button write the same
 * files through the same downloader, `maestro-cli models endpoints test` and
 * Settings' Test button use the same record, the same key lookup, and the same
 * budget, and `maestro-cli models run` goes through the same task router (and
 * the same assignment) as an in-app caller.
 *
 * Adding, editing and removing an endpoint, and assigning a task, do NOT come
 * through here: like SSH remotes, the CLI edits `localModelEndpoints` and
 * `localModelAssignments` in the settings file through the shared helpers, and
 * the settings watcher reloads every window. Only the verbs that need the model
 * store, the network, or Settings -> Environment run in the app.
 */

import { readCallerMessageFields } from '../../../../shared/agentDelegation';
import {
	detectNewLocalModelEndpoints,
	listLocalModelEndpointModels,
	testLocalModelEndpoint,
} from '../../../local-models/endpoint-service';
import {
	cancelLocalModel,
	installLocalModel,
	installLocalRuntime,
	listLocalRuntimes,
	listLocalModels,
	localModelsFootprint,
	pauseLocalModel,
	removeLocalModel,
	verifyLocalModel,
} from '../../../local-models/service';
import { resolveHardwareProfile } from '../../../local-models/hardware';
import {
	addHuggingFaceModel,
	previewHuggingFaceModel,
	removeUserLocalModel,
} from '../../../local-models/user-models';
import { transcribeAudioFileRequest } from '../../../local-models/dictation';
import { speakNoticeRequest } from '../../../local-models/spoken-notices';
import { draftPullRequestRequest } from '../../../local-models/git-drafts';
import { runLocalTaskRequest } from '../../../local-models/task-router';
import { resolveTaskReadinessRequest } from '../../../local-models/task-readiness';
import { semanticIndexProgress } from '../../../local-models/semantic-indexer';
import { searchPastWorkRequest } from '../../../local-models/work-search';
import { suggestTabCleanup } from '../../../local-models/tab-cleanup';
import { getTokenProxyReport, readTokenProxyBlock } from '../../../local-models/proxy/service';
import {
	getModelServerKey,
	startModelServer,
	stopModelServer,
} from '../../../local-models/server/supervisor';
import {
	getModelServerReport,
	installModelServerEngine,
	updateModelServerConfigRequest,
} from '../../../local-models/server/service';
import { modelServerForHarness } from '../../../local-models/server/server-endpoint';
import {
	clearSystemOneKeyRequest,
	getSystemOneReport,
	setSystemOneKeyRequest,
	testSystemOne,
	updateSystemOneSettingsRequest,
} from '../../../local-models/system-one/service';
import {
	getSystemOneAgentAccessRequest,
	readSystemOneAgentUsage,
	runAgentSystemOneRequest,
} from '../../../local-models/system-one/agent-service';
import { readSystemOneLedger } from '../../../local-models/system-one/decisions';
import { routeTurnRequest } from '../../../local-models/route-turn';
import { recordModelRoutingCorrectionRequest } from '../../../local-models/model-routing-corrections';
import { testAgentRunOn } from '../../../local-models/run-on-test';
import { listHarnessTierOptionsRequest } from '../../../local-models/tier-options';
import type { WebClient, WebClientMessage, MessageHandlerContext } from './types';

/**
 * Run one service call and answer with its result under `key`, or with
 * `success: false` and the error message. Every handler here has the same
 * shape: a verdict the service RETURNS (a failed download, a corrupt verify)
 * is a successful round trip, and only a thrown error is a failed one.
 */
async function respond(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage,
	type: string,
	work: () => Promise<Record<string, unknown>>
): Promise<void> {
	try {
		const payload = await work();
		ctx.send(client, { type, success: true, ...payload, requestId: message.requestId });
	} catch (error) {
		const errMsg = error instanceof Error ? error.message : String(error);
		ctx.send(client, { type, success: false, error: errMsg, requestId: message.requestId });
	}
}

/**
 * Handle local_models_list - every model (curated, then the ones the user
 * added) joined to its install state, plus the disk footprint (`maestro-cli
 * models list`). With `fit`, the hardware profile the fit labels are judged
 * against comes too (`models list --fit`). A disk read; no network.
 */
export function handleLocalModelsList(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): Promise<void> {
	return respond(ctx, client, message, 'local_models_list_result', async () => {
		const [listings, footprint, hardware] = await Promise.all([
			listLocalModels(),
			localModelsFootprint(),
			message.fit === true ? resolveHardwareProfile() : Promise.resolve(undefined),
		]);
		return { listings, footprint, ...(hardware ? { hardware } : {}) };
	});
}

/**
 * Handle local_models_hf_add - add a Hugging Face repo file to the Library as a
 * user entry (`maestro-cli models add-hf`), or with `dryRun` only describe it.
 * One metadata request to Hugging Face; the model is not downloaded. A refusal
 * the user can act on is a failed round trip carrying its message.
 */
export function handleLocalModelsHfAdd(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): Promise<void> {
	return respond(ctx, client, message, 'local_models_hf_add_result', async () => {
		if (message.dryRun === true) {
			const preview = await previewHuggingFaceModel(message.repo, message.file);
			if (!preview.ok) throw new Error(preview.message);
			return { entry: preview.value.entry, added: false, dryRun: true };
		}
		const added = await addHuggingFaceModel(message.repo, message.file);
		if (!added.ok) throw new Error(added.message);
		return { entry: added.value.entry, added: added.value.added };
	});
}

/**
 * Handle local_models_hf_remove - take a user model out of the Library and
 * delete its files (`maestro-cli models remove-hf`). The in-use warning is the
 * CLI's job before it sends this, as with `local_models_remove`.
 */
export function handleLocalModelsHfRemove(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): Promise<void> {
	return respond(ctx, client, message, 'local_models_hf_remove_result', async () => {
		const removed = await removeUserLocalModel(message.modelId);
		if (!removed.ok) throw new Error(removed.message);
		return { ...removed.value };
	});
}

/**
 * Handle local_models_download - download (or resume) one model and answer when
 * the job settles (`maestro-cli models install`). The same downloader as the
 * Settings button, so a download already running from the app is joined, not
 * duplicated, and its progress shows in every window.
 */
export function handleLocalModelsDownload(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): Promise<void> {
	return respond(ctx, client, message, 'local_models_download_result', async () => ({
		// The model and the runtime that reads it, exactly as the Settings button.
		result: await installLocalModel(message.modelId),
	}));
}

/**
 * Handle local_models_runtimes_list - every native runtime joined to what is on
 * disk (`maestro-cli models runtimes list`). A disk read; no network.
 */
export function handleLocalModelsRuntimesList(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): Promise<void> {
	return respond(ctx, client, message, 'local_models_runtimes_list_result', async () => ({
		runtimes: await listLocalRuntimes(),
	}));
}

/**
 * Handle local_models_runtime_install - download, verify and install one
 * runtime, answering with its listing afterwards (`maestro-cli models runtimes
 * install`). Joins an install already running from the app.
 */
export function handleLocalModelsRuntimeInstall(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): Promise<void> {
	return respond(ctx, client, message, 'local_models_runtime_install_result', async () => {
		await installLocalRuntime(message.runtimeId);
		const runtimes = await listLocalRuntimes();
		return { runtime: runtimes.find((runtime) => runtime.id === message.runtimeId) };
	});
}

/**
 * Handle local_models_pause - abort one running download and keep its partial
 * file (`maestro-cli models pause`). `paused` is false when nothing was running,
 * which is an answer, not an error. Resume is `local_models_download` again.
 */
export function handleLocalModelsPause(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): Promise<void> {
	return respond(ctx, client, message, 'local_models_pause_result', async () => ({
		paused: pauseLocalModel(message.modelId),
	}));
}

/**
 * Handle local_models_cancel - abort one download and delete what it wrote
 * (`maestro-cli models cancel`). `cancelled` is false when no job was running;
 * a partial file left by an earlier run is cleared either way.
 */
export function handleLocalModelsCancel(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): Promise<void> {
	return respond(ctx, client, message, 'local_models_cancel_result', async () => ({
		cancelled: await cancelLocalModel(message.modelId),
	}));
}

/** Handle local_models_verify - re-hash one model against the catalog. */
export function handleLocalModelsVerify(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): Promise<void> {
	return respond(ctx, client, message, 'local_models_verify_result', async () => ({
		result: await verifyLocalModel(message.modelId),
	}));
}

/**
 * Handle local_models_remove - delete one model, answering with the bytes
 * reclaimed. The in-use warning is the CLI's job before it sends this, exactly
 * as the Settings row warns before it calls `localModels:remove`.
 */
export function handleLocalModelsRemove(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): Promise<void> {
	return respond(ctx, client, message, 'local_models_remove_result', async () => ({
		bytes: await removeLocalModel(message.modelId),
	}));
}

/** Handle local_models_endpoints_detect - running loopback servers not configured yet. */
export function handleLocalModelsEndpointsDetect(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): Promise<void> {
	return respond(ctx, client, message, 'local_models_endpoints_detect_result', async () => ({
		detected: await detectNewLocalModelEndpoints(),
	}));
}

/**
 * Handle local_models_endpoint_models - the models one saved endpoint serves
 * now, named by id, id prefix, or name (`maestro-cli models endpoints models`).
 * A server that cannot be listed is still a successful round trip: the verdict
 * rides in `result`, with the same error kinds as the test.
 */
export function handleLocalModelsEndpointModels(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): Promise<void> {
	const ref = typeof message.endpoint === 'string' ? message.endpoint : '';
	return respond(ctx, client, message, 'local_models_endpoint_models_result', async () => ({
		result: await listLocalModelEndpointModels(ref),
	}));
}

/**
 * Handle local_models_endpoint_test - a one-token chat against a saved
 * endpoint, named by id, id prefix, or name. An endpoint that answers badly is
 * still a successful round trip: the verdict rides in `result`, whose `error`
 * keeps its `kind` so the CLI can tell a missing key from a dead server.
 */
export function handleLocalModelsEndpointTest(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): Promise<void> {
	const ref = typeof message.endpoint === 'string' ? message.endpoint : '';
	const model = typeof message.model === 'string' ? message.model : undefined;
	return respond(ctx, client, message, 'local_models_endpoint_test_result', async () => ({
		result: await testLocalModelEndpoint(ref, model),
	}));
}

/**
 * Handle local_models_run_task - one text-generation task through the task
 * router. Every router verdict (`off`, `use-utility-agent`, `unavailable`, ...)
 * is a successful round trip and rides in `result`; only a bad request (an
 * unknown task, a non-text task, a malformed input) comes back as an error.
 */
export function handleLocalModelsRunTask(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): Promise<void> {
	return respond(ctx, client, message, 'local_models_run_task_result', async () => ({
		result: await runLocalTaskRequest(message.taskId, message.input),
	}));
}

/**
 * Handle local_models_task_readiness - whether each task's assigned source
 * would answer now (`maestro-cli models status`). An unavailable task is a
 * successful round trip with the verdict in `readiness`; only an unknown task
 * id comes back as an error.
 */
export function handleLocalModelsTaskReadiness(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): Promise<void> {
	return respond(ctx, client, message, 'local_models_task_readiness_result', async () => ({
		readiness: await resolveTaskReadinessRequest(message.taskId),
	}));
}

/**
 * Handle local_models_git_draft - a pull request title and body for a local
 * branch (`maestro-cli models run git-drafts --cwd`), through the same service
 * function as the Create Pull Request form's draft button. A task that is off,
 * unavailable, or has nothing to draft from is a successful round trip with the
 * reason in `result`; only a bad request (no path, a bad branch name) comes
 * back as an error.
 */
export function handleLocalModelsGitDraft(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): Promise<void> {
	return respond(ctx, client, message, 'local_models_git_draft_result', async () => ({
		result: await draftPullRequestRequest({ cwd: message.cwd, baseBranch: message.baseBranch }),
	}));
}

/**
 * Handle local_models_semantic_index_status - what the background indexer is
 * doing and how far along it is (`maestro-cli models index`). The same record
 * the `localModels:semanticIndex:status` IPC channel answers with; reads memory
 * only, and answers `off` before the indexer has started.
 */
export function handleLocalModelsSemanticIndexStatus(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): Promise<void> {
	return respond(ctx, client, message, 'local_models_semantic_index_status_result', async () => ({
		progress: semanticIndexProgress(),
	}));
}

/**
 * Handle local_models_proxy_status - what the Maestro token proxy is doing, the
 * agents on it with their mode, what it carried and what it last shortened
 * (`maestro-cli models proxy status`). The same report the
 * `localModels:proxy:report` IPC channel answers with; it never chooses a port.
 */
export function handleLocalModelsProxyStatus(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): Promise<void> {
	return respond(ctx, client, message, 'local_models_proxy_status_result', async () => ({
		report: await getTokenProxyReport(),
	}));
}

/**
 * Handle local_models_proxy_block - both sides of one compressed block from the
 * content-addressed cache (`maestro-cli models proxy block <hash>`). A hash the
 * cache has no compressed verdict for answers `block: null`; a value that is
 * not a hash is an error.
 */
export function handleLocalModelsProxyBlock(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): Promise<void> {
	return respond(ctx, client, message, 'local_models_proxy_block_result', async () => ({
		block: await readTokenProxyBlock(message.hash),
	}));
}

/**
 * Handle local_models_server_status - the Maestro model server's report: its
 * state, address, engine and accelerator, and the models it has loaded
 * (`maestro-cli models server status`). The same report the Model server card
 * reads through `localModels:server:report`; it never starts the server.
 */
export function handleLocalModelsServerStatus(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): Promise<void> {
	return respond(ctx, client, message, 'local_models_server_status_result', async () => ({
		report: await getModelServerReport(),
	}));
}

/**
 * Handle local_models_server_start - start the model server, answering with
 * the report once it is ready (`maestro-cli models server start`). A start that
 * fails (no engine, port taken) is an error carrying the supervisor's message.
 */
export function handleLocalModelsServerStart(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): Promise<void> {
	return respond(ctx, client, message, 'local_models_server_start_result', async () => {
		await startModelServer();
		return { report: await getModelServerReport() };
	});
}

/** Handle local_models_server_stop - stop the model server and wait for it to exit. */
export function handleLocalModelsServerStop(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): Promise<void> {
	return respond(ctx, client, message, 'local_models_server_stop_result', async () => {
		await stopModelServer();
		return { report: await getModelServerReport() };
	});
}

/**
 * Handle local_models_server_set - change the bind mode or model count, rotate
 * the key, and/or install a build of the engine (`maestro-cli models server
 * set`). The settings apply first, then the build, each through the function
 * the card's controls call. A running server restarts to apply either.
 */
export function handleLocalModelsServerSet(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): Promise<void> {
	return respond(ctx, client, message, 'local_models_server_set_result', async () => {
		const patch: Record<string, unknown> = {};
		if (message.bind !== undefined) patch.bind = message.bind;
		if (message.maxModels !== undefined) patch.maxModels = message.maxModels;
		if (message.rotateKey === true) patch.rotateKey = true;
		if (Object.keys(patch).length > 0) await updateModelServerConfigRequest(patch);
		if (message.build !== undefined) await installModelServerEngine(message.build);
		return { report: await getModelServerReport() };
	});
}

/**
 * Handle local_models_server_key - the model server's API key, made on first
 * use (`maestro-cli models server key`), the same key the card's Copy copies.
 * The bridge only accepts clients that hold the CLI's token, so this goes no
 * further than the card does.
 */
export function handleLocalModelsServerKey(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): Promise<void> {
	return respond(ctx, client, message, 'local_models_server_key_result', async () => ({
		key: await getModelServerKey(),
	}));
}

/**
 * Handle local_models_server_ensure - make the model server ready to serve one
 * model (start it and load the model when needed) and answer with where it
 * listens and its key. This is how a `maestro-cli` spawn launches an agent
 * whose Run on target is the server: the CLI runs the agent in its own process
 * and cannot start the server, which the app supervises. The same function the
 * app's own launches call. A server that cannot serve the model answers with
 * the reason, and the CLI refuses the launch with it.
 */
export function handleLocalModelsServerEnsure(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): Promise<void> {
	return respond(ctx, client, message, 'local_models_server_ensure_result', async () => {
		const model = typeof message.model === 'string' ? message.model.trim() : '';
		if (model === '') throw new Error('Name the model the server should serve.');
		const server = await modelServerForHarness(model);
		if (!server.ok) throw new Error(server.error);
		return { baseUrl: server.baseUrl, key: server.key };
	});
}

/**
 * Handle local_models_run_on_test - one short read-only turn through a stored
 * agent's harness on its Run on target (`maestro-cli agent test-run-on`), by
 * the function the picker's Test button calls. Only the agent's id crosses the
 * bridge: the test launches what is stored, never values a caller supplies. A
 * target that cannot run is a successful round trip with the verdict in
 * `result`.
 */
export function handleLocalModelsRunOnTest(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): Promise<void> {
	return respond(ctx, client, message, 'local_models_run_on_test_result', async () => {
		const agentId = typeof message.agentId === 'string' ? message.agentId.trim() : '';
		if (agentId === '') throw new Error('Name the agent to test.');
		return { result: await testAgentRunOn({ agentId }) };
	});
}

/**
 * Handle local_models_tier_options - what a harness can launch a tier on: its
 * own catalogue and the Run on targets (`maestro-cli models tiers options` and
 * `suggest`), by the function the Tier defaults table reads. With no `harness`
 * it answers for every installed harness that can select a model. A read: it
 * starts no server and saves nothing. An id that names no harness with tiers
 * comes back as an error.
 */
export function handleLocalModelsTierOptions(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): Promise<void> {
	return respond(ctx, client, message, 'local_models_tier_options_result', async () => ({
		options: await listHarnessTierOptionsRequest({
			harness: message.harness,
			refresh: message.refresh,
		}),
	}));
}

/**
 * Handle system_one_status - the System One engine in force, where each key
 * comes from, and the fail policies (`maestro-cli s1 status`). The same report
 * the System One card reads through `localModels:systemOne:report`. It carries
 * no key and sends nothing to an engine.
 */
export function handleSystemOneStatus(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): Promise<void> {
	return respond(ctx, client, message, 'system_one_status_result', async () => ({
		report: await getSystemOneReport(),
	}));
}

/**
 * Handle system_one_set - change the engine, the OpenJev URL, a pinned model,
 * the timeout or one task's fail policy (`maestro-cli s1 set`), through the
 * function the card's controls call. A change that is refused comes back as an
 * error and writes nothing.
 */
export function handleSystemOneSet(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): Promise<void> {
	return respond(ctx, client, message, 'system_one_set_result', async () => ({
		report: await updateSystemOneSettingsRequest(message.patch),
	}));
}

/**
 * Handle system_one_key_set - seal and store a key for a remote engine
 * (`maestro-cli s1 key set`, which reads it from standard input). The key is
 * written and never read back: the answer is the report, which says where the
 * key comes from and nothing more.
 */
export function handleSystemOneKeySet(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): Promise<void> {
	return respond(ctx, client, message, 'system_one_key_set_result', async () => ({
		report: await setSystemOneKeyRequest({ engine: message.engine, key: message.key }),
	}));
}

/** Handle system_one_key_clear - forget the key stored for a remote engine (`maestro-cli s1 key clear`). */
export function handleSystemOneKeyClear(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): Promise<void> {
	return respond(ctx, client, message, 'system_one_key_clear_result', async () => ({
		report: await clearSystemOneKeyRequest({ engine: message.engine }),
	}));
}

/**
 * Handle system_one_test - ask the engine in force one fixed question
 * (`maestro-cli s1 test`), by the function the card's Test button calls. An
 * engine that gives no answer is a successful round trip with the verdict in
 * `result`, which names the engine that was asked.
 */
export function handleSystemOneTest(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): Promise<void> {
	return respond(ctx, client, message, 'system_one_test_result', async () => ({
		result: await testSystemOne(),
	}));
}

/**
 * Handle system_one_agent_request - one request from an agent's `maestro-cli
 * s1 yes | pick | rate | ask | rank | batch`, answered by the same service
 * function whatever sends it. The engine's key stays in this process: the
 * answer carries typed answers, the engine's name and the spend, never a key.
 *
 * The caller is what the CLI read from its own environment and forwarded as
 * `fromSessionId` / `fromTabId`, the fields `dispatch` and `ask` already use.
 * A refusal (off, over budget, no answer from the engine) is a successful round
 * trip that carries it: only a failure no engine classified is a failed one.
 */
export function handleSystemOneAgentRequest(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): Promise<void> {
	return respond(ctx, client, message, 'system_one_agent_result', async () => {
		const from = readCallerMessageFields(message);
		return {
			response: await runAgentSystemOneRequest(
				message.request,
				from
					? { agentId: from.fromSessionId, ...(from.fromTabId ? { tabId: from.fromTabId } : {}) }
					: undefined
			),
		};
	});
}

/**
 * Handle system_one_usage - what agents' own requests came to, per agent, and
 * today's spend against the budget (`maestro-cli s1 usage`). The caller is read
 * as `system_one_agent_request` reads it, so an agent that asks sees its own
 * count beside the day's. A query that cannot be read comes back as an error.
 * It sends nothing to an engine and changes nothing.
 */
export function handleSystemOneUsage(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): Promise<void> {
	return respond(ctx, client, message, 'system_one_usage_result', async () => ({
		report: await readSystemOneAgentUsage(
			message.query,
			readCallerMessageFields(message)?.fromSessionId
		),
	}));
}

/**
 * Handle system_one_access - whether a System One request from one agent would
 * be answered right now, by which engine, and what is left of the day's budget.
 * The CLI's system prompt builder asks it for the agent it is about to spawn
 * (`agentId`), through the function the renderer's builder reaches over
 * `localModels:systemOne:agentAccess`. It sends nothing to an engine and
 * changes nothing.
 */
export function handleSystemOneAccess(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): Promise<void> {
	return respond(ctx, client, message, 'system_one_access_result', async () => ({
		access: await getSystemOneAgentAccessRequest(message.agentId),
	}));
}

/**
 * Handle model_route_turn - how much model and effort one turn needs, for a
 * turn `maestro-cli` is about to spawn on the Auto model (`send`, an Auto Run
 * task, a standalone Cue run). The routers, their models and the decision
 * ledger are this process's, so the CLI asks here, through the function the
 * renderer's send path reaches over `localModels:routeTurn`. No decision (the
 * task is off, the router was slow or down) is a successful round trip with
 * the reason in `result`; only a request that cannot be read is an error.
 *
 * The agent the turn is for is `agentId` / `tabId` in the request, NOT the
 * caller's own identity: an agent that runs `send` to another agent is routing
 * that agent's turn.
 */
export function handleModelRouteTurn(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): Promise<void> {
	return respond(ctx, client, message, 'model_route_turn_result', async () => ({
		result: await routeTurnRequest(message.request),
	}));
}

/**
 * Handle model_route_correct - record that a prompt needed a different tier
 * than the router picked (`maestro-cli s1 route --correct <tier>`). The
 * embedding router reads the corrections beside its shipped examples, so the
 * next prompt like it is voted on with this one. A correction the store
 * refuses (a blank prompt) is a successful round trip with the reason in
 * `result`; only a request that cannot be read is an error.
 */
export function handleModelRouteCorrect(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): Promise<void> {
	return respond(ctx, client, message, 'model_route_correct_result', async () => ({
		result: await recordModelRoutingCorrectionRequest(message.request),
	}));
}

/**
 * Handle system_one_ledger - the decision ledger (`maestro-cli s1 ledger`),
 * by the function the ledger in Settings > Models > System One reads through.
 * A query that cannot be read comes back as an error. It sends nothing to an
 * engine and changes nothing.
 */
export function handleSystemOneLedger(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): Promise<void> {
	return respond(ctx, client, message, 'system_one_ledger_result', async () => ({
		page: readSystemOneLedger(message.query),
	}));
}

/**
 * Handle local_models_search - search past work by meaning or by text
 * (`maestro-cli search`), through the same function the `localModels:search`
 * IPC channel calls. A search that is off or unavailable is a successful round
 * trip with the verdict in `result`; only a bad request (no query, an unknown
 * source) comes back as an error.
 */
export function handleLocalModelsSearch(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): Promise<void> {
	return respond(ctx, client, message, 'local_models_search_result', async () => ({
		result: await searchPastWorkRequest(message.request),
	}));
}

/**
 * Handle local_models_tab_cleanup - which tabs could be closed, snoozed, or
 * woken (`maestro-cli tab suggest-cleanup`), through the same function the
 * Tab Cleanup Suggestions modal calls. Read-only: it answers with a list and
 * changes no tab. A task that is off or unavailable is a successful round trip
 * with the reason in `result`.
 */
export function handleLocalModelsTabCleanup(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): Promise<void> {
	return respond(ctx, client, message, 'local_models_tab_cleanup_result', async () => ({
		result: await suggestTabCleanup(),
	}));
}

/**
 * Handle local_models_transcribe - transcribe a WAV file with the Dictation
 * assignment (`maestro-cli models run dictation --audio <file>`), through the
 * same `transcribeClip()` a dictation recorded in a text box ends in. A task
 * that is off or unavailable is a successful round trip with the verdict in
 * `result`; only a bad request (no path, not a WAV) comes back as an error.
 */
export function handleLocalModelsTranscribe(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): Promise<void> {
	return respond(ctx, client, message, 'local_models_transcribe_result', async () => ({
		result: await transcribeAudioFileRequest(message.path),
	}));
}

/**
 * Handle notify_speak - say one line aloud through the spoken notices queue
 * (`maestro-cli notify speak "<text>"`), the same `speakNotice()` the Test
 * button in Settings > Notifications calls. Answers once the line was spoken
 * or refused. A refusal (a voice session is live, the voice could not speak)
 * is a successful round trip with the verdict in `result`; only a bad request
 * (no text, too long) comes back as an error.
 */
export function handleNotifySpeak(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): Promise<void> {
	return respond(ctx, client, message, 'notify_speak_result', async () => ({
		result: await speakNoticeRequest(message.text),
	}));
}
