import { stripEmojis } from '../emojiUtils';
import { stripMarkdown } from '../markdown';
import { stripAnsiCodes } from '../stringUtils';

/**
 * Written presentation to spoken prose, shared by sessions and notices.
 * Keep punctuation, accents, numbers and units: each voice's native front end
 * owns their pronunciation. Do not send SSML to a provider that expects text.
 */
export function prepareSpeechText(text: string): string {
	const prose = stripAnsiCodes(text)
		// Code/diagrams and images belong to the written answer, not the speaker.
		.replace(/^\s*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\s*\1\s*$/gm, ' ')
		.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
		.replace(/^\s*::[\w-]+\{[^\n]*\}\s*$/gm, ' ')
		.replace(/\[!(?:NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/g, '')
		// Strip markup before markdown so an HTML attribute cannot become speech.
		.replace(/<\/?[A-Za-z][^>]*>/g, '')
		.replace(
			/&(amp|lt|gt|quot|apos|nbsp);/g,
			(_, entity: string) =>
				({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' })[entity] ?? ''
		);
	const plain = stripEmojis(stripMarkdown(prose, { tables: 'flatten' }))
		.replace(/https?:\/\/\S+/g, ' ')
		.replace(/^\s*(?:[-+*]\s+|\d+[.)]\s+)(?:\[[ xX]\]\s*)?/gm, '')
		.replace(/^\s*[-*_]{3,}\s*$/gm, '')
		.replace(/\s+([,.;:!?])/g, '$1')
		.replace(/\s+/g, ' ')
		.trim();
	return /[\p{L}\p{N}]/u.test(plain) ? plain : '';
}
