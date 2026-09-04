import path from 'node:path';
import { fileURLToPath } from 'node:url';
const CASE_STATUSES = new Set(['pass', 'fail', 'ambiguous', 'not-run']);
const CAPABILITY_STATUSES = new Set(['supported', 'unsupported', 'ambiguous']);

function isRecord(value) {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireUniqueStrings(value, label) {
	if (
		!Array.isArray(value) ||
		value.length === 0 ||
		value.some((item) => typeof item !== 'string' || item.length === 0)
	) {
		throw new Error(`${label} must be a non-empty string array`);
	}
	if (new Set(value).size !== value.length) throw new Error(`${label} contains duplicates`);
}

export function validateBaseline(baseline) {
	if (!isRecord(baseline) || baseline.schemaVersion !== 1) {
		throw new Error('baseline.schemaVersion must be 1');
	}
	if (!isRecord(baseline.omp) || !/^\d+\.\d+\.\d+$/.test(baseline.omp.version)) {
		throw new Error('baseline.omp.version must be an exact semantic version');
	}
	if (!/^[a-f0-9]{64}$/i.test(baseline.omp.sha256 ?? '')) {
		throw new Error('baseline.omp.sha256 must be a SHA-256 digest');
	}
	requireUniqueStrings(baseline.requiredCommandTypes, 'baseline.requiredCommandTypes');
	requireUniqueStrings(baseline.requiredEventTypes, 'baseline.requiredEventTypes');
	requireUniqueStrings(baseline.requiredCases, 'baseline.requiredCases');
	if (!Array.isArray(baseline.powerUserCapabilities)) {
		throw new Error('baseline.powerUserCapabilities must be an array');
	}
	return baseline;
}

export function parseConformanceArgs(argv) {
	const parsed = { executable: null, baselinePath: null, outputPath: null, live: false };
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === '--live') {
			parsed.live = true;
			continue;
		}
		if (!['--executable', '--baseline', '--output'].includes(argument)) {
			throw new Error(`unknown argument: ${argument}`);
		}
		const value = argv[index + 1];
		if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value`);
		index += 1;
		if (argument === '--executable') parsed.executable = value;
		if (argument === '--baseline') parsed.baselinePath = value;
		if (argument === '--output') parsed.outputPath = value;
	}
	if (!parsed.executable) throw new Error('--executable is required');
	if (!path.isAbsolute(parsed.executable)) {
		throw new Error('--executable must be an absolute path to the user-installed OMP binary');
	}
	const executable = path.resolve(parsed.executable);
	const baselinePath = path.resolve(
		parsed.baselinePath ??
			path.join(
				path.dirname(fileURLToPath(import.meta.url)),
				'fixtures',
				'omp-rpc-18.1.6-baseline.json'
			)
	);
	const outputPath = parsed.outputPath ? path.resolve(parsed.outputPath) : null;
	return { executable, baselinePath, outputPath, live: parsed.live };
}
export function parseOmpVersionOutput(output) {
	const match = String(output)
		.trim()
		.match(/^omp\/(\d+\.\d+\.\d+)$/);
	if (!match) throw new Error('unable to parse exact OMP version from --version');
	return match[1];
}

function optionText(option) {
	if (typeof option === 'string') return option;
	if (!isRecord(option)) return '';
	return [option.label, option.title, option.value, option.id]
		.filter((value) => typeof value === 'string')
		.join(' ');
}

function optionValue(option) {
	if (typeof option === 'string') return option;
	if (!isRecord(option)) return undefined;
	return option.value ?? option.id ?? option.label;
}

export function buildExtensionUiResponse(request, decision) {
	if (!isRecord(request) || typeof request.id !== 'string' || typeof request.method !== 'string') {
		throw new Error('extension UI request requires string id and method');
	}
	if (!['approve', 'reject'].includes(decision)) {
		throw new Error('extension UI decision must be approve or reject');
	}
	const response = { type: 'extension_ui_response', id: request.id };
	if (request.method !== 'select') {
		return { ...response, confirmed: decision === 'approve' };
	}

	const options = Array.isArray(request.options) ? request.options : [];
	const selected = options.find((option) => {
		const text = optionText(option);
		return decision === 'approve'
			? /(?:allow|approve|yes)/i.test(text) && !/(?:always|permanent)/i.test(text)
			: /(?:deny|reject|cancel|no)/i.test(text);
	});
	const value = optionValue(selected);
	if (value === undefined) return { ...response, cancelled: true };
	return { ...response, value };
}

export function comparePinnedIdentity(identity, baseline) {
	validateBaseline(baseline);
	const reasons = [];
	if (identity.version !== baseline.omp.version) {
		reasons.push(`expected OMP ${baseline.omp.version}, observed ${String(identity.version)}`);
	}
	if (identity.sha256?.toLowerCase() !== baseline.omp.sha256.toLowerCase()) {
		reasons.push(`expected SHA-256 ${baseline.omp.sha256}, observed ${String(identity.sha256)}`);
	}
	return { status: reasons.length === 0 ? 'pass' : 'fail', reasons };
}

export function assertSuccessfulResponse(response, expectedCommand) {
	if (!isRecord(response) || response.type !== 'response') {
		throw new Error(`expected ${expectedCommand} RPC response`);
	}
	if (response.command !== expectedCommand) {
		throw new Error(`expected ${expectedCommand} response, received ${String(response.command)}`);
	}
	if (response.success !== true) {
		const detail = response.code ?? response.error ?? 'unknown RPC failure';
		throw new Error(`${expectedCommand} failed: ${detail}`);
	}
	return response.data;
}

export function classifyPowerUserCapabilities({
	commandTypes,
	workerTranscriptObserved,
	abortAndPromptCompletionObserved,
}) {
	const commands = new Set(commandTypes);
	const g1Supported = commands.has('create_worker');
	const g2Supported = commands.has('command_worker');
	return [
		{
			id: 'G1',
			name: 'host-created workers',
			status: g1Supported ? 'supported' : 'unsupported',
			reason: g1Supported
				? 'RPC exposes a create_worker command.'
				: 'RPC has observation APIs but no create_worker command.',
		},
		{
			id: 'G2',
			name: 'direct worker steering and messaging',
			status: g2Supported ? 'supported' : 'unsupported',
			reason: g2Supported
				? 'RPC exposes a command_worker command.'
				: 'RPC steering targets the root session and exposes no command_worker command.',
		},
		{
			id: 'G3',
			name: 'completed worker transcript visibility',
			status: workerTranscriptObserved ? 'supported' : 'unsupported',
			reason: workerTranscriptObserved
				? 'get_subagent_messages exposed the completed worker message.'
				: 'get_subagent_messages returned no completed worker message after terminal root completion.',
		},
		{
			id: 'G5',
			name: 'deterministic abort-and-prompt completion',
			status: abortAndPromptCompletionObserved ? 'supported' : 'ambiguous',
			reason: abortAndPromptCompletionObserved
				? 'Observed response.data.agentInvoked or prompt_result completion correlation.'
				: 'Command acceptance alone does not prove terminal abort-and-prompt completion.',
		},
	];
}

export function computeConformanceVerdict({ cases, capabilities }) {
	if (!Array.isArray(cases) || !Array.isArray(capabilities)) {
		throw new TypeError('cases and capabilities must be arrays');
	}
	for (const testCase of cases) {
		if (!CASE_STATUSES.has(testCase.status))
			throw new Error(`invalid case status: ${testCase.status}`);
	}
	for (const capability of capabilities) {
		if (!CAPABILITY_STATUSES.has(capability.status)) {
			throw new Error(`invalid capability status: ${capability.status}`);
		}
	}
	const blockingCaseIds = cases
		.filter((testCase) => testCase.required && testCase.status !== 'pass')
		.map((testCase) => testCase.id);
	const blockingCapabilityIds = capabilities
		.filter(
			(capability) =>
				['G1', 'G2', 'G3', 'G5'].includes(capability.id) && capability.status !== 'supported'
		)
		.map((capability) => capability.id);
	return {
		adapterProtocol: blockingCaseIds.length === 0 ? 'pass' : 'fail',
		workloadParity:
			blockingCapabilityIds.length === 0 && blockingCaseIds.length === 0 ? 'pass' : 'blocked',
		blockingCaseIds,
		blockingCapabilityIds,
	};
}
