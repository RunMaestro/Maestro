/**
 * @file groupChatExport.ts
 * @description Export utility for Group Chat conversations.
 *
 * Generates a self-contained HTML file with the user's current theme colors
 * and properly rendered GitHub Flavored Markdown content using the marked library.
 */

import { marked } from 'marked';
import type { GroupChat, GroupChatMessage, GroupChatHistoryEntry, Theme } from '../types';

// Configure marked for GFM (tables, strikethrough, etc.)
marked.setOptions({
	gfm: true,
	breaks: true,
});

/**
 * Escape HTML special characters
 */
function escapeHtml(text: string): string {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#039;');
}

/**
 * Format a timestamp for display
 */
function formatTimestamp(timestamp: string | number): string {
	const date = new Date(timestamp);
	return date.toLocaleString();
}

/**
 * Format duration from milliseconds
 */
function formatDuration(messages: GroupChatMessage[]): string {
	if (messages.length < 2) return '0m';

	const firstTimestamp = new Date(messages[0].timestamp).getTime();
	const lastTimestamp = new Date(messages[messages.length - 1].timestamp).getTime();
	const durationMs = lastTimestamp - firstTimestamp;
	const durationHours = Math.floor(durationMs / (1000 * 60 * 60));
	const durationMins = Math.floor((durationMs % (1000 * 60 * 60)) / (1000 * 60));

	return durationHours > 0 ? `${durationHours}h ${durationMins}m` : `${durationMins}m`;
}

/**
 * Get participant color or default
 */
function getParticipantColor(groupChat: GroupChat, from: string, theme: Theme): string {
	if (from === 'user') return theme.colors.accent;
	if (from === 'moderator') return theme.colors.warning;

	const participant = groupChat.participants.find(
		(p) => p.name.toLowerCase() === from.toLowerCase()
	);
	return participant?.color || theme.colors.textDim;
}

/**
 * Escape special regex characters in a string
 */
function escapeRegExp(string: string): string {
	return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Process content to embed images and render markdown
 */
function formatContent(content: string, images: Record<string, string> = {}): string {
	let processed = content;

	// Replace image references with base64 data URLs before markdown processing
	for (const [filename, dataUrl] of Object.entries(images)) {
		// Replace markdown image syntax ![alt](path/to/filename)
		processed = processed.replace(
			new RegExp(`!\\[([^\\]]*)\\]\\([^)]*${escapeRegExp(filename)}[^)]*\\)`, 'g'),
			`![${filename}](${dataUrl})`
		);
		// Replace [Image: filename] pattern
		processed = processed.replace(
			new RegExp(`\\[Image:\\s*${escapeRegExp(filename)}\\s*\\]`, 'gi'),
			`![${filename}](${dataUrl})`
		);
	}

	// Render markdown to HTML using marked (synchronous)
	const html = marked.parse(processed, { async: false }) as string;

	return html;
}

/**
 * Generate the HTML export content with theme colors
 */
export function generateGroupChatExportHtml(
	groupChat: GroupChat,
	messages: GroupChatMessage[],
	_history: GroupChatHistoryEntry[],
	images: Record<string, string>,
	theme: Theme
): string {
	// Calculate stats
	const userMessages = messages.filter((m) => m.from === 'user').length;
	const agentMessages = messages.filter((m) => m.from !== 'user' && m.from !== 'moderator').length;

	const stats = {
		participantCount: groupChat.participants.length,
		totalMessages: messages.length,
		agentMessages,
		userMessages,
		duration: formatDuration(messages),
	};

	// Generate messages HTML with embedded images
	const messagesHtml = messages
		.map((msg) => {
			const color = getParticipantColor(groupChat, msg.from, theme);
			const isUser = msg.from === 'user';

			// Format content with images map for embedding
			const formattedContent = formatContent(msg.content, images);

			return `
      <div class="message ${isUser ? 'message-user' : 'message-agent'}">
        <div class="message-header">
          <span class="message-from" style="color: ${color}">${escapeHtml(msg.from)}</span>
          <span class="message-time">${formatTimestamp(msg.timestamp)}</span>
          ${msg.readOnly ? '<span class="read-only-badge">read-only</span>' : ''}
        </div>
        <div class="message-content">${formattedContent}</div>
      </div>`;
		})
		.join('\n');

	// Generate participants HTML
	const participantsHtml = groupChat.participants
		.map((p) => {
			return `
      <div class="participant">
        <span class="participant-color" style="background-color: ${p.color || theme.colors.textDim}"></span>
        <span class="participant-name">${escapeHtml(p.name)}</span>
        <span class="participant-agent">${escapeHtml(p.agentId)}</span>
      </div>`;
		})
		.join('\n');

	// Build HTML document with theme colors
	const colors = theme.colors;

	// Maestro app icon as base64 PNG (72x72)
	const maestroIconBase64 =
		'data:image/png;base64,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';

	return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(groupChat.name)} - Maestro Group Chat Export</title>
  <style>
    :root {
      --bg-primary: ${colors.bgMain};
      --bg-secondary: ${colors.bgSidebar};
      --bg-tertiary: ${colors.bgActivity};
      --text-primary: ${colors.textMain};
      --text-secondary: ${colors.textDim};
      --text-dim: ${colors.textDim};
      --border: ${colors.border};
      --accent: ${colors.accent};
      --accent-dim: ${colors.accentDim};
      --success: ${colors.success};
      --warning: ${colors.warning};
      --error: ${colors.error};
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      background-color: var(--bg-primary);
      color: var(--text-primary);
      line-height: 1.6;
      padding: 2rem;
    }

    .container {
      max-width: 900px;
      margin: 0 auto;
    }

    /* Branding Header */
    .branding {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 1rem;
      padding: 1.5rem;
      margin-bottom: 2rem;
      background: linear-gradient(135deg, var(--accent-dim) 0%, transparent 100%);
      border-radius: 1rem;
      border: 1px solid var(--border);
    }

    .branding-logo {
      width: 48px;
      height: 48px;
      flex-shrink: 0;
      border-radius: 8px;
    }

    .branding-logo img {
      width: 100%;
      height: 100%;
      border-radius: 8px;
    }

    .branding-text {
      text-align: left;
    }

    .branding-title {
      font-size: 1.5rem;
      font-weight: 700;
      color: var(--text-primary);
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }

    .branding-tagline {
      font-size: 0.875rem;
      color: var(--text-secondary);
      margin-top: 0.25rem;
    }

    .branding-links {
      display: flex;
      gap: 1rem;
      margin-top: 0.5rem;
    }

    .branding-link {
      font-size: 0.75rem;
      color: var(--accent);
      text-decoration: none;
      display: flex;
      align-items: center;
      gap: 0.25rem;
    }

    .branding-link:hover {
      text-decoration: underline;
    }

    .branding-link svg {
      width: 12px;
      height: 12px;
    }

    .header {
      text-align: center;
      margin-bottom: 2rem;
      padding-bottom: 1.5rem;
      border-bottom: 1px solid var(--border);
    }

    .header h1 {
      font-size: 1.75rem;
      font-weight: 600;
      margin-bottom: 0.5rem;
    }

    .header .subtitle {
      color: var(--text-secondary);
      font-size: 0.875rem;
    }

    .stats-grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 1rem;
      margin-bottom: 2rem;
    }

    .stat-card {
      background-color: var(--accent-dim);
      border-radius: 0.5rem;
      padding: 1rem;
      text-align: center;
    }

    .stat-value {
      font-size: 1.5rem;
      font-weight: 700;
      color: var(--text-primary);
    }

    .stat-label {
      font-size: 0.75rem;
      color: var(--text-secondary);
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    .section {
      margin-bottom: 2rem;
    }

    .section-title {
      font-size: 1rem;
      font-weight: 600;
      color: var(--text-secondary);
      margin-bottom: 1rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    .info-grid {
      display: grid;
      grid-template-columns: auto 1fr;
      gap: 0.5rem 1rem;
      font-size: 0.875rem;
    }

    .info-label {
      color: var(--text-dim);
    }

    .info-value {
      color: var(--text-primary);
      font-family: 'SF Mono', Monaco, 'Courier New', monospace;
      word-break: break-all;
    }

    .participants {
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem;
    }

    .participant {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      background-color: var(--bg-secondary);
      padding: 0.5rem 0.75rem;
      border-radius: 0.375rem;
      font-size: 0.875rem;
    }

    .participant-color {
      width: 0.75rem;
      height: 0.75rem;
      border-radius: 50%;
    }

    .participant-name {
      font-weight: 500;
    }

    .participant-agent {
      color: var(--text-dim);
      font-size: 0.75rem;
    }

    .messages {
      display: flex;
      flex-direction: column;
      gap: 1rem;
    }

    .message {
      background-color: var(--bg-secondary);
      border-radius: 0.5rem;
      padding: 1rem;
      border-left: 3px solid var(--border);
    }

    .message-user {
      border-left-color: var(--accent);
    }

    .message-header {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      margin-bottom: 0.5rem;
    }

    .message-from {
      font-weight: 600;
      font-size: 0.875rem;
    }

    .message-time {
      color: var(--text-dim);
      font-size: 0.75rem;
    }

    .read-only-badge {
      background-color: rgba(251, 191, 36, 0.2);
      color: var(--warning);
      font-size: 0.625rem;
      padding: 0.125rem 0.375rem;
      border-radius: 0.25rem;
      text-transform: uppercase;
      font-weight: 600;
    }

    /* Message Content - Markdown Styles */
    .message-content {
      font-size: 0.9375rem;
      color: var(--text-primary);
      line-height: 1.6;
    }

    .message-content > *:first-child {
      margin-top: 0;
    }

    .message-content > *:last-child {
      margin-bottom: 0;
    }

    .message-content h1 {
      font-size: 1.5rem;
      font-weight: 600;
      margin: 1.5rem 0 0.75rem;
      padding-bottom: 0.3rem;
      border-bottom: 1px solid var(--border);
    }

    .message-content h2 {
      font-size: 1.25rem;
      font-weight: 600;
      margin: 1.25rem 0 0.5rem;
      padding-bottom: 0.2rem;
      border-bottom: 1px solid var(--border);
    }

    .message-content h3 {
      font-size: 1.1rem;
      font-weight: 600;
      margin: 1rem 0 0.5rem;
    }

    .message-content h4, .message-content h5, .message-content h6 {
      font-size: 1rem;
      font-weight: 600;
      margin: 0.75rem 0 0.5rem;
    }

    .message-content p {
      margin: 0.75rem 0;
    }

    .message-content ul, .message-content ol {
      margin: 0.75rem 0;
      padding-left: 1.75rem;
    }

    .message-content li {
      margin: 0.25rem 0;
    }

    .message-content li > ul, .message-content li > ol {
      margin: 0.25rem 0;
    }

    .message-content a {
      color: var(--accent);
      text-decoration: none;
    }

    .message-content a:hover {
      text-decoration: underline;
    }

    .message-content strong {
      font-weight: 600;
    }

    .message-content em {
      font-style: italic;
    }

    .message-content blockquote {
      margin: 0.75rem 0;
      padding: 0.5rem 1rem;
      border-left: 4px solid var(--accent);
      background-color: var(--bg-tertiary);
      color: var(--text-secondary);
    }

    .message-content blockquote > *:first-child {
      margin-top: 0;
    }

    .message-content blockquote > *:last-child {
      margin-bottom: 0;
    }

    /* Horizontal Rule */
    .message-content hr {
      border: none;
      border-top: 1px solid var(--border);
      margin: 1.5rem 0;
    }

    /* Tables */
    .message-content table {
      border-collapse: collapse;
      width: 100%;
      margin: 1rem 0;
      font-size: 0.875rem;
    }

    .message-content th, .message-content td {
      border: 1px solid var(--border);
      padding: 0.5rem 0.75rem;
      text-align: left;
    }

    .message-content th {
      background-color: var(--bg-tertiary);
      font-weight: 600;
    }

    .message-content tr:nth-child(even) {
      background-color: var(--accent-dim);
    }

    /* Code */
    .message-content code {
      background-color: var(--bg-tertiary);
      padding: 0.125rem 0.375rem;
      border-radius: 0.25rem;
      font-family: 'SF Mono', Monaco, 'Courier New', monospace;
      font-size: 0.875em;
    }

    .message-content pre {
      background-color: var(--bg-tertiary);
      border-radius: 0.5rem;
      padding: 1rem;
      overflow-x: auto;
      margin: 0.75rem 0;
      border: 1px solid var(--border);
    }

    .message-content pre code {
      background-color: transparent;
      padding: 0;
      font-size: 0.8125rem;
      line-height: 1.5;
    }

    /* Task Lists */
    .message-content input[type="checkbox"] {
      margin-right: 0.5rem;
    }

    /* Images */
    .message-content img {
      max-width: 100%;
      height: auto;
      border-radius: 0.5rem;
      margin: 0.75rem 0;
    }

    /* Strikethrough */
    .message-content del {
      text-decoration: line-through;
      color: var(--text-dim);
    }

    .footer {
      margin-top: 3rem;
      padding-top: 1.5rem;
      border-top: 1px solid var(--border);
      text-align: center;
      color: var(--text-dim);
      font-size: 0.75rem;
    }

    .footer a {
      color: var(--accent);
      text-decoration: none;
    }

    .footer a:hover {
      text-decoration: underline;
    }

    .footer-theme {
      margin-top: 0.5rem;
      font-size: 0.625rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    @media (max-width: 640px) {
      body {
        padding: 1rem;
      }

      .branding {
        flex-direction: column;
        text-align: center;
      }

      .branding-text {
        text-align: center;
      }

      .branding-links {
        justify-content: center;
      }

      .stats-grid {
        grid-template-columns: repeat(2, 1fr);
      }

      .info-grid {
        grid-template-columns: 1fr;
      }
    }

    @media print {
      body {
        background-color: white;
        color: black;
      }

      .branding {
        background: #f5f5f5;
      }

      .message {
        background-color: #f5f5f5;
        border-left-color: #ccc;
      }

      .stat-card {
        background-color: #f5f5f5;
      }
    }
  </style>
</head>
<body>
  <div class="container">
    <!-- Maestro Branding -->
    <div class="branding">
      <div class="branding-logo">
        <img src="${maestroIconBase64}" alt="Maestro" />
      </div>
      <div class="branding-text">
        <div class="branding-title">
          Maestro
        </div>
        <div class="branding-tagline">Multi-agent orchestration for AI coding assistants</div>
        <div class="branding-links">
          <a href="https://runmaestro.ai" target="_blank" class="branding-link">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
            runmaestro.ai
          </a>
          <a href="https://github.com/pedramamini/Maestro" target="_blank" class="branding-link">
            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/></svg>
            GitHub
          </a>
        </div>
      </div>
    </div>

    <header class="header">
      <h1>${escapeHtml(groupChat.name)}</h1>
      <p class="subtitle">Group Chat Export - ${formatTimestamp(groupChat.createdAt)}</p>
    </header>

    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-value">${stats.participantCount}</div>
        <div class="stat-label">Agents</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${stats.totalMessages}</div>
        <div class="stat-label">Messages</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${stats.agentMessages}</div>
        <div class="stat-label">Agent Replies</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${stats.duration}</div>
        <div class="stat-label">Duration</div>
      </div>
    </div>

    <section class="section">
      <h2 class="section-title">Details</h2>
      <div class="info-grid">
        <span class="info-label">Group Chat ID</span>
        <span class="info-value">${escapeHtml(groupChat.id)}</span>
        <span class="info-label">Created</span>
        <span class="info-value">${formatTimestamp(groupChat.createdAt)}</span>
        <span class="info-label">Moderator</span>
        <span class="info-value">${escapeHtml(groupChat.moderatorAgentId)}</span>
      </div>
    </section>

    ${
			groupChat.participants.length > 0
				? `
    <section class="section">
      <h2 class="section-title">Participants</h2>
      <div class="participants">
        ${participantsHtml}
      </div>
    </section>
    `
				: ''
		}

    <section class="section">
      <h2 class="section-title">Conversation</h2>
      <div class="messages">
        ${messagesHtml}
      </div>
    </section>

    <footer class="footer">
      <p>Exported from <a href="https://runmaestro.ai" target="_blank">Maestro</a> on ${formatTimestamp(Date.now())}</p>
      <p class="footer-theme">Theme: ${escapeHtml(theme.name)}</p>
    </footer>
  </div>
</body>
</html>`;
}

/**
 * Download the group chat as an HTML file
 */
export async function downloadGroupChatExport(
	groupChat: GroupChat,
	messages: GroupChatMessage[],
	history: GroupChatHistoryEntry[],
	theme: Theme
): Promise<void> {
	// Fetch images from the main process
	let images: Record<string, string> = {};
	try {
		images = await window.maestro.groupChat.getImages(groupChat.id);
	} catch (error) {
		console.warn('Failed to fetch images for export:', error);
	}

	// Generate HTML
	const html = generateGroupChatExportHtml(groupChat, messages, history, images, theme);

	// Create blob and download
	const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
	const url = URL.createObjectURL(blob);

	const link = document.createElement('a');
	link.href = url;
	link.download = `${groupChat.name.replace(/[^a-z0-9]/gi, '-').toLowerCase()}-export.html`;
	document.body.appendChild(link);
	link.click();
	document.body.removeChild(link);

	URL.revokeObjectURL(url);
}
