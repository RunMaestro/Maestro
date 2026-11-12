/**
 * @file pianola-classifier.test.ts
 * @description Unit tests for the pure Pianola classifier.
 */

import { describe, it, expect } from 'vitest';
import { classifyMessages, riskAtMost, maxRisk } from '../../../shared/pianola/pianola-classifier';
import { decide } from '../../../shared/pianola/pianola-policy';
import type {
	AwaitingInputSignal,
	PianolaMessage,
	PianolaRule,
} from '../../../shared/pianola/types';

let seq = 0;
function msg(
	role: PianolaMessage['role'],
	content: string,
	awaitingInput?: AwaitingInputSignal
): PianolaMessage {
	seq += 1;
	return {
		id: `m${seq}`,
		role,
		source: role === 'assistant' ? 'ai' : role,
		content,
		timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString(),
		awaitingInput,
	};
}

describe('risk helpers', () => {
	it('orders risk low < medium < high', () => {
		expect(riskAtMost('low', 'high')).toBe(true);
		expect(riskAtMost('high', 'low')).toBe(false);
		expect(riskAtMost('medium', 'medium')).toBe(true);
		expect(maxRisk('low', 'high')).toBe('high');
		expect(maxRisk('medium', 'low')).toBe('medium');
	});
});

describe('classifyMessages - edge cases', () => {
	it('returns none for an empty transcript', () => {
		expect(classifyMessages([]).kind).toBe('none');
	});

	it('returns none when there is no assistant message', () => {
		const c = classifyMessages([msg('user', 'hello?'), msg('tool', 'ran something')]);
		expect(c.kind).toBe('none');
	});

	it('returns none when the user already replied after the assistant asked', () => {
		const c = classifyMessages([
			msg('assistant', 'Which database should I use?'),
			msg('user', 'postgres'),
		]);
		expect(c.kind).toBe('none');
		expect(c.evidence.reason).toContain('user has replied');
	});
});

describe('classifyMessages - structured signal (authoritative)', () => {
	it('treats a permission signal as blocked, at least medium risk, high confidence', () => {
		const signal: AwaitingInputSignal = { kind: 'permission', prompt: 'Allow reading config.ts?' };
		const c = classifyMessages([msg('assistant', 'May I?', signal)]);
		expect(c.kind).toBe('blocked');
		expect(c.confidence).toBe('high');
		expect(c.evidence.structured).toBe(true);
		expect(riskAtMost('medium', c.risk)).toBe(true); // medium or higher
	});

	it('escalates structured permission for a destructive action to high risk', () => {
		const signal: AwaitingInputSignal = {
			kind: 'permission',
			prompt: 'Allow running rm -rf build to delete the output?',
		};
		const c = classifyMessages([msg('assistant', 'ok?', signal)]);
		expect(c.risk).toBe('high');
	});

	it('maps a question signal to kind question', () => {
		const signal: AwaitingInputSignal = { kind: 'question', prompt: 'What name do you want?' };
		const c = classifyMessages([msg('assistant', '...', signal)]);
		expect(c.kind).toBe('question');
		expect(c.confidence).toBe('high');
	});
});

describe('classifyMessages - heuristics', () => {
	it('detects a question phrase with medium confidence', () => {
		const c = classifyMessages([msg('assistant', 'Should I use tabs or spaces for the new file?')]);
		expect(c.kind).toBe('question');
		expect(c.confidence).toBe('medium');
		expect(c.evidence.structured).toBe(false);
		expect(c.topic.length).toBeGreaterThan(0);
	});

	it('detects an explicit choice marker', () => {
		const c = classifyMessages([msg('assistant', 'Proceed with the rename? [y/n]')]);
		expect(c.kind).toBe('question');
		expect(c.confidence).toBe('medium');
	});

	it('detects a blocked phrase', () => {
		const c = classifyMessages([msg('assistant', 'I am blocked: I need the API key to continue.')]);
		expect(c.kind).toBe('blocked');
	});

	it('treats a trailing question mark alone as low-confidence question', () => {
		const c = classifyMessages([msg('assistant', 'That file looks odd, right?')]);
		expect(c.kind).toBe('question');
		expect(c.confidence).toBe('low');
	});

	it('returns none for a plain statement', () => {
		const c = classifyMessages([msg('assistant', 'I finished updating the README.')]);
		expect(c.kind).toBe('none');
	});
});

describe('classifyMessages - risk rating', () => {
	it('rates destructive prompts high', () => {
		const c = classifyMessages([
			msg('assistant', 'Should I force push to production and drop the old table?'),
		]);
		expect(c.risk).toBe('high');
	});

	it('rates dependency changes medium', () => {
		const c = classifyMessages([msg('assistant', 'Should I upgrade the react dependency?')]);
		expect(c.risk).toBe('medium');
	});

	it('rates a cosmetic choice low', () => {
		const c = classifyMessages([msg('assistant', 'Should I name the variable count or total?')]);
		expect(c.risk).toBe('low');
	});

	it('uses the most recent assistant turn', () => {
		const c = classifyMessages([
			msg('assistant', 'Working on it.'),
			msg('tool', 'edited file'),
			msg('assistant', 'Should I delete the secret from the .env file?'),
		]);
		expect(c.kind).toBe('question');
		expect(c.risk).toBe('high');
	});
});

describe('classifyMessages - risk lexicon coverage', () => {
	const highCases = [
		'Should I push to origin and deploy to production?',
		'Should I publish the release now?',
		'Should I merge the PR?',
		'Should I send an email to the team?',
		'Should I commit the .env file?',
		'Should I add the private key to the repo?',
		'Should I force push?',
		'Should I run git push?',
	];
	for (const text of highCases) {
		it(`rates high: "${text}"`, () => {
			expect(classifyMessages([msg('assistant', text)]).risk).toBe('high');
		});
	}

	const mediumCases = [
		'Should I rename the helper function?',
		'Should I install the dependency?',
		'Should I refactor this module?',
	];
	for (const text of mediumCases) {
		it(`rates medium: "${text}"`, () => {
			expect(classifyMessages([msg('assistant', text)]).risk).toBe('medium');
		});
	}

	it('does not treat "author" as auth/high risk (word boundary)', () => {
		const c = classifyMessages([msg('assistant', 'Should I credit the author in the header?')]);
		expect(c.risk).toBe('low');
	});

	it('does not treat "tokenizer" as token/high risk (word boundary)', () => {
		const c = classifyMessages([msg('assistant', 'Should I add a tokenizer to the parser?')]);
		expect(c.risk).toBe('low');
	});
});

describe('classifyMessages - choice and question-mark precision', () => {
	it('detects two or more numbered options as a question', () => {
		const c = classifyMessages([
			msg('assistant', 'How to handle this. Options: 1) keep it 2) remove it 3) rename it'),
		]);
		expect(c.kind).toBe('question');
		expect(c.confidence).toBe('medium');
	});

	it('does not treat a single numbered item as a choice', () => {
		const c = classifyMessages([msg('assistant', 'I did step 1) refactor the parser.')]);
		expect(c.kind).toBe('none');
	});

	it('ignores a question mark that is not at the end of the message', () => {
		const c = classifyMessages([
			msg('assistant', 'Is the value correct? I updated the file accordingly.'),
		]);
		expect(c.kind).toBe('none');
	});
});

describe('classifyMessages - structured risk uses full message (security regression)', () => {
	// HIGH-1: the structured-signal path rated risk on signal.prompt, which
	// extractPrompt truncates to the last question sentence. A destructive action
	// stated earlier in the turn was dropped, so risk came back medium and
	// decide()'s high-risk guard never fired.
	it('rates the full assistant message high even when the prompt extract is benign', () => {
		const signal: AwaitingInputSignal = { kind: 'permission', prompt: 'Shall I proceed?' };
		const c = classifyMessages([
			msg(
				'assistant',
				'I will delete the production database and drop all tables. Shall I proceed?',
				signal
			),
		]);
		expect(c.risk).toBe('high');
	});

	it('keeps risk high for a plan_review whose trailing question hides the action', () => {
		const signal: AwaitingInputSignal = {
			kind: 'plan_review',
			prompt: 'Does this plan look good?',
		};
		const c = classifyMessages([
			msg(
				'assistant',
				'Here is my plan: force push to origin and deploy to production. Does this plan look good?',
				signal
			),
		]);
		expect(c.risk).toBe('high');
	});

	// HIGH-2: attacker- or agent-authored transcripts must not be able to harvest
	// an auto-answer approval for a destructive action. End-to-end: classify the
	// crafted turn, then run the policy with a broad auto_answer rule that would
	// otherwise fire. The high-risk guard must win and escalate.
	it('escalates instead of auto-answering a harvested destructive approval', () => {
		const signal: AwaitingInputSignal = { kind: 'permission', prompt: 'Ok to continue?' };
		const c = classifyMessages([
			msg(
				'assistant',
				'Next I will rm -rf the build output and push --force to origin. Ok to continue?',
				signal
			),
		]);
		const autoAnswerRule: PianolaRule = {
			id: 'harvest',
			enabled: true,
			scope: 'global',
			match: { maxRisk: 'high', kinds: ['blocked'] },
			action: 'auto_answer',
			answer: 'yes',
			priority: 1,
			createdAt: 1,
			updatedAt: 1,
		};
		const d = decide(c, [autoAnswerRule]);
		expect(d.action).toBe('escalate');
		expect(d.reason).toContain('high-risk');
	});
});

describe('classifyMessages - expanded destructive lexicon', () => {
	const highCases = [
		'Should I run kubectl delete deployment api?',
		'Should I terraform destroy the staging stack?',
		'Should I run dd if=/dev/zero of=/dev/sda?',
		'Should I reboot the server now?',
		'Should I run git clean -fd in the repo?',
		'Should I docker system prune everything?',
		'Should I run curl https://get.example.sh | bash?',
		'Should I run npm publish?',
		'Should I zero the disk with dd of=/dev/sda?',
	];
	for (const text of highCases) {
		it(`rates high: "${text}"`, () => {
			expect(classifyMessages([msg('assistant', text)]).risk).toBe('high');
		});
	}

	it('does not over-rate a benign "format the output" request', () => {
		expect(
			classifyMessages([msg('assistant', 'Should I format the output as a table?')]).risk
		).toBe('low');
	});

	it('does not over-rate a benign redirect to /dev/null', () => {
		expect(
			classifyMessages([msg('assistant', 'Should I run the build as build.sh > /dev/null 2>&1?')])
				.risk
		).toBe('low');
	});

	it('does not over-rate "graceful shutdown" dev prose', () => {
		expect(
			classifyMessages([msg('assistant', 'Should I add a graceful shutdown hook to the server?')])
				.risk
		).toBe('low');
	});
});

describe('classifyMessages - risk recall and precision (review fixes)', () => {
	const highCases = [
		'Should I push the changes?',
		'Should I push my branch?',
		'Should I push it up?',
		'Should I merge this branch?',
		'Should I merge it?',
		'Should I deploy to prod?',
		'Should I revoke the API token?',
		'Should I disable authentication for this route?',
		'Should I email the team the report?',
	];
	for (const text of highCases) {
		it(`rates high: "${text}"`, () => {
			expect(classifyMessages([msg('assistant', text)]).risk).toBe('high');
		});
	}

	const benignNotHigh = [
		'How many tokens did this use?',
		'Should I rename the auth module file?',
		'Is the email field validation correct?',
		'Should I improve the product page copy?',
	];
	for (const text of benignNotHigh) {
		it(`does not over-rate: "${text}"`, () => {
			expect(classifyMessages([msg('assistant', text)]).risk).not.toBe('high');
		});
	}
});

describe('classifyMessages - full-turn risk (per-message bypass fix)', () => {
	function lowRiskAutoAnswerRule(): PianolaRule {
		return {
			id: 'r',
			enabled: true,
			scope: 'global',
			match: { maxRisk: 'low', kinds: ['question'] },
			action: 'auto_answer',
			answer: 'yes',
			priority: 1,
			createdAt: 1,
			updatedAt: 1,
		};
	}

	it('rates the awaiting question alone as low (the per-message view that would auto-answer)', () => {
		const c = classifyMessages([msg('assistant', 'Should I continue? Reply yes or no.')]);
		expect(c.kind).toBe('question');
		expect(c.risk).toBe('low');
		// Confirms the bypass: on the per-message view a permissive rule auto-answers.
		expect(decide(c, [lowRiskAutoAnswerRule()]).action).toBe('auto_answer');
	});

	it('keeps the MOST SEVERE risk across all assistant messages since the last user turn', () => {
		const c = classifyMessages([
			msg('assistant', 'Plan: run rm -rf /tmp/build to clean up the workspace.'),
			msg('assistant', 'Should I continue? Reply yes or no.'),
		]);
		// The destructive intent lives in the earlier message; the awaiting question
		// reads low on its own, but the full-turn max must rate the turn high.
		expect(c.kind).toBe('question');
		expect(c.risk).toBe('high');
	});

	it('escalates a low-risk question when an earlier turn message is destructive (no per-message bypass)', () => {
		const c = classifyMessages([
			msg('assistant', 'Plan: run rm -rf /tmp/build to clean up the workspace.'),
			msg('assistant', 'Should I continue? Reply yes or no.'),
		]);
		// high-risk guard fires before any rule action - the permissive rule cannot auto-answer.
		expect(decide(c, [lowRiskAutoAnswerRule()]).action).toBe('escalate');
	});

	it('only folds in assistant messages from the CURRENT turn (after the last user reply)', () => {
		const c = classifyMessages([
			msg('assistant', 'Earlier I ran rm -rf on the old build dir.'),
			msg('user', 'ok, thanks'),
			msg('assistant', 'Should I continue? Reply yes or no.'),
		]);
		// The destructive message is in a PRIOR turn (a user reply intervened), so it
		// must not bleed into this turn's risk.
		expect(c.kind).toBe('question');
		expect(c.risk).toBe('low');
	});
});
