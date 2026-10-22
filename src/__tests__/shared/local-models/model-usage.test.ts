/**
 * Tests for the model usage rules that need no database: which source a stored
 * row belongs to, what a source is called, and whether it is on this machine.
 */

import { describe, it, expect } from 'vitest';
import type { LocalModelEndpoint } from '../../../shared/local-models/endpoints';
import {
	MODEL_USAGE_SOURCE_KIND_LABELS,
	MODEL_USAGE_SOURCE_KINDS,
	describeModelUsageRequestSplit,
	describeModelUsageSource,
	isModelUsageEmpty,
	modelUsageEndpointSource,
	modelUsageOnDeviceShare,
	modelUsageProviderSource,
	modelUsageRunSource,
	modelUsageSourceLatency,
	type ModelUsage,
	type ModelUsageTotals,
} from '../../../shared/local-models/model-usage';
import { emptyPercentiles } from '../../../shared/percentiles';
import { LOCAL_MODEL_RUN_SOURCE_TYPES } from '../../../shared/stats-types';
import { modelUsageLatency } from '../../helpers/modelUsageFixtures';

const LAN: LocalModelEndpoint = {
	id: 'ep-lan',
	name: 'LM Studio on the workstation',
	kind: 'lmstudio',
	baseUrl: 'http://192.168.1.20:1234',
	enabled: true,
};

const LOOPBACK: LocalModelEndpoint = {
	id: 'ep-local',
	name: 'Ollama',
	kind: 'ollama',
	baseUrl: 'http://127.0.0.1:11434',
	enabled: false,
};

function totals(overrides: Partial<ModelUsageTotals> = {}): ModelUsageTotals {
	return {
		requests: 0,
		otherModelRequests: 0,
		onDeviceRequests: 0,
		errors: 0,
		tokensIn: 0,
		tokensOut: 0,
		onDeviceTokens: 0,
		...overrides,
	};
}

describe('model usage sources', () => {
	it('has a label for every kind, and a kind for every stored source type', () => {
		for (const kind of MODEL_USAGE_SOURCE_KINDS) {
			expect(MODEL_USAGE_SOURCE_KIND_LABELS[kind]).toBeTruthy();
		}
		for (const sourceType of LOCAL_MODEL_RUN_SOURCE_TYPES) {
			expect(modelUsageRunSource(sourceType, 'some-id').kind).toBe(sourceType);
		}
	});

	it('keys the one-of-a-kind sources without an id, and the others by it', () => {
		expect(modelUsageRunSource('local', null)).toEqual({ key: 'local', kind: 'local', id: null });
		// An id on a local or server row is not part of what the source is.
		expect(modelUsageRunSource('server', 'ignored')).toEqual({
			key: 'server',
			kind: 'server',
			id: null,
		});
		expect(modelUsageRunSource('endpoint', 'ep-lan')).toEqual({
			key: 'endpoint:ep-lan',
			kind: 'endpoint',
			id: 'ep-lan',
		});
		expect(modelUsageRunSource('system-one', 'jev-cloud')).toEqual({
			key: 'system-one:jev-cloud',
			kind: 'system-one',
			id: 'jev-cloud',
		});
		expect(modelUsageProviderSource('codex')).toEqual({
			key: 'provider:codex',
			kind: 'provider',
			id: 'codex',
		});
	});

	it('reads the model server id as the server, wherever an endpoint id is stored', () => {
		expect(modelUsageRunSource('endpoint', 'maestro-server').key).toBe('server');
		expect(modelUsageEndpointSource('maestro-server')).toEqual({
			key: 'server',
			kind: 'server',
			id: null,
		});
		expect(modelUsageEndpointSource(null)).toEqual({
			key: 'endpoint:',
			kind: 'endpoint',
			id: null,
		});
	});
});

describe('describeModelUsageSource', () => {
	const names = { endpoints: [LAN, LOOPBACK] };

	it('names the sources that are always on this machine', () => {
		expect(describeModelUsageSource(modelUsageRunSource('local', null))).toEqual({
			label: 'In-process (this machine)',
			onDevice: true,
			endpointKind: null,
		});
		expect(describeModelUsageSource(modelUsageRunSource('server', null))).toEqual({
			label: 'Maestro model server',
			onDevice: true,
			endpointKind: null,
		});
	});

	it('calls an endpoint on this machine only when its URL is a loopback address', () => {
		expect(describeModelUsageSource(modelUsageEndpointSource('ep-local'), names)).toEqual({
			label: 'Ollama',
			onDevice: true,
			endpointKind: 'ollama',
		});
		// A server on the LAN is the user's own, and the work still left this computer.
		expect(describeModelUsageSource(modelUsageEndpointSource('ep-lan'), names)).toEqual({
			label: 'LM Studio on the workstation',
			onDevice: false,
			endpointKind: 'lmstudio',
		});
	});

	it('does not guess where an endpoint that is no longer saved was', () => {
		expect(describeModelUsageSource(modelUsageEndpointSource('ep-gone'), names)).toEqual({
			label: 'Removed endpoint (ep-gone)',
			onDevice: null,
			endpointKind: null,
		});
		expect(describeModelUsageSource(modelUsageEndpointSource(null), names).label).toBe(
			'Unknown endpoint'
		);
	});

	it('names the System One engines, and places OpenJev by its URL', () => {
		const jev = modelUsageRunSource('system-one', 'jev-cloud');
		const openJev = modelUsageRunSource('system-one', 'openjev');

		expect(describeModelUsageSource(jev)).toMatchObject({
			label: 'Jev (TypeSafe cloud)',
			onDevice: false,
		});
		expect(describeModelUsageSource(openJev)).toMatchObject({ label: 'OpenJev', onDevice: null });
		expect(
			describeModelUsageSource(openJev, { openJevUrl: 'http://localhost:8080' })
		).toMatchObject({ label: 'OpenJev at localhost:8080', onDevice: true });
		expect(
			describeModelUsageSource(openJev, { openJevUrl: 'https://jev.example.com' })
		).toMatchObject({ label: 'OpenJev at jev.example.com', onDevice: false });
		// An engine a later build added reads as its id, never as another engine.
		expect(describeModelUsageSource(modelUsageRunSource('system-one', 'jev-next'))).toMatchObject({
			label: 'jev-next',
			onDevice: null,
		});
		expect(describeModelUsageSource(modelUsageRunSource('system-one', null)).label).toBe(
			'System One'
		);
	});

	it('names a provider by its display name, and an unknown one by its id', () => {
		expect(describeModelUsageSource(modelUsageProviderSource('claude-code'))).toEqual({
			label: 'Claude Code',
			onDevice: false,
			endpointKind: null,
		});
		expect(describeModelUsageSource(modelUsageProviderSource('some-new-cli')).label).toBe(
			'some-new-cli'
		);
	});
});

describe('model usage summaries', () => {
	it("says how a source's requests split, each in its own unit", () => {
		expect(describeModelUsageRequestSplit({ runs: 36, turns: 4, routed: 1 })).toBe(
			'36 runs, 4 turns, 1 routed'
		);
		expect(describeModelUsageRequestSplit({ runs: 1, turns: 1, routed: 0 })).toBe('1 run, 1 turn');
		expect(describeModelUsageRequestSplit({ runs: 0, turns: 40, routed: 0 })).toBe('40 turns');
		expect(describeModelUsageRequestSplit({ runs: 0, turns: 0, routed: 0 })).toBe('');
	});

	it("reads a source's latency from its requests, and from its turns only when it has no request", () => {
		const requests = modelUsageLatency(240, 1200);
		const turns = modelUsageLatency(60_000, 240_000, 4);

		// A source that answered requests and also ran turns reads the requests.
		expect(modelUsageSourceLatency({ latency: requests, turnDuration: turns })).toEqual({
			unit: 'request',
			distribution: requests,
		});
		// A provider's own cloud, or a Run on target with no housekeeping work.
		expect(modelUsageSourceLatency({ latency: emptyPercentiles(), turnDuration: turns })).toEqual({
			unit: 'turn',
			distribution: turns,
		});
		expect(
			modelUsageSourceLatency({ latency: emptyPercentiles(), turnDuration: emptyPercentiles() })
		).toBeNull();
	});

	it('reads the on-device share as a fraction, and 0 with no request', () => {
		expect(modelUsageOnDeviceShare(totals())).toBe(0);
		expect(modelUsageOnDeviceShare(totals({ requests: 8, onDeviceRequests: 2 }))).toBe(0.25);
	});

	it('calls a range empty unless another model, System One or the proxy did something', () => {
		const usage = (overrides: {
			otherModelRequests?: number;
			decisions?: number;
			proxyRequests?: number;
		}): ModelUsage =>
			({
				totals: totals({ requests: 40, otherModelRequests: overrides.otherModelRequests ?? 0 }),
				systemOne: { decisions: overrides.decisions ?? 0 },
				proxy: { totals: { requests: overrides.proxyRequests ?? 0 } },
			}) as ModelUsage;

		// Forty turns on the providers' own cloud are not what the tab is for.
		expect(isModelUsageEmpty(usage({}))).toBe(true);
		expect(isModelUsageEmpty(usage({ otherModelRequests: 1 }))).toBe(false);
		expect(isModelUsageEmpty(usage({ decisions: 1 }))).toBe(false);
		expect(isModelUsageEmpty(usage({ proxyRequests: 1 }))).toBe(false);
	});
});
