Provide a brief synopsis of what you just accomplished in this task using this exact format:

**Summary:** [2-3 sentences. The first sentence is a headline in commit-message-title style. The following 1-2 sentences add the concrete substance: what files/areas changed, what behavior is now different, or what the key decision was. This whole block is what shows in the History list - a reader must be able to tell what was actually done without opening the entry.]

**Details:** [A paragraph of plain prose with file paths, behavioral changes, and any non-obvious decisions.]

Rules for Summary:

- Lead with a verb and the concrete artifact (file, feature, fix, function). Examples: "Added JWT validation to /auth/login", "Fixed tooltip clipping in FilePreview", "Refactored cue-engine dispatch to use a single queue".
- Aim for 2-3 sentences (roughly 25-60 words). A single sentence is only acceptable when the work genuinely cannot be described with more substance - and even then it must name the concrete artifact, not just a verb. "Implemented and pushed." / "Task complete." / "Completed end-to-end in X." are all unacceptable - they describe nothing.
- After the headline sentence, the follow-up sentence(s) must add information: the specific files/modules touched, the user-visible or behavioral change, or the key non-obvious decision. Do not pad with restatements of the headline.
- Do NOT use Summary for wrap-up status or meta-commentary. These belong in Details (or nowhere). Forbidden phrasings in Summary include: "Task complete", "Task done", "Pushed cleanly", "Pushed to remote", "No commit needed", "Nothing to commit", "Done", "All set", "Ready to ship", "Per playbook instructions", "Checkbox flipped", and similar.
- Do NOT start with conversational filler: "Excellent!", "Perfect!", "Great!", "Awesome!", "Done!", or similar expressions.
- Do NOT include session/interaction preamble: "You asked me to...", "This is our first interaction...", "there's no prior work to summarize...", etc.
- Do NOT prefix Summary with playbook/task identifiers like "[2026-05-16-Post-MVP-Tech-Debt/POST-MVP-07]" - that context belongs in Details if anywhere; Summary should describe the work itself.

Rules for Details:

- Start with prose. NEVER lead Details with a markdown heading (`#`, `##`, `###`) or a bolded title line (`**Headline**`) - the lede already lives in Summary; do not restate it as a heading.
- Scientific-log style: factual, concise, informative. Name specific files, functions, and behaviors changed.
- Report what was actually accomplished, not what was attempted.

If nothing meaningful was accomplished (no code changes, no files modified, no research completed - just greetings or introductions), respond with ONLY the text: NOTHING_TO_REPORT
