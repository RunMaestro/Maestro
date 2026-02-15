# Phase 05: Reply Input + Send Mechanism

> **Feature:** Focus Mode (Inbox Triage View)
> **Codebase:** `~/Documents/Vibework/Maestro` | **Branch:** `feature/focus-mode`
> **Depends on:** Phase 04 (conversation tail rendering)

This phase adds the reply input at the bottom of FocusModeView. The user can type a message and send it to the agent. Sending navigates to the session (activates it), writes the text to the agent's stdin, and auto-advances to the next inbox item.

---

## Understand the Send Path

The existing send mechanism works like this:
1. `App.tsx` has a `processInput()` function (from `useInputProcessing` hook)
2. It reads the active session's `inputValue` from the active AITab
3. It calls `processService.write(sessionId, data)` which writes to the agent's PTY stdin via `window.maestro.process.write(sessionId, data)`
4. The input is cleared and a log entry is added

For Focus Mode, we can't reuse `processInput` directly because it operates on the *active* session. Instead, the send flow is:
1. User types in the reply input
2. User presses Enter (or clicks Send)
3. We call `onNavigateToSession(sessionId, tabId)` to activate the target session/tab
4. We set the input value on that tab
5. The existing input processing handles the actual send

**Simpler approach:** Since `onNavigateToSession` already closes the modal, we can:
1. Navigate to the session (activates it, closes modal)
2. Set the tab's inputValue to the typed text
3. Let the user send manually (or auto-send via a flag)

**Even simpler:** Add a new callback prop `onReplyToSession` that:
1. Navigates to the session
2. Pre-fills the input with the typed text
3. Optionally auto-sends

We'll go with the pre-fill approach — it's safer (user confirms before sending) and requires minimal changes to App.tsx.

---

## Add Reply Input to FocusModeView

- [ ] **Add a reply input bar above the footer in `src/renderer/components/AgentInbox/FocusModeView.tsx`.** Changes:

  1. **Add a new prop** to FocusModeViewProps:
     ```ts
     onReplyToSession?: (sessionId: string, tabId: string, text: string) => void;
     ```

  2. **Add reply state:**
     ```ts
     const [replyText, setReplyText] = useState('');
     const replyInputRef = useRef<HTMLTextAreaElement>(null);
     ```

  3. **Reset reply text when item changes** (prev/next navigation):
     ```ts
     useEffect(() => {
     	setReplyText('');
     }, [item.sessionId, item.tabId]);
     ```

  4. **Add the reply input bar** between the conversation body and the footer. Layout: flex row, `px-4 py-2`, border-top.

     ```tsx
     {/* Reply input bar */}
     <div
     	className="flex items-end gap-2 px-4 py-2 border-t"
     	style={{ borderColor: theme.colors.border }}
     >
     	<textarea
     		ref={replyInputRef}
     		value={replyText}
     		onChange={(e) => setReplyText(e.target.value)}
     		onKeyDown={(e) => {
     			if (e.key === 'Enter' && !e.shiftKey) {
     				e.preventDefault();
     				handleReply();
     			}
     			// Prevent focus-mode keyboard shortcuts from firing while typing
     			e.stopPropagation();
     		}}
     		placeholder="Reply to agent..."
     		rows={1}
     		className="flex-1 resize-none rounded-lg px-3 py-2 text-sm outline-none"
     		style={{
     			backgroundColor: theme.colors.bgActive,
     			color: theme.colors.textMain,
     			border: `1px solid ${theme.colors.border}`,
     			minHeight: 36,
     			maxHeight: 80,
     		}}
     		onFocus={() => {
     			// Auto-resize on focus
     			if (replyInputRef.current) {
     				replyInputRef.current.style.height = 'auto';
     				replyInputRef.current.style.height = replyInputRef.current.scrollHeight + 'px';
     			}
     		}}
     		onInput={(e) => {
     			// Auto-resize textarea
     			const target = e.target as HTMLTextAreaElement;
     			target.style.height = 'auto';
     			target.style.height = Math.min(target.scrollHeight, 80) + 'px';
     		}}
     	/>
     	<button
     		onClick={handleReply}
     		disabled={!replyText.trim()}
     		className="p-2 rounded-lg transition-colors flex-shrink-0"
     		style={{
     			backgroundColor: replyText.trim()
     				? theme.colors.accent
     				: `${theme.colors.accent}30`,
     			color: replyText.trim()
     				? theme.colors.accentForeground
     				: theme.colors.textDim,
     			cursor: replyText.trim() ? 'pointer' : 'default',
     		}}
     		title="Send reply (Enter)"
     	>
     		<ArrowUp className="w-4 h-4" />
     	</button>
     </div>
     ```

  5. **Import ArrowUp** from lucide-react (same icon used by InputArea's send button).

  6. **Add the `handleReply` callback:**
     ```ts
     const handleReply = useCallback(() => {
     	const text = replyText.trim();
     	if (!text) return;
     	if (onReplyToSession) {
     		onReplyToSession(item.sessionId, item.tabId, text);
     	}
     	setReplyText('');
     	// Auto-advance to next item after reply
     	if (items.length > 1) {
     		const nextIndex = (currentIndex + 1) % items.length;
     		onNavigateItem(nextIndex);
     	}
     }, [replyText, item, items, currentIndex, onReplyToSession, onNavigateItem]);
     ```

  7. **Important:** The `e.stopPropagation()` in the textarea's `onKeyDown` is critical — without it, pressing `ArrowLeft`/`ArrowRight` while typing would navigate between items, and `Escape` would exit focus mode instead of just blurring the input. The shell's keyboard handler should only fire when the textarea is NOT focused.

  Run `npx tsc --noEmit` to verify.

---

## Wire onReplyToSession in the AgentInbox Shell

- [ ] **Add `onReplyToSession` handler in `src/renderer/components/AgentInbox/index.tsx` and pass it to FocusModeView.** Changes:

  1. **Add prop to AgentInboxProps:**
     ```ts
     onReplyToSession?: (sessionId: string, tabId: string, text: string) => void;
     ```

  2. **Pass through to FocusModeView:**
     ```tsx
     <FocusModeView
     	...
     	onReplyToSession={onReplyToSession}
     />
     ```

  3. **Update AppModals.tsx** to pass `onReplyToSession` prop through from App.tsx.

  4. **In App.tsx, create the handler.** Search for where `onNavigateToSession` is defined for AgentInbox and add a sibling handler:

     ```ts
     const handleReplyToSession = useCallback((sessionId: string, tabId: string, text: string) => {
     	// 1. Navigate to the session (same as onNavigateToSession)
     	// Find the session, activate it, switch to the correct tab
     	// 2. Set the tab's inputValue to the reply text
     	// 3. The user will see the text pre-filled in the input area

     	// Find session and set the active tab's input
     	const targetSession = sessions.find(s => s.id === sessionId);
     	if (!targetSession) return;

     	// Activate the session
     	setActiveSessionId(sessionId);

     	// Switch to the correct tab
     	updateSession(sessionId, (s) => ({
     		...s,
     		activeTabId: tabId,
     		aiTabs: s.aiTabs.map(t =>
     			t.id === tabId ? { ...t, inputValue: text } : t
     		),
     	}));

     	// Close the modal
     	setAgentInboxOpen(false);
     }, [sessions, setActiveSessionId, updateSession, setAgentInboxOpen]);
     ```

     **Note:** Look at how the existing `onNavigateToSession` handler works in App.tsx and follow the same pattern. The key addition is setting `inputValue` on the target tab.

  5. **Pass it through AppModals:**
     ```tsx
     // In AppModals.tsx props
     onReplyToSession?: (sessionId: string, tabId: string, text: string) => void;

     // In the AgentInbox render
     <AgentInbox
     	...
     	onReplyToSession={onReplyToSession}
     />
     ```

  Run `npx tsc --noEmit` to verify the full chain compiles.

---

## Verification Gate

- [ ] **Run full verification.** Execute:
  ```bash
  cd ~/Documents/Vibework/Maestro && npx tsc --noEmit && npx vitest run && npx eslint src/renderer/components/AgentInbox/ --ext .ts,.tsx
  ```
  All tests must pass.

---

## Commit

- [ ] **Commit this phase.**
  ```bash
  git add src/renderer/components/AgentInbox/FocusModeView.tsx \
          src/renderer/components/AgentInbox/index.tsx \
          src/renderer/components/AppModals.tsx \
          src/renderer/App.tsx
  git commit -m "FOCUS-MODE: Phase 05 — reply input with pre-fill and auto-advance"
  ```
