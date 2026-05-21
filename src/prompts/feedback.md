# Maestro Feedback Submission

A Maestro user has submitted feedback. Your task is to convert it into a well-structured GitHub issue on the `RunMaestro/Maestro` repository.

Do **not** ask the user for clarification — work with what's provided. If details are missing, note them as "Not specified" in the appropriate section rather than asking follow-up questions.

## User's Raw Feedback

{{FEEDBACK}}

## Your Steps

1. **Classify the feedback** into exactly one of: `Bug`, `Feature`, `Improvement`, or `Feedback`.
   - `Bug` — something is broken, crashing, or behaving incorrectly
   - `Feature` — a request for new functionality that doesn't exist
   - `Improvement` — refinement to existing functionality (UX, performance, polish)
   - `Feedback` — general commentary, praise, or open-ended observations

2. **Craft a clear, concise title** prefixed by type, e.g.:
   - `Bug: Settings modal fails to close on Escape`
   - `Feature: Add export to CSV for usage stats`
   - `Improvement: Smoother tab switching animation`
   - `Feedback: Loving the new wizard flow`

3. **Write a structured body** in Markdown. Choose sections based on type:
   - **Bug:** Description, Steps to Reproduce, Expected Behavior, Current Behavior, Environment (if mentioned).
   - **Feature:** Description, Problem It Solves, Proposed Solution, Alternatives Considered (if applicable).
   - **Improvement:** Description, Current Behavior, Proposed Change, Why It Matters.
   - **Feedback:** Description, Context (if any).

   Always end the body with:

   ```
   ---
   _Submitted via Maestro's in-app feedback._
   ```

4. **Ensure the `Maestro-feedback` label exists.** Run:

   ```bash
   gh label create "Maestro-feedback" --repo RunMaestro/Maestro --description "User feedback submitted via Maestro" --color "0E8A16"
   ```

   If the label already exists, `gh` will report an error — that's fine, ignore it and continue.

5. **Create the issue:**

   ```bash
   gh issue create --repo RunMaestro/Maestro --label "Maestro-feedback" --title "TITLE" --body "BODY"
   ```

   Replace `TITLE` and `BODY` with the values from steps 2 and 3. Use a heredoc or properly escape the body so newlines and special characters are preserved.

6. **Output the resulting GitHub issue URL** on its own line so the user can click through to it. Keep your overall response brief — confirm the type, title, and URL.
