#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

import {
	assertSuccessfulResponse,
	buildExtensionUiResponse,
	classifyPowerUserCapabilities,
	comparePinnedIdentity,
	computeConformanceVerdict,
	parseConformanceArgs,
	parseOmpVersionOutput,
	validateBaseline,
} from './omp-rpc-conformance-lib.mjs';
import {
	JsonLineDecoder,
	MAESTRO_RPC_MAX_REASSEMBLED_BYTES,
	RpcProcessPeer,
	RpcV2FrameDecoder,
	redactConformanceReport,
	summarizeProtocolFrame,
	validateReadyFrame,
} from './omp-rpc-protocol.mjs';

const execFileAsync = promisify(execFile);
const TIMEOUT_MS = 120_000;
const LIVE_TIMEOUT_MS = 300_000;
const MAX_CAPTURED_FRAMES = 20_000;
const SOURCE_POLICY = Object.freeze({
	allowed: ['OMP --help', 'OMP --version', 'omp://rpc.md', 'RPC stdio', 'ACP stdio'],
	forbidden: ['private OMP session files', 'private OMP settings', 'OMP implementation modules'],
});

const CASE_TITLES = Object.freeze({
	A01: 'RPC identity, negotiation, framing, and limits',
	A02: 'Session identity and public reattachment',
	A03: 'Root stream, snapshot, paging, and replay',
	A04: 'Worker registry, hierarchy, and transcript surface',
	A05: 'Steering, cancellation, and abort-and-prompt',
	A06: 'Approval callback and restrictive launch policy',
	A07: 'Dynamic models, providers, thinking, and effective state',
	A08: 'Todos, commands, host tools, stats, and compaction surface',
	A09: 'Evidence, artifact, process, worktree, and export surface',
	A10: 'Typed errors and fail-closed capability changes',
	A11: 'Stable power-user protocol gaps',
});

class NotRunError extends Error {}

const options = parseConformanceArgs(process.argv.slice(2));
const baseline = validateBaseline(JSON.parse(await readFile(options.baselinePath, 'utf8')));
const temporaryWorkspace = await mkdtemp(path.join(os.tmpdir(), 'maestro-omp-conformance-'));
const caseResults = [];
const deviations = [];
const shared = {
	commandTypes: [],
	eventTypes: [],
	workerTranscriptObserved: false,
	abortAndPromptCompletionObserved: false,
	busyErrorCode: null,
};
let baseHandle;

const report = {
	schemaVersion: 1,
	startedAt: new Date().toISOString(),
	finishedAt: null,
	executable: options.executable,
	workspace: temporaryWorkspace,
	harnessSha256: null,
	sourceRevision: null,
	fixtureRevision: baseline.schemaVersion,
	maestro: { version: null, hostContract: 'run-fleet/v1-placeholder' },
	adapter: { id: 'official.omp', version: 'unreleased-placeholder' },
	host: { platform: process.platform, architecture: process.arch, release: os.release() },
	omp: null,
	protocol: { name: 'rpc', requestedVersion: 2, ready: null, documentationSha256: null },
	sourcePolicy: SOURCE_POLICY,
	options: { live: options.live },
	cases: caseResults,
	capabilities: [],
	deviations,
	verdict: null,
};

try {
	await populateBuildIdentity(report);
	const identity = await readOmpIdentity(options.executable);
	const identityComparison = comparePinnedIdentity(identity, baseline);
	report.omp = {
		version: identity.version,
		sha256: identity.sha256,
		identityStatus: identityComparison.status,
		identityReasons: identityComparison.reasons,
	};

	if (identityComparison.status === 'pass') {
		const publicHelp = await runPublicCommand(['--help']);
		const publicAcpHelp = await runPublicCommand(['acp', '--help']);
		const publicRpcDocumentation = await runPublicCommand(['read', 'omp://rpc.md']);
		report.protocol.documentationSha256 = sha256(Buffer.from(publicRpcDocumentation, 'utf8'));
		shared.commandTypes = baseline.requiredCommandTypes.filter((type) =>
			publicRpcDocumentation.includes(`\"${type}\"`)
		);
		shared.eventTypes = baseline.requiredEventTypes.filter(
			(type) =>
				publicRpcDocumentation.includes(`\"${type}\"`) ||
				publicRpcDocumentation.includes(`\`${type}\``)
		);

		baseHandle = createRpcHandle({
			args: deterministicRpcArgs({ noSession: true, tools: [] }),
			approvalDecision: 'approve',
			hostToolResultText: 'MAESTRO_HOST_TOOL_OK',
		});
		const ready = await withTimeout(baseHandle.peer.ready, TIMEOUT_MS, 'base RPC ready frame');
		report.protocol.ready = validateReadyFrame(ready);

		await runCase('A01', true, async () => {
			if (identityComparison.status !== 'pass')
				throw new Error(identityComparison.reasons.join('; '));
			const readyData = validateReadyFrame(ready);
			if (!readyData.supportedProtocolVersions.includes(2)) {
				throw new Error('RPC v2 is not advertised');
			}
			const negotiated = assertSuccessfulResponse(
				await baseHandle.peer.request('negotiate_protocol', { protocolVersion: 2 }, TIMEOUT_MS),
				'negotiate_protocol'
			);
			if (negotiated?.protocolVersion !== 2)
				throw new Error('RPC v2 negotiation did not read back v2');
			if (readyData.maxFrameBytes !== baseline.transport.serverMaxFrameBytes) {
				throw new Error(`unexpected physical-frame limit ${readyData.maxFrameBytes}`);
			}
			if (
				readyData.maxReassembledFrameBytes !== baseline.transport.serverMaxReassembledFrameBytes
			) {
				throw new Error(
					`unexpected server logical-frame limit ${readyData.maxReassembledFrameBytes}`
				);
			}
			runCodecSelfCheck();
			const undocumentedCommands = baseline.requiredCommandTypes.filter(
				(type) => !shared.commandTypes.includes(type)
			);
			const undocumentedEvents = baseline.requiredEventTypes.filter(
				(type) => !shared.eventTypes.includes(type)
			);
			if (undocumentedCommands.length > 0 || undocumentedEvents.length > 0) {
				throw new Error(
					`public RPC documentation omissions: commands=${undocumentedCommands.join(',')}; events=${undocumentedEvents.join(',')}`
				);
			}
			const rpcUiHandle = createRpcHandle({
				args: deterministicRpcArgs({ mode: 'rpc-ui', noSession: true, tools: [] }),
				approvalDecision: 'reject',
			});
			let rpcUiReady;
			try {
				rpcUiReady = validateReadyFrame(
					await withTimeout(rpcUiHandle.peer.ready, TIMEOUT_MS, 'RPC-UI ready frame')
				);
				assertSuccessfulResponse(
					await rpcUiHandle.peer.request('get_state', {}, TIMEOUT_MS),
					'get_state'
				);
			} finally {
				await rpcUiHandle.peer.close();
			}
			return {
				evidence: {
					version: identity.version,
					sha256: identity.sha256,
					protocolVersions: readyData.supportedProtocolVersions,
					serverLimits: {
						maxFrameBytes: readyData.maxFrameBytes,
						maxReassembledFrameBytes: readyData.maxReassembledFrameBytes,
					},
					maestroLogicalLimit: MAESTRO_RPC_MAX_REASSEMBLED_BYTES,
					documentedCommandCount: shared.commandTypes.length,
					documentedEventCount: shared.eventTypes.length,
					helpAdvertisesNoSession: publicHelp.includes('--no-session'),
					transportComparison: {
						selected: 'rpc',
						rpc: { advertised: publicHelp.includes('rpc'), liveStateRead: true },
						rpcUi: {
							advertised: publicHelp.includes('rpc-ui'),
							liveStateRead: true,
							protocolVersions: rpcUiReady.supportedProtocolVersions,
						},
						acp: {
							advertised: publicAcpHelp.includes('Agent Client Protocol'),
							selected: false,
							reason:
								'Standard client compatibility surface; RPC exposes the OMP-specific host-control contract.',
						},
					},
				},
			};
		});

		await runCase('A02', true, async () => probeSessionIdentity());
		await runCase('A03', true, async () => probeRootStream());
		await runCase('A04', true, async () => probeWorkerSurface());
		await runCase('A05', true, async () => probeSteeringAndAbort());
		await runCase('A06', true, async () => probeApprovalRoundTrip());
		await runCase('A07', true, async () => probeDynamicConfiguration());
		await runCase('A08', true, async () => probeOperationalSurface());
		await runCase('A09', true, async () => probeEvidenceAndProcessSurface());
		await runCase('A10', true, async () => probeTypedErrors());
	} else {
		await runCase('A01', true, async () => {
			throw new Error(identityComparison.reasons.join('; '));
		});
		for (const id of ['A02', 'A03', 'A04', 'A05', 'A06', 'A07', 'A08', 'A09', 'A10']) {
			await runCase(id, true, async () => {
				throw new NotRunError('pinned OMP identity did not match');
			});
		}
	}
	report.capabilities = classifyPowerUserCapabilities(shared);
	await runCase('A11', false, async () => ({
		status: report.capabilities.every((capability) => capability.status === 'supported')
			? 'pass'
			: 'fail',
		evidence: { requirements: report.capabilities },
	}));

	report.verdict = computeConformanceVerdict({
		cases: report.cases,
		capabilities: report.capabilities,
	});
} catch (error) {
	deviations.push({ id: 'HARNESS_FATAL', detail: errorMessage(error) });
	report.verdict = {
		adapterProtocol: 'fail',
		workloadParity: 'blocked',
		blockingCaseIds: baseline.requiredCases,
		blockingCapabilityIds: ['G1', 'G2', 'G5'],
	};
} finally {
	if (baseHandle) await baseHandle.peer.close();
	report.finishedAt = new Date().toISOString();
	const sanitized = redactConformanceReport(report);
	const serialized = `${JSON.stringify(sanitized, null, '\t')}\n`;
	if (options.outputPath) await writeFile(options.outputPath, serialized, 'utf8');
	process.stdout.write(serialized);
	await rm(temporaryWorkspace, { recursive: true, force: true });
	if (report.verdict?.adapterProtocol !== 'pass') process.exitCode = 1;
}

async function runCase(id, required, operation) {
	const startedAt = Date.now();
	try {
		const outcome = (await operation()) ?? {};
		caseResults.push({
			id,
			title: CASE_TITLES[id],
			required,
			status: outcome.status ?? 'pass',
			durationMs: Date.now() - startedAt,
			evidence: outcome.evidence ?? {},
		});
	} catch (error) {
		caseResults.push({
			id,
			title: CASE_TITLES[id],
			required,
			status: error instanceof NotRunError ? 'not-run' : 'fail',
			durationMs: Date.now() - startedAt,
			error: errorMessage(error),
		});
	}
}

function requireLive(caseId) {
	if (!options.live) throw new NotRunError(`${caseId} requires --live`);
}

function deterministicRpcArgs({ mode = 'rpc', noSession, tools, resume, sessionDirectory } = {}) {
	const args = [
		'--mode',
		mode,
		'--no-extensions',
		'--no-skills',
		'--no-rules',
		'--no-lsp',
		'--no-title',
		'--approval-mode',
		'always-ask',
		'--system-prompt',
		'You are an isolated protocol-conformance probe. Follow the synthetic request exactly. Do not inspect the workspace or any external resource.',
	];
	if (noSession) args.push('--no-session');
	if (sessionDirectory) args.push('--session-dir', sessionDirectory);
	if (resume) args.push('--resume', resume);
	if (Array.isArray(tools) && tools.length === 0) args.push('--no-tools');
	else if (Array.isArray(tools)) args.push('--tools', tools.join(','));
	return args;
}

function createRpcHandle({ args, approvalDecision, hostToolResultText }) {
	const frames = [];
	const approvalRequests = [];
	const uiRequests = [];
	const hostToolCalls = [];
	const peer = new RpcProcessPeer({
		executable: options.executable,
		args,
		cwd: temporaryWorkspace,
		env: process.env,
		onFrame(frame, activePeer) {
			if (frames.length < MAX_CAPTURED_FRAMES) frames.push(frame);
			if (frame.type === 'extension_ui_request') {
				uiRequests.push(frame);
				if (['confirm', 'input', 'editor', 'select'].includes(frame.method)) {
					approvalRequests.push(frame);
				}
				activePeer.send(buildExtensionUiResponse(frame, approvalDecision));
			}
			if (frame.type === 'host_tool_call' && typeof hostToolResultText === 'string') {
				hostToolCalls.push(frame);
				activePeer.send({
					type: 'host_tool_update',
					id: frame.id,
					partialResult: { content: [{ type: 'text', text: 'working' }] },
				});
				activePeer.send({
					type: 'host_tool_result',
					id: frame.id,
					result: { content: [{ type: 'text', text: hostToolResultText }] },
				});
			}
		},
	});
	return { peer, frames, approvalRequests, uiRequests, hostToolCalls };
}

async function probeSessionIdentity() {
	requireLive('A02');
	const sessionDirectory = path.join(temporaryWorkspace, 'sessions');
	const created = createRpcHandle({
		args: deterministicRpcArgs({ noSession: false, tools: [], sessionDirectory }),
		approvalDecision: 'reject',
	});
	let firstState;
	try {
		await withTimeout(created.peer.ready, TIMEOUT_MS, 'saved-session ready frame');
		await negotiate(created.peer);
		firstState = await requestData(created.peer, 'get_state');
		if (!firstState?.sessionId || !firstState?.sessionFile) {
			throw new Error('public state omitted sessionId or sessionFile');
		}
		const terminal = created.peer.waitForFrame(
			(frame) => frame.type === 'agent_end' && frame.isTerminal !== false,
			LIVE_TIMEOUT_MS,
			'terminal saved-session turn'
		);
		assertSuccessfulResponse(
			await created.peer.request(
				'prompt',
				{ message: 'Reply with exactly MAESTRO_SESSION_OK.' },
				TIMEOUT_MS
			),
			'prompt'
		);
		await terminal;
	} finally {
		await created.peer.close();
	}

	const resumed = createRpcHandle({
		args: deterministicRpcArgs({
			noSession: false,
			tools: [],
			sessionDirectory,
			resume: firstState.sessionFile,
		}),
		approvalDecision: 'reject',
	});
	try {
		await withTimeout(resumed.peer.ready, TIMEOUT_MS, 'resumed-session ready frame');
		await negotiate(resumed.peer);
		const secondState = await requestData(resumed.peer, 'get_state');
		const stableSessionId = secondState.sessionId === firstState.sessionId;
		const stableSessionFile =
			path.resolve(secondState.sessionFile) === path.resolve(firstState.sessionFile);
		if (!stableSessionId || !stableSessionFile) {
			throw new Error(
				`public resume identity mismatch: stableSessionId=${stableSessionId}, stableSessionFile=${stableSessionFile}`
			);
		}
		return {
			evidence: {
				stableSessionId,
				stableSessionFile,
				createAndResumeUsedPublicRpcStateOnly: true,
			},
		};
	} finally {
		await resumed.peer.close();
	}
}

async function probeRootStream() {
	requireLive('A03');
	const handle = createRpcHandle({
		args: deterministicRpcArgs({ noSession: true, tools: [] }),
		approvalDecision: 'reject',
	});
	try {
		await withTimeout(handle.peer.ready, TIMEOUT_MS, 'root live ready frame');
		await negotiate(handle.peer);
		const start = handle.frames.length;
		const agentStarted = handle.peer.waitForFrame(
			(frame) => frame.type === 'agent_start',
			LIVE_TIMEOUT_MS,
			'root agent_start'
		);
		const terminal = handle.peer.waitForFrame(
			(frame) => frame.type === 'agent_end' && frame.isTerminal !== false,
			LIVE_TIMEOUT_MS,
			'terminal root agent_end'
		);
		const promptResponse = await handle.peer.request(
			'prompt',
			{ message: 'Write the integers 1 through 200 on one line, then write MAESTRO_ROOT_OK.' },
			TIMEOUT_MS
		);
		assertSuccessfulResponse(promptResponse, 'prompt');
		await agentStarted;
		const busy = await handle.peer.request('get_messages_page', { limit: 1 }, TIMEOUT_MS);
		if (busy.success === false) shared.busyErrorCode = busy.code ?? null;
		await terminal;
		const liveFrames = handle.frames.slice(start);
		const kinds = countFrameTypes(liveFrames);
		for (const required of [
			'agent_start',
			'turn_start',
			'message_start',
			'message_update',
			'message_end',
			'turn_end',
			'agent_end',
		]) {
			if (!kinds[required]) throw new Error(`missing live event ${required}`);
		}
		const paged = await requestData(handle.peer, 'get_messages_page', { limit: 256 });
		const legacy = await requestData(handle.peer, 'get_messages');
		const pagedMessages = paged?.messages ?? [];
		const legacyMessages = Array.isArray(legacy) ? legacy : (legacy?.messages ?? []);
		if (pagedMessages.length === 0 || legacyMessages.length === 0) {
			throw new Error('public message snapshots were empty after a live root turn');
		}
		const pagedHash = hashJson(pagedMessages);
		const legacyHash = hashJson(legacyMessages);
		if (pagedHash !== legacyHash) throw new Error('paged and legacy snapshots differ');

		const firstPage = await requestData(handle.peer, 'get_messages_page', { limit: 1 });
		if (firstPage.nextCursor) {
			await requestData(handle.peer, 'bash', {
				command: 'node -e "process.stdout.write(\'CURSOR_MUTATION\')"',
			});
			const stale = await handle.peer.request(
				'get_messages_page',
				{ cursor: firstPage.nextCursor, limit: 1 },
				TIMEOUT_MS
			);
			if (stale.success === false) shared.staleErrorCode = stale.code ?? null;
		}
		return {
			evidence: {
				frameCounts: kinds,
				messageCount: pagedMessages.length,
				snapshotSha256: pagedHash,
				terminalAgentEnd: true,
				busyErrorCode: shared.busyErrorCode,
				staleCursorCode: shared.staleErrorCode,
			},
		};
	} finally {
		await handle.peer.close();
	}
}

async function probeWorkerSurface() {
	requireLive('A04');
	const handle = createRpcHandle({
		args: deterministicRpcArgs({ noSession: true, tools: ['task'] }),
		approvalDecision: 'approve',
	});
	try {
		await withTimeout(handle.peer.ready, TIMEOUT_MS, 'worker live ready frame');
		await negotiate(handle.peer);
		await requestData(handle.peer, 'set_subagent_subscription', { level: 'events' });
		const terminal = handle.peer.waitForFrame(
			(frame) => frame.type === 'agent_end' && frame.isTerminal !== false,
			LIVE_TIMEOUT_MS,
			'terminal worker-probe agent_end'
		);
		const firstLifecycle = handle.peer.waitForFrame(
			(frame) => frame.type === 'subagent_lifecycle',
			LIVE_TIMEOUT_MS,
			'first Worker lifecycle frame'
		);
		assertSuccessfulResponse(
			await handle.peer.request(
				'prompt',
				{
					message:
						'Call the task tool exactly once. Ask that worker to reply exactly MAESTRO_WORKER_OK without tools. Wait for it, then reply exactly MAESTRO_ROOT_OK.',
				},
				TIMEOUT_MS
			),
			'prompt'
		);
		await firstLifecycle;
		const snapshot = await requestData(handle.peer, 'get_subagents');
		await terminal;
		const workers = snapshot?.subagents ?? snapshot ?? [];
		if (!Array.isArray(workers) || workers.length === 0) {
			const lifecycle = handle.frames.find((frame) => frame.type === 'subagent_lifecycle');
			throw new Error(
				`no active Worker appeared in the public subagent registry; snapshotKeys=${Object.keys(snapshot ?? {}).join(',')}; lifecycleKeys=${Object.keys(lifecycle ?? {}).join(',')}; frames=${JSON.stringify(countFrameTypes(handle.frames))}; uiMethods=${handle.uiRequests.map((request) => request.method).join(',')}`
			);
		}
		const worker = workers[0];
		const workerId = worker.id ?? worker.subagentId;
		if (!workerId) throw new Error('public Worker record omitted an id');
		const selectors = [
			{ subagentId: workerId, fromByte: 0 },
			typeof worker.sessionFile === 'string'
				? { sessionFile: worker.sessionFile, fromByte: 0 }
				: null,
		].filter(Boolean);
		let transcript = null;
		for (let attempt = 0; attempt < 5; attempt += 1) {
			for (const selector of selectors) {
				const candidate = await requestData(handle.peer, 'get_subagent_messages', selector);
				if (
					Array.isArray(candidate?.messages) &&
					candidate.messages.length > 0 &&
					JSON.stringify(candidate.messages).includes('MAESTRO_WORKER_OK')
				) {
					transcript = candidate;
					break;
				}
			}
			if (transcript) break;
			await new Promise((resolve) => setTimeout(resolve, 200));
		}
		if (!transcript) {
			throw new Error('public Worker transcript did not expose the completed worker message');
		}
		shared.workerTranscriptObserved = true;
		return {
			evidence: {
				workerCount: workers.length,
				workerFields: Object.keys(worker).sort(),
				workerMessageCount: transcript.messages.length,
				workerTranscriptSha256: hashJson(transcript.messages),
				forwardedFrameCounts: countFrameTypes(handle.frames),
			},
		};
	} finally {
		await handle.peer.close();
	}
}

async function probeSteeringAndAbort() {
	requireLive('A05');
	const handle = createRpcHandle({
		args: deterministicRpcArgs({ noSession: true, tools: [] }),
		approvalDecision: 'reject',
	});
	try {
		await withTimeout(handle.peer.ready, TIMEOUT_MS, 'steering live ready frame');
		await negotiate(handle.peer);
		await requestData(handle.peer, 'set_steering_mode', { mode: 'one-at-a-time' });
		await requestData(handle.peer, 'set_follow_up_mode', { mode: 'one-at-a-time' });
		await requestData(handle.peer, 'set_interrupt_mode', { mode: 'immediate' });

		const started = handle.peer.waitForFrame(
			(frame) => frame.type === 'agent_start',
			LIVE_TIMEOUT_MS,
			'agent_start before steering'
		);
		assertSuccessfulResponse(
			await handle.peer.request(
				'prompt',
				{ message: 'Write a long numbered list from 1 through 500, one item at a time.' },
				TIMEOUT_MS
			),
			'prompt'
		);
		await started;
		assertSuccessfulResponse(
			await handle.peer.request(
				'steer',
				{ message: 'Stop the list and reply STEERED.' },
				TIMEOUT_MS
			),
			'steer'
		);

		const terminal = handle.peer.waitForFrame(
			(frame) => frame.type === 'agent_end' && frame.isTerminal !== false,
			LIVE_TIMEOUT_MS,
			'terminal agent_end after abort_and_prompt'
		);
		const abortAndPrompt = await handle.peer.request(
			'abort_and_prompt',
			{ message: 'Reply with exactly ABORT_PROMPT_OK.' },
			TIMEOUT_MS
		);
		assertSuccessfulResponse(abortAndPrompt, 'abort_and_prompt');
		await terminal;
		const completionSignal =
			typeof abortAndPrompt.data?.agentInvoked === 'boolean' ||
			handle.frames.some(
				(frame) => frame.type === 'prompt_result' && frame.id === abortAndPrompt.id
			);
		assertSuccessfulResponse(await handle.peer.request('abort', {}, TIMEOUT_MS), 'abort');
		shared.abortAndPromptCompletionObserved = completionSignal;
		if (!completionSignal) {
			const promptResults = handle.frames.filter((frame) => frame.type === 'prompt_result');
			throw new Error(
				`abort_and_prompt was accepted without a correlated completion signal; responseKeys=${Object.keys(abortAndPrompt).join(',')}; dataKeys=${Object.keys(abortAndPrompt.data ?? {}).join(',')}; promptResultCount=${promptResults.length}; promptResultIds=${promptResults.map((frame) => String(frame.id)).join(',')}`
			);
		}
		return {
			evidence: {
				steerAccepted: true,
				abortAndPromptCompletionSignal: true,
				idleAbortAccepted: true,
				frameCounts: countFrameTypes(handle.frames),
			},
		};
	} finally {
		await handle.peer.close();
	}
}

async function probeApprovalRoundTrip() {
	requireLive('A06');
	const handle = createRpcHandle({
		args: deterministicRpcArgs({ noSession: true, tools: ['write'] }),
		approvalDecision: 'reject',
	});
	try {
		await withTimeout(handle.peer.ready, TIMEOUT_MS, 'approval live ready frame');
		await negotiate(handle.peer);
		const terminal = handle.peer.waitForFrame(
			(frame) => frame.type === 'agent_end' && frame.isTerminal !== false,
			LIVE_TIMEOUT_MS,
			'terminal approval-probe agent_end'
		);
		assertSuccessfulResponse(
			await handle.peer.request(
				'prompt',
				{
					message:
						'Use the write tool to create approval-probe.txt in the current directory containing APPROVAL_PROBE. If denied, reply DENIED.',
				},
				TIMEOUT_MS
			),
			'prompt'
		);
		await terminal;
		if (handle.approvalRequests.length === 0) {
			throw new Error('restrictive RPC launch produced no extension_ui_request approval callback');
		}
		const request = handle.approvalRequests[0];
		const rejectedTarget = path.join(temporaryWorkspace, 'approval-probe.txt');
		try {
			await readFile(rejectedTarget);
			throw new Error('host-rejected write still created approval-probe.txt');
		} catch (error) {
			if (error?.code !== 'ENOENT') throw error;
		}
		if (!request.id || !request.method) throw new Error('approval callback omitted id or method');
		return {
			evidence: {
				requestCount: handle.approvalRequests.length,
				methods: [...new Set(handle.approvalRequests.map((item) => item.method))].sort(),
				rejectedByHost: true,
				restrictiveLaunch: true,
				acpPermissionSurface: 'documented-standard; RPC is the selected adapter transport',
			},
		};
	} finally {
		await handle.peer.close();
	}
}

async function probeDynamicConfiguration() {
	const stateBefore = await requestData(baseHandle.peer, 'get_state');
	const modelCatalog = await requestData(baseHandle.peer, 'get_available_models');
	const models = modelCatalog?.models ?? modelCatalog ?? [];
	if (!Array.isArray(models) || models.length === 0) throw new Error('model catalog is empty');
	const original = stateBefore.model;
	const alternate = models.find(
		(model) => model.provider !== original?.provider || (model.id ?? model.modelId) !== original?.id
	);
	let changedModel = false;
	if (alternate) {
		await requestData(baseHandle.peer, 'set_model', {
			provider: alternate.provider,
			modelId: alternate.id ?? alternate.modelId,
		});
		const changed = await requestData(baseHandle.peer, 'get_state');
		changedModel =
			changed.model?.provider === alternate.provider &&
			changed.model?.id === (alternate.id ?? alternate.modelId);
		if (!changedModel) throw new Error('set_model acknowledgement did not match effective state');
		await requestData(baseHandle.peer, 'set_model', {
			provider: original.provider,
			modelId: original.id,
		});
	}
	const thinkingLevels = ['off', 'minimal', 'low', 'medium', 'high'];
	const alternateThinking = thinkingLevels.find((level) => level !== stateBefore.thinkingLevel);
	await requestData(baseHandle.peer, 'set_thinking_level', { level: alternateThinking });
	const thinkingChanged = await requestData(baseHandle.peer, 'get_state');
	if (thinkingChanged.thinkingLevel !== alternateThinking) {
		throw new Error('set_thinking_level acknowledgement did not match effective state');
	}
	await requestData(baseHandle.peer, 'set_thinking_level', { level: stateBefore.thinkingLevel });
	const fastMode = await requestData(baseHandle.peer, 'set_fast_mode', { enabled: false });
	const loginProviders = await requestData(baseHandle.peer, 'get_login_providers');
	return {
		evidence: {
			modelCount: models.length,
			providerCount: new Set(models.map((model) => model.provider)).size,
			modelChangeRoundTrip: alternate ? changedModel : 'single-model-catalog',
			thinkingChangeRoundTrip: true,
			fastModeReadbackFields: Object.keys(fastMode ?? {}).sort(),
			loginProviderCount: (loginProviders?.providers ?? loginProviders ?? []).length,
		},
	};
}

async function probeOperationalSurface() {
	requireLive('A08');
	const phase = {
		id: 'maestro-conformance',
		name: 'Conformance',
		tasks: [{ id: 'round-trip', content: 'Round-trip public todo state', status: 'pending' }],
	};
	const setTodos = await requestData(baseHandle.peer, 'set_todos', { phases: [phase] });
	const returnedPhases = Array.isArray(setTodos)
		? setTodos
		: (setTodos?.phases ?? setTodos?.todoPhases ?? []);
	const state = await requestData(baseHandle.peer, 'get_state');
	if (
		returnedPhases.length !== 1 ||
		state.todoPhases?.length !== 1 ||
		hashJson(returnedPhases) !== hashJson(state.todoPhases)
	) {
		throw new Error(
			`normalized todo state did not round-trip: responseCount=${returnedPhases.length}, stateCount=${state.todoPhases?.length ?? 0}`
		);
	}
	const hostTools = await requestData(baseHandle.peer, 'set_host_tools', {
		tools: [
			{
				name: 'maestro_probe',
				label: 'Maestro Probe',
				description: 'Conformance-only no-op tool',
				parameters: { type: 'object', properties: {}, additionalProperties: false },
				loadMode: 'essential',
			},
		],
	});
	const uriSchemes = await requestData(baseHandle.peer, 'set_host_uri_schemes', {
		schemes: [
			{
				scheme: 'maestroprobe',
				description: 'Conformance-only immutable resource',
				writable: false,
				immutable: true,
			},
		],
	});
	const hostCallStart = baseHandle.hostToolCalls.length;
	const hostToolTerminal = baseHandle.peer.waitForFrame(
		(frame) => frame.type === 'agent_end' && frame.isTerminal !== false,
		LIVE_TIMEOUT_MS,
		'terminal host-tool probe agent_end'
	);
	assertSuccessfulResponse(
		await baseHandle.peer.request(
			'prompt',
			{
				message:
					'Call the maestro_probe tool exactly once with no arguments. After its result, reply exactly HOST_TOOL_COMPLETE.',
			},
			TIMEOUT_MS
		),
		'prompt'
	);
	await hostToolTerminal;
	const hostToolCalls = baseHandle.hostToolCalls.slice(hostCallStart);
	if (hostToolCalls.length !== 1 || hostToolCalls[0].toolName !== 'maestro_probe') {
		throw new Error(
			`host tool callback mismatch: count=${hostToolCalls.length}; names=${hostToolCalls.map((call) => call.toolName).join(',')}`
		);
	}
	const commands = await requestData(baseHandle.peer, 'get_available_commands');
	const stats = await requestData(baseHandle.peer, 'get_session_stats');
	await requestData(baseHandle.peer, 'set_auto_compaction', { enabled: false });
	await requestData(baseHandle.peer, 'set_auto_compaction', { enabled: true });
	await requestData(baseHandle.peer, 'set_auto_retry', { enabled: false });
	await requestData(baseHandle.peer, 'set_todos', { phases: [] });
	await requestData(baseHandle.peer, 'set_host_tools', { tools: [] });
	await requestData(baseHandle.peer, 'set_host_uri_schemes', { schemes: [] });
	return {
		evidence: {
			todoRoundTrip: true,
			hostToolNames: hostTools?.toolNames ?? [],
			hostToolCallbackCount: hostToolCalls.length,
			hostToolCallFields: Object.keys(hostToolCalls[0]).sort(),
			hostUriSchemes: uriSchemes?.schemes ?? [],
			commandCount: (commands?.commands ?? commands ?? []).length,
			statsFields: Object.keys(stats ?? {}).sort(),
			contextUsageFields: Object.keys(state.contextUsage ?? {}).sort(),
		},
	};
}
async function probeEvidenceAndProcessSurface() {
	const evidencePath = path.join(temporaryWorkspace, 'rpc-evidence.txt');
	const command = `node -e \"require('node:fs').writeFileSync('rpc-evidence.txt', 'EVIDENCE_OK'); process.stdout.write('PROCESS_OK')\"`;
	const bashResult = await requestData(baseHandle.peer, 'bash', { command }, TIMEOUT_MS);
	const evidenceContents = await readFile(evidencePath, 'utf8');
	if (
		bashResult?.exitCode !== 0 ||
		bashResult?.output !== 'PROCESS_OK' ||
		evidenceContents !== 'EVIDENCE_OK'
	) {
		throw new Error(
			`bash evidence mismatch: exitCode=${String(bashResult?.exitCode)}; outputMatch=${bashResult?.output === 'PROCESS_OK'}; fileMatch=${evidenceContents === 'EVIDENCE_OK'}`
		);
	}
	const exportPath = path.join(temporaryWorkspace, 'session-export.html');
	let exportStatus = 'supported';
	try {
		await requestData(baseHandle.peer, 'export_html', { outputPath: exportPath }, TIMEOUT_MS);
	} catch (error) {
		exportStatus = `unavailable: ${errorMessage(error)}`;
	}
	const state = await requestData(baseHandle.peer, 'get_state');
	const toolNames = (state.dumpTools ?? []).map((tool) => tool.name);
	const surfaces = {
		file: toolNames.some((name) => ['read', 'write', 'edit'].includes(name)),
		browser: toolNames.some((name) => /browser/i.test(name)),
		worktree: toolNames.some((name) => /worktree/i.test(name)),
		process: toolNames.some((name) => /process|^ps$/i.test(name)),
		pty: toolNames.some((name) => /pty|terminal/i.test(name)),
		artifact: toolNames.some((name) => /artifact/i.test(name)),
	};
	deviations.push({
		id: 'A09_RESOURCE_SURFACE',
		detail:
			'Dedicated artifact, browser, worktree, background-process, and PTY lifecycle APIs are not part of RPC v2; available agent tools remain provider-owned structured events.',
	});
	return {
		evidence: {
			bashResponseFields: Object.keys(bashResult ?? {}).sort(),
			bashEffectObserved: true,
			exportStatus,
			discoveredToolSurfaces: surfaces,
			providerOwnedToolEvents: true,
		},
	};
}

async function probeTypedErrors() {
	requireLive('A10');
	const parseWait = baseHandle.peer.waitForFrame(
		(frame) => frame.type === 'response' && frame.success === false && frame.command === 'parse',
		TIMEOUT_MS,
		'typed malformed-JSON response'
	);
	baseHandle.peer.sendRaw('{malformed-json');
	const parseFailure = await parseWait;

	const unknownWait = baseHandle.peer.waitForFrame(
		(frame) => frame.type === 'response' && frame.success === false && frame.command !== 'parse',
		5_000,
		'typed unknown-command response'
	);
	baseHandle.peer.send({ id: 'maestro-unknown', type: 'maestro_unknown_command' });
	const unknown = await unknownWait;
	if (unknown.success !== false) throw new Error('unknown command did not fail');
	if (shared.staleErrorCode !== 'stale_cursor') {
		throw new Error(
			`mutated paged snapshot did not return stale_cursor (received ${String(shared.staleErrorCode)})`
		);
	}
	if (shared.busyErrorCode !== 'session_busy') {
		throw new Error(
			`streaming page request did not return session_busy (received ${String(shared.busyErrorCode)})`
		);
	}

	const before = await requestData(baseHandle.peer, 'get_state');
	const unavailable = await baseHandle.peer.request(
		'set_model',
		{ provider: 'maestro-invalid-provider', modelId: 'maestro-invalid-model' },
		TIMEOUT_MS
	);
	if (unavailable.success !== false) throw new Error('unavailable provider/model did not fail');
	const after = await requestData(baseHandle.peer, 'get_state');
	if (hashJson(before.model) !== hashJson(after.model)) {
		throw new Error('failed model change mutated effective model state');
	}
	return {
		evidence: {
			parseFailure: summarizeProtocolFrame(parseFailure),
			unknownCommand: summarizeProtocolFrame(unknown),
			staleCursorCode: shared.staleErrorCode,
			busyCodeObservedDuringLiveRun: shared.busyErrorCode,
			providerFailure: summarizeProtocolFrame(unavailable),
			stateUnchangedAfterRejectedMutation: true,
		},
	};
}
async function requestData(peer, type, params = {}, timeoutMs = TIMEOUT_MS) {
	return assertSuccessfulResponse(await peer.request(type, params, timeoutMs), type);
}

async function negotiate(peer) {
	const response = await peer.request('negotiate_protocol', { protocolVersion: 2 }, TIMEOUT_MS);
	const data = assertSuccessfulResponse(response, 'negotiate_protocol');
	if (data?.protocolVersion !== 2)
		throw new Error('RPC v2 negotiation did not return protocolVersion 2');
}

async function runPublicCommand(args) {
	const { stdout } = await execFileAsync(options.executable, args, {
		cwd: temporaryWorkspace,
		windowsHide: true,
		timeout: TIMEOUT_MS,
		maxBuffer: 8 * 1024 * 1024,
	});
	return stdout;
}

async function readOmpIdentity(executable) {
	const { stdout } = await execFileAsync(executable, ['--version'], {
		cwd: temporaryWorkspace,
		windowsHide: true,
		timeout: 30_000,
	});
	return { version: parseOmpVersionOutput(stdout), sha256: await hashFile(executable) };
}

async function populateBuildIdentity(target) {
	const packageJson = JSON.parse(await readFile(path.join(process.cwd(), 'package.json'), 'utf8'));
	target.maestro.version = packageJson.version;
	const harnessDigest = createHash('sha256');
	for (const relativePath of [
		'scripts/omp-rpc-protocol.mjs',
		'scripts/omp-rpc-conformance-lib.mjs',
		'scripts/omp-rpc-conformance.mjs',
		'scripts/fixtures/omp-rpc-18.1.6-baseline.json',
		'scripts/fixtures/omp-rpc-upstream-requirements.json',
	]) {
		harnessDigest.update(relativePath);
		harnessDigest.update(await readFile(path.join(process.cwd(), relativePath)));
	}
	target.harnessSha256 = harnessDigest.digest('hex');
	try {
		const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
			cwd: process.cwd(),
			windowsHide: true,
			timeout: 30_000,
		});
		target.sourceRevision = stdout.trim();
	} catch {
		target.sourceRevision = 'unavailable';
	}
}

function runCodecSelfCheck() {
	const physical = new JsonLineDecoder({ maxFrameBytes: 256 });
	const snowman = '\u2603';
	const frame = Buffer.from(`${JSON.stringify({ type: 'notice', value: snowman })}\n`, 'utf8');
	const boundary = frame.indexOf(Buffer.from(snowman)) + 1;
	if (physical.push(frame.subarray(0, boundary)).length !== 0) {
		throw new Error('UTF-8 split unexpectedly emitted a physical frame');
	}
	const decoded = physical.push(frame.subarray(boundary));
	if (decoded[0]?.value !== snowman) throw new Error('UTF-8 split did not round-trip');

	const logical = { type: 'response', id: 'self-check', data: { value: snowman.repeat(16) } };
	const bytes = Buffer.from(JSON.stringify(logical), 'utf8');
	const split = Math.floor(bytes.length / 2);
	const chunks = [bytes.subarray(0, split), bytes.subarray(split)];
	const reassembler = new RpcV2FrameDecoder({ maxReassembledFrameBytes: 1024 });
	let value = null;
	for (let index = 0; index < chunks.length; index += 1) {
		value = reassembler.push({
			type: 'rpc_chunk',
			chunkId: 'rpc-self-check',
			index,
			count: chunks.length,
			byteLength: bytes.length,
			data: chunks[index].toString('base64'),
		});
	}
	if (hashJson(value) !== hashJson(logical)) throw new Error('RPC v2 chunk self-check failed');
}

function countFrameTypes(frames) {
	const counts = {};
	for (const frame of frames) {
		const key = typeof frame.type === 'string' ? frame.type : 'unknown';
		counts[key] = (counts[key] ?? 0) + 1;
	}
	return Object.fromEntries(
		Object.entries(counts).sort(([left], [right]) => left.localeCompare(right))
	);
}

function stableJson(value) {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
	if (value && typeof value === 'object') {
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
			.join(',')}}`;
	}
	return JSON.stringify(value);
}

function hashJson(value) {
	return sha256(Buffer.from(stableJson(value), 'utf8'));
}

function sha256(bytes) {
	return createHash('sha256').update(bytes).digest('hex');
}

async function hashFile(filePath) {
	const digest = createHash('sha256');
	for await (const chunk of createReadStream(filePath)) digest.update(chunk);
	return digest.digest('hex');
}

async function withTimeout(promise, timeoutMs, description) {
	let timer;
	const timeout = new Promise((_, reject) => {
		timer = setTimeout(() => reject(new Error(`timed out waiting for ${description}`)), timeoutMs);
	});
	try {
		return await Promise.race([promise, timeout]);
	} finally {
		clearTimeout(timer);
	}
}

function errorMessage(error) {
	return error instanceof Error ? error.message : String(error);
}
