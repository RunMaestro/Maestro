/**
 * Tests for the renderer-side TTSR rule service.
 *
 * The only real logic here is the authoring hand-off: rule files are markdown
 * and the agent already writes files, so authoring is a prompt, not a
 * generation pipeline. What matters is that the brief actually reaches the
 * agent with the user's request and the rules directory filled in - and that a
 * missing prompt file degrades to something still usable.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { buildRuleAuthoringPrompt, isTtsrRuleApiAvailable } from '../../../renderer/services/ttsr';
import { TTSR_RULES_DIR } from '../../../shared/maestro-paths';

const TEMPLATE = [
	'# Authoring a rule',
	'Write files under `{{TTSR_RULES_DIR}}/`.',
	'Scopes: text, thinking, tool:edit, tool:write, tool:bash.',
	'',
	'## The request',
	'',
	'{{USER_REQUEST}}',
].join('\n');

beforeEach(() => {
	vi.clearAllMocks();
	window.maestro.prompts.get = vi.fn().mockResolvedValue({ success: true, content: TEMPLATE });
});

describe('buildRuleAuthoringPrompt', () => {
	it('folds the request and the rules directory into the brief', async () => {
		const prompt = await buildRuleAuthoringPrompt('stop you force-pushing to main');

		expect(prompt).toContain(`${TTSR_RULES_DIR}/`);
		expect(prompt).toContain('stop you force-pushing to main');
		// No placeholder may survive into what the agent actually reads.
		expect(prompt).not.toContain('{{');
	});

	it('trims the request so a stray newline does not land in the prompt', async () => {
		const prompt = await buildRuleAuthoringPrompt('  no console.log  \n');

		expect(prompt.endsWith('no console.log')).toBe(true);
	});

	it('replaces every occurrence of a placeholder, not just the first', async () => {
		window.maestro.prompts.get = vi.fn().mockResolvedValue({
			success: true,
			content: '{{TTSR_RULES_DIR}} and again {{TTSR_RULES_DIR}}: {{USER_REQUEST}}',
		});

		const prompt = await buildRuleAuthoringPrompt('x');

		expect(prompt).toBe(`${TTSR_RULES_DIR} and again ${TTSR_RULES_DIR}: x`);
	});

	it('falls back to an inline brief when the prompt file is unavailable', async () => {
		window.maestro.prompts.get = vi.fn().mockResolvedValue({ success: false, error: 'missing' });

		const prompt = await buildRuleAuthoringPrompt('stop you force-pushing');

		// Still teaches the schema and still carries the request: a broken install
		// should degrade, not hand the agent an empty instruction.
		expect(prompt).toContain(TTSR_RULES_DIR);
		expect(prompt).toContain('tool:bash');
		expect(prompt).toContain('stop you force-pushing');
	});

	it('falls back when the prompt lookup throws', async () => {
		window.maestro.prompts.get = vi.fn().mockRejectedValue(new Error('bridge gone'));

		await expect(buildRuleAuthoringPrompt('x')).resolves.toContain(TTSR_RULES_DIR);
	});
});

describe('isTtsrRuleApiAvailable', () => {
	it('is true when the preload exposes rule management', () => {
		expect(isTtsrRuleApiAvailable()).toBe(true);
	});

	it('is false on a preload without it, so the panel can degrade', () => {
		const original = window.maestro.ttsr;
		// @ts-expect-error - deliberately simulating an older preload
		window.maestro.ttsr = { onTriggered: vi.fn() };

		expect(isTtsrRuleApiAvailable()).toBe(false);

		window.maestro.ttsr = original;
	});
});
