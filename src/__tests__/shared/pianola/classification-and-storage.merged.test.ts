// Consolidated from current rc sources; per-source hooks and state stay in an unnamed suite.
// Source: src/__tests__/shared/pianola/pianola-classifier.test.ts
// Source: src/__tests__/shared/pianola/pianola-awaiting-detector.test.ts
// Source: src/__tests__/shared/pianola/pianola-completion-detector.test.ts
// Source: src/__tests__/shared/pianola/storage.test.ts
// Source: src/__tests__/shared/pianola/transcript-mining.test.ts
import { describe, it, expect } from 'vitest';
import {
	classifyMessages as s1_classifyMessages,
	riskAtMost,
	maxRisk,
} from '../../../shared/pianola/pianola-classifier';
import { decide } from '../../../shared/pianola/pianola-policy';
import type {
	AwaitingInputSignal,
	PianolaMessage as S1_PianolaMessage,
	PianolaRule,
} from '../../../shared/pianola/types';
import {
	detectAwaitingInput,
	enrichWithAwaitingInput,
} from '../../../shared/pianola/pianola-awaiting-detector';
import { classifyMessages as s2_classifyMessages } from '../../../shared/pianola/pianola-classifier';
import type { PianolaMessage as S2_PianolaMessage } from '../../../shared/pianola/types';
import {
	detectTaskOutcome,
	hasFailureMarker,
	FAILURE_MARKER_PATTERNS,
	type AgentRunState,
} from '../../../shared/pianola/pianola-completion-detector';
import type { PianolaMessage as S3_PianolaMessage } from '../../../shared/pianola/types';
import {
	validatePianolaRule,
	validatePianolaDecisionRecord,
	validatePianolaRules,
	validatePianolaSupervisedTarget,
	validatePianolaProfileEntry,
	validatePianolaProfiles,
	resolveProfile,
	PIANOLA_PROFILE_MAX_CHARS,
	trimJsonlToLastRecords,
	trimJsonlToFit,
	type PianolaProfiles,
} from '../../../shared/pianola/storage';
import { createMockNativeDecisionPair } from '../../helpers/pianola';
import {
	parseClaudeTranscriptLine,
	parseCodexTranscriptLine,
	parseClaudeCwd,
	parseCodexCwd,
	flattenContent,
	replyPolarity,
	extractDecisionPairs,
	aggregateDecisionPairs,
	type DecisionPair,
} from '../../../shared/pianola/transcript-mining';
import type { PianolaMessage as S5_PianolaMessage } from '../../../shared/pianola/types';
// Source: src/__tests__/shared/pianola/pianola-classifier.test.ts
describe('', () => {
	let seq = 0;
	function msg(
		role: S1_PianolaMessage['role'],
		content: string,
		awaitingInput?: AwaitingInputSignal
	): S1_PianolaMessage {
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
			expect(s1_classifyMessages([]).kind).toBe('none');
		});
		it('returns none when there is no assistant message', () => {
			const c = s1_classifyMessages([msg('user', 'hello?'), msg('tool', 'ran something')]);
			expect(c.kind).toBe('none');
		});
		it('returns none when the user already replied after the assistant asked', () => {
			const c = s1_classifyMessages([
				msg('assistant', 'Which database should I use?'),
				msg('user', 'postgres'),
			]);
			expect(c.kind).toBe('none');
			expect(c.evidence.reason).toContain('user has replied');
		});
	});
	describe('classifyMessages - structured signal (authoritative)', () => {
		it('treats a permission signal as blocked, at least medium risk, high confidence', () => {
			const signal: AwaitingInputSignal = {
				kind: 'permission',
				prompt: 'Allow reading config.ts?',
			};
			const c = s1_classifyMessages([msg('assistant', 'May I?', signal)]);
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
			const c = s1_classifyMessages([msg('assistant', 'ok?', signal)]);
			expect(c.risk).toBe('high');
		});
		it('maps a question signal to kind question', () => {
			const signal: AwaitingInputSignal = { kind: 'question', prompt: 'What name do you want?' };
			const c = s1_classifyMessages([msg('assistant', '...', signal)]);
			expect(c.kind).toBe('question');
			expect(c.confidence).toBe('high');
		});
	});
	describe('classifyMessages - heuristics', () => {
		it('detects a question phrase with medium confidence', () => {
			const c = s1_classifyMessages([
				msg('assistant', 'Should I use tabs or spaces for the new file?'),
			]);
			expect(c.kind).toBe('question');
			expect(c.confidence).toBe('medium');
			expect(c.evidence.structured).toBe(false);
			expect(c.topic.length).toBeGreaterThan(0);
		});
		it('detects an explicit choice marker', () => {
			const c = s1_classifyMessages([msg('assistant', 'Proceed with the rename? [y/n]')]);
			expect(c.kind).toBe('question');
			expect(c.confidence).toBe('medium');
		});
		it('detects a blocked phrase', () => {
			const c = s1_classifyMessages([
				msg('assistant', 'I am blocked: I need the API key to continue.'),
			]);
			expect(c.kind).toBe('blocked');
		});
		it('treats a trailing question mark alone as low-confidence question', () => {
			const c = s1_classifyMessages([msg('assistant', 'That file looks odd, right?')]);
			expect(c.kind).toBe('question');
			expect(c.confidence).toBe('low');
		});
		it('returns none for a plain statement', () => {
			const c = s1_classifyMessages([msg('assistant', 'I finished updating the README.')]);
			expect(c.kind).toBe('none');
		});
	});
	describe('classifyMessages - risk rating', () => {
		it('rates destructive prompts high', () => {
			const c = s1_classifyMessages([
				msg('assistant', 'Should I force push to production and drop the old table?'),
			]);
			expect(c.risk).toBe('high');
		});
		it('rates dependency changes medium', () => {
			const c = s1_classifyMessages([msg('assistant', 'Should I upgrade the react dependency?')]);
			expect(c.risk).toBe('medium');
		});
		it('rates a cosmetic choice low', () => {
			const c = s1_classifyMessages([
				msg('assistant', 'Should I name the variable count or total?'),
			]);
			expect(c.risk).toBe('low');
		});
		it('uses the most recent assistant turn', () => {
			const c = s1_classifyMessages([
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
				expect(s1_classifyMessages([msg('assistant', text)]).risk).toBe('high');
			});
		}
		const mediumCases = [
			'Should I rename the helper function?',
			'Should I install the dependency?',
			'Should I refactor this module?',
		];
		for (const text of mediumCases) {
			it(`rates medium: "${text}"`, () => {
				expect(s1_classifyMessages([msg('assistant', text)]).risk).toBe('medium');
			});
		}
		it('does not treat "author" as auth/high risk (word boundary)', () => {
			const c = s1_classifyMessages([
				msg('assistant', 'Should I credit the author in the header?'),
			]);
			expect(c.risk).toBe('low');
		});
		it('does not treat "tokenizer" as token/high risk (word boundary)', () => {
			const c = s1_classifyMessages([msg('assistant', 'Should I add a tokenizer to the parser?')]);
			expect(c.risk).toBe('low');
		});
	});
	describe('classifyMessages - choice and question-mark precision', () => {
		it('detects two or more numbered options as a question', () => {
			const c = s1_classifyMessages([
				msg('assistant', 'How to handle this. Options: 1) keep it 2) remove it 3) rename it'),
			]);
			expect(c.kind).toBe('question');
			expect(c.confidence).toBe('medium');
		});
		it('does not treat a single numbered item as a choice', () => {
			const c = s1_classifyMessages([msg('assistant', 'I did step 1) refactor the parser.')]);
			expect(c.kind).toBe('none');
		});
		it('ignores a question mark that is not at the end of the message', () => {
			const c = s1_classifyMessages([
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
			const c = s1_classifyMessages([
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
			const c = s1_classifyMessages([
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
			const c = s1_classifyMessages([
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
				expect(s1_classifyMessages([msg('assistant', text)]).risk).toBe('high');
			});
		}
		it('does not over-rate a benign "format the output" request', () => {
			expect(
				s1_classifyMessages([msg('assistant', 'Should I format the output as a table?')]).risk
			).toBe('low');
		});
		it('does not over-rate a benign redirect to /dev/null', () => {
			expect(
				s1_classifyMessages([
					msg('assistant', 'Should I run the build as build.sh > /dev/null 2>&1?'),
				]).risk
			).toBe('low');
		});
		it('does not over-rate "graceful shutdown" dev prose', () => {
			expect(
				s1_classifyMessages([
					msg('assistant', 'Should I add a graceful shutdown hook to the server?'),
				]).risk
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
				expect(s1_classifyMessages([msg('assistant', text)]).risk).toBe('high');
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
				expect(s1_classifyMessages([msg('assistant', text)]).risk).not.toBe('high');
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
			const c = s1_classifyMessages([msg('assistant', 'Should I continue? Reply yes or no.')]);
			expect(c.kind).toBe('question');
			expect(c.risk).toBe('low');
			// Confirms the bypass: on the per-message view a permissive rule auto-answers.
			expect(decide(c, [lowRiskAutoAnswerRule()]).action).toBe('auto_answer');
		});
		it('keeps the MOST SEVERE risk across all assistant messages since the last user turn', () => {
			const c = s1_classifyMessages([
				msg('assistant', 'Plan: run rm -rf /tmp/build to clean up the workspace.'),
				msg('assistant', 'Should I continue? Reply yes or no.'),
			]);
			// The destructive intent lives in the earlier message; the awaiting question
			// reads low on its own, but the full-turn max must rate the turn high.
			expect(c.kind).toBe('question');
			expect(c.risk).toBe('high');
		});
		it('escalates a low-risk question when an earlier turn message is destructive (no per-message bypass)', () => {
			const c = s1_classifyMessages([
				msg('assistant', 'Plan: run rm -rf /tmp/build to clean up the workspace.'),
				msg('assistant', 'Should I continue? Reply yes or no.'),
			]);
			// high-risk guard fires before any rule action - the permissive rule cannot auto-answer.
			expect(decide(c, [lowRiskAutoAnswerRule()]).action).toBe('escalate');
		});
		it('only folds in assistant messages from the CURRENT turn (after the last user reply)', () => {
			const c = s1_classifyMessages([
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
	describe('RF03 bounded optional question text', () => {
		it.each([
			['ASCII', 'x'.repeat(7998), 'x'.repeat(7999)],
			['Unicode', 'é'.repeat(3999), 'é'.repeat(4000)],
			['escaped control characters', '\n'.repeat(3999), '\n'.repeat(4000)],
		])(
			'preserves fitting %s text and omits oversized text without losing risk',
			(_name, fitting, oversized) => {
				const signal: AwaitingInputSignal = { kind: 'question', prompt: 'Should I continue?' };
				const classify = (content: string) =>
					s1_classifyMessages([
						msg('assistant', 'I will deploy to production.'),
						msg('assistant', content, signal),
					]);
				expect(classify(fitting)).toMatchObject({
					kind: 'question',
					risk: 'high',
					questionText: fitting,
				});
				const result = classify(oversized);
				expect(result).toMatchObject({ kind: 'question', risk: 'high' });
				expect(result.questionText).toBeUndefined();
			}
		);
	});
});
// Source: src/__tests__/shared/pianola/pianola-awaiting-detector.test.ts
describe('', () => {
	let seq = 0;
	function msg(role: S2_PianolaMessage['role'], content: string): S2_PianolaMessage {
		seq += 1;
		return {
			id: `m${seq}`,
			role,
			source: role === 'assistant' ? 'ai' : role,
			content,
			timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString(),
		};
	}
	describe('detectAwaitingInput - kinds', () => {
		it('detects plan review', () => {
			const s = detectAwaitingInput("Here's the plan: refactor the parser. Ready to code?");
			expect(s?.kind).toBe('plan_review');
		});
		it('detects a permission request', () => {
			const s = detectAwaitingInput('Do you want me to run the migration now?');
			expect(s?.kind).toBe('permission');
		});
		it('detects an explicit choice and extracts numbered options', () => {
			const s = detectAwaitingInput('How should I proceed? 1) keep it 2) remove it 3) rename it');
			expect(s?.kind).toBe('choice');
			expect(s?.options).toEqual(['keep it', 'remove it', 'rename it']);
		});
		it('extracts slash-bracket options', () => {
			const s = detectAwaitingInput('Proceed with the change? [keep/discard]');
			expect(s?.options).toEqual(['keep', 'discard']);
		});
		it('detects a direct question', () => {
			const s = detectAwaitingInput('Should I use tabs or spaces?');
			expect(s?.kind).toBe('question');
			expect(s?.prompt).toContain('Should I use tabs or spaces?');
		});
		it('returns null for a plain statement', () => {
			expect(detectAwaitingInput('I updated the README and ran the tests.')).toBeNull();
		});
		it('returns null for question intent that is not actually a question', () => {
			// No trailing question mark -> left to the classifier heuristics, not structured.
			expect(detectAwaitingInput('I will decide which option is best and continue.')).toBeNull();
		});
		it('returns null for empty content', () => {
			expect(detectAwaitingInput('   ')).toBeNull();
		});
		it('prefers plan review over permission when both phrasings appear', () => {
			const s = detectAwaitingInput('Here is the plan. May I proceed with the plan?');
			expect(s?.kind).toBe('plan_review');
		});
	});
	describe('detectAwaitingInput - false-positive hardening', () => {
		it('does not treat a markdown link as options', () => {
			expect(
				detectAwaitingInput('See the guide at [docs/api](https://x.example). Done.')
			).toBeNull();
		});
		it('does not treat a bracketed file path as options', () => {
			expect(detectAwaitingInput('I edited [src/foo.ts] as requested.')).toBeNull();
		});
		it('does not treat a version number as a numbered choice', () => {
			expect(detectAwaitingInput('Bumped the package to 1.2.3 today.')).toBeNull();
		});
		it('does not treat a changelog-style numbered list without a question as a choice', () => {
			expect(
				detectAwaitingInput('Changes in this release: 1) fixed a bug 2) added a feature')
			).toBeNull();
		});
		it('still treats a genuine bracketed choice with asking context as a choice', () => {
			const s = detectAwaitingInput('Proceed? [approve/cancel]');
			expect(s?.kind).toBe('choice');
			expect(s?.options).toEqual(['approve', 'cancel']);
		});
	});
	describe('enrichWithAwaitingInput', () => {
		it('fills awaitingInput on assistant messages without mutating inputs', () => {
			const input = [
				msg('user', 'go'),
				msg('assistant', 'Do you want me to deploy to production?'),
			];
			const frozenContent = input[1].content;
			const out = enrichWithAwaitingInput(input);
			expect(out[1].awaitingInput?.kind).toBe('permission');
			expect(input[1].awaitingInput).toBeUndefined(); // original untouched
			expect(input[1].content).toBe(frozenContent);
		});
		it('leaves non-assistant messages and plain statements alone', () => {
			const out = enrichWithAwaitingInput([
				msg('user', 'should I do it?'),
				msg('assistant', 'Done, all tests pass.'),
			]);
			expect(out[0].awaitingInput).toBeUndefined();
			expect(out[1].awaitingInput).toBeUndefined();
		});
		it('does not overwrite a pre-existing signal', () => {
			const pre: S2_PianolaMessage = {
				...msg('assistant', 'anything?'),
				awaitingInput: { kind: 'choice' },
			};
			const out = enrichWithAwaitingInput([pre]);
			expect(out[0].awaitingInput?.kind).toBe('choice');
		});
	});
	describe('detector + classifier integration', () => {
		it('upgrades a permission prompt to a high-confidence structured classification', () => {
			const enriched = enrichWithAwaitingInput([
				msg('assistant', 'Do you want me to force push the branch?'),
			]);
			const c = s2_classifyMessages(enriched);
			expect(c.evidence.structured).toBe(true);
			expect(c.confidence).toBe('high');
			expect(c.kind).toBe('blocked'); // permission maps to blocked
			expect(c.risk).toBe('high'); // force push
		});
		it('keeps a low-risk auto-answerable choice as a structured choice signal', () => {
			const enriched = enrichWithAwaitingInput([
				msg('assistant', 'Which name do you prefer? 1) count 2) total'),
			]);
			const c = s2_classifyMessages(enriched);
			expect(c.evidence.structured).toBe(true);
			expect(c.kind).toBe('blocked'); // choice maps to blocked (awaiting a pick)
			expect(c.risk).toBe('low');
		});
	});
});
// Source: src/__tests__/shared/pianola/pianola-completion-detector.test.ts
describe('', () => {
	let seq = 0;
	function msg(role: S3_PianolaMessage['role'], content: string): S3_PianolaMessage {
		seq += 1;
		return {
			id: `m${seq}`,
			role,
			source: role === 'assistant' ? 'ai' : role,
			content,
			timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString(),
		};
	}
	function input(
		currentState: AgentRunState,
		previousState?: AgentRunState,
		recentMessages: readonly S3_PianolaMessage[] = []
	) {
		return { previousState, currentState, recentMessages };
	}
	describe('detectTaskOutcome - completion', () => {
		it('busy -> idle with no failure is done', () => {
			const r = detectTaskOutcome(
				input('idle', 'busy', [msg('assistant', 'All set, README updated.')])
			);
			expect(r.outcome).toBe('done');
			expect(r.reason).toContain('idle');
		});
		it('connecting -> idle does not prove a worker ran', () => {
			const r = detectTaskOutcome(input('idle', 'connecting', [msg('assistant', 'Done.')]));
			expect(r.outcome).toBe('working');
		});
		it('done verdict requires no message history beyond clean output', () => {
			const r = detectTaskOutcome(input('idle', 'busy', []));
			expect(r.outcome).toBe('done');
		});
	});
	describe('detectTaskOutcome - failure', () => {
		it('error state is failed', () => {
			const r = detectTaskOutcome(input('error', 'busy', []));
			expect(r.outcome).toBe('failed');
			expect(r.reason).toContain('error state');
		});
		it('error state beats everything, even a clean transition', () => {
			const r = detectTaskOutcome(input('error', 'busy', [msg('assistant', 'looking good')]));
			expect(r.outcome).toBe('failed');
		});
		it('failure-marker message is failed even when idle', () => {
			const r = detectTaskOutcome(
				input('idle', 'busy', [msg('assistant', 'Build failed: 3 errors in compiler output.')])
			);
			expect(r.outcome).toBe('failed');
			expect(r.reason).toContain('failure marker');
		});
		it('an error-role message in the tail is a failure', () => {
			const r = detectTaskOutcome(input('idle', 'busy', [msg('error', 'connection reset')]));
			expect(r.outcome).toBe('failed');
		});
		it('a fatal error marker fails the task', () => {
			const r = detectTaskOutcome(
				input('idle', 'busy', [msg('assistant', 'A fatal error occurred while writing.')])
			);
			expect(r.outcome).toBe('failed');
		});
	});
	describe('detectTaskOutcome - working', () => {
		it('still busy is working', () => {
			const r = detectTaskOutcome(input('busy', 'busy', [msg('assistant', 'Editing files...')]));
			expect(r.outcome).toBe('working');
			expect(r.reason).toContain('busy');
		});
		it('connecting is working', () => {
			const r = detectTaskOutcome(input('connecting', 'idle', []));
			expect(r.outcome).toBe('working');
		});
		it('waiting_input is working (the watcher handles the ask)', () => {
			const r = detectTaskOutcome(
				input('waiting_input', 'busy', [msg('assistant', 'Which database should I use?')])
			);
			expect(r.outcome).toBe('working');
			expect(r.reason).toContain('waiting');
		});
		it('idle with no prior working state is working (no transition observed)', () => {
			const r = detectTaskOutcome(input('idle', 'idle', [msg('assistant', 'hello')]));
			expect(r.outcome).toBe('working');
			expect(r.reason).toContain('no completion transition observed');
		});
		it('idle with no previousState at all is working', () => {
			const r = detectTaskOutcome(input('idle', undefined, []));
			expect(r.outcome).toBe('working');
			expect(r.reason).toContain('no completion transition observed');
		});
		it('waiting_input is not failed even with a question mark', () => {
			const r = detectTaskOutcome(
				input('waiting_input', 'busy', [msg('assistant', 'Proceed with the rename? [y/n]')])
			);
			expect(r.outcome).toBe('working');
		});
	});
	describe('hasFailureMarker', () => {
		it('is false for an empty transcript', () => {
			expect(hasFailureMarker([])).toBe(false);
		});
		it('is false for a clean completion message', () => {
			expect(
				hasFailureMarker([msg('assistant', 'Finished updating the README successfully.')])
			).toBe(false);
		});
		it('is true for an error-role message regardless of content', () => {
			expect(hasFailureMarker([msg('error', 'something went sideways')])).toBe(true);
		});
		it('is true for "error:" prefix in assistant output', () => {
			expect(hasFailureMarker([msg('assistant', 'error: cannot find module foo')])).toBe(true);
		});
		it('is true for an exception/traceback', () => {
			expect(hasFailureMarker([msg('assistant', 'Traceback (most recent call last):')])).toBe(true);
		});
		it('is true for a non-zero exit code', () => {
			expect(hasFailureMarker([msg('assistant', 'process ended with exit code 1')])).toBe(true);
		});
		it('only inspects the latest assistant/error message', () => {
			// An earlier failure followed by a clean assistant turn is not a failure:
			// the detector keys off the latest relevant turn, like the classifier.
			const messages = [
				msg('assistant', 'Build failed earlier.'),
				msg('tool', 'reran build'),
				msg('assistant', 'All green now, build succeeded.'),
			];
			expect(hasFailureMarker(messages)).toBe(false);
		});
		it('ignores tool/user messages when finding the latest relevant turn', () => {
			const messages = [msg('assistant', 'compilation failed: see log'), msg('user', 'ok thanks')];
			// Latest assistant is the failure; the trailing user message is skipped.
			expect(hasFailureMarker(messages)).toBe(true);
		});
	});
	describe('FAILURE_MARKER_PATTERNS', () => {
		it('is a non-empty exported pattern array', () => {
			expect(Array.isArray(FAILURE_MARKER_PATTERNS)).toBe(true);
			expect(FAILURE_MARKER_PATTERNS.length).toBeGreaterThan(0);
		});
		it('does not over-fire on benign prose', () => {
			expect(hasFailureMarker([msg('assistant', 'The build is green and tests pass.')])).toBe(
				false
			);
		});
	});
	describe('detectTaskOutcome - failure lexicon precision', () => {
		it('does not fail a task on benign failed/aborted narration', () => {
			const benign = [
				'All tests pass; 0 failed.',
				'The test failed earlier but now passes.',
				'I aborted the old approach and finished the new one.',
				'No failures found.',
			];
			for (const text of benign) {
				expect(detectTaskOutcome(input('idle', 'busy', [msg('assistant', text)])).outcome).toBe(
					'done'
				);
			}
		});
		it('still fails on tool/exit-shaped failure signals', () => {
			const failing = [
				'error: ENOENT: no such file or directory',
				'fatal: not a git repository',
				'Traceback (most recent call last):',
				'panic: runtime error',
				'the process exited with exit code 1',
				'command not found: foo',
			];
			for (const text of failing) {
				expect(detectTaskOutcome(input('idle', 'busy', [msg('assistant', text)])).outcome).toBe(
					'failed'
				);
			}
		});
		it('treats an error-role message as failure regardless of wording', () => {
			expect(
				detectTaskOutcome(input('idle', 'busy', [msg('error', 'all good here')])).outcome
			).toBe('failed');
		});
	});
	describe('FAILURE_MARKER_PATTERNS - exception/error-prefix precision (Q7)', () => {
		const negatives = [
			'Added exception handling; task complete.',
			'Completed without exception.',
			'Result: no error: all tests pass',
			'0 errors, build succeeded',
		];
		for (const text of negatives) {
			it(`does not fire on benign prose: ${text}`, () => {
				expect(hasFailureMarker([msg('assistant', text)])).toBe(false);
				expect(detectTaskOutcome(input('idle', 'busy', [msg('assistant', text)])).outcome).toBe(
					'done'
				);
			});
		}
		const positives = [
			'Uncaught exception: TypeError',
			'Traceback (most recent call last):',
			'error: cannot find module',
			'Build failed: 3 errors',
			'exit code 1',
			'command not found',
		];
		for (const text of positives) {
			it(`still detects a real failure signal: ${text}`, () => {
				expect(hasFailureMarker([msg('assistant', text)])).toBe(true);
				expect(detectTaskOutcome(input('idle', 'busy', [msg('assistant', text)])).outcome).toBe(
					'failed'
				);
			});
		}
	});
});
// Source: src/__tests__/shared/pianola/storage.test.ts
describe('', () => {
	describe('program supervisor target', () => {
		it('requires a nonempty programId without changing existing target kinds', () => {
			const base = { id: 'p', kind: 'program', enabled: true, createdAt: 1 };
			expect(validatePianolaSupervisedTarget(base)).toBeNull();
			expect(validatePianolaSupervisedTarget({ ...base, programId: '' })).toBeNull();
			expect(validatePianolaSupervisedTarget({ ...base, programId: 'product' })).toMatchObject({
				kind: 'program',
				programId: 'product',
			});
		});
	});
	function validRaw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
		return {
			id: 'r1',
			enabled: true,
			scope: 'global',
			match: { maxRisk: 'low', kinds: ['question'], topicIncludes: ['tabs'] },
			action: 'auto_answer',
			answer: 'Use tabs.',
			priority: 100,
			createdAt: 1,
			updatedAt: 2,
			...overrides,
		};
	}
	describe('validatePianolaRule', () => {
		it('accepts a well-formed rule', () => {
			const rule = validatePianolaRule(validRaw());
			expect(rule).not.toBeNull();
			expect(rule?.id).toBe('r1');
			expect(rule?.match.kinds).toEqual(['question']);
		});
		it('accepts a minimal rule with an empty match', () => {
			const rule = validatePianolaRule(
				validRaw({ match: undefined, action: 'escalate', answer: undefined })
			);
			expect(rule?.match).toEqual({});
		});
		it.each([
			['missing id', { id: undefined }],
			['empty id', { id: '' }],
			['non-boolean enabled', { enabled: 'yes' }],
			['bad scope', { scope: 'planet' }],
			['bad action', { action: 'nuke' }],
			['non-numeric priority', { priority: 'high' }],
			['missing timestamps', { createdAt: undefined }],
			['bad maxRisk', { match: { maxRisk: 'extreme' } }],
			['bad kinds', { match: { kinds: ['banana'] } }],
			['non-string topicIncludes', { match: { topicIncludes: [1, 2] } }],
			['non-string scopeId', { scopeId: 42 }],
		])('rejects %s', (_label, overrides) => {
			expect(validatePianolaRule(validRaw(overrides))).toBeNull();
		});
		it('rejects non-object input', () => {
			expect(validatePianolaRule(null)).toBeNull();
			expect(validatePianolaRule('rule')).toBeNull();
			expect(validatePianolaRule([])).toBeNull();
		});
		it('rejects an auto_answer rule with no narrowing predicate', () => {
			expect(validatePianolaRule(validRaw({ match: {} }))).toBeNull();
		});
		it('rejects an auto_answer rule with blank answer text', () => {
			expect(validatePianolaRule(validRaw({ answer: '   ' }))).toBeNull();
		});
		it('rejects an auto_answer rule with no answer', () => {
			expect(validatePianolaRule(validRaw({ answer: undefined }))).toBeNull();
		});
	});
	describe('validatePianolaRules', () => {
		it('keeps valid rules and drops invalid ones', () => {
			const rules = validatePianolaRules([
				validRaw({ id: 'a' }),
				{ junk: true },
				validRaw({ id: 'b' }),
			]);
			expect(rules.map((r) => r.id)).toEqual(['a', 'b']);
		});
		it('returns an empty array for non-array input', () => {
			expect(validatePianolaRules({})).toEqual([]);
			expect(validatePianolaRules(undefined)).toEqual([]);
		});
	});
	describe('validatePianolaProfileEntry', () => {
		it('accepts a well-formed entry', () => {
			const entry = validatePianolaProfileEntry({
				profile: 'Approves tests freely.',
				updatedAt: 123,
				pairCount: 42,
			});
			expect(entry).toEqual({ profile: 'Approves tests freely.', updatedAt: 123, pairCount: 42 });
		});
		it('accepts an entry without pairCount', () => {
			const entry = validatePianolaProfileEntry({ profile: 'x', updatedAt: 1 });
			expect(entry).toEqual({ profile: 'x', updatedAt: 1 });
			expect(entry?.pairCount).toBeUndefined();
		});
		it('drops a non-finite pairCount rather than failing', () => {
			const entry = validatePianolaProfileEntry({ profile: 'x', updatedAt: 1, pairCount: NaN });
			expect(entry).toEqual({ profile: 'x', updatedAt: 1 });
		});
		it('truncates an over-long profile to the max', () => {
			const entry = validatePianolaProfileEntry({
				profile: 'a'.repeat(PIANOLA_PROFILE_MAX_CHARS + 500),
				updatedAt: 1,
			});
			expect(entry?.profile.length).toBe(PIANOLA_PROFILE_MAX_CHARS);
		});
		it.each([
			['non-object', null],
			['missing profile', { updatedAt: 1 }],
			['non-string profile', { profile: 5, updatedAt: 1 }],
			['missing updatedAt', { profile: 'x' }],
			['non-finite updatedAt', { profile: 'x', updatedAt: Infinity }],
		])('rejects %s', (_label, raw) => {
			expect(validatePianolaProfileEntry(raw)).toBeNull();
		});
	});
	describe('validatePianolaProfiles', () => {
		it('keeps valid global and project entries, drops malformed ones', () => {
			const profiles = validatePianolaProfiles({
				global: { profile: 'g', updatedAt: 1 },
				projects: {
					'/a': { profile: 'pa', updatedAt: 2 },
					'/bad': { profile: 5, updatedAt: 3 },
				},
			});
			expect(profiles.global).toEqual({ profile: 'g', updatedAt: 1 });
			expect(profiles.projects['/a']).toEqual({ profile: 'pa', updatedAt: 2 });
			expect(profiles.projects['/bad']).toBeUndefined();
		});
		it('returns a well-formed empty object for junk input', () => {
			expect(validatePianolaProfiles(null)).toEqual({ projects: {} });
			expect(validatePianolaProfiles('nope')).toEqual({ projects: {} });
			expect(validatePianolaProfiles({ projects: 'nope' })).toEqual({ projects: {} });
		});
	});
	describe('resolveProfile', () => {
		const profiles: PianolaProfiles = {
			global: { profile: 'global guidance', updatedAt: 1 },
			projects: { '/proj': { profile: 'project guidance', updatedAt: 2 } },
		};
		it('returns the project profile when one exists for the path', () => {
			expect(resolveProfile(profiles, '/proj')).toEqual({
				source: 'project',
				entry: profiles.projects['/proj'],
			});
		});
		it('falls back to global when the project has no profile', () => {
			expect(resolveProfile(profiles, '/other')).toEqual({
				source: 'global',
				entry: profiles.global,
			});
		});
		it('falls back to global when no path is given', () => {
			expect(resolveProfile(profiles)).toEqual({ source: 'global', entry: profiles.global });
		});
		it('returns none when neither project nor global exists', () => {
			expect(resolveProfile({ projects: {} }, '/proj')).toEqual({ source: 'none', entry: null });
		});
	});
	describe('trimJsonlToLastRecords', () => {
		it('returns content unchanged when within the cap', () => {
			const content = 'a\nb\nc\n';
			expect(trimJsonlToLastRecords(content, 5)).toBe(content);
		});
		it('keeps only the most recent records when over the cap', () => {
			expect(trimJsonlToLastRecords('l1\nl2\nl3\nl4\n', 2)).toBe('l3\nl4\n');
		});
		it('ignores blank lines when counting', () => {
			expect(trimJsonlToLastRecords('l1\n\nl2\n\nl3\n', 2)).toBe('l2\nl3\n');
		});
		it('returns content unchanged for a non-positive cap', () => {
			expect(trimJsonlToLastRecords('l1\nl2\n', 0)).toBe('l1\nl2\n');
			expect(trimJsonlToLastRecords('l1\nl2\n', -1)).toBe('l1\nl2\n');
		});
	});
	describe('trimJsonlToFit', () => {
		it('returns content unchanged when within both caps', () => {
			const content = 'a\nb\nc\n';
			expect(trimJsonlToFit(content, 10, 1000)).toBe(content);
		});
		it('trims by record cap', () => {
			expect(trimJsonlToFit('l1\nl2\nl3\nl4\n', 2, 100000)).toBe('l3\nl4\n');
		});
		it('trims further to fit the byte budget', () => {
			// Four 5-byte lines ("xxxx\n"); a 10-byte budget keeps the last two.
			expect(trimJsonlToFit('xxxx\nxxxx\nxxxx\nxxxx\n', 100, 10)).toBe('xxxx\nxxxx\n');
		});
		it('applies the tighter of record cap and byte budget', () => {
			// record cap 3 keeps last 3 (15 bytes); byte budget 12 drops one more.
			expect(trimJsonlToFit('aaaa\nbbbb\ncccc\ndddd\n', 3, 12)).toBe('cccc\ndddd\n');
		});
	});
	function decisionRecord(over: Record<string, unknown> = {}): Record<string, unknown> {
		return {
			id: 'd1',
			timestamp: '2026-01-01T00:00:00.000Z',
			tabId: 't1',
			agentId: 'a1',
			dispatched: false,
			dryRun: true,
			classification: {
				kind: 'question',
				risk: 'low',
				topic: 'tabs or spaces?',
				confidence: 'high',
				evidence: { messageId: 'm1', reason: 'asked about indentation', structured: true },
			},
			decision: { action: 'escalate', matchedRuleId: null, reason: 'no rule matched' },
			...over,
		};
	}
	function withEvidence(evidence: unknown): Record<string, unknown> {
		return decisionRecord({
			classification: {
				kind: 'question',
				risk: 'low',
				topic: 'tabs or spaces?',
				confidence: 'high',
				evidence,
			},
		});
	}
	describe('validatePianolaDecisionRecord', () => {
		it('accepts a fully valid record', () => {
			const rec = validatePianolaDecisionRecord(decisionRecord());
			expect(rec).not.toBeNull();
			expect(rec?.id).toBe('d1');
			expect(rec?.classification.evidence.messageId).toBe('m1');
		});
		it('accepts a record whose evidence.messageId is null', () => {
			const rec = validatePianolaDecisionRecord(
				withEvidence({ messageId: null, reason: 'heuristic', structured: false })
			);
			expect(rec).not.toBeNull();
			expect(rec?.classification.evidence.messageId).toBeNull();
		});
		it('rejects evidence missing messageId', () => {
			expect(
				validatePianolaDecisionRecord(withEvidence({ reason: 'r', structured: true }))
			).toBeNull();
		});
		it('rejects a non-string evidence.reason', () => {
			expect(
				validatePianolaDecisionRecord(
					withEvidence({ messageId: 'm1', reason: 42, structured: true })
				)
			).toBeNull();
		});
		it('rejects a non-boolean evidence.structured', () => {
			expect(
				validatePianolaDecisionRecord(
					withEvidence({ messageId: 'm1', reason: 'r', structured: 'yes' })
				)
			).toBeNull();
		});
		it('rejects evidence that is not an object', () => {
			expect(validatePianolaDecisionRecord(withEvidence('nope'))).toBeNull();
			expect(validatePianolaDecisionRecord(withEvidence(null))).toBeNull();
		});
	});
});
// Source: src/__tests__/shared/pianola/transcript-mining.test.ts
describe('', () => {
	let seq = 0;
	function msg(role: S5_PianolaMessage['role'], content: string): S5_PianolaMessage {
		seq += 1;
		return {
			id: `m${seq}`,
			role,
			source: role === 'assistant' ? 'ai' : role,
			content,
			timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString(),
		};
	}
	describe('flattenContent', () => {
		it('returns a bare string unchanged', () => {
			expect(flattenContent('hello there')).toBe('hello there');
		});
		it('joins text blocks and ignores non-text blocks', () => {
			const content = [
				{ type: 'text', text: 'line one' },
				{ type: 'tool_use', name: 'Bash', input: {} },
				{ type: 'text', text: 'line two' },
			];
			expect(flattenContent(content)).toBe('line one\nline two');
		});
		it('returns empty for a tool-result-only array', () => {
			expect(flattenContent([{ type: 'tool_result', content: 'output' }])).toBe('');
		});
		it('returns empty for non-string non-array', () => {
			expect(flattenContent(null)).toBe('');
			expect(flattenContent(42)).toBe('');
		});
	});
	describe('parseClaudeTranscriptLine', () => {
		it('parses an assistant message with text blocks', () => {
			const line = JSON.stringify({
				isSidechain: false,
				type: 'assistant',
				message: {
					role: 'assistant',
					content: [{ type: 'text', text: 'Should I run the migration now?' }],
				},
				uuid: 'a1',
				timestamp: '2026-06-01T00:00:01.000Z',
				cwd: '/proj',
			});
			const m = parseClaudeTranscriptLine(line);
			expect(m).not.toBeNull();
			expect(m?.role).toBe('assistant');
			expect(m?.content).toBe('Should I run the migration now?');
			expect(m?.id).toBe('a1');
		});
		it('parses a string-content user message', () => {
			const line = JSON.stringify({
				isSidechain: false,
				type: 'user',
				message: { role: 'user', content: 'Yes, go ahead' },
				uuid: 'u1',
				timestamp: '2026-06-01T00:00:05.000Z',
			});
			expect(parseClaudeTranscriptLine(line)?.content).toBe('Yes, go ahead');
		});
		it('returns null for header/metadata lines', () => {
			expect(
				parseClaudeTranscriptLine(JSON.stringify({ type: 'summary', leafUuid: 'x' }))
			).toBeNull();
		});
		it('returns null for sidechain turns', () => {
			const line = JSON.stringify({
				isSidechain: true,
				message: { role: 'assistant', content: 'sub-agent work' },
				uuid: 'sc1',
				timestamp: 't',
			});
			expect(parseClaudeTranscriptLine(line)).toBeNull();
		});
		it('returns null for a tool-result-only user turn (no human text)', () => {
			const line = JSON.stringify({
				isSidechain: false,
				message: { role: 'user', content: [{ type: 'tool_result', content: 'stdout' }] },
				uuid: 'tr1',
				timestamp: 't',
			});
			expect(parseClaudeTranscriptLine(line)).toBeNull();
		});
		it('returns null for invalid JSON', () => {
			expect(parseClaudeTranscriptLine('{not json')).toBeNull();
		});
	});
	describe('parseCodexTranscriptLine', () => {
		it('parses a response_item message', () => {
			const line = JSON.stringify({
				timestamp: '2026-06-01T00:00:01.000Z',
				type: 'response_item',
				payload: {
					type: 'message',
					role: 'assistant',
					content: [{ type: 'output_text', text: 'Do you want me to delete the file?' }],
				},
			});
			const m = parseCodexTranscriptLine(line);
			expect(m?.role).toBe('assistant');
			expect(m?.content).toBe('Do you want me to delete the file?');
		});
		it('returns null for session_meta', () => {
			const line = JSON.stringify({ type: 'session_meta', payload: { cwd: '/c', id: 's' } });
			expect(parseCodexTranscriptLine(line)).toBeNull();
		});
		it('returns null for non-message response_items (reasoning, tool calls)', () => {
			const line = JSON.stringify({
				type: 'response_item',
				payload: { type: 'reasoning', content: [] },
			});
			expect(parseCodexTranscriptLine(line)).toBeNull();
		});
	});
	describe('cwd extraction', () => {
		it('reads cwd from a Claude line', () => {
			expect(parseClaudeCwd(JSON.stringify({ cwd: '/proj', type: 'user' }))).toBe('/proj');
		});
		it('reads cwd from a Codex session_meta line', () => {
			expect(parseCodexCwd(JSON.stringify({ type: 'session_meta', payload: { cwd: '/cx' } }))).toBe(
				'/cx'
			);
		});
		it('returns undefined when absent', () => {
			expect(parseCodexCwd(JSON.stringify({ type: 'response_item', payload: {} }))).toBeUndefined();
		});
	});
	describe('replyPolarity', () => {
		it('classifies affirmatives', () => {
			expect(replyPolarity('yes')).toBe('affirmative');
			expect(replyPolarity('Go ahead, do it')).toBe('affirmative');
			expect(replyPolarity('lgtm')).toBe('affirmative');
		});
		it('classifies negatives', () => {
			expect(replyPolarity('no')).toBe('negative');
			expect(replyPolarity("don't do that")).toBe('negative');
			expect(replyPolarity('stop')).toBe('negative');
		});
		it('falls back to other for substantive replies', () => {
			expect(replyPolarity('Use the repository pattern and add a test')).toBe('other');
			expect(replyPolarity('')).toBe('other');
		});
	});
	describe('extractDecisionPairs', () => {
		it('pairs an awaiting-input assistant turn with the next user reply', () => {
			const messages: S5_PianolaMessage[] = [
				msg('user', 'Please migrate the database schema.'),
				msg('assistant', 'Do you want me to run the migration now?'),
				msg('user', 'Yes, go ahead'),
			];
			const pairs = extractDecisionPairs(messages, {
				agent: 'claude-code',
				sessionId: 's1',
				projectPath: '/p',
			});
			expect(pairs).toHaveLength(1);
			expect(pairs[0].agent).toBe('claude-code');
			expect(pairs[0].sessionId).toBe('s1');
			expect(pairs[0].polarity).toBe('affirmative');
			expect(pairs[0].classification.kind).not.toBe('none');
			expect(pairs[0].ask).toContain('migration');
			expect(pairs[0].reply).toBe('Yes, go ahead');
		});
		it('does not pair a plain statement with no awaiting input', () => {
			const messages: S5_PianolaMessage[] = [
				msg('user', 'Update the README.'),
				msg('assistant', 'I updated the README and ran the tests.'),
				msg('user', 'thanks'),
			];
			expect(extractDecisionPairs(messages, { agent: 'codex', sessionId: 's2' })).toHaveLength(0);
		});
		it('skips an awaiting turn with no following user reply', () => {
			const messages: S5_PianolaMessage[] = [
				msg('user', 'Refactor the parser.'),
				msg('assistant', 'Should I use tabs or spaces?'),
			];
			expect(
				extractDecisionPairs(messages, { agent: 'claude-code', sessionId: 's3' })
			).toHaveLength(0);
		});
		it('captures heuristic prose asks the strict structured detector would miss', () => {
			// "let me know" is a question phrase the classifier catches heuristically,
			// even without a structured awaiting-input signal - this is the recall gain.
			const messages: S5_PianolaMessage[] = [
				msg('user', 'Wire up the export.'),
				msg(
					'assistant',
					'I can keep the old format or switch to JSON. Let me know how to proceed.'
				),
				msg('user', 'switch to JSON'),
			];
			const pairs = extractDecisionPairs(messages, { agent: 'claude-code', sessionId: 's4' });
			expect(pairs).toHaveLength(1);
			expect(pairs[0].classification.kind).not.toBe('none');
			expect(pairs[0].reply).toBe('switch to JSON');
		});
	});
	describe('aggregateDecisionPairs', () => {
		function pair(
			risk: 'low' | 'medium' | 'high',
			polarity: DecisionPair['polarity']
		): DecisionPair {
			const value = createMockNativeDecisionPair(++seq);
			value.classification.risk = risk;
			value.polarity = polarity;
			return value;
		}
		it('rolls up risk counts, polarity counts, and the risk x polarity cross-tab', () => {
			const pairs: DecisionPair[] = [
				pair('low', 'affirmative'),
				pair('low', 'affirmative'),
				pair('low', 'negative'),
				pair('high', 'other'),
			];
			const agg = aggregateDecisionPairs(pairs);
			expect(agg.total).toBe(4);
			expect(agg.byRisk).toEqual({ low: 3, high: 1 });
			expect(agg.byPolarity).toEqual({ affirmative: 2, negative: 1, other: 1 });
			expect(agg.byRiskPolarity.low).toEqual({ affirmative: 2, negative: 1, other: 0 });
			expect(agg.byRiskPolarity.high).toEqual({ affirmative: 0, negative: 0, other: 1 });
		});
	});
	describe('size caps (Q8 robustness)', () => {
		it('truncates flattened string content to the classifier cap', () => {
			const flat = flattenContent('x'.repeat(150000));
			expect(flat.length).toBe(100000);
		});
		it('truncates flattened array text content to the classifier cap', () => {
			const flat = flattenContent([{ type: 'text', text: 'y'.repeat(150000) }]);
			expect(flat.length).toBe(100000);
		});
		it('leaves normal-sized content unaffected', () => {
			expect(flattenContent('regular reply')).toBe('regular reply');
			expect(flattenContent([{ type: 'text', text: 'a normal block' }])).toBe('a normal block');
		});
		it('skips an oversized Claude JSONL line before parsing', () => {
			const line = JSON.stringify({
				isSidechain: false,
				type: 'assistant',
				message: { role: 'assistant', content: 'z'.repeat(300000) },
				uuid: 'big1',
				timestamp: 't',
			});
			expect(line.length).toBeGreaterThan(256 * 1024);
			expect(parseClaudeTranscriptLine(line)).toBeNull();
		});
		it('skips an oversized Codex JSONL line before parsing', () => {
			const line = JSON.stringify({
				type: 'response_item',
				payload: {
					type: 'message',
					role: 'assistant',
					content: [{ type: 'output_text', text: 'z'.repeat(300000) }],
				},
				timestamp: 't',
			});
			expect(line.length).toBeGreaterThan(256 * 1024);
			expect(parseCodexTranscriptLine(line)).toBeNull();
		});
		it('parses a line under the byte cap but truncates its large content', () => {
			const line = JSON.stringify({
				isSidechain: false,
				type: 'assistant',
				message: { role: 'assistant', content: 'w'.repeat(150000) },
				uuid: 'mid1',
				timestamp: 't',
			});
			expect(line.length).toBeLessThan(256 * 1024);
			const m = parseClaudeTranscriptLine(line);
			expect(m).not.toBeNull();
			expect(m?.content.length).toBe(100000);
		});
		it('parses a normal line unaffected by the caps', () => {
			const line = JSON.stringify({
				isSidechain: false,
				type: 'assistant',
				message: { role: 'assistant', content: 'short and sweet' },
				uuid: 'ok1',
				timestamp: 't',
			});
			expect(parseClaudeTranscriptLine(line)?.content).toBe('short and sweet');
		});
	});
});
