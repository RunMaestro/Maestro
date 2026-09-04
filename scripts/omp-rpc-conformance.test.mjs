import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

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

const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url));
const baselinePath = path.join(scriptsDirectory, 'fixtures', 'omp-rpc-18.1.6-baseline.json');
const baseline = JSON.parse(await readFile(baselinePath, 'utf8'));
const upstreamRequirements = JSON.parse(
	await readFile(
		path.join(scriptsDirectory, 'fixtures', 'omp-rpc-upstream-requirements.json'),
		'utf8'
	)
);

test('upstream G1 G2 G3 G5 contracts are explicit and correlation-bearing', () => {
	assert.equal(upstreamRequirements.schemaVersion, 1);
	assert.deepEqual(
		upstreamRequirements.requirements.map((requirement) => requirement.id),
		['G1', 'G2', 'G3', 'G5']
	);
	for (const requirement of upstreamRequirements.requirements) {
		assert.match(
			requirement.request.type,
			/^(create_worker|command_worker|get_subagent_messages|abort_and_prompt)$/
		);
		assert.ok(requirement.request.required.includes('id'));
		assert.ok(requirement.response.successDataRequired.length > 0);
		assert.ok(requirement.events.length > 0);
		assert.ok(
			requirement.invariants.some((invariant) => /acknowledgement|correlat/i.test(invariant))
		);
	}
});

test('extension UI responses select one-time approval and explicit rejection values', () => {
	const request = {
		type: 'extension_ui_request',
		id: 'approval-1',
		method: 'select',
		options: [
			{ label: 'Always allow', value: 'always' },
			{ label: 'Allow once', value: 'once' },
			{ label: 'Reject', value: 'reject' },
		],
	};
	assert.deepEqual(buildExtensionUiResponse(request, 'approve'), {
		type: 'extension_ui_response',
		id: 'approval-1',
		value: 'once',
	});
	assert.deepEqual(buildExtensionUiResponse(request, 'reject'), {
		type: 'extension_ui_response',
		id: 'approval-1',
		value: 'reject',
	});
});

test('extension UI responses cancel unknown selects and confirm boolean prompts', () => {
	assert.deepEqual(
		buildExtensionUiResponse({ id: 'select-1', method: 'select', options: [] }, 'reject'),
		{ type: 'extension_ui_response', id: 'select-1', cancelled: true }
	);
	assert.deepEqual(buildExtensionUiResponse({ id: 'confirm-1', method: 'confirm' }, 'approve'), {
		type: 'extension_ui_response',
		id: 'confirm-1',
		confirmed: true,
	});
});
test('OMP version parser accepts the public slash form only', () => {
	assert.equal(parseOmpVersionOutput('omp/18.1.6\n'), '18.1.6');
	assert.throws(() => parseOmpVersionOutput('omp v18.1.6'), /exact OMP version/);
	assert.throws(() => parseOmpVersionOutput('18.1'), /exact OMP version/);
});

test('the pinned baseline is internally complete and unique', () => {
	assert.equal(validateBaseline(baseline), baseline);
	assert.equal(new Set(baseline.requiredCommandTypes).size, baseline.requiredCommandTypes.length);
	assert.equal(new Set(baseline.requiredEventTypes).size, baseline.requiredEventTypes.length);
	assert.deepEqual(baseline.requiredCases, [
		'A01',
		'A02',
		'A03',
		'A04',
		'A05',
		'A06',
		'A07',
		'A08',
		'A09',
		'A10',
		'A11',
	]);
});

test('parseConformanceArgs requires an explicit absolute OMP executable', () => {
	assert.throws(() => parseConformanceArgs([]), /--executable/);
	assert.throws(() => parseConformanceArgs(['--executable', 'omp']), /absolute path/);
	assert.deepEqual(
		parseConformanceArgs([
			'--executable',
			'C:\\Tools\\omp.exe',
			'--baseline',
			baselinePath,
			'--output',
			'C:\\Temp\\report.json',
			'--live',
		]),
		{
			executable: path.resolve('C:\\Tools\\omp.exe'),
			baselinePath: path.resolve(baselinePath),
			outputPath: path.resolve('C:\\Temp\\report.json'),
			live: true,
		}
	);
});

test('parseConformanceArgs rejects unknown flags and missing values', () => {
	assert.throws(() => parseConformanceArgs(['--executable']), /requires a value/);
	assert.throws(
		() => parseConformanceArgs(['--executable', 'C:\\Tools\\omp.exe', '--surprise']),
		/unknown argument/
	);
});

test('comparePinnedIdentity requires exact semantic version and SHA-256 digest', () => {
	assert.deepEqual(
		comparePinnedIdentity({ version: '18.1.6', sha256: baseline.omp.sha256 }, baseline),
		{ status: 'pass', reasons: [] }
	);
	assert.deepEqual(comparePinnedIdentity({ version: '18.1.7', sha256: '0'.repeat(64) }, baseline), {
		status: 'fail',
		reasons: [
			'expected OMP 18.1.6, observed 18.1.7',
			`expected SHA-256 ${baseline.omp.sha256}, observed ${'0'.repeat(64)}`,
		],
	});
});

test('assertSuccessfulResponse returns data and rejects failed or mismatched responses', () => {
	assert.deepEqual(
		assertSuccessfulResponse(
			{ type: 'response', command: 'get_state', success: true, data: { value: 1 } },
			'get_state'
		),
		{ value: 1 }
	);
	assert.throws(
		() =>
			assertSuccessfulResponse(
				{ type: 'response', command: 'get_state', success: false, code: 'stale_cursor' },
				'get_state'
			),
		/stale_cursor/
	);
	assert.throws(
		() =>
			assertSuccessfulResponse({ type: 'response', command: 'prompt', success: true }, 'get_state'),
		/expected get_state/
	);
});

test('power-user capability classification exposes fleet gaps and proves observed signals', () => {
	assert.deepEqual(
		classifyPowerUserCapabilities({
			commandTypes: baseline.requiredCommandTypes,
			workerTranscriptObserved: true,
			abortAndPromptCompletionObserved: true,
		}),
		[
			{
				id: 'G1',
				name: 'host-created workers',
				status: 'unsupported',
				reason: 'RPC has observation APIs but no create_worker command.',
			},
			{
				id: 'G2',
				name: 'direct worker steering and messaging',
				status: 'unsupported',
				reason: 'RPC steering targets the root session and exposes no command_worker command.',
			},
			{
				id: 'G3',
				name: 'completed worker transcript visibility',
				status: 'supported',
				reason: 'get_subagent_messages exposed the completed worker message.',
			},
			{
				id: 'G5',
				name: 'deterministic abort-and-prompt completion',
				status: 'supported',
				reason: 'Observed response.data.agentInvoked or prompt_result completion correlation.',
			},
		]
	);
});
test('power-user capability classification requires an observed Worker transcript', () => {
	const capabilities = classifyPowerUserCapabilities({
		commandTypes: baseline.requiredCommandTypes,
		workerTranscriptObserved: false,
		abortAndPromptCompletionObserved: true,
	});
	assert.equal(capabilities[2].id, 'G3');
	assert.equal(capabilities[2].status, 'unsupported');
});
test('conformance verdict blocks workload parity on missing Worker transcript visibility', () => {
	const cases = baseline.requiredCases.map((id) => ({ id, required: true, status: 'pass' }));
	const capabilities = classifyPowerUserCapabilities({
		commandTypes: [...baseline.requiredCommandTypes, 'create_worker', 'command_worker'],
		workerTranscriptObserved: false,
		abortAndPromptCompletionObserved: true,
	});
	assert.deepEqual(computeConformanceVerdict({ cases, capabilities }), {
		adapterProtocol: 'pass',
		workloadParity: 'blocked',
		blockingCaseIds: [],
		blockingCapabilityIds: ['G3'],
	});
});

test('power-user capability classification never infers G5 from command acceptance alone', () => {
	assert.equal(
		classifyPowerUserCapabilities({
			commandTypes: baseline.requiredCommandTypes,
			workerTranscriptObserved: true,
			abortAndPromptCompletionObserved: false,
		})[3].status,
		'ambiguous'
	);
});

test('conformance verdict separates adapter protocol readiness from workload parity', () => {
	const cases = baseline.requiredCases.map((id) => ({ id, required: true, status: 'pass' }));
	const capabilities = classifyPowerUserCapabilities({
		commandTypes: baseline.requiredCommandTypes,
		workerTranscriptObserved: true,
		abortAndPromptCompletionObserved: true,
	});
	assert.deepEqual(computeConformanceVerdict({ cases, capabilities }), {
		adapterProtocol: 'pass',
		workloadParity: 'blocked',
		blockingCaseIds: [],
		blockingCapabilityIds: ['G1', 'G2'],
	});
});

test('required failed, ambiguous, or not-run cases fail the adapter protocol gate', () => {
	for (const status of ['fail', 'ambiguous', 'not-run']) {
		const cases = baseline.requiredCases.map((id) => ({
			id,
			required: true,
			status: id === 'A04' ? status : 'pass',
		}));
		assert.deepEqual(computeConformanceVerdict({ cases, capabilities: [] }), {
			adapterProtocol: 'fail',
			workloadParity: 'blocked',
			blockingCaseIds: ['A04'],
			blockingCapabilityIds: [],
		});
	}
});
