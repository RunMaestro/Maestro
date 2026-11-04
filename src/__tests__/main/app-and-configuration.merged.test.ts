// Consolidated from current rc sources; per-source hooks and state stay in an unnamed suite.
// Source: src/__tests__/main/concerto-html.test.ts
// Source: src/__tests__/main/constants.test.ts
// Source: src/__tests__/main/themes.test.ts
import { describe, beforeEach, expect, it, vi, afterEach } from 'vitest';
import {
	applyCadenzaHtmlPayload,
	applyMovementHtmlPayload,
	attachConcertoHtmlNavigationGuard,
	clearConcertoHtmlDocumentsForTests,
	CODEX_VISUALIZATION_CSP,
	CONCERTO_HTML_CSP,
	createConcertoHtmlResponse,
	getConcertoHtmlDocumentRevision,
	injectConcertoDesignerBootstrap,
	MAX_CONCERTO_HTML_BYTES,
	MAX_CONCERTO_HTML_DOCUMENTS,
	MAX_CODEX_VISUALIZATION_DOCUMENTS,
	registerCodexVisualizationDocument,
	releaseConcertoHtmlDocument,
	restoreConcertoHtmlDocument,
} from '../../main/concerto-html';
import { buildConcertoHtmlUrl, CONCERTO_DESIGNER_CHANNEL } from '../../shared/concerto-html';
import {
	REGEX_MODERATOR_SESSION,
	REGEX_MODERATOR_SESSION_TIMESTAMP,
	REGEX_PARTICIPANT_UUID,
	REGEX_PARTICIPANT_TIMESTAMP,
	REGEX_PARTICIPANT_FALLBACK,
	REGEX_AI_SUFFIX,
	REGEX_AI_TAB_ID,
	debugLog,
	MAX_GROUP_CHAT_BUFFER_SIZE,
	resolveSharedDataPath,
} from '../../main/constants';
import { THEMES, getThemeById } from '../../main/themes';
// Source: src/__tests__/main/concerto-html.test.ts
describe('', () => {
	describe('Concerto HTML document protocol', () => {
		beforeEach(clearConcertoHtmlDocumentsForTests);
		it('serves inline CSS and JavaScript with a restrictive response policy', async () => {
			const html =
				'<style>button{color:red}</style><button>Buy</button><script>window.ready=true</script>';
			applyMovementHtmlPayload({
				op: 'add',
				id: 'mockup',
				viewType: 'html',
				body: html,
			});
			const response = createConcertoHtmlResponse(buildConcertoHtmlUrl('movement', 'mockup', 1));
			expect(response.status).toBe(200);
			const served = await response.text();
			expect(served).toContain(html);
			expect(served).toContain(CONCERTO_DESIGNER_CHANNEL);
			expect(served).toContain("data.action === 'click'");
			expect(served.indexOf("'RTCPeerConnection'")).toBeLessThan(
				served.indexOf('window.ready=true')
			);
			expect(response.headers.get('content-security-policy')).toBe(CONCERTO_HTML_CSP);
			expect(CONCERTO_HTML_CSP).toContain("script-src 'unsafe-inline' blob:");
			expect(CONCERTO_HTML_CSP).toContain("connect-src 'none'");
			expect(CONCERTO_HTML_CSP).toContain("webrtc 'block'");
			expect(CONCERTO_HTML_CSP).toContain("frame-src 'none'");
			expect(CONCERTO_HTML_CSP).toContain('sandbox allow-scripts');
			expect(response.headers.get('x-dns-prefetch-control')).toBe('off');
		});
		it('updates an existing HTML document without requiring viewType again', async () => {
			applyCadenzaHtmlPayload({
				op: 'open',
				id: 'mini',
				viewType: 'html',
				body: '<button>First</button>',
			});
			applyCadenzaHtmlPayload({ op: 'update', id: 'mini', body: '<button>Second</button>' });
			const response = createConcertoHtmlResponse(buildConcertoHtmlUrl('cadenza', 'mini', 2));
			expect(await response.text()).toContain('<button>Second</button>');
		});
		it('injects the designer harness at the start of head', () => {
			const result = injectConcertoDesignerBootstrap(
				'<!doctype html><html><head><title>Mockup</title></head><body></body></html>'
			);
			expect(result.indexOf(CONCERTO_DESIGNER_CHANNEL)).toBeGreaterThan(result.indexOf('<head>'));
			expect(result.indexOf(CONCERTO_DESIGNER_CHANNEL)).toBeLessThan(result.indexOf('<title>'));
		});
		it('removes documents and rejects oversized payloads', () => {
			applyMovementHtmlPayload({
				op: 'add',
				id: 'mockup',
				viewType: 'html',
				body: '<p>ok</p>',
			});
			applyMovementHtmlPayload({ op: 'remove', id: 'mockup' });
			expect(createConcertoHtmlResponse(buildConcertoHtmlUrl('movement', 'mockup', 1)).status).toBe(
				404
			);
			expect(() =>
				applyMovementHtmlPayload({
					op: 'add',
					id: 'too-large',
					viewType: 'html',
					body: 'x'.repeat(MAX_CONCERTO_HTML_BYTES + 1),
				})
			).toThrow(/size limit/);
		});
		it('assigns a new revision whenever HTML content changes', () => {
			const first = applyMovementHtmlPayload({
				op: 'add',
				id: 'mockup',
				viewType: 'html',
				body: '<p>first</p>',
			});
			const second = applyMovementHtmlPayload({
				op: 'update',
				id: 'mockup',
				body: '<p>second</p>',
			});
			expect(first.revision).toBe(1);
			expect(second.revision).toBe(2);
			expect(getConcertoHtmlDocumentRevision('movement', 'mockup')).toBe(2);
		});
		it('restores a released document with a fresh revision', async () => {
			applyMovementHtmlPayload({
				op: 'add',
				id: 'mockup',
				viewType: 'html',
				body: '<p>original</p>',
			});
			releaseConcertoHtmlDocument('movement', 'mockup');
			const revision = restoreConcertoHtmlDocument('movement', 'mockup', '<p>fresh</p>');
			expect(revision).toBe(2);
			const response = createConcertoHtmlResponse(
				buildConcertoHtmlUrl('movement', 'mockup', revision)
			);
			expect(response.status).toBe(200);
			expect(await response.text()).toContain('<p>fresh</p>');
		});
		it('rejects capacity instead of evicting a live document and accepts explicit release', () => {
			for (let index = 0; index < MAX_CONCERTO_HTML_DOCUMENTS; index += 1) {
				applyMovementHtmlPayload({
					op: 'add',
					id: `mockup-${index}`,
					viewType: 'html',
					body: `<p>${index}</p>`,
				});
			}
			expect(() =>
				applyMovementHtmlPayload({
					op: 'add',
					id: 'overflow',
					viewType: 'html',
					body: '<p>overflow</p>',
				})
			).toThrow(/document limit reached/);
			expect(
				createConcertoHtmlResponse(buildConcertoHtmlUrl('movement', 'mockup-0', 1)).status
			).toBe(200);
			releaseConcertoHtmlDocument('movement', 'mockup-0');
			expect(
				createConcertoHtmlResponse(buildConcertoHtmlUrl('movement', 'mockup-0', 1)).status
			).toBe(404);
			expect(() =>
				applyMovementHtmlPayload({
					op: 'add',
					id: 'replacement',
					viewType: 'html',
					body: '<p>replacement</p>',
				})
			).not.toThrow();
		});
		it('blocks an HTML frame from navigating away from the local protocol', () => {
			let guard:
				| ((details: {
						preventDefault: () => void;
						isMainFrame: boolean;
						url: string;
						frame: {
							url: string;
						} | null;
						initiator: {
							url: string;
						} | null;
				  }) => void)
				| undefined;
			const webContents = {
				on: vi.fn((name: string, listener: typeof guard) => {
					if (name === 'will-frame-navigate') guard = listener;
				}),
			};
			attachConcertoHtmlNavigationGuard(webContents as never);
			const preventDefault = vi.fn();
			guard?.({
				preventDefault,
				isMainFrame: false,
				url: 'https://example.com/exfiltrate',
				frame: { url: buildConcertoHtmlUrl('movement', 'mockup', 1) },
				initiator: null,
			});
			expect(preventDefault).toHaveBeenCalledOnce();
			guard?.({
				preventDefault,
				isMainFrame: true,
				url: 'https://example.com/top-navigation',
				frame: { url: 'file:///maestro/index.html' },
				initiator: { url: buildConcertoHtmlUrl('movement', 'mockup', 1) },
			});
			expect(preventDefault).toHaveBeenCalledTimes(2);
		});
		it('serves a Codex visualization under its own CDN-allowlist policy', async () => {
			const revision = registerCodexVisualizationDocument('viz', '<div id="v">chart</div>');
			const response = createConcertoHtmlResponse(
				buildConcertoHtmlUrl('visualization', 'viz', revision)
			);
			expect(response.status).toBe(200);
			expect(await response.text()).toContain('<div id="v">chart</div>');
			const csp = response.headers.get('content-security-policy');
			expect(csp).toBe(CODEX_VISUALIZATION_CSP);
			expect(csp).toContain('https://unpkg.com');
			expect(csp).toContain('connect-src blob: data:');
			expect(csp).toContain("webrtc 'block'");
			expect(csp).toContain('sandbox allow-scripts');
		});
		it('keeps a visualization revision while its HTML is unchanged', () => {
			const first = registerCodexVisualizationDocument('viz', '<p>a</p>');
			expect(registerCodexVisualizationDocument('viz', '<p>a</p>')).toBe(first);
			expect(registerCodexVisualizationDocument('viz', '<p>b</p>')).toBeGreaterThan(first);
		});
		it('evicts the oldest visualization instead of filling the registry', () => {
			for (let i = 0; i <= MAX_CODEX_VISUALIZATION_DOCUMENTS; i += 1) {
				registerCodexVisualizationDocument(`viz-${i}`, `<p>${i}</p>`);
			}
			expect(getConcertoHtmlDocumentRevision('visualization', 'viz-0')).toBeNull();
			expect(
				getConcertoHtmlDocumentRevision('visualization', `viz-${MAX_CODEX_VISUALIZATION_DOCUMENTS}`)
			).not.toBeNull();
			expect(getConcertoHtmlDocumentRevision('visualization', 'viz-1')).not.toBeNull();
		});
	});
});
// Source: src/__tests__/main/constants.test.ts
describe('', () => {
	describe('main/constants', () => {
		describe('resolveSharedDataPath', () => {
			it('shares the install data directory outside demo mode', () => {
				expect(resolveSharedDataPath('/data/maestro', { enabled: false, path: '/tmp/demo' })).toBe(
					'/data/maestro'
				);
			});
			it('keeps a demo profile sealed inside its own directory', () => {
				expect(resolveSharedDataPath('/data/maestro', { enabled: true, path: '/tmp/demo' })).toBe(
					'/tmp/demo'
				);
			});
		});
		// groupChatId is ALWAYS a uuidv4() in production (see group-chat-storage.ts).
		// The regexes now anchor on the UUID format to eliminate greedy-backtrack
		// ambiguity when participant names contain sentinel substrings like
		// "-participant-". Fixtures use real UUIDs accordingly.
		const GC_ID = '550e8400-e29b-41d4-a716-446655440000';
		const GC_ID_2 = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
		describe('REGEX_MODERATOR_SESSION', () => {
			it('should match moderator session IDs', () => {
				const match = `group-chat-${GC_ID}-moderator-1702934567890`.match(REGEX_MODERATOR_SESSION);
				expect(match).not.toBeNull();
				expect(match![1]).toBe(GC_ID);
			});
			it('should match moderator synthesis session IDs', () => {
				const match = `group-chat-${GC_ID}-moderator-synthesis-1702934567890`.match(
					REGEX_MODERATOR_SESSION
				);
				expect(match).not.toBeNull();
				expect(match![1]).toBe(GC_ID);
			});
			it('should not match participant session IDs', () => {
				const match = `group-chat-${GC_ID}-participant-Claude-1702934567890`.match(
					REGEX_MODERATOR_SESSION
				);
				expect(match).toBeNull();
			});
			it('should not match regular session IDs', () => {
				const match = 'session-abc123'.match(REGEX_MODERATOR_SESSION);
				expect(match).toBeNull();
			});
			it('should not match non-UUID groupChatId (strict UUID anchor)', () => {
				const match = 'group-chat-abc123-moderator-1702934567890'.match(REGEX_MODERATOR_SESSION);
				expect(match).toBeNull();
			});
		});
		describe('REGEX_MODERATOR_SESSION_TIMESTAMP', () => {
			it('should match moderator session IDs with timestamp suffix', () => {
				const match = `group-chat-${GC_ID}-moderator-1702934567890`.match(
					REGEX_MODERATOR_SESSION_TIMESTAMP
				);
				expect(match).not.toBeNull();
				expect(match![1]).toBe(GC_ID);
			});
			it('should not match moderator synthesis session IDs', () => {
				// This pattern expects only digits after "moderator-"
				const match = `group-chat-${GC_ID}-moderator-synthesis-1702934567890`.match(
					REGEX_MODERATOR_SESSION_TIMESTAMP
				);
				expect(match).toBeNull();
			});
			it('should not match session IDs without timestamp', () => {
				const match = `group-chat-${GC_ID}-moderator-`.match(REGEX_MODERATOR_SESSION_TIMESTAMP);
				expect(match).toBeNull();
			});
		});
		describe('REGEX_PARTICIPANT_UUID', () => {
			it('should match participant session IDs with UUID suffix', () => {
				const match = `group-chat-${GC_ID}-participant-Claude-${GC_ID_2}`.match(
					REGEX_PARTICIPANT_UUID
				);
				expect(match).not.toBeNull();
				expect(match![1]).toBe(GC_ID);
				expect(match![2]).toBe('Claude');
				expect(match![3]).toBe(GC_ID_2);
			});
			it('should match participant with hyphenated name and UUID', () => {
				const match = `group-chat-${GC_ID}-participant-OpenCode-Ollama-${GC_ID_2}`.match(
					REGEX_PARTICIPANT_UUID
				);
				expect(match).not.toBeNull();
				expect(match![1]).toBe(GC_ID);
				expect(match![2]).toBe('OpenCode-Ollama');
			});
			it('should be case-insensitive for UUID', () => {
				const match = `group-chat-${GC_ID}-participant-Claude-${GC_ID_2.toUpperCase()}`.match(
					REGEX_PARTICIPANT_UUID
				);
				expect(match).not.toBeNull();
			});
			it('should not match timestamp suffix as UUID', () => {
				const match = `group-chat-${GC_ID}-participant-Claude-1702934567890`.match(
					REGEX_PARTICIPANT_UUID
				);
				expect(match).toBeNull();
			});
			it('should resist name containing "-participant-" sentinel', () => {
				// Adversarial: a participant name that literally contains "-participant-"
				// used to mis-parse under the old greedy (.+) capture. With the UUID
				// anchor on groupChatId the split is unambiguous.
				const match = `group-chat-${GC_ID}-participant-evil-participant-name-${GC_ID_2}`.match(
					REGEX_PARTICIPANT_UUID
				);
				expect(match).not.toBeNull();
				expect(match![1]).toBe(GC_ID);
				expect(match![2]).toBe('evil-participant-name');
			});
		});
		describe('REGEX_PARTICIPANT_TIMESTAMP', () => {
			it('should match participant session IDs with timestamp suffix', () => {
				const match = `group-chat-${GC_ID}-participant-Claude-1702934567890`.match(
					REGEX_PARTICIPANT_TIMESTAMP
				);
				expect(match).not.toBeNull();
				expect(match![1]).toBe(GC_ID);
				expect(match![2]).toBe('Claude');
				expect(match![3]).toBe('1702934567890');
			});
			it('should match participant with hyphenated name and timestamp', () => {
				const match = `group-chat-${GC_ID}-participant-OpenCode-Ollama-1702934567890`.match(
					REGEX_PARTICIPANT_TIMESTAMP
				);
				expect(match).not.toBeNull();
				expect(match![1]).toBe(GC_ID);
				expect(match![2]).toBe('OpenCode-Ollama');
			});
			it('should require at least 13 digits for timestamp', () => {
				const shortTimestamp = `group-chat-${GC_ID}-participant-Claude-170293456`.match(
					REGEX_PARTICIPANT_TIMESTAMP
				);
				expect(shortTimestamp).toBeNull();
				const longTimestamp = `group-chat-${GC_ID}-participant-Claude-17029345678901`.match(
					REGEX_PARTICIPANT_TIMESTAMP
				);
				expect(longTimestamp).not.toBeNull();
			});
			it('should resist name containing "-participant-" sentinel', () => {
				const match = `group-chat-${GC_ID}-participant-evil-participant-name-1702934567890`.match(
					REGEX_PARTICIPANT_TIMESTAMP
				);
				expect(match).not.toBeNull();
				expect(match![1]).toBe(GC_ID);
				expect(match![2]).toBe('evil-participant-name');
			});
		});
		describe('REGEX_PARTICIPANT_FALLBACK', () => {
			it('should match basic participant session IDs', () => {
				const match = `group-chat-${GC_ID}-participant-Claude-anything`.match(
					REGEX_PARTICIPANT_FALLBACK
				);
				expect(match).not.toBeNull();
				expect(match![1]).toBe(GC_ID);
				expect(match![2]).toBe('Claude');
			});
			it('should only capture first segment for hyphenated names', () => {
				// Fallback is for backwards compatibility with non-hyphenated names
				const match = `group-chat-${GC_ID}-participant-OpenCode-Ollama-1702934567890`.match(
					REGEX_PARTICIPANT_FALLBACK
				);
				expect(match).not.toBeNull();
				expect(match![1]).toBe(GC_ID);
				expect(match![2]).toBe('OpenCode'); // Only captures up to first hyphen
			});
			it('should not match non-UUID groupChatId', () => {
				const match = 'group-chat-abc123-participant-Claude-anything'.match(
					REGEX_PARTICIPANT_FALLBACK
				);
				expect(match).toBeNull();
			});
		});
		describe('REGEX_AI_SUFFIX', () => {
			it('should match session IDs with -ai- suffix and any tab ID format', () => {
				expect('session-123-ai-tab1'.match(REGEX_AI_SUFFIX)).not.toBeNull();
				expect('session-123-ai-abc123def'.match(REGEX_AI_SUFFIX)).not.toBeNull();
				expect(
					'51cee651-6629-4de8-abdd-1c1540555f2d-ai-73aaeb23-6673-45a4-8fdf-c769802f79bb'.match(
						REGEX_AI_SUFFIX
					)
				).not.toBeNull();
			});
			it('should not match session IDs without -ai- suffix', () => {
				expect('session-123-terminal'.match(REGEX_AI_SUFFIX)).toBeNull();
				expect('session-123'.match(REGEX_AI_SUFFIX)).toBeNull();
			});
			it('should correctly strip -ai- suffix to extract base session ID', () => {
				const sessionId =
					'51cee651-6629-4de8-abdd-1c1540555f2d-ai-73aaeb23-6673-45a4-8fdf-c769802f79bb';
				expect(sessionId.replace(REGEX_AI_SUFFIX, '')).toBe('51cee651-6629-4de8-abdd-1c1540555f2d');
			});
		});
		describe('REGEX_AI_TAB_ID', () => {
			it('should extract simple tab ID from session ID', () => {
				const match = 'session-123-ai-tab1'.match(REGEX_AI_TAB_ID);
				expect(match).not.toBeNull();
				expect(match![1]).toBe('tab1');
			});
			it('should extract UUID tab ID from session ID', () => {
				const match =
					'51cee651-6629-4de8-abdd-1c1540555f2d-ai-73aaeb23-6673-45a4-8fdf-c769802f79bb'.match(
						REGEX_AI_TAB_ID
					);
				expect(match).not.toBeNull();
				expect(match![1]).toBe('73aaeb23-6673-45a4-8fdf-c769802f79bb');
			});
		});
		describe('debugLog', () => {
			let consoleSpy: ReturnType<typeof vi.spyOn>;
			beforeEach(() => {
				consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
			});
			afterEach(() => {
				consoleSpy.mockRestore();
			});
			it('should be a function', () => {
				expect(typeof debugLog).toBe('function');
			});
			it('should accept prefix, message, and additional args', () => {
				// Function should not throw regardless of DEBUG_GROUP_CHAT value
				expect(() => debugLog('TestPrefix', 'Test message', { extra: 'data' })).not.toThrow();
			});
			it('should format message with prefix when called', () => {
				debugLog('TestPrefix', 'Test message');
				// If DEBUG_GROUP_CHAT is true, it will log; if false, it won't
				// We're just testing it doesn't throw
			});
		});
		describe('MAX_GROUP_CHAT_BUFFER_SIZE', () => {
			it('should be defined', () => {
				expect(MAX_GROUP_CHAT_BUFFER_SIZE).toBeDefined();
			});
			it('should be 10MB (10 * 1024 * 1024 bytes)', () => {
				expect(MAX_GROUP_CHAT_BUFFER_SIZE).toBe(10 * 1024 * 1024);
			});
			it('should be a positive number', () => {
				expect(MAX_GROUP_CHAT_BUFFER_SIZE).toBeGreaterThan(0);
			});
		});
	});
});
// Source: src/__tests__/main/themes.test.ts
describe('', () => {
	describe('themes.ts', () => {
		describe('THEMES constant', () => {
			it('should export themes matching renderer themes', () => {
				expect(Object.keys(THEMES).length).toBeGreaterThan(0);
			});
		});
		describe('getThemeById', () => {
			it('should return a theme for valid theme IDs', () => {
				const theme = getThemeById('dracula');
				expect(theme).not.toBeNull();
				expect(theme?.id).toBe('dracula');
			});
			it('should return null for unknown theme IDs', () => {
				expect(getThemeById('nonexistent-theme')).toBeNull();
				expect(getThemeById('')).toBeNull();
			});
			it('should return the exact same object from THEMES', () => {
				const themeId = 'nord';
				expect(getThemeById(themeId)).toBe(THEMES[themeId]);
			});
			it('should work for all theme IDs', () => {
				for (const themeId of Object.keys(THEMES)) {
					const theme = getThemeById(themeId);
					expect(theme).not.toBeNull();
					expect(theme?.id).toBe(themeId);
				}
			});
		});
	});
});
