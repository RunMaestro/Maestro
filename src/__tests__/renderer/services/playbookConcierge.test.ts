/**
 * playbookConcierge service: the prompt template fill, the JSON contract
 * parse, and that turns go through the shared wizard loop with the
 * concierge's own suffix and parser.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const sendWizardMessage = vi.fn();
vi.mock('../../../renderer/services/inlineWizardConversation', async (importActual) => {
	const actual =
		await importActual<typeof import('../../../renderer/services/inlineWizardConversation')>();
	return { ...actual, sendWizardMessage: (...args: unknown[]) => sendWizardMessage(...args) };
});

import {
	buildPlaybookConciergePrompt,
	loadPlaybookConciergePrompt,
	parsePlaybookConciergeResponse,
	sendPlaybookConciergeMessage,
	startPlaybookConcierge,
	type PlaybookConciergeContext,
} from '../../../renderer/services/playbookConcierge';
import type { PlaybookParamSpec } from '../../../shared/playbookParams';

const SPECS: PlaybookParamSpec[] = [
	{ name: 'PR_URL', type: 'url', required: true, source: 'overlay' },
	{ name: 'TEST_COMMAND', type: 'string', required: true, source: 'prose' },
	{ name: 'MAX_ITEMS', type: 'number', required: false, default: '25', source: 'both' },
];
const OPEN = new Set(['PR_URL', 'TEST_COMMAND']);

function context(overrides: Partial<PlaybookConciergeContext> = {}): PlaybookConciergeContext {
	return {
		title: 'Review a PR',
		readme: 'Reviews the open PR.',
		specs: SPECS,
		facts: null,
		stored: {},
		factProposals: {
			PR_URL: { value: 'https://github.com/acme/app/pull/7', evidence: 'Open pull request' },
		},
		open: ['PR_URL', 'TEST_COMMAND'],
		questionCap: 2,
		...overrides,
	};
}

describe('buildPlaybookConciergePrompt', () => {
	it('fills every token from the context', () => {
		const prompt = buildPlaybookConciergePrompt(
			'T={{PLAYBOOK_TITLE}}|R={{PLAYBOOK_README}}|O={{OPEN_PARAMETERS}}|Q={{QUESTION_CAP}}|C={{READY_CONFIDENCE_THRESHOLD}}|K={{KNOWN_VALUES_JSON}}|S={{PARAMETER_SPECS_JSON}}|F={{FACTS_JSON}}',
			context({ stored: { TEST_COMMAND: 'npm test' } })
		);
		expect(prompt).toContain(
			'T=Review a PR|R=Reviews the open PR.|O=PR_URL, TEST_COMMAND|Q=2|C=80'
		);
		const known = JSON.parse(prompt.split('|K=')[1].split('|S=')[0]);
		expect(known).toEqual({
			PR_URL: {
				value: 'https://github.com/acme/app/pull/7',
				source: 'detected',
				evidence: 'Open pull request',
			},
			TEST_COMMAND: { value: 'npm test', source: 'user' },
			MAX_ITEMS: { value: '25', source: 'default' },
		});
		const specs = JSON.parse(prompt.split('|S=')[1].split('|F=')[0]);
		expect(specs[0]).toEqual({ name: 'PR_URL', type: 'url', required: true, open: true });
		expect(specs[2].open).toBe(false);
		expect(prompt).toContain('F={\n  "unavailable": true\n}');
	});

	it('inserts a README literally, so its own tokens are never substituted', () => {
		const prompt = buildPlaybookConciergePrompt(
			'{{PLAYBOOK_README}} / {{UNKNOWN_TOKEN}}',
			context({ readme: 'Use {{QUESTION_CAP}} and {{AGENT_PATH}}' })
		);
		expect(prompt).toBe('Use {{QUESTION_CAP}} and {{AGENT_PATH}} / {{UNKNOWN_TOKEN}}');
	});

	it('says so when there is no README', () => {
		expect(buildPlaybookConciergePrompt('{{PLAYBOOK_README}}', context({ readme: null }))).toBe(
			'(This playbook has no README.)'
		);
	});
});

describe('parsePlaybookConciergeResponse', () => {
	it('reads the wizard fields and the filtered parameters', () => {
		const reply = JSON.stringify({
			confidence: 85,
			ready: true,
			message: 'All set.',
			parameters: [
				{ name: 'TEST_COMMAND', value: 'npm test', source: 'detected', confidence: 90 },
				{ name: 'MAX_ITEMS', value: '10', source: 'asked', confidence: 90 },
			],
		});
		expect(parsePlaybookConciergeResponse(reply, false, SPECS, OPEN)).toEqual({
			confidence: 85,
			ready: true,
			message: 'All set.',
			parameters: [{ name: 'TEST_COMMAND', value: 'npm test', source: 'detected', confidence: 90 }],
		});
	});

	it('applies the ready threshold', () => {
		const reply = '{"confidence": 40, "ready": true, "message": "Hm.", "parameters": []}';
		expect(parsePlaybookConciergeResponse(reply, false, SPECS, OPEN)?.ready).toBe(false);
	});

	it('reads JSON inside a code fence', () => {
		const reply =
			'Here:\n```json\n{"confidence": 50, "ready": false, "message": "Which command?", "parameters": [{"name": "PR_URL", "value": "https://github.com/acme/app/pull/9"}]}\n```';
		const parsed = parsePlaybookConciergeResponse(reply, false, SPECS, OPEN);
		expect(parsed?.message).toBe('Which command?');
		expect(parsed?.parameters.map((p) => p.name)).toEqual(['PR_URL']);
	});

	it('treats plain text as a message with no proposals, unless structure is required', () => {
		const parsed = parsePlaybookConciergeResponse('Which test command?', false, SPECS, OPEN);
		expect(parsed?.message).toBe('Which test command?');
		expect(parsed?.parameters).toEqual([]);
		expect(parsePlaybookConciergeResponse('Which test command?', true, SPECS, OPEN)).toBeNull();
	});
});

describe('turns', () => {
	beforeEach(() => {
		sendWizardMessage.mockReset();
		sendWizardMessage.mockResolvedValue({ success: true });
	});

	it('loads the editable prompt by id', async () => {
		const get = window.maestro.prompts.get as ReturnType<typeof vi.fn>;
		get.mockResolvedValueOnce({ success: true, content: 'CONCIERGE' });
		await expect(loadPlaybookConciergePrompt(true)).resolves.toBe('CONCIERGE');
		expect(get).toHaveBeenCalledWith('playbook-concierge');
	});

	it('opens a concierge session and sends through the wizard loop with its own contract', async () => {
		const conversation = startPlaybookConcierge(
			{ agentType: 'claude-code', directoryPath: '/repo', projectName: 'Repo' },
			'Title: {{PLAYBOOK_TITLE}}',
			context()
		);
		expect(conversation.session.sessionId).toMatch(/^playbook-concierge-/);
		expect(conversation.session.systemPrompt).toBe('Title: Review a PR');
		expect(conversation.questionCap).toBe(2);

		await sendPlaybookConciergeMessage(conversation, 'hello', []);
		const [session, message, history, , options] = sendWizardMessage.mock.calls[0];
		expect(session).toBe(conversation.session);
		expect(message).toBe('hello');
		expect(history).toEqual([]);
		expect(options.structuredOutputSuffix).toContain('"parameters"');
		const parsed = options.parseResponse(
			'{"confidence": 90, "ready": true, "message": "ok", "parameters": [{"name": "TEST_COMMAND", "value": "npm test"}]}',
			false
		);
		expect(parsed.parameters).toEqual([
			{ name: 'TEST_COMMAND', value: 'npm test', source: 'asked', confidence: 50 },
		]);
	});
});
