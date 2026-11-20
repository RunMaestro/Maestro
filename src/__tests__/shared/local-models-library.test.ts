/**
 * @file local-models-library.test.ts
 *
 * How the Library lists models: in sections (the tabs of Settings > Models >
 * Library), and inside a section one group per model, by what it is for, with
 * its other roles as badges. Settings and `maestro-cli models list` both group
 * through this module.
 */

import { describe, it, expect } from 'vitest';

import {
	BGE_SMALL_EN_ID,
	GEMMA_4_12B_ID,
	GEMMA_4_E4B_ID,
	GPT_OSS_20B_ID,
	GPT_OSS_120B_ID,
	LOCAL_MODEL_CATALOG,
	LOCAL_MODEL_KIND_LABELS,
	QWEN3_1_7B_ID,
	QWEN3_5_9B_ID,
	QWEN3_CODER_30B_A3B_ID,
	getLocalModel,
	PARAKEET_TDT_V2_ID,
	WHISPER_BASE_EN_ID,
} from '../../shared/local-models/model-catalog';
import {
	CLOUD_ONLY_MODELS,
	CLOUD_ONLY_NOTE,
	LOCAL_MODEL_LIBRARY_GROUPS,
	LOCAL_MODEL_LIBRARY_SECTIONS,
	LOCAL_MODEL_LIBRARY_SECTION_IDS,
	LOCAL_MODEL_ROLE_LABELS,
	groupLocalModelsForLibrary,
	localModelLibraryGroup,
	localModelLibrarySection,
	localModelRoleBadges,
	recommendedLocalModelsForHardware,
} from '../../shared/local-models/library';
import {
	modelFit,
	RAM_SYSTEM_HEADROOM_BYTES,
	type HardwareProfile,
} from '../../shared/local-models/model-fit';
import { userLocalModelEntry } from '../../shared/local-models/user-models';

const USER_ENTRY = userLocalModelEntry({
	id: 'hf-someone-model-q4_k_m',
	displayName: 'model-Q4_K_M',
	repo: 'someone/model-GGUF',
	revision: '0'.repeat(40),
	license: { spdx: 'mit', url: 'https://huggingface.co/someone/model-GGUF' },
	files: [{ path: 'model-Q4_K_M.gguf', sha256: 'a'.repeat(64), bytes: 1_000_000_000 }],
	parametersB: 1.5,
	contextLength: 8192,
	addedAt: 0,
});

describe('hardware recommendations', () => {
	const mac: HardwareProfile = {
		platform: 'darwin',
		arch: 'arm64',
		totalMemoryBytes: 128 * 1024 ** 3,
		unifiedMemory: true,
		gpus: [],
	};

	it('chooses the preferred agent that comfortably fits, independent of catalog order', () => {
		const entries = [getLocalModel(GPT_OSS_20B_ID)!, getLocalModel(GPT_OSS_120B_ID)!];
		expect(Object.keys(recommendedLocalModelsForHardware(entries, mac))).toEqual([GPT_OSS_120B_ID]);
		expect(
			Object.keys(
				recommendedLocalModelsForHardware(entries, { ...mac, totalMemoryBytes: 32 * 1024 ** 3 })
			)
		).toEqual([GPT_OSS_20B_ID]);
	});

	it('falls back to the smaller recognizer when Parakeet exceeds the memory budget', () => {
		const whisper = getLocalModel(WHISPER_BASE_EN_ID)!;
		const profile = { ...mac, totalMemoryBytes: RAM_SYSTEM_HEADROOM_BYTES + whisper.bytes };
		const picks = recommendedLocalModelsForHardware(
			[getLocalModel(PARAKEET_TDT_V2_ID)!, whisper],
			profile
		);
		expect(Object.keys(picks)).toEqual([WHISPER_BASE_EN_ID]);
	});

	it('never recommends tight, oversized, pending or user-added models, or guesses without hardware', () => {
		expect(recommendedLocalModelsForHardware(LOCAL_MODEL_CATALOG, null)).toEqual({});
		const cpu = { ...mac, unifiedMemory: false };
		const picks = recommendedLocalModelsForHardware(LOCAL_MODEL_CATALOG, cpu);
		for (const id of Object.keys(picks)) {
			expect(modelFit(getLocalModel(id)!, cpu).fit).toBe('fits');
			expect(getLocalModel(id)!.kind).not.toBe('text-gen');
		}
		const agent = getLocalModel(GPT_OSS_120B_ID)!;
		expect(recommendedLocalModelsForHardware([{ ...agent, pending: 'Unavailable' }], mac)).toEqual(
			{}
		);
		expect(recommendedLocalModelsForHardware([{ ...agent, userAdded: true }], mac)).toEqual({});
		expect(recommendedLocalModelsForHardware([USER_ENTRY], mac)).toEqual({});
	});

	it('offers at most one pick per Library group and leaves complementary wake-word parts alone', () => {
		const groups = Object.keys(recommendedLocalModelsForHardware(LOCAL_MODEL_CATALOG, mac)).map(
			(id) => localModelLibraryGroup(getLocalModel(id)!)
		);
		expect(new Set(groups).size).toBe(groups.length);
		expect(groups).not.toContain('wake-word');
	});
});

describe('Library sections', () => {
	it('lists six sections, engines first because nothing runs without one', () => {
		expect(LOCAL_MODEL_LIBRARY_SECTION_IDS).toEqual([
			'engines',
			'agents',
			'housekeeping',
			'speech',
			'search',
			'custom',
		]);
		expect(LOCAL_MODEL_LIBRARY_SECTIONS.agents.label).toBe('Agent Models');
		expect(LOCAL_MODEL_LIBRARY_SECTIONS.search.label).toBe('Search & Safety');
		for (const id of LOCAL_MODEL_LIBRARY_SECTION_IDS) {
			const section = LOCAL_MODEL_LIBRARY_SECTIONS[id];
			expect(section.id).toBe(id);
			expect(section.label.length).toBeGreaterThan(0);
			expect(section.description).toMatch(/\.$/);
		}
		// Engines lists no model; every other section lists at least one group.
		expect(LOCAL_MODEL_LIBRARY_SECTIONS.engines.groups).toEqual([]);
		expect(LOCAL_MODEL_LIBRARY_SECTIONS.engines.description).toContain('inside Maestro');
		expect(LOCAL_MODEL_LIBRARY_SECTIONS.engines.description).toContain(
			'llama-server, installed separately in Models > Sources'
		);
	});

	it('files every group in exactly one section', () => {
		for (const group of LOCAL_MODEL_LIBRARY_GROUPS) {
			const holders = LOCAL_MODEL_LIBRARY_SECTION_IDS.filter((id) =>
				(LOCAL_MODEL_LIBRARY_SECTIONS[id].groups as readonly string[]).includes(group.id)
			);
			expect(holders, group.id).toEqual([group.section]);
		}
		expect(LOCAL_MODEL_LIBRARY_SECTIONS.speech.groups).toEqual(['stt', 'tts', 'wake-word']);
		expect(LOCAL_MODEL_LIBRARY_SECTIONS.search.groups).toEqual(['embedding', 'classifier']);
	});

	it('names the section a model is listed on', () => {
		const sectionOf = (id: string) => localModelLibrarySection(getLocalModel(id)!);
		expect(sectionOf(GPT_OSS_20B_ID)).toBe('agents');
		expect(sectionOf(QWEN3_1_7B_ID)).toBe('housekeeping');
		expect(sectionOf(GEMMA_4_12B_ID)).toBe('housekeeping');
		expect(sectionOf(BGE_SMALL_EN_ID)).toBe('search');
		expect(localModelLibrarySection(USER_ENTRY)).toBe('custom');
	});

	it('groups only the named section when one is asked for', () => {
		const groups = groupLocalModelsForLibrary(
			[...LOCAL_MODEL_CATALOG, USER_ENTRY],
			(e) => e,
			'speech'
		);
		expect(groups.map((group) => group.group.id)).toEqual(['stt', 'tts', 'wake-word']);
		expect(groupLocalModelsForLibrary(LOCAL_MODEL_CATALOG, (e) => e, 'engines')).toEqual([]);
	});
});

describe('Library groups', () => {
	it('lists the two text groups first, then the user group, then every non-text kind', () => {
		expect(LOCAL_MODEL_LIBRARY_GROUPS.map((group) => group.id)).toEqual([
			'agent',
			'housekeeping',
			'user',
			'embedding',
			'classifier',
			'stt',
			'tts',
			'wake-word',
		]);
		for (const group of LOCAL_MODEL_LIBRARY_GROUPS) {
			expect(group.label.length).toBeGreaterThan(0);
			// A kind group's line is the tasks that use it, built where it is drawn.
			if (group.kind) expect(group.label).toBe(LOCAL_MODEL_KIND_LABELS[group.kind]);
			else expect(group.description).toMatch(/\.$/);
		}
	});

	it('lists a text model once: with the agents if it qualified, else under housekeeping', () => {
		const groupOf = (id: string) => localModelLibraryGroup(getLocalModel(id)!);
		expect(groupOf(GPT_OSS_20B_ID)).toBe('agent');
		// An agent that also reads images is still listed with the agents.
		expect(groupOf(GEMMA_4_E4B_ID)).toBe('agent');
		// A judge or a vision model is a housekeeping model; the role is a badge.
		expect(groupOf(GEMMA_4_12B_ID)).toBe('housekeeping');
		expect(groupOf(QWEN3_1_7B_ID)).toBe('housekeeping');
		expect(groupOf(QWEN3_5_9B_ID)).toBe('housekeeping');
		expect(groupOf(BGE_SMALL_EN_ID)).toBe('embedding');
		expect(localModelLibraryGroup(USER_ENTRY)).toBe('user');
	});

	it('groups every model exactly once, in group order, and drops empty groups', () => {
		const groups = groupLocalModelsForLibrary([...LOCAL_MODEL_CATALOG, USER_ENTRY], (e) => e);
		const ids = groups.flatMap((group) => group.items.map((entry) => entry.id));
		expect(ids).toHaveLength(LOCAL_MODEL_CATALOG.length + 1);
		expect(new Set(ids).size).toBe(ids.length);
		const order = LOCAL_MODEL_LIBRARY_GROUPS.map((group) => group.id);
		const seen = groups.map((group) => group.group.id);
		expect(seen).toEqual(order.filter((id) => seen.includes(id)));
		// Both text groups have a model today, so both are drawn.
		expect(seen).toContain('agent');
		expect(seen).toContain('housekeeping');
		expect(groupLocalModelsForLibrary([], (e: typeof USER_ENTRY) => e)).toEqual([]);
		// Within a group the catalog order is kept.
		const agents = groups.find((group) => group.group.id === 'agent')!.items;
		const catalogOrder = LOCAL_MODEL_CATALOG.filter((e) => e.roles?.includes('agent'));
		expect(agents).toEqual(catalogOrder);
	});

	it('badges every role, and names the harnesses an agent model passed', () => {
		expect(localModelRoleBadges(getLocalModel(GPT_OSS_20B_ID)!)).toEqual([
			'Agent-ready: Claude Code, Codex',
			LOCAL_MODEL_ROLE_LABELS.housekeeping,
		]);
		expect(localModelRoleBadges(getLocalModel(QWEN3_CODER_30B_A3B_ID)!)[0]).toBe(
			'Agent-ready: Claude Code'
		);
		// The judge role survives as a badge on a housekeeping row.
		expect(localModelRoleBadges(getLocalModel(QWEN3_1_7B_ID)!)).toContain(
			LOCAL_MODEL_ROLE_LABELS.judge
		);
		expect(localModelRoleBadges(getLocalModel(GEMMA_4_12B_ID)!)).toEqual([
			LOCAL_MODEL_ROLE_LABELS.housekeeping,
			LOCAL_MODEL_ROLE_LABELS.vision,
		]);
		// Nothing was measured for a model the user added, or for a non-text model.
		expect(localModelRoleBadges(USER_ENTRY)).toEqual([]);
		expect(localModelRoleBadges(getLocalModel(BGE_SMALL_EN_ID)!)).toEqual([]);
	});

	it('names the cloud-only models in one sentence that claims no protocol', () => {
		expect(CLOUD_ONLY_MODELS).toEqual(['DeepSeek V4', 'Kimi K3', 'Kimi K2.7 Code', 'GLM-5.3']);
		for (const name of CLOUD_ONLY_MODELS) expect(CLOUD_ONLY_NOTE).toContain(name);
		expect(CLOUD_ONLY_NOTE).toContain('with your own key');
		expect(CLOUD_ONLY_NOTE).not.toMatch(/openai|compatible|anthropic/i);
	});
});
