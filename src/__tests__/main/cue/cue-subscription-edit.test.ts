/**
 * Tests for in-place subscription edits. Everything runs against a real temp
 * project root so the YAML round-trip is asserted on disk.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as yaml from 'js-yaml';

vi.mock('../../../main/utils/sentry', () => ({
	captureException: vi.fn(),
}));

import {
	findSubscriptionsByName,
	patchSubscriptionInYaml,
	setSubscriptionTurnSettings,
} from '../../../main/cue/cue-subscription-edit';

const HEADER = '# Pipeline: Review (color: #06b6d4)\n\n';

function writeCueYaml(projectRoot: string, subscriptions: Record<string, unknown>[]): void {
	fs.mkdirSync(path.join(projectRoot, '.maestro'), { recursive: true });
	fs.writeFileSync(
		path.join(projectRoot, '.maestro', 'cue.yaml'),
		HEADER + yaml.dump({ subscriptions })
	);
}

function readCueYaml(projectRoot: string): { raw: string; subs: Record<string, unknown>[] } {
	const raw = fs.readFileSync(path.join(projectRoot, '.maestro', 'cue.yaml'), 'utf-8');
	const parsed = yaml.load(raw) as { subscriptions: Record<string, unknown>[] };
	return { raw, subs: parsed.subscriptions };
}

const review = {
	name: 'review',
	event: 'github.pull_request',
	enabled: true,
	prompt: 'Review {{CUE_GH_URL}}',
	agent_id: 'agent-alpha',
};
const deploy = {
	name: 'deploy',
	event: 'agent.completed',
	enabled: true,
	source_session: 'Alpha',
	source_sub: 'review',
	action: 'command',
	command: { mode: 'shell', shell: 'echo done' },
	agent_id: 'agent-alpha',
};

describe('cue-subscription-edit', () => {
	let projectRoot = '';

	beforeEach(() => {
		projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-sub-edit-'));
	});

	afterEach(() => {
		if (projectRoot && fs.existsSync(projectRoot)) {
			fs.rmSync(projectRoot, { recursive: true, force: true });
		}
	});

	describe('setSubscriptionTurnSettings', () => {
		it('writes tier and effort onto a non-scheduled subscription and keeps the header', async () => {
			writeCueYaml(projectRoot, [review, deploy]);

			const result = await setSubscriptionTurnSettings(projectRoot, 'review', {
				tier: 'high',
				effort: 'low',
			});

			expect(result).toEqual({ updated: true });
			const { raw, subs } = readCueYaml(projectRoot);
			expect(raw.startsWith(HEADER)).toBe(true);
			expect(subs[0]).toMatchObject({ name: 'review', tier: 'high', effort: 'low' });
			// The sibling subscription is untouched.
			expect(subs[1]).toEqual(deploy);
		});

		it('replaces a tier with an exact model, then clears back to the agent default', async () => {
			writeCueYaml(projectRoot, [{ ...review, tier: 'high', effort: 'low' }]);

			await setSubscriptionTurnSettings(projectRoot, 'review', { model: 'claude-opus-4-7' });
			expect(readCueYaml(projectRoot).subs[0]).toMatchObject({
				model: 'claude-opus-4-7',
				effort: 'low',
			});
			expect(readCueYaml(projectRoot).subs[0]).not.toHaveProperty('tier');

			await setSubscriptionTurnSettings(projectRoot, 'review', {
				tier: null,
				model: null,
				effort: null,
			});
			expect(readCueYaml(projectRoot).subs[0]).toEqual(review);
		});

		it('refuses a command subscription and leaves the file byte-for-byte alone', async () => {
			writeCueYaml(projectRoot, [review, deploy]);
			const before = readCueYaml(projectRoot).raw;

			const result = await setSubscriptionTurnSettings(projectRoot, 'deploy', { tier: 'high' });

			expect(result.updated).toBe(false);
			expect(result.reason).toMatch(/action "command"/);
			expect(readCueYaml(projectRoot).raw).toBe(before);
		});

		it('reports a missing subscription and a missing cue.yaml', async () => {
			expect(await setSubscriptionTurnSettings(projectRoot, 'review', { tier: 'low' })).toEqual({
				updated: false,
				reason: 'cue.yaml not found',
			});
			writeCueYaml(projectRoot, [review]);
			expect(await setSubscriptionTurnSettings(projectRoot, 'ghost', { tier: 'low' })).toEqual({
				updated: false,
				reason: 'subscription "ghost" not found',
			});
		});
	});

	describe('patchSubscriptionInYaml', () => {
		it('writes nothing when the mutation refuses', async () => {
			writeCueYaml(projectRoot, [review]);
			const before = readCueYaml(projectRoot).raw;

			const result = await patchSubscriptionInYaml(projectRoot, 'review', (target) => {
				target.prompt = 'changed';
				return 'nope';
			});

			expect(result).toEqual({ updated: false, reason: 'nope' });
			expect(readCueYaml(projectRoot).raw).toBe(before);
		});
	});

	describe('findSubscriptionsByName', () => {
		it('reads a cue.yaml shared by two agents once and credits the agent that runs the sub', () => {
			writeCueYaml(projectRoot, [{ ...review, agent_id: 'agent-bravo', tier: 'low' }]);
			const agents = [
				{ id: 'agent-alpha', name: 'Alpha', projectRoot },
				{ id: 'agent-bravo', name: 'Bravo', projectRoot },
			];

			const { matches, warnings } = findSubscriptionsByName(agents, 'review');

			expect(warnings).toEqual([]);
			expect(matches).toHaveLength(1);
			expect(matches[0].agent.id).toBe('agent-bravo');
			expect(matches[0].projectRoot).toBe(projectRoot);
			expect(matches[0].turnSettings).toEqual({ tier: 'low' });
		});

		it('finds the same name on two agents with separate project roots', () => {
			const otherRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-sub-edit-b-'));
			try {
				writeCueYaml(projectRoot, [review]);
				writeCueYaml(otherRoot, [{ ...review, agent_id: 'agent-bravo' }]);

				const { matches } = findSubscriptionsByName(
					[
						{ id: 'agent-alpha', name: 'Alpha', projectRoot },
						{ id: 'agent-bravo', name: 'Bravo', projectRoot: otherRoot },
					],
					'review'
				);

				expect(matches.map((m) => m.agent.id)).toEqual(['agent-alpha', 'agent-bravo']);
			} finally {
				fs.rmSync(otherRoot, { recursive: true, force: true });
			}
		});

		it('skips an agent with no cue.yaml and warns about one that does not parse', () => {
			const brokenRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-sub-edit-c-'));
			try {
				fs.mkdirSync(path.join(brokenRoot, '.maestro'), { recursive: true });
				fs.writeFileSync(path.join(brokenRoot, '.maestro', 'cue.yaml'), 'subscriptions: [\n');

				const { matches, warnings } = findSubscriptionsByName(
					[
						{ id: 'agent-alpha', name: 'Alpha', projectRoot },
						{ id: 'agent-bravo', name: 'Bravo', projectRoot: brokenRoot },
					],
					'review'
				);

				expect(matches).toEqual([]);
				expect(warnings).toHaveLength(1);
				expect(warnings[0]).toMatch(/Bravo/);
			} finally {
				fs.rmSync(brokenRoot, { recursive: true, force: true });
			}
		});
	});
});
