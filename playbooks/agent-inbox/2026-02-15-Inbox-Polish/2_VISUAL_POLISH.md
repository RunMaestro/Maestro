# Phase 2: Implement — Visual Polish (Modal + Cards + Pipes + Expand Toggle)

## Context

- **Playbook:** Unified Inbox Polish
- **Agent:** {{AGENT_NAME}}
- **Project:** {{AGENT_PATH}}
- **Loop:** {{LOOP_NUMBER}}
- **Date:** {{DATE}}
- **Working Folder:** {{AUTORUN_FOLDER}}

## Purpose

Increase modal width to 800px with an expand toggle (800px ↔ 90vw), increase card height to 120px with multi-line message display, and replace the decorated Row 1 format (with icons and slashes) with flat pipe-separated text matching the Maestro title bar style. All visual changes must respect existing design system patterns (font sizes, spacing, border-radius, color tokens).

## Key Paths

- **Component:** `src/renderer/components/AgentInbox.tsx`
- **Design system reference:** `src/renderer/components/ui/Modal.tsx` (header p-4 text-sm font-bold, content p-6, rounded-lg shadow-2xl)
- **Theme tokens:** `src/shared/themes.ts` (NEVER hardcode hex values)

---

## Task 1: Increase modal width and card height

- [ ] Open `{{AGENT_PATH}}/src/renderer/components/AgentInbox.tsx`. Make three changes: (1) Find the constant `ITEM_HEIGHT = 100` (around line 21) and change it to `ITEM_HEIGHT = 120`. (2) Find the modal container div with class `w-[600px]` (around line 659). Remove the `w-[600px]` Tailwind class entirely — width will now be controlled by inline style (see Task 4 for the expand toggle). For now, add `width: 800` to the existing `style={{ }}` object on that div. (3) Update the `listHeight` calculation (around line 642) — change the `600` max constraint to `700` so the taller cards have room: `Math.min(window.innerHeight * 0.8 - MODAL_HEADER_HEIGHT - MODAL_FOOTER_HEIGHT - 80, 700)`. Use TABS for indentation. Success criteria: `ITEM_HEIGHT` is 120, modal width is set via inline style (not Tailwind class), listHeight max is 700.

## Task 2: Multi-line lastMessage display

- [ ] Open `{{AGENT_PATH}}/src/renderer/components/AgentInbox.tsx`. Find the Row 2 div that displays `item.lastMessage` (around line 200-210). Currently it has `whiteSpace: 'nowrap'`, `overflow: 'hidden'`, `textOverflow: 'ellipsis'` which forces 1 line. Change this to support 3-5 lines: remove `whiteSpace: 'nowrap'` and `textOverflow: 'ellipsis'`, and add `display: '-webkit-box'`, `WebkitLineClamp: 4`, `WebkitBoxOrient: 'vertical' as const`, `overflow: 'hidden'`, `lineHeight: '1.4'`. This gives 4 lines of text with ellipsis on the last line. Also go to `{{AGENT_PATH}}/src/renderer/hooks/useAgentInbox.ts` and change `MAX_MESSAGE_LENGTH` from `90` to `300` (line 5) so the hook passes enough text for 4 lines. Use TABS for indentation. Success criteria: lastMessage div uses `-webkit-box` with `WebkitLineClamp: 4`, and `MAX_MESSAGE_LENGTH` is 300.

## Task 3: Replace Row 1 with flat pipe separators (title bar style)

- [ ] Open `{{AGENT_PATH}}/src/renderer/components/AgentInbox.tsx`. Find the Row 1 div inside `InboxItemCardContent` (around lines 143-197). Currently it shows: `groupName / (agent_icon) sessionName / (pencil_icon) tabName + timestamp`. Replace the entire Row 1 content with a flat pipe-separated format matching the Maestro title bar: `GROUPNAME | sessionName | tabName` with timestamp on the right. Specifically: (1) Remove the `getAgentIcon(item.toolType)` span (the robot emoji). (2) Remove the `<Edit3>` icon component from the tab name area. (3) Replace all `/` separator spans with `|` pipe characters, styled with `color: theme.colors.textDim, padding: '0 6px'`. (4) Make the groupName display in UPPERCASE using `textTransform: 'uppercase'` and `letterSpacing: '0.5px'`. (5) Keep the timestamp span on the right as-is. The result should look like: `WORKSPACE | vibework-chat | Vitascience Rename    2m ago`. Remove the `import { Edit3 }` from the lucide-react imports at the top of the file ONLY if Edit3 is not used elsewhere in the file (search first). Use TABS for indentation. Success criteria: Row 1 uses `|` pipes, no agent icon emoji, no Edit3 pencil icon, groupName is uppercase. The visual output matches the pattern `GROUP | session | tab    timestamp`.

## Task 4: Add Normal ↔ Expanded toggle button

- [ ] Open `{{AGENT_PATH}}/src/renderer/components/AgentInbox.tsx`. Add an expand/collapse toggle so users can switch between Normal (800px) and Expanded (90vw) modal width. Implementation: (1) Add `import { Maximize2, Minimize2 } from 'lucide-react'` to the existing lucide imports at the top of the file (merge into the existing import statement). (2) Add state: `const [isExpanded, setIsExpanded] = useState(false)`. (3) Find the modal container div (the one with `role="dialog"` and `aria-modal="true"`, around line 654). Update its inline `style` to use dynamic width: `width: isExpanded ? '90vw' : 800`, and add a CSS transition: `transition: 'width 200ms ease, max-height 200ms ease'`. Also update `maxHeight` to: `isExpanded ? '90vh' : '80vh'`. (4) In the header row 1 (the div with title + badge + close button), add an expand toggle button BEFORE the close button. The button should look like the existing close button (same padding, border-radius, hover style): `<button onClick={() => setIsExpanded(prev => !prev)} className="p-1.5 rounded" style={{ color: theme.colors.textDim }} onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = theme.colors.accent + '20')} onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')} title={isExpanded ? 'Collapse' : 'Expand'}>{isExpanded ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}</button>`. Add the same `onFocus`/`onBlur` outline handlers that the close button has. (5) Update the `listHeight` calculation to also respect expanded mode: when `isExpanded`, use `window.innerHeight * 0.85` instead of the 700 max. Something like: `Math.min(window.innerHeight * (isExpanded ? 0.85 : 0.8) - MODAL_HEADER_HEIGHT - MODAL_FOOTER_HEIGHT - 80, isExpanded ? 1200 : 700)`. Use TABS for indentation. All colors from `theme.colors.*` — no hardcoded hex. Button styling must match the existing close button pattern exactly (same `p-1.5 rounded`, same hover/focus behavior). Success criteria: a Maximize2/Minimize2 icon button appears in the header next to the close button, clicking it toggles between 800px and 90vw with a smooth 200ms transition, the list height adjusts accordingly.
