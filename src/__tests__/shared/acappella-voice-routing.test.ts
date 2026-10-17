/**
 * @file acappella-voice-routing.test.ts
 *
 * Which Brain routes: the `voice-routing` assignment when it names a source,
 * otherwise the stored voice-specific choice. These rules are what keep the
 * voice panels, the provider registry, and the capability gate on one answer.
 */

import { describe, it, expect } from 'vitest';

import {
	ENDPOINT_BRAIN_PROVIDER_ID,
	QWEN3_BRAIN_PROVIDER_ID,
} from '../../shared/acappella/provider-catalog';
import {
	ROUTE_DECISION_GRAMMAR_SCHEMA,
	ROUTE_DECISION_JSON_SCHEMA,
} from '../../shared/acappella/route-decision';
import {
	VOICE_ROUTING_TASK_ID,
	assignedBrainProviderId,
	effectiveBrainProviderId,
	isAssignedBrainProviderId,
	isVoiceRoutingOnSystemOne,
	parseVoiceBrainChoice,
	resolveVoiceBrainSource,
	voiceBrainChoiceValue,
} from '../../shared/acappella/voice-routing';
import { LOCAL_MODEL_TASKS } from '../../shared/local-models/tasks';

const ENDPOINTS = [{ id: 'ep-1', name: 'Ollama' }];

describe('the voice-routing assignment as the Brain', () => {
	it('is the text-generation task that defaults to off', () => {
		expect(LOCAL_MODEL_TASKS[VOICE_ROUTING_TASK_ID]).toMatchObject({
			needs: 'text-gen',
			defaultAssignment: { type: 'off' },
		});
	});

	it('maps a local model and an endpoint to their own provider ids', () => {
		expect(assignedBrainProviderId({ type: 'local', modelId: 'm' })).toBe(QWEN3_BRAIN_PROVIDER_ID);
		expect(assignedBrainProviderId({ type: 'endpoint', endpointId: 'e', model: 'm' })).toBe(
			ENDPOINT_BRAIN_PROVIDER_ID
		);
		expect(assignedBrainProviderId({ type: 'off' })).toBeNull();
		expect(assignedBrainProviderId({ type: 'utility-agent' })).toBeNull();
	});

	it('knows which provider ids are never a stored choice', () => {
		expect(isAssignedBrainProviderId(QWEN3_BRAIN_PROVIDER_ID)).toBe(true);
		expect(isAssignedBrainProviderId(ENDPOINT_BRAIN_PROVIDER_ID)).toBe(true);
		expect(isAssignedBrainProviderId('mock-brain')).toBe(false);
		expect(isAssignedBrainProviderId('openai-brain')).toBe(false);
	});

	it('resolves no source when the task is off, unset, or the setting is junk', () => {
		expect(resolveVoiceBrainSource({}, ENDPOINTS)).toBeNull();
		expect(resolveVoiceBrainSource(undefined, ENDPOINTS)).toBeNull();
		expect(resolveVoiceBrainSource('nonsense', ENDPOINTS)).toBeNull();
		expect(resolveVoiceBrainSource({ 'voice-routing': { type: 'off' } }, ENDPOINTS)).toBeNull();
		// This task has no agent path, so the assignment is unusable and reads as off.
		expect(
			resolveVoiceBrainSource({ 'voice-routing': { type: 'utility-agent' } }, ENDPOINTS)
		).toBeNull();
		// Another task's assignment is not this one's.
		expect(
			resolveVoiceBrainSource({ 'tab-naming': { type: 'local', modelId: 'm' } }, ENDPOINTS)
		).toBeNull();
	});

	it('names an endpoint source by its model and its endpoint', () => {
		expect(
			resolveVoiceBrainSource(
				{ 'voice-routing': { type: 'endpoint', endpointId: 'ep-1', model: 'qwen3:8b' } },
				ENDPOINTS
			)
		).toEqual({
			assignment: { type: 'endpoint', endpointId: 'ep-1', model: 'qwen3:8b' },
			spec: 'endpoint:ep-1:qwen3:8b',
			label: 'qwen3:8b on Ollama',
			endpointName: 'Ollama',
		});
	});

	it('still resolves a source whose endpoint was removed, so the slot can say so', () => {
		const source = resolveVoiceBrainSource(
			{ 'voice-routing': { type: 'endpoint', endpointId: 'gone', model: 'qwen3:8b' } },
			ENDPOINTS
		);

		expect(source).toMatchObject({ spec: 'endpoint:gone:qwen3:8b', label: 'qwen3:8b' });
		expect(source?.endpointName).toBeUndefined();
	});

	it('names a local source by its catalog name, or its id when the catalog dropped it', () => {
		expect(
			resolveVoiceBrainSource(
				{ 'voice-routing': { type: 'local', modelId: 'qwen3-1.7b-instruct-q4km' } },
				[]
			)
		).toMatchObject({
			spec: 'local:qwen3-1.7b-instruct-q4km',
			label: 'Qwen3 1.7B Instruct (Q4_K_M)',
		});
		expect(
			resolveVoiceBrainSource({ 'voice-routing': { type: 'local', modelId: 'retired' } }, [])
		).toMatchObject({ label: 'retired' });
	});

	it('lets the assignment decide the Brain, and the stored choice wait behind it', () => {
		const source = resolveVoiceBrainSource(
			{ 'voice-routing': { type: 'endpoint', endpointId: 'ep-1', model: 'm' } },
			ENDPOINTS
		);

		expect(effectiveBrainProviderId(source, 'openai-brain')).toBe(ENDPOINT_BRAIN_PROVIDER_ID);
		expect(effectiveBrainProviderId(null, 'openai-brain')).toBe('openai-brain');
		// Unset stays unset: the registry applies the build default.
		expect(effectiveBrainProviderId(null, undefined)).toBeUndefined();
	});

	it('reads a picker value as an assignment or a provider, and writes it back', () => {
		expect(parseVoiceBrainChoice('endpoint:ep-1:qwen3:8b')).toEqual({
			kind: 'assignment',
			assignment: { type: 'endpoint', endpointId: 'ep-1', model: 'qwen3:8b' },
		});
		expect(parseVoiceBrainChoice('local:qwen3-1.7b-instruct-q4km')).toEqual({
			kind: 'assignment',
			assignment: { type: 'local', modelId: 'qwen3-1.7b-instruct-q4km' },
		});
		expect(parseVoiceBrainChoice('anthropic-brain')).toEqual({
			kind: 'provider',
			providerId: 'anthropic-brain',
		});

		const source = resolveVoiceBrainSource(
			{ 'voice-routing': { type: 'endpoint', endpointId: 'ep-1', model: 'qwen3:8b' } },
			ENDPOINTS
		);
		expect(voiceBrainChoiceValue(source, ENDPOINT_BRAIN_PROVIDER_ID)).toBe(
			'endpoint:ep-1:qwen3:8b'
		);
		expect(voiceBrainChoiceValue(null, 'mock-brain')).toBe('mock-brain');
	});
});

describe('the route decision schema a grammar is compiled from', () => {
	it('lets every optional field be null, and nothing else', () => {
		const nullable = { oneOf: [{ type: 'null' }, { type: 'string' }] };
		const required = new Set<string>(ROUTE_DECISION_JSON_SCHEMA.required);

		for (const [name, schema] of Object.entries(ROUTE_DECISION_GRAMMAR_SCHEMA.properties)) {
			if (required.has(name)) {
				// A required field is the same shape a server is held to.
				expect(schema).toBe(
					ROUTE_DECISION_JSON_SCHEMA.properties[
						name as keyof typeof ROUTE_DECISION_JSON_SCHEMA.properties
					]
				);
			} else {
				// A grammar emits every listed property, so an optional one that could
				// only be a string would be written on every turn.
				expect(schema).toEqual(nullable);
			}
		}
	});

	it('keeps the fields, their order, and the required list of the plain schema', () => {
		expect(Object.keys(ROUTE_DECISION_GRAMMAR_SCHEMA.properties)).toEqual(
			Object.keys(ROUTE_DECISION_JSON_SCHEMA.properties)
		);
		expect(ROUTE_DECISION_GRAMMAR_SCHEMA.required).toEqual(ROUTE_DECISION_JSON_SCHEMA.required);
	});
});

describe('voice routing assigned to System One', () => {
	const SYSTEM_ONE = { [VOICE_ROUTING_TASK_ID]: { type: 'system-one' } };

	it('is accepted by the task, which declares its typed questions', () => {
		expect(LOCAL_MODEL_TASKS[VOICE_ROUTING_TASK_ID].systemOneQuestions).toBeTypeOf('function');
		expect(isVoiceRoutingOnSystemOne(SYSTEM_ONE)).toBe(true);
	});

	it('is not the case for off, a model, an endpoint, or an unreadable setting', () => {
		expect(isVoiceRoutingOnSystemOne({})).toBe(false);
		expect(isVoiceRoutingOnSystemOne(undefined)).toBe(false);
		expect(isVoiceRoutingOnSystemOne('system-one')).toBe(false);
		expect(
			isVoiceRoutingOnSystemOne({ [VOICE_ROUTING_TASK_ID]: { type: 'local', modelId: 'm' } })
		).toBe(false);
	});

	it('fills no Brain slot: the stored voice-specific choice stays the Brain in force', () => {
		const source = resolveVoiceBrainSource(SYSTEM_ONE, ENDPOINTS);
		expect(source).toBeNull();
		expect(effectiveBrainProviderId(source, 'builtin-brain')).toBe('builtin-brain');
		expect(voiceBrainChoiceValue(source, 'builtin-brain')).toBe('builtin-brain');
	});
});
