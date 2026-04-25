# Maestro Constitution

The guiding principles that shape every decision in Maestro's development.

---

## Core Philosophy

**Maestro exists to transform fractured attention into focused productivity.**

In a world where AI agents multiply and conversations splinter, Maestro is the conductor's podium—the single point of control from which you orchestrate an entire symphony of autonomous work.

---

## The Two Modes

Maestro serves two distinct modes of work, and we must excel at both:

- **Solo Mode:** Agents run unattended, executing tasks autonomously while you're away
- **Interactive Mode:** You're at the podium, conducting your fleet in real-time

The first two tenets address these modes directly. The remaining tenets apply to both.

---

## The Seven Tenets

### 1. Unattended Excellence _(Solo Mode)_

The measure of Maestro's success is how long agents run without intervention.

**What this means in practice:**

- Auto Run is a first-class citizen, not an afterthought
- Error recovery should be automatic where possible
- Agents should be self-healing and self-continuing
- The leaderboard celebrates autonomy, not activity
- Interruptions are failures to be minimized

**The Autonomy Principle:**
Every feature we build should extend the runway of unattended operation. If a feature requires more babysitting, it's moving backwards.

### 2. The Conductor's Perspective _(Interactive Mode)_

You are the maestro. The agents are your orchestra. The interface is your podium. Fleet management is critical for optimal interactive experience.

**What this means in practice:**

- Overview and control trump granular details
- Point at an agent, give direction, move on
- Status should be glanceable, not readable
- Batch operations over individual ones
- Trust the agents to execute; focus on directing
- Switching between agents must be frictionless
- Context should persist as you move through your fleet

**The Orchestra Model:**
A conductor doesn't play every instrument—they ensure each section knows its part and plays in harmony. Maestro should make you feel powerful through delegation, not through micromanagement. The best conductors move fluidly between sections, never losing the thread of the whole performance.

### 3. Keyboard Sovereignty

Your hands never leave the keyboard. Every action, every navigation, every command flows through deliberate keystrokes.

**What this means in practice:**

- Focus must always be predictable and intentional
- Escape always returns you to a known, useful state
- Every modal, every panel, every input has a keyboard path
- Tab order follows visual hierarchy and user intent
- No mouse-only features ever

**The Focus Contract:**
When you press a key, you must know where focus will land. When you press Escape, you must return to productivity, not limbo. Focus is sacred—we never steal it, lose it, or leave it ambiguous.

### 4. Instant Response

The interface must be faster than thought. Latency kills flow.

**What this means in practice:**

- UI interactions respond in milliseconds, not seconds
- Switching sessions is instantaneous
- Keyboard navigation has zero perceptible delay
- Heavy operations happen in the background
- Perceived performance matters as much as actual performance

**The Speed Imperative:**
If you can fly through the interface with your keyboard, but the interface can't keep up, keyboard-first is a lie. Speed is what makes sovereignty _feel_ sovereign.

### 5. Delightful Focus

We solve fleet management brilliantly. We don't solve everything.

**What this means in practice:**

- Say no to feature creep that dilutes the core experience
- Polish what exists before adding what's new
- Every interaction should feel responsive and intentional
- Complexity lives under the hood, not in the interface
- Latency is a bug

**The Delight Standard:**
Users should smile when they use Maestro. Not because it's cute, but because it's _satisfying_—like a perfectly weighted keyboard or a door that closes with a solid click.

### 6. Transparent Complexity

Power users deserve depth. New users deserve simplicity. Both get what they need.

**What this means in practice:**

- Progressive disclosure of advanced features
- Sensible defaults that work out of the box
- Power features accessible but not intrusive
- Documentation embedded where needed, not hidden
- Complexity is opt-in, never mandatory

**The Iceberg Principle:**
90% of Maestro's power should be invisible until needed. The surface is calm and simple; the depth is available to those who dive.

### 7. Agent Omniscience

Everything the conductor can see, the agents can see. Everything the conductor can do, the agents can do. The interface is not a wall between human and machine—it's a shared control surface.

**What this means in practice:**

- Every setting, state, and action reachable through the GUI is equally reachable by agents through CLI and filesystem
- Agents read, write, peek, and poke the application directly—no human hands required
- History, configuration, playbooks, and agent state are all accessible artifacts, not locked-away internals
- Inter-agent communication is a first-class operation, not a workaround
- The user should never leave the conversation to manipulate Maestro

**The Shared Podium Principle:**
The conductor and the orchestra share the same stage. An agent that can write code but can't change its own theme, inspect a peer's history, or launch a playbook is an agent working with one hand tied behind its back. Full access means full agency—the interface serves the agent as readily as it serves the conductor.

---

## Design Principles

### Visual Language

- **Status at a glance:** Colors indicate state (green=ready, yellow=thinking, red=error, orange=connecting)
- **Hierarchy through space:** Important things get room to breathe
- **Motion with purpose:** Animation conveys meaning, never decoration
- **Dark by default:** Optimized for long sessions and focused work

### Interaction Patterns

- **Escape is home:** Pressing Escape should always improve your situation
- **Enter confirms:** The primary action is always Enter
- **Modals are temporary:** Get in, do the thing, get out
- **Context stays close:** Related controls live near related content
- **Undo is expected:** Destructive actions are reversible or confirmed

### Information Architecture

- **Left Bar:** Your fleet—sessions and groups at a glance
- **Main Window:** The current focus—AI terminal or command terminal
- **Right Bar:** Context—files, history, Auto Run
- **Overlays:** Transient—modals, menus, confirmations

---

## What Maestro Is Not

- **Not an IDE:** We complement your editor, not replace it
- **Not a single-agent wrapper:** One agent is just a small orchestra
- **Not a chat interface:** Conversations are work sessions, not dialogues
- **Not a project manager:** We execute, not plan (that's what agents do)
- **Not feature-complete:** We're laser-focused, not comprehensive

---

## The Maestro Test

Before shipping any feature, ask:

1. **Does it extend unattended runtime?**
2. **Does it make fleet management better?**
3. **Can I use it without touching the mouse?**
4. **Is it fast?**
5. **Is the complexity justified?**
6. **Will users smile?**
7. **Can an agent do this without human hands?**

If the answer to any of these is "no," reconsider.

---

## The Name

Yes, "Maestro" is overused. But when you're conducting a dozen agents across multiple projects, watching them work in concert while you simply point and direct—there's no other word for it.

You're not managing. You're not supervising. You're not multitasking.

You're conducting.

---

_This Constitution is a living document. It evolves as Maestro evolves, but its core principles remain: keyboard-first, unattended-focused, delightfully simple, and always in service of the conductor._
