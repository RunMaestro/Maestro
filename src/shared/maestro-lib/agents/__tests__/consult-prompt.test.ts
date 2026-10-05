import { describe, expect, it } from 'vitest';
import type { CrossAgentRequest, CrossAgentTranscriptEntry } from '../../../crossAgentTypes';
import {
	buildConsultHistoryEntry,
	buildConsultTabName,
	buildCrossAgentPrompt,
	crossAgentTerminationNote,
	serializeTranscript,
} from '../consult-prompt';

/** Pure prompt assembly and wording for a cross-agent consult. */

const entry = (source: string, text?: string): CrossAgentTranscriptEntry => ({ source, text });

function request(overrides: Partial<CrossAgentRequest> = {}): CrossAgentRequest {
	return {
		requestId: 'r1',
		sourceSessionId: 'src',
		sourceTabId: 'tab',
		targetSessionId: 'tgt',
		userPrompt: 'What is your take?',
		transcript: [],
		strategy: { kind: 'full' },
		createdAt: 0,
		...overrides,
	};
}

describe('serializeTranscript', () => {
	it('labels user and assistant turns', () => {
		const out = serializeTranscript([entry('user', 'Hi'), entry('ai', 'Hello there')]);
		expect(out).toBe('**User:** Hi\n**Assistant:** Hello there');
	});

	it('drops entries with no visible text', () => {
		const out = serializeTranscript([
			entry('user', 'Question'),
			entry('ai', '   '),
			entry('ai', undefined),
			entry('tool'),
		]);
		expect(out).toBe('**User:** Question');
	});

	it('keeps tool/thinking entries only when they carry visible text', () => {
		const out = serializeTranscript([
			entry('thinking', 'pondering...'),
			entry('tool', 'ran a search'),
		]);
		expect(out).toContain('pondering...');
		expect(out).toContain('ran a search');
	});

	it('returns an empty string for an empty transcript', () => {
		expect(serializeTranscript([])).toBe('');
	});
});

describe('buildCrossAgentPrompt', () => {
	it('prepends the consult header, then transcript, then the relayed question', () => {
		const prompt = buildCrossAgentPrompt(
			request({
				transcript: [entry('user', 'Hi'), entry('ai', 'Yo')],
				userPrompt: 'Thoughts?',
			})
		);
		expect(prompt).toMatch(/^You are being consulted by another agent in Maestro\./);
		expect(prompt).toContain('**User:** Hi');
		expect(prompt).toContain('**Assistant:** Yo');
		expect(prompt).toContain(
			'**Question from the user (relayed via the source agent):**\nThoughts?'
		);
		// The header comes before the transcript, which comes before the question.
		expect(prompt.indexOf('consulted')).toBeLessThan(prompt.indexOf('**User:** Hi'));
		expect(prompt.indexOf('**Assistant:** Yo')).toBeLessThan(
			prompt.indexOf('Question from the user')
		);
	});

	it('omits the transcript block entirely when there is nothing to forward', () => {
		const prompt = buildCrossAgentPrompt(request({ transcript: [], userPrompt: 'Just this' }));
		expect(prompt).toContain('You are being consulted');
		expect(prompt).toContain('Just this');
		// No stray blank transcript section: header flows straight into the question.
		expect(prompt).not.toContain('**User:**');
	});

	it('does not announce a transcript when none was forwarded', () => {
		// `maestro-cli ask` sends a self-contained question with no transcript.
		// Telling the target to read "the conversation transcript so far" sends it
		// hunting for context that is not in the prompt.
		const prompt = buildCrossAgentPrompt(request({ transcript: [], userPrompt: 'Just this' }));
		expect(prompt).toContain('no prior conversation to read');
		expect(prompt).not.toContain('conversation transcript so far');
	});

	it('still announces the transcript when one was forwarded', () => {
		const prompt = buildCrossAgentPrompt(
			request({ transcript: [entry('user', 'Hi')], userPrompt: 'Thoughts?' })
		);
		expect(prompt).toContain('conversation transcript so far');
		expect(prompt).not.toContain('no prior conversation to read');
	});

	it('grants read access to the source cwd when forwarded, before the question', () => {
		const prompt = buildCrossAgentPrompt(
			request({ sourceCwd: '/Users/me/proj', userPrompt: 'Look at the config' })
		);
		expect(prompt).toContain('`/Users/me/proj`');
		expect(prompt).toContain('permission to READ');
		expect(prompt).toContain('Do NOT modify or create files');
		// The grant rides with the header, ahead of the relayed question.
		expect(prompt.indexOf('/Users/me/proj')).toBeLessThan(prompt.indexOf('Look at the config'));
	});

	it('omits the cwd grant entirely when no source cwd is forwarded', () => {
		const prompt = buildCrossAgentPrompt(request({ sourceCwd: undefined }));
		expect(prompt).not.toContain('permission to READ');
	});

	it('tells the target how to lift the read-only restriction when read-only', () => {
		const prompt = buildCrossAgentPrompt(
			request({ sourceCwd: '/Users/me/proj', userPrompt: 'Fix the bug' })
		);
		expect(prompt).toContain('Settings > General > Cross-Agent Mentions');
		// The remedy has to name the setting as the user sees it in Settings, or
		// the target sends them hunting for a control that is labeled otherwise.
		expect(prompt).toContain('Consult or Delegate');
	});

	it('names the read-only mode a consult so the target can say which mode it is in', () => {
		const prompt = buildCrossAgentPrompt(
			request({ sourceCwd: '/Users/me/proj', userPrompt: 'Fix the bug' })
		);
		expect(prompt).toContain('consults (read-only)');
		expect(prompt).not.toContain('DELEGATION');
	});

	it('grants write access and drops the prohibition when writable is opted into', () => {
		const prompt = buildCrossAgentPrompt(
			request({ sourceCwd: '/Users/me/proj', userPrompt: 'Fix the bug' }),
			true
		);
		expect(prompt).toContain('permission to READ and MODIFY');
		expect(prompt).not.toContain('Do NOT modify or create files');
		expect(prompt).not.toContain('Settings > General > Cross-Agent Mentions');
	});

	it('names the writable mode a delegation so the target knows it may apply changes', () => {
		const prompt = buildCrossAgentPrompt(
			request({ sourceCwd: '/Users/me/proj', userPrompt: 'Fix the bug' }),
			true
		);
		expect(prompt).toContain('DELEGATION');
	});
});

describe('crossAgentTerminationNote', () => {
	const base = { targetAgentName: 'Maestro Marketing' };

	it('is null for a consult that simply finished', () => {
		expect(crossAgentTerminationNote(base)).toBeNull();
	});

	it('words a failure as the target not responding, with the reason', () => {
		expect(crossAgentTerminationNote({ ...base, error: 'timed out' })).toBe(
			'⚠️ Maestro Marketing could not respond: timed out'
		);
	});

	it('words Stop apart from a failure, and Stop wins', () => {
		// The user pressing Stop is not the target failing to answer.
		const note = crossAgentTerminationNote({ ...base, canceled: true, error: 'ignored' });
		expect(note).toBe('⏹ Maestro Marketing was stopped.');
	});
});

describe('buildConsultTabName', () => {
	it('marks an inbound consult and names who it came from', () => {
		expect(buildConsultTabName('Pedsidian')).toBe('↩ Pedsidian');
	});
});

describe('buildConsultHistoryEntry', () => {
	function entry(overrides: Partial<Parameters<typeof buildConsultHistoryEntry>[0]> = {}) {
		return buildConsultHistoryEntry({
			entryId: 'e1',
			timestamp: 1_700_000_000_000,
			sourceAgentName: 'Pedsidian',
			subject: 'why was the export empty',
			accumulated: 'Because the grooming agent timed out.',
			historySessionId: 'tgt',
			projectPath: '/repo',
			...overrides,
		});
	}

	it('records a consult as AGENT, not AUTO', () => {
		// A consult is an ordinary message proxied in from another agent. Typing it
		// AUTO made it render as an Auto Run task and inflated the Auto Run counts.
		expect(entry().type).toBe('AGENT');
	});

	it('names who consulted and about what', () => {
		expect(entry().summary).toBe('Consulted by Pedsidian: why was the export empty');
		expect(entry().sessionName).toBe('↩ why was the export empty');
	});

	it('falls back to the consult tab name when there is no subject', () => {
		const e = entry({ subject: '', consultTabName: '↩ Pedsidian', targetName: 'rc' });
		expect(e.summary).toBe('Consulted by Pedsidian');
		expect(e.sessionName).toBe('↩ Pedsidian');
	});

	it('falls back to the target agent name when there is no tab name either', () => {
		expect(entry({ subject: '', targetName: 'rc' }).sessionName).toBe('rc');
	});

	it('marks a clean consult successful and keeps the response as the detail', () => {
		const e = entry();
		expect(e.success).toBe(true);
		expect(e.fullResponse).toBe('Because the grooming agent timed out.');
	});

	it('persists the failure reason for a consult that never answered', () => {
		// Regression: failures accumulate no text, so the reason (which lives only
		// on the chunk) was dropped - leaving a red X with an empty detail view.
		const e = entry({ accumulated: '', error: 'Codex is not available.' });
		expect(e.success).toBe(false);
		expect(e.fullResponse).toContain('Codex is not available.');
	});

	it('keeps BOTH the partial answer and the reason when a consult fails mid-stream', () => {
		const e = entry({ accumulated: 'I started to look and', error: 'timed out' });
		expect(e.fullResponse).toContain('I started to look and');
		expect(e.fullResponse).toContain('timed out');
	});

	it('leaves the detail undefined when there is nothing to show', () => {
		expect(entry({ accumulated: '' }).fullResponse).toBeUndefined();
	});

	it('records a stopped consult as a success with a note, not as a failure', () => {
		// The user pressing Stop is their own decision; logging it against the
		// target as a failed consult misattributes it.
		const e = entry({ accumulated: '', canceled: true });
		expect(e.success).toBe(true);
		expect(e.fullResponse).toContain('stopped by the user');
	});

	it('keeps a stopped consult partial answer alongside the stop note', () => {
		const e = entry({ accumulated: 'I got as far as', canceled: true });
		expect(e.fullResponse).toContain('I got as far as');
		expect(e.fullResponse).toContain('stopped by the user');
	});

	it('stamps the calling agent so the target remembers who consulted it', () => {
		expect(entry().sourceAgentName).toBe('Pedsidian');
	});
});
