---
title: Local Models
description: Run Maestro's housekeeping tasks on models that live on your machine or on a model server you already run, instead of spending agent turns on them.
icon: hard-drive
---

Maestro does a lot of small model work besides your agents' own turns: it names new tabs, writes context summaries, turns a plain-English request into a shell command, and more. By default most of that runs through the **Utility Agent**, an ordinary agent spawn. **Local Models** lets you point each of those jobs somewhere else: a small model Maestro downloads and runs itself, or a model server you already run, such as Ollama or LM Studio. A model on one of those can also be the model behind one of your agents: see [Run on](#run-on).

Open it from **Settings -> Models**, or run **Open Models Settings** from the command palette. From a terminal, `maestro-cli open settings --tab models` opens it, and `--sub-tab system-one` (or `overview`, `library`, `sources`, `system-two`, `gateway`) lands on one of its panels. A Library section takes a path: `--sub-tab library/speech` (or `library/engines`, `library/agents`, `library/housekeeping`, `library/search`, `library/custom`). The old name still works: `--tab local-models` opens the same tab. It is a core part of Maestro, not an Encore Feature, and it starts empty. The whole tab also works from the web interface: downloads, endpoints, the model server, System One, and every task run on the computer running Maestro, whichever screen you press the button on. Two controls stay in the desktop app: the model server key's **Copy** and VoiceStudio's **Check connection** (see [Sources in the web interface](#sources-in-the-web-interface)). The fit labels and the **Memory** tile describe that computer too, not the device the browser runs on, and download progress shows on every screen that has the tab open.

The tab has no shortcut of its own: **Open Settings** (`Cmd+,` / `Ctrl+,`) opens Settings, and the command palette entry opens the Models tab directly. Settings search also finds **Models overview**, **Library**, **Agent Models**, **Housekeeping models**, **Speech models**, **Search & Safety models**, **Engines**, and **Add from Hugging Face**, and lands on that place.

<Note>
	**Nothing downloads on its own.** Opening the tab, or enabling anything else in Maestro, fetches
	no model and calls no server. Every download, every server probe, and every test is a button you
	press. Every task also starts where it was: the ones that already ran through the Utility Agent stay
	there, and every new task starts **Off**.
</Note>

Clicking **Models** in the Settings sidebar opens the **Overview**. A row of tiles across the top shows where this computer stands: **On disk** (downloaded model files), **Installed**, **Engines** (installed and current), **Active tasks**, **Endpoints**, and **Memory**, the memory every model's fit is judged against. The Overview only reads: it downloads, probes, and calls nothing. A **task** is one of Maestro's background jobs (naming a tab, screening text, routing a voice request); it is active once you give it a source, and the rest are off. A model that failed verification shows a warning under the tiles, and clicking it opens the Library section that lists it. Below the tiles, a card for each panel says what it is for; click one to open it.

The five panels are listed under **Models** in the sidebar; click one to open it. The list stays expanded while the sidebar has room for every row, and collapses to show only under an open **Models** when it would make the sidebar scroll. **Cmd+Shift+[** and **]** walk the Overview and the panels too. Maestro remembers the panel you used last, separately on the desktop and in each browser.

| Panel          | What lives there                                                                                                                                    |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Library**    | The [models](#models) Maestro downloads, in sections, and the [engines](#engines) that run them.                                                    |
| **Sources**    | The [endpoints](#endpoints) you have added, the [Maestro model server](#model-server), and the local [VoiceStudio](#voicestudio) speech service.    |
| **System One** | The tasks whose answer is a judgment: a decision, label, score, vector, or transcript. See [System One and System Two](#system-one-and-system-two). |
| **System Two** | The tasks that write text for someone to read or run, plus the shared Utility source settings.                                                      |
| **Gateway**    | Per-agent gateway URLs, the token proxy mode for each agent, and what the token proxy carried and saved. See [Gateway](#gateway).                   |

### System One and System Two

One rule sorts every task. If its output is a **judgment** (a decision, label, score, vector, or transcript), it is **System One**: fast, small, and cheap to run often. If its output is **text written for someone to read or run**, it is **System Two**.

| System One                                                                                                                          | System Two                                                                                                |
| ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Cue gate, Prompt-injection screen, Secret screen, Voice routing, Model routing, Tab cleanup suggestions, Semantic search, Dictation | Tab naming, Summaries, AI command mode, Git drafts, Spoken notices, Token proxy, Computer History digests |

A task's assignment row sits on the panel of its system. Every message in Maestro that says where to pick a model for a task names that panel, for example "Settings > Models > System One".

## Models

Models are files Maestro downloads, checks, and runs on this machine. They live in **Models -> Library**. One line at the top says how much disk the installed models use, how many are installed, and what this computer has to run a model on, for example "32.0 GB of unified memory (Apple Silicon)" or "32.0 GB of RAM, NVIDIA GeForce RTX 4060 (8.0 GB)". A card whose memory Maestro cannot read shows "(memory not reported)". A model whose files failed verification is called out under it, and the section it sits in carries a red dot. **Engines** carries the dot too when an engine needs an update.

Below that line is a strip of sections, one shown at a time. **Cmd+[** and **Cmd+]** step through them. Maestro remembers the one you used last; the first time, it opens **Engines**.

| Section             | What it lists                                                                                                          |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| **Engines**         | The [engines](#engines) that run the models. First, because no model runs without one.                                 |
| **Agent Models**    | Text models strong enough to be the model behind an agent. Pick one as an agent's [Run on](#run-on) target.            |
| **Housekeeping**    | Smaller text models for Maestro's own tasks: tab names, summaries, shell commands, fast yes or no answers, and images. |
| **Speech**          | Speech-to-text, text-to-speech, and the wake word, for voice and dictation. One card per kind.                         |
| **Search & Safety** | Embeddings for search by meaning, and the classifiers that screen text for prompt injection. One card per kind.        |
| **Custom**          | The models you [added from Hugging Face](#add-from-hugging-face), and the form that adds one.                          |

A text model is listed once: in **Agent Models** when it can drive an agent, otherwise in **Housekeeping**. Every role it has is a badge on its row: **Agent-ready**, **Housekeeping**, **Judge** for the fastest small judgments, and **Vision** for a model that reads images. In **Speech** and **Search & Safety**, each card says which tasks can use that kind of model, or "Nothing uses this kind of model yet."

**Recommended** marks a curated starting point for each job that fits this computer comfortably. Hover over the badge for the reason. It is a memory-fit recommendation, not a speed benchmark. No badge appears without a hardware reading, and custom models are not recommended.

| Section         | Model                             | Size     | Good at                                                                   |
| --------------- | --------------------------------- | -------- | ------------------------------------------------------------------------- |
| Agent Models    | Gemma 4 E4B (Q4_0)                | 5.2 GB   | Screenshots and images, many languages, fast replies on laptops           |
| Agent Models    | gpt-oss 20B (MXFP4)               | 11.3 GB  | Reasoning with tool calls; the smallest that drives Claude Code and Codex |
| Agent Models    | Qwen3-Coder 30B-A3B (Q4_K_M)      | 17.3 GB  | A fast coding agent with tool use                                         |
| Agent Models    | Gemma 4 31B (Q4_K_M)              | 18.2 GB  | The strongest Gemma: tool calling and images                              |
| Agent Models    | Qwen3-Coder-Next 80B-A3B (Q4_K_M) | 45.2 GB  | The strongest local coding agent                                          |
| Agent Models    | gpt-oss 120B (MXFP4)              | 59.0 GB  | The strongest local reasoning and tool use                                |
| Housekeeping    | Qwen3 1.7B Instruct (Q4_K_M)      | 1.0 GB   | The fastest small judgments: tab names, gate answers, short summaries     |
| Housekeeping    | Qwen3.5 4B (Q4_K_M)               | 2.6 GB   | Every housekeeping task, shell commands and voice routing included        |
| Housekeeping    | Qwen3.5 9B (Q4_K_M)               | 5.3 GB   | Commit and PR drafts, shell commands and summaries                        |
| Housekeeping    | Gemma 4 12B (Q4_K_M)              | 6.8 GB   | Writing and multilingual work, with images                                |
| Housekeeping    | Devstral Small 2 24B (Q4_K_M)     | 13.3 GB  | Multi-file edits in large repositories                                    |
| Housekeeping    | Qwen3.6 35B-A3B (Q4_K_M)          | 19.0 GB  | General agent work: fast, with a long context                             |
| Housekeeping    | Qwen3.8 27B (Q4_K_M)              | 17.7 GB  | Hard reasoning and coding                                                 |
| Speech          | Parakeet TDT 0.6B (English)       | 630.7 MB | Dictated English: names, casing and punctuation                           |
| Speech          | Whisper Base (English)            | 198.8 MB | Plain English dictation on modest hardware                                |
| Speech          | Whisper Base (German / English)   | 198.9 MB | Explicit German and English transcription                                 |
| Speech          | Whisper Small (German / English)  | 561.2 MB | A larger alternative for German and English dictation                     |
| Speech          | Kokoro 82M                        | 311.0 MB | Reading replies and notices aloud                                         |
| Speech          | openWakeWord Base                 | 2.3 MB   | Hearing the wake and stop words with little CPU                           |
| Speech          | Wake phrase: "Hey Jarvis"         | 1.2 MB   | Hearing "hey jarvis" to start a hands-free session                        |
| Search & Safety | BGE Small (English)               | 33.1 MB  | Quick search by meaning in English                                        |
| Search & Safety | EmbeddingGemma 300M               | 208.6 MB | Higher-quality search by meaning, in many languages                       |
| Search & Safety | Llama Prompt Guard 2 22M          | 77.4 MB  | Catching prompt injection in untrusted text                               |
| Search & Safety | DeBERTa v3 Prompt Injection v2    | 712.6 MB | The same, under a permissive license, at a larger size                    |

The text models are all Apache-2.0. The licenses of the others are under [Licenses](#licenses).

**Agent Models** is not a claim from a model card. A model is in that section only after it fixed a bug in a scratch repository through a real harness (Claude Code, Codex, or OpenCode driving the model), and its **Agent-ready** badge names the harnesses it passed with ("Agent-ready: Claude Code, Codex"). That is what makes it a safe [Run on](#run-on) target: the agent keeps its harness and its tools, and the model behind it is the local one.

Each row shows what the model is good at, its size, the repo and revision it comes from, its license, where its files are on disk, and what uses it right now ("In use by ..."): the tasks assigned to it, and the A Cappella voice slot when voice uses it. A status badge says **Not installed**, **Downloading**, **Verifying**, **Paused**, **Installed**, or **Corrupt**. A model this build cannot run shows the reason in place of a **Download** button.

The buttons on a row follow its state:

| Button                  | When it shows                       | What it does                                                                                          | From a terminal                     |
| ----------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------- |
| **Download (size)**     | Not installed                       | Fetches the model, and its engine beside it when that is missing ("Download (1.1 GB + 41 MB engine)") | `maestro-cli models install <id>`   |
| **Pause**               | Downloading or verifying            | Stops the transfer and keeps what has arrived                                                         | `maestro-cli models pause <id>`     |
| **Resume**              | Paused                              | Continues from the partial file                                                                       | `maestro-cli models install <id>`   |
| **Cancel**              | Downloading or paused               | Stops the transfer and deletes the partial files. It never touches an installed model                 | `maestro-cli models cancel <id>`    |
| **Re-download (size)**  | Corrupt                             | Downloads the model again                                                                             | `maestro-cli models install <id>`   |
| **Re-verify**           | Installed or corrupt, no download   | Hashes the files again. It never deletes or re-downloads anything                                     | `maestro-cli models verify <id>`    |
| **Remove (size)**       | Files on disk                       | Deletes the files and frees that much disk                                                            | `maestro-cli models remove <id>`    |
| **Remove from Library** | A model you added from Hugging Face | Deletes its files and takes it out of the list (see [Add from Hugging Face](#add-from-hugging-face))  | `maestro-cli models remove-hf <id>` |

While a model downloads, the row shows a bar and a line such as "1.2 GB of 2.6 GB at 24.0 MB/s, 1m 5s left", with the file it is on. Up to two models download at once, and a dropped connection is retried a few times before the download fails. `maestro-cli models list` prints the model ids, grouped as the Library groups them. `models install` waits until the download is done and says whether the engine came with it.

Every file comes from a pinned revision and is checked against a SHA-256 recorded in the app while it downloads, so a file altered in transit fails to install rather than running. A failed check names the file and both hashes. A corrupt model says "Re-verify to confirm, or re-download to replace it."

**Removing a model a task uses warns first.** The warning names the tasks that would be left unavailable, and you choose **Remove anyway** or **Keep it**. A model that only A Cappella uses is removed without the warning. From a terminal, `maestro-cli models remove <id>` refuses a model a task uses and names the tasks; add `--force` to remove it anyway.

### Will it run on this computer

Each row carries a fit label, judged against this computer and the context the model runs at:

| Label         | Meaning                                                       |
| ------------- | ------------------------------------------------------------- |
| **Fits**      | The model and its context fit in the memory the GPU can use   |
| **Tight**     | It runs, slowly or with the system squeezed. The row says why |
| **Too large** | It does not run here. The row says how much it needs          |

A model needs its file, plus memory for its context, plus room for the system. The rule depends on the machine:

- **Apple Silicon.** The GPU can use about 75% of memory by default. A model fits when its file, its context and 2 GB for the system are within that. It is tight up to 90%.
- **A PC with a graphics card.** A model fits when its file and its context are within the card's memory. A mixture-of-experts model that does not fit can keep part of itself in RAM, and is tight. A dense model that does not fit is too large.
- **No GPU.** A model is never better than tight, because it replies slowly on the CPU. A model of 10B active parameters or more is too large, and so is one whose file, context and 4 GB for the system exceed the RAM.

The speech, embedding, classifier and wake word models run on the CPU on every machine: each fits when its file and 4 GB for the system are within the RAM. Hover over a label for the numbers behind it. A model you added has no measured context size, so its share is an estimate ("about ...").

As examples, on a Mac: Qwen3.5 4B fits in 8 GB; Gemma 4 E4B, Qwen3.5 9B and Gemma 4 12B fit in 16 GB; the 20B to 35B models fit in 32 GB; Qwen3-Coder-Next is tight in 64 GB, and it and gpt-oss 120B fit in 128 GB.

Models that are too large are hidden. **Show models too large for this machine** at the bottom of a section shows them, with the count; **Hide models too large for this machine** hides them again, and Maestro remembers the choice. A model with files on disk, or with a download running or paused, is never hidden.

`maestro-cli models list --fit` prints each model's label and the reason, and `--json` adds the hardware reading.

On a PC, Maestro reads the graphics card's memory from the model server's engine. Until that engine is installed, the Overview, the Library and `models list --fit` say so, and each model is judged as if it ran on the CPU. With more than one card, the one with the most memory counts. Install the engine under [Model server](#model-server) for an accurate answer.

### Cloud only

DeepSeek V4, Kimi K3, Kimi K2.7 Code and GLM-5.3 are too large to run on a desktop (the smallest is 155 GB), so the Library does not offer them. Use them through their provider's API, with your own key, from an endpoint.

### Add from Hugging Face

**Add from Hugging Face**, on **Models -> Library -> Custom**, adds a GGUF text model the Library does not offer. Enter the **Repo id** (`unsloth/Qwen3.5-2B-GGUF`; a pasted `https://huggingface.co/` prefix is dropped) and the **File name** (`Qwen3.5-2B-Q4_K_M.gguf`), then:

1. **Look up** (or Enter) asks Hugging Face about the repo and shows the model's license (from its model card), its size, its revision, and its fit, or "This model is already in the Library." Nothing is saved or downloaded yet. Changing either field clears the answer.
2. **Add to Library** saves the model. It appears in **Custom** with its own **Download** button, and nothing downloads until you press it.

A model you add is labeled **Not verified by Maestro**. Maestro pins the revision the repo was at when you added it, and checks the download against the hash Hugging Face reports for that revision, so a damaged download still fails to install. Nobody at Maestro has tested the model, so it has no role and no "good at" line, and its fit is an estimate from its size.

- Naming one part of a split GGUF (`-00001-of-00003.gguf`) adds every part.
- Only GGUF text models can be added. A vision projector file is refused: name the model's own GGUF file.
- A gated or private repo cannot be added: Maestro downloads without an account. A repo Hugging Face reports no hash or no GGUF metadata for is refused too, because Maestro could not check the download or tell the model's context length.
- **Remove from Library** on the row deletes the model's files and takes it out of the list. **Remove** deletes only the files. It warns first when a task uses the model, as **Remove** does. A model Maestro ships cannot be taken out of the Library, only have its files removed.

From a terminal, `maestro-cli models add-hf <repo> <file>` adds a model (`--dry-run` looks it up and saves nothing) and prints the id to install it with, and `maestro-cli models remove-hf <model-id>` takes one out (`--force` when a task uses it).

### Download source

Models download from Hugging Face. If your network blocks it, use `maestro-cli models config set download-base <url>` to set a mirror: a base URL that serves the same paths as Hugging Face (`/<repo>/resolve/<revision>/<file>` and `/api/models/<repo>`). Downloads and **Add from Hugging Face** then request from the mirror. `maestro-cli models config set download-base default` restores Hugging Face, and `maestro-cli models config show` prints the source in force. The mirror has no field in the app: it is set only from a terminal (or with `maestro-cli settings set localModelsDownloadBase <url>`). `models config show` and `models config set` work with Maestro closed.

The mirror covers model files and **Add from Hugging Face**; engines download from npm and do not use it. It changes the host and nothing else. Every file is still checked against the hash Maestro pins (or, for a model you added, the hash Hugging Face reported), so a mirror that serves different bytes fails the download. Only `http` and `https` URLs with a host are accepted, and credentials in the URL are refused. A change applies to the next request, so a download already running keeps its host; pause and resume it to move it to the new one.

### The small text models

Two small models do the housekeeping tasks. Both were run on the same requests, on the prompts Maestro ships:

| Task                                 | Qwen3.5 4B (2.6 GB)          | Qwen3 1.7B (1.0 GB)               |
| ------------------------------------ | ---------------------------- | --------------------------------- |
| Tab names (8)                        | 8 good, both ID numbers kept | 8 good, one ID number dropped     |
| Shell commands (8)                   | 8 correct                    | 1 correct, 1 that kills a process |
| Cue gate answers (8)                 | 8 correct                    | 8 correct                         |
| Pull request drafts (2)              | 2 good, with file names      | 2 good, shorter                   |
| Spoken requests sent to an agent (4) | 4                            | 0                                 |
| A tab name on Apple Silicon          | about 0.25 s                 | about 0.1 s                       |

**Qwen3.5 4B is the one to start with.** It is offered for every text task, and it fits a Mac with 8 GB of memory.

**Qwen3 1.7B** is the smallest and the fastest, and that size decides what it is offered for:

- **Offered for:** tab naming, summaries, the Cue gate, pull request drafts, spoken notices, tab cleanup suggestions, and the token proxy's digest.
- **Not offered for AI command mode.** In testing it wrote one correct command for eight requests, and a command that kills a process for a request to find it.
- **Not offered for voice routing.** It sent requests that named an agent to the Conductor instead of to that agent.
- **Not offered for model routing.** As a judge it rated every one of 40 test requests, lookups included, as needing the most model and the most effort.

The assignment picker leaves it out of those three tasks. For them, use Qwen3.5 4B, or an [endpoint](#endpoints) with a larger model. `maestro-cli models assign` still accepts it there and prints the reason.

### The neural voice

**Kokoro 82M** is a neural text-to-speech voice that runs on this machine: American English, one voice (Heart). It speaks about six times faster than real time on Apple Silicon. Choose it under **Text-to-Speech** in the A Cappella voice settings, and it is also the voice [spoken notices](#spoken-notices) use when it is the voice you chose there. The system voice stays the default, because it needs no download.

Kokoro reads text through espeak-ng, which turns words into the sounds the model was trained on. espeak-ng ships inside Maestro (it is small, and plain JavaScript) under the GPL, version 3 or later; see `THIRD-PARTY-NOTICES.md` in the repository.

### Engines

A model is a file of weights. An **engine** is the library that reads it: ONNX Runtime for the speech, embedding, classifier, and wake word models, and llama.cpp for the text model. Engines are not bundled in the installer. A model's **Download** button fetches its engine with it when that is missing, and says so on the button ("Download (1.1 GB + 41 MB engine)").

**Models -> Library -> Engines** shows each engine on its own, **llama.cpp (text generation)** and **ONNX Runtime (speech, wake word, and classifiers)**, with the models it runs:

| State         | What you see                                                                                          |
| ------------- | ----------------------------------------------------------------------------------------------------- |
| Installed     | **Installed**                                                                                         |
| Not installed | **Install (size)**                                                                                    |
| Needs update  | **Update (size)**, and "This build expects a newer version. Update it before these models will load." |
| Not available | **Not available**, and "No build is published for this platform, so these models cannot run here."    |
| Installing    | **Downloading N%**, then **Verifying**, then **Installing**                                           |

Press **Install** or **Update** there if an engine did not arrive with its model. From a terminal, `maestro-cli models runtimes list` prints the same states, and `maestro-cli models runtimes install <onnx|llama>` installs or updates one and waits until it is usable. A second install of the same engine joins the one already running.

These engines run models inside Maestro. Serving text models to agents over HTTP also needs **llama-server**, installed separately under **Models -> Sources**.

The speech and wake word models are the same files A Cappella uses. Installing them here or from [Voice Setup](./voice-mode#downloading-the-models) is the same install, and either page shows it.

## Endpoints

An endpoint is a model server you run yourself. Endpoints live in **Models -> Sources**. Maestro sends it requests and downloads nothing. If you already run one, it is the fastest way to a working text model. Three kinds are supported:

| Kind              | Default address          | Notes                                     |
| ----------------- | ------------------------ | ----------------------------------------- |
| Ollama            | `http://127.0.0.1:11434` |                                           |
| LM Studio         | `http://127.0.0.1:1234`  |                                           |
| OpenAI-compatible | none, you enter it       | Any `/v1` server, such as LiteLLM or vLLM |

An endpoint serves text generation and embeddings, and on some servers speech-to-text. Endpoints are a core part of Maestro, not an Encore Feature. They have no shortcut; Settings search finds **Endpoints** and lands on the list.

- **Detect local servers** looks for Ollama and LM Studio at their default addresses on this machine, skipping any you already added, and offers each one it finds with its model count and an **Add** button. It runs only when you click it, and adds nothing on its own. When it finds none: "No new Ollama or LM Studio server is running on this machine." (`maestro-cli models endpoints detect`)
- **Add endpoint** and **Edit** open a small form: the kind (Ollama, LM Studio, or OpenAI-compatible), **Name**, **Base URL**, and **API key variable (optional)**. Choosing a kind fills in its default name and address unless you typed your own. **Test** sends a one-token request to the first model the server lists and shows which model answered and how many milliseconds it took, or the error, before you save. **Add endpoint** or **Save** stores it, and **Cancel** discards it. (`maestro-cli models endpoints add --kind <ollama|lmstudio|openai-compatible> [--url <url>] [--name <name>] [--api-key-env <VAR>] [--disabled]`, and `models endpoints update <endpoint>` with the same fields)
- Each endpoint has an **enabled** switch, the list of models it serves, and **Test**, **Refresh models**, **Edit**, and **Remove**. A disabled endpoint stays configured and is never called; a task assigned to it is unavailable until you enable it again. (`maestro-cli models endpoints update <endpoint> --enable` or `--disable`, `models endpoints models <endpoint>`, `models endpoints test <endpoint> [--model <model>]`)
- **Remove** warns first when a task is assigned to the endpoint. It names the task, which stays unavailable until you add the endpoint again or assign another source. Choose **Remove anyway** or **Keep it**. `maestro-cli models endpoints remove <endpoint>` removes it at once, without that warning.

**The API key is never stored in the endpoint.** You give the NAME of an environment variable, and Maestro reads its value from **Settings -> Environment** at the moment it sends a request. A variable with a blank value counts as unset, and `maestro-cli models endpoints add` warns when the variable is not set yet. Settings files end up in backups and debug packages, so a key written into one would leak through all of them. To rotate a key, change it in one place. A local server usually needs no key.

Maestro refuses an endpoint it cannot use, and says why:

- A base URL that is not `http` or `https`, has no host, or has a query string or fragment.
- A base URL with credentials in it: "Do not put credentials in the URL. Name an environment variable for the API key instead."
- An address that is already configured. Every loopback spelling (`localhost`, `127.0.0.1`, `[::1]`) counts as the same host.
- An empty name, or an API key variable that is not a valid environment variable name.

When a call fails, the message names the endpoint and the cause: the server could not be reached ("Check that the server is running."), did not answer in time, rejected the key (HTTP 401 or 403), returned an answer Maestro could not read ("Check that its kind is right."), or serves no models ("Load or pull one, then test again.").

`list`, `add`, `update`, and `remove` edit the settings file and work with Maestro closed. `models`, `test`, and `detect` need the app running. There is no CLI test of an endpoint you have not saved yet.

## Assignments

Assignments choose what each task runs on. There is one row per task, each with a source picker and a readiness line. The rows are on **Models -> System One** and **Models -> System Two**, each tab listing only its own tasks.

The picker only offers sources that can do the job:

- **Off**: the feature does not use a model.
- **Utility source**: inherit the shared source on **System Two** (see [Utility source](#utility-source)). Only Tab naming, Summaries, and AI command mode offer it. The General tab keeps only the switch for automatic tab naming, with a link to System Two for the model choice.
- **An installed model** of the kind the task needs.
- **A model on an enabled endpoint**, for tasks an endpoint can serve (text generation, embeddings, and speech-to-text).
- **System One**, for a task that asks typed questions, while an [engine](#system-one-engines) is chosen. See [System One](#system-one).

A pick the picker no longer offers stays selected and is marked, for example "(not installed)", "(endpoint removed)", "(disabled)", or "(not recommended)". A pick the task cannot use is refused with a red line under the row that says why and what to choose instead. A model that is offered but a poor fit for the task shows a caution above the row.

The readiness line under each row has one of four headlines:

| Headline           | What it means                                                                                                                                                                                                                                                                       |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Ready**          | The source is set up. The line names it.                                                                                                                                                                                                                                            |
| **Utility source** | The task runs on the Utility Agent.                                                                                                                                                                                                                                                 |
| **Off**            | The task does not use a model.                                                                                                                                                                                                                                                      |
| **Unavailable**    | The source cannot run. The line says why and what to do, and offers the fix when Maestro can make it: **Download**, **Resume**, or **Re-download** a model (a model that failed verification), **Enable** a switched-off endpoint, or **Check again** when a server did not answer. |

Some fixes are outside Maestro (for example, starting Ollama), and the line tells you what to do. From the command line:

```bash
maestro-cli models tasks                          # every task, its assignment, and readiness
maestro-cli models assign <task-id> <source>      # off, utility-agent, system-one, local:<model-id>, or endpoint:<endpoint>:<model>
maestro-cli models status <task-id>               # would it run; exits 0 only when ready or on the Utility source
```

`models assign` works with Maestro closed. It prints the same caution the row shows, and tells you when the endpoint you named is disabled.

### Utility source

The **Utility source** card at the top of **Models -> System Two** sets the source for every task left on **Utility source**. Its **Source** picker offers:

- **Default (same as session)**: each task uses the provider of the agent it works for. This is the default.
- A provider under **Providers**: every such task runs on that provider. A **Model override** field takes a model name for it (leave it empty for the provider's default model).
- An installed text model, or a model on an enabled endpoint.

On a local model or an endpoint, context grooming and transfer still use the session's provider, because they need tools. If the provider you picked is no longer installed, the card says so and those tasks fail until you pick another one or return to **Default (same as session)**.

The card has no `models` verb. It is three settings:

```bash
maestro-cli settings set utilitySource '{"type":"local","modelId":"<model-id>"}'
maestro-cli settings set utilitySource '{"type":"utility-agent"}'         # a provider, or Default (same as session)
maestro-cli settings set utilityAgentId claude-code                       # the provider; reset it for Default (same as session)
maestro-cli settings set utilityModelId haiku                             # the Model override
maestro-cli settings reset utilityAgentId
```

### The tasks

| Task                            | System | Needs                              | Default        | What it does                                                                                                                                            |
| ------------------------------- | ------ | ---------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tab naming                      | Two    | Text generation                    | Utility source | Names a new AI tab from the first message sent in it.                                                                                                   |
| Summaries                       | Two    | Text generation                    | Utility source | Writes context summaries for Summarize & Continue and the group chat participant summary.                                                               |
| AI command mode                 | Two    | Text generation                    | Utility source | Turns a plain-English request in command mode into a shell command. You review it before it runs.                                                       |
| Tab cleanup suggestions         | One    | Text generation                    | Off            | Suggests tabs to close, snooze, or bring back. Every action still needs your confirmation.                                                              |
| Git drafts                      | Two    | Text generation                    | Off            | Drafts a pull request title and description from the branch commits and changed files. Fills the fields, never submits.                                 |
| Semantic search                 | One    | Embeddings                         | Off            | Finds history, transcripts, and documents by meaning rather than exact words. See [Semantic search](#semantic-search).                                  |
| Cue gate                        | One    | Text generation                    | Off            | Checks a Cue subscription's gate condition against the event before an agent starts.                                                                    |
| Prompt-injection screen         | One    | Classifier                         | Off            | Scores untrusted text for prompt injection before Cue passes it to an agent.                                                                            |
| Secret screen                   | One    | Classifier                         | Off            | Adds model coverage when scanning content for secrets before it is published. Pattern detection always runs.                                            |
| Dictation                       | One    | Speech-to-text                     | Off            | Transcribes speech into any text box without starting a voice session.                                                                                  |
| Dictation vocabulary correction | One    | Text generation                    | Off            | Corrects misheard names in dictation and A Cappella transcripts using validated vocabulary replacements.                                                |
| Spoken notices                  | Two    | Text generation and text-to-speech | Off            | Writes the short summary a spoken notice adds when an agent finishes a turn. See [Spoken notices](#spoken-notices).                                     |
| Voice routing                   | One    | Text generation                    | Off            | Decides which agent and tab a spoken request is for. See [Voice routing](#voice-routing).                                                               |
| Model routing                   | One    | Embeddings or text generation      | Off            | Decides how much model and effort a turn needs, for an agent on Auto. See [Model routing and Auto](#model-routing-and-auto).                            |
| Token proxy                     | Two    | Text generation                    | Off            | Summarizes large tool output for the token-conservation proxy.                                                                                          |
| Computer History digests        | Two    | Text generation                    | Off            | Writes the 15-minute digests and 6-hour roll-ups of [Computer History](./computer-history#digests-optional) while its digest source is the local model. |
| Local judge                     | One    | Text generation                    | Off            | The text model the System One local judge answers on: yes or no, pick one, or rate on a rubric. Its answers are not calibrated.                         |

**Off** keeps the behavior a feature had before it could use a model. For Summaries that means Summarize & Continue still runs through an agent, as it did before; only the group chat participant summary is not written.

For AI command mode, **Utility source** follows the shared choice. When that choice is **Default (same as session)**, it uses the tab's provider at its current model and effort. On a local model or an endpoint, the [AI Command Mode](./general-usage#ai-command-mode) strip names that model, and the proposed command comes with one line that says what it does.

**Git drafts** adds a **Draft with local model** button to the Create Pull Request form once it is assigned a source. It reads the branch's commit subjects and the list of changed files (not the diff itself), and fills the title and description for you to edit. It never creates the pull request: that is still the Create PR button. While the task is off the button is not shown, and when the assigned model or endpoint is not ready the button is disabled with the reason beside it. A draft adds a note naming the model that wrote it; review it before you create the pull request. The draft reads the local checkout, so it does not work for an agent on an SSH remote. From the command line, `maestro-cli models run git-drafts --cwd <repo> [--base <branch>]` prints the title, a blank line, and the body, and pushes nothing. Without `--base` it compares against `main`, then `master`.

**Tab cleanup suggestions** opens from the menu at the top of the Left Bar (**Tab Cleanup**) or the command palette (**Tab Cleanup Suggestions**). It has no shortcut until you bind one in **Settings -> Shortcuts**. While the task is off, the window says **Tab cleanup suggestions is off** and offers **Open Models Settings**. It gives the model one line about each open and snoozed tab across every agent (its name, when it was last active, how many messages it holds, and what was last asked in it) and lists the tabs the model would close, snooze, or bring back from snooze, each with a one-line reason. It is a list of suggestions and nothing else: every row starts unticked, and no tab changes until you tick the rows you agree with and press **Apply**. A tab that is busy, starred, or holding an unsent draft is never suggested, whatever the model says, and a tab that becomes busy while the list is open is greyed out. A closed tab can still be brought back with Reopen Closed Tab. Snoozed tabs in one batch share the wake time you pick beside the Apply button.

**A task never falls back.** If a task's assignment is not ready, the task does not run on some other source instead. It reports why, and the readiness line shows the same reason. A silent fallback would send your text somewhere you did not choose.

Where it reports depends on the task. A task you started yourself shows the reason in place: AI command mode in its strip, Git drafts beside the button, Tab cleanup in its window, Summarize & Continue as an error. A task that runs in the background raises a yellow notice instead, titled with the task, for example **Tab naming skipped**, with the reason as its message. Tab naming, the group chat participant summary, Spoken notices, Token proxy, and Computer History digests do this. The notice shows once per task and agent, and again only after the task has run fine in between. Every skip is also written to the system log.

### Semantic search

**Semantic search** finds History entries, Director's Notes, and tab transcripts by meaning rather than exact words: "the time the upload retry was fixed" finds the entry even if it never used those words. Give it an embedding model from **Settings -> Models -> Library** (the **Search & Safety** section; **BGE Small (English)** is the small one) or an endpoint that serves embeddings, then assign it on **Settings -> Models -> System One**. It cannot run on the utility source or a System One engine. While it is off, a search by meaning says **Semantic search is off. Assign it a source in Settings > Models > System One.**

```bash
maestro-cli models assign semantic-search local:bge-small-en-v1.5
maestro-cli models status semantic-search        # would it run, and if not, why
```

#### What is indexed

The index builds in the background whenever the task has a source. It has no switch of its own: setting the task back to Off stops indexing, and nothing runs, reads a file, or loads a model until you assign it again.

- **History entries**: the summary and the full response. Cue runs are most of History and mostly repeat, so they are left out unless you turn on **Index Cue runs** (below).
- **Director's Notes**: each synopsis written while Semantic search has a source is kept for the index, the newest 100. A synopsis belongs to no agent, so a search limited to one agent leaves it out.
- **Tab transcripts, one turn at a time**: a turn runs from one of your messages to the next. Only the conversation is read (your messages and the agent's replies), not tool cards. Maestro reads the transcript it saves for each tab, which holds the newest 100 entries, and never the provider's own session files. Background consult tabs are left out. A tab's newest turn is indexed once it has been quiet for 2 minutes.

The first pass starts about a minute after launch. A pass also runs 5 seconds after you change the assignment, new History entries and synopses are indexed within a few seconds, and a full pass every 15 minutes picks up transcripts. A source that no longer exists drops out of the index at the next pass. Indexing waits whenever another task is using the model, and text that has not changed is never embedded twice. If you assign a different model, the next passes index everything again for it; the old model's entries stay on disk until you clear the index. If the model cannot run, indexing stops with the reason and never switches to another model.

#### The Semantic index card

The **Semantic index** card sits under the task table on **Settings -> Models -> System One** (`maestro-cli open settings --tab models --sub-tab system-one`). It shows:

- The state: **Off**, **Up to date**, **Waiting for next pass**, **Indexing**, **Paused while another task uses the model**, or **Unavailable** with the reason.
- How far along it is ("1,204 of 3,400 items indexed"), with a progress bar while it indexes.
- The disk it uses ("12.4 MB on disk · 5,120 searchable chunks"). This counts the index for every model you have indexed with; model downloads are stored separately.

Its buttons:

- **Explore index** lists what is indexed. Pick an **Indexed model** (the one in use is marked **(active)**) and a **Source type**, and page through 20 sources at a time with **Previous** and **Next**. Each row shows the source, its agent, how many chunks it has, when it was indexed, and a passage, or **Original source is unavailable.** when the source is gone. **Refresh entries** reloads the list and **Hide index** closes it.
- **Refresh storage** measures the disk use again.
- **Clear index** removes the cached search vectors for every indexed model and gives back the disk space. Your History entries, Director's Notes, and transcripts are kept. Confirm in the **Clear semantic index** dialog. While Semantic search has a source, the next scheduled pass builds the index again.
- **Index Cue runs** (off by default) adds Cue runs to the index. Turning it off removes them at the next pass.

From the command line:

```bash
maestro-cli models index [--json]                # the state, and how many sources of each kind are indexed
maestro-cli settings set semanticIndexCue true   # Index Cue runs (false turns it off)
```

`models index` exits with code 1 only when the index is **Unavailable**; Off is not a failure. **Explore index**, **Refresh storage**, and **Clear index** have no `maestro-cli` equivalent yet.

#### Searching by meaning

Once the task is ready, two search boxes gain a **Semantic** toggle (a sparkle icon). The toggle is not shown while the task is off or its model is not ready, and it appears without reopening the box once you assign a source.

| Search box                                                                    | What it searches                       | From the command line                                                       |
| ----------------------------------------------------------------------------- | -------------------------------------- | --------------------------------------------------------------------------- |
| [History panel filter](./history#by-meaning)                                  | This agent's History entries           | `maestro-cli search "<query>" --semantic --source history --agent <id>`     |
| [Search Messages (All Agent Tabs)](./general-usage#searching-message-history) | The turns in this agent's open AI tabs | `maestro-cli search "<query>" --semantic --source transcripts --agent <id>` |

With it on, describe what you are looking for. The search runs 300 ms after you stop typing and lists at most 30 results, best match first. Each result shows how close it is (a percentage) and the passage that matched, with your query's words highlighted. A search by meaning never falls back to matching text: when it cannot run, the list shows the reason instead. While the index is still building, the result count says so, for example **Index is still building: 120 of 400 sources.** or **The index has not finished its first pass yet.** When indexing has stopped, it says **The index is not being updated right now.**

#### In the web interface

From the [web interface](./remote-control), both **Semantic** toggles and the **Semantic index** card work as they do in the desktop app. The index and the model are on the computer running Maestro.

#### Searching from the command line

`maestro-cli search` finds past work across History entries, Director's Notes, and tab transcripts. Without `--semantic` it matches the exact text (case does not matter), newest first, and needs no model.

```bash
maestro-cli search "<query>"                     # exact text, newest first
maestro-cli search "<query>" --semantic          # by meaning, best match first
maestro-cli search "<query>" --source history,notes --agent <id> --limit 50 --json
```

`--source` takes `history`, `notes`, or `transcripts` (repeat it or separate with commas). `--agent` takes an id, an id prefix, or the exact name. `--limit` defaults to 20, at most 100. A query is cut at 1,000 characters. The desktop app must be running. The command exits with code 0 when the search ran, even with no results, and 1 when it could not. With Semantic search off, it adds the fix: `maestro-cli models assign semantic-search <source>`.

### Dictation

Dictation types what you say into a text box. It is off until you assign the **Dictation** task a speech-to-text source on **Settings -> Models -> System One**: a local model, or a model on an enabled endpoint that offers `/v1/audio/transcriptions`. Dictation is part of Local Models, not an Encore Feature, so it works with A Cappella switched off.

Download a local model in **Settings -> Models -> Library**, under **Speech**:

| Model                            | Languages       | Good at                                                                                     |
| -------------------------------- | --------------- | ------------------------------------------------------------------------------------------- |
| Parakeet TDT 0.6B (English)      | English         | Dictated English: names, casing and punctuation, quickly, on the CPU                        |
| Whisper Base (English)           | English         | Plain English dictation on modest hardware                                                  |
| Whisper Base (German / English)  | German, English | Explicit German and English transcription                                                   |
| Whisper Small (German / English) | German, English | A larger alternative to Whisper Base. It uses more memory and can take longer to transcribe |

When the Dictation row points at a German / English model, a **Transcription language (never translation)** toggle appears under it, with **Deutsch** and **English** (the default). The model writes down what you said in that language. It never translates. The toggle is not shown for an endpoint.

From the command line:

```bash
maestro-cli models install whisper-small                                 # download a speech model
maestro-cli models assign dictation local:parakeet-tdt-0.6b-v2           # dictate on a local model
maestro-cli models assign dictation 'local:whisper-small?language=de'    # German; quote it, the shell reads ? as a wildcard
maestro-cli models assign dictation endpoint:<endpoint>:<model>          # dictate on an endpoint
maestro-cli models assign dictation off
maestro-cli models status dictation                                      # would it run, and if not, why and what to do
```

A language the model does not have is refused, for example `Parakeet TDT 0.6B (English) does not support transcription language "de".`

#### Using it

Once the task is ready, a small microphone appears in the AI composer (not in terminal mode), the group chat composer, and the bottom corner of every markdown editor you can type in: the file editor, the Auto Run editor, the memory viewer, and the prompt editors. While the task is off, no microphone is drawn. There are two ways to use it:

- **Tap** the microphone to start, speak, and tap it again to stop.
- **Hold** the microphone down while you speak, and release it when you are done.

How long a press must last to count as a hold is the A Cappella **Tap vs hold** setting (300 ms by default). That slider is shown only while A Cappella is on. With A Cappella off, change it from the command line: `maestro-cli settings set acappella.controls.holdThresholdMs 400`.

The words land where the caret is, replacing any selected text, with a space added where one is needed. They land in the box you started in, even if you click somewhere else while you speak. If that box is gone by the time the words arrive, a toast titled **Dictation: the text box is gone** shows what you said so you can copy it.

A pill at the bottom of the window shows what dictation is doing: **Opening the microphone...**, **Dictating**, then **Transcribing...**. While it records, the pill has a **Stop** button. The X button beside it (**Discard this dictation**) throws the recording away. Only one dictation records at a time; while one is recording, the other microphones say **Dictation is recording into another text box**. If the recording held no speech, Maestro flashes **No speech heard**.

You can also dictate from the keyboard. Open **Settings**, then **Shortcuts**, and give **Dictate into Text Box** a chord (it ships with none). The chord works the same way, tap or hold, and it dictates into whichever text box holds the caret, including text boxes that have no microphone button of their own. It never types into a terminal. If no text box holds the caret, Maestro flashes **Nowhere to dictate** and **Click into a text box first.**

Dictation is not a voice session. Nothing is sent to an agent, nothing is spoken back, and the text is not submitted for you: it is typed into the box and you send it when you are ready. In the AI composer, dictated text never changes the command mode, so a sentence cannot become a shell command by accident.

Dictation records through the microphone you picked for A Cappella (**Voice setup**, then **Microphone**), so there is one microphone setting, not two. Until you pick one there, it uses the system default. The picker is shown only while A Cappella is on.

#### Vocabulary

Dictation passes a vocabulary to the recognizer as hints: the current agent, every agent name, every tab title, the word "Maestro", and your custom voice terms. Custom terms have no field in Settings; add them from the command line, for example `maestro-cli settings set acappella.providers.vocabulary '["Kubernetes","Postgres"]'`.

**Dictation vocabulary correction** is a separate, optional text generation task on the same tab, off by default. Assign a model or endpoint to correct misheard names against that vocabulary. It also applies to A Cappella transcripts. Only validated dictionary replacements are accepted: at most four whole words, each replaced by an exact vocabulary term that sounds close to it, and never a number. Other words stay unchanged. A failed, ambiguous, or timed-out correction (it gets 1.5 seconds) keeps the recognizer's original text. Recognition hints and correction use their selected sources, so an assigned endpoint can receive the transcript and vocabulary.

```bash
maestro-cli models assign dictation-cleanup local:<model-id>
maestro-cli models assign dictation-cleanup off
```

#### Limits and refusals

A recording stops by itself after 5 minutes and keeps what it captured. A yellow toast titled **Dictation stopped early** says so. The same toast appears when the microphone stops while you speak: what was said up to then is kept and transcribed.

Dictation checks its model before it opens the microphone. If something is wrong, the microphone is dimmed and its tooltip starts with **Dictation is unavailable:** and names the problem and the fix, for example a model that is not downloaded or an endpoint that is not reachable. Pressing a dimmed microphone checks again. Dictation does not run on a different source instead.

| What you see                                                                                     | What to do                                                                                              |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| Dictation is off. Assign it a local model or an endpoint in Settings > Models > System One.      | Assign the **Dictation** task a source.                                                                 |
| A voice session is using the microphone. End it, then dictate.                                   | End the A Cappella session. Speech is already going to it.                                              |
| The wake word Test is using the microphone. Stop it, then dictate.                               | Stop the wake word **Test** in the A Cappella settings.                                                 |
| A wake phrase is being recorded. Finish that, then dictate.                                      | Finish recording the wake phrase.                                                                       |
| **Microphone access denied**                                                                     | Allow Maestro to use the microphone. Where the system has a setting for it, click the toast to open it. |
| No microphone is available to record a dictation through.                                        | Connect a microphone.                                                                                   |
| The microphone did not open. Try again.                                                          | Try again.                                                                                              |
| Dictation was switched off while recording. Assign it a model in Settings > Models > System One. | Assign the task again, then dictate again.                                                              |

The first time you dictate, your operating system asks for microphone access. A transcription that fails shows a red **Dictation** toast with the reason.

#### In the web interface

From the [web interface](./remote-control), dictation records on the microphone of the device you are using (your browser asks for access the first time) and the computer running Maestro transcribes it with the same assigned model. A clip from a browser may be at most 5 minutes long. A browser opens its microphone only over HTTPS, so over a plain `http://` address the microphone stays dimmed and its tooltip says: **A browser opens its microphone only over HTTPS. Open Maestro through Remote Control, or at localhost on the computer running it, to dictate.** If you deny the browser access, the **Microphone access denied** toast tells you to allow the microphone for the site in your browser's settings.

#### Dictating from the command line

Live dictation needs a microphone, so it has no command. An agent brings the audio as a file instead and gets the same transcript from the same model:

```bash
maestro-cli models run dictation --audio <file.wav> [--json]
```

The file must be a 16-bit PCM WAV, at most 512 MB. The desktop app must be running. The command prints the transcript, and exits with code 6 when the task is off and 7 when it is not ready, with the same reason the dimmed microphone shows.

### Spoken notices

A spoken notice is one line said aloud when an agent finishes a turn, for example "Backend finished". Notices are part of Local Models, not an Encore Feature, so they work with A Cappella switched off. They have no keyboard shortcut, menu item, or command palette entry: you set them in Settings or from the command line.

#### Turning them on

Open **Settings -> Notifications** and find **Speak When an Agent Finishes** (the settings search finds it as "spoken" or "speak"). Pick one value:

| Value                           | What it does                                      |
| ------------------------------- | ------------------------------------------------- |
| **Off** (the default)           | Nothing is spoken.                                |
| **When Maestro is not focused** | Speaks only while no Maestro window has focus.    |
| **Always**                      | Speaks after every finished turn, focused or not. |

Press **Test** beside the choice to hear the sample line "Maestro finished: this is how a spoken notice sounds." The button shows **Speaking** while the line plays. Test speaks whatever the setting says, with the same voice and the same queue as a real notice. If the line is not spoken, the reason is shown under the row in red, for example "A voice session is live, so the notice was not spoken."

```bash
maestro-cli settings set spokenNotices unfocused   # or off, always
maestro-cli settings get spokenNotices
maestro-cli notify speak "Maestro finished: this is how a spoken notice sounds."   # what Test does
```

#### What the line says

The **Spoken notices** task on **Settings -> Models -> System Two** decides how much the line says. It chooses the words only. It never decides whether a notice is spoken.

- **Off** (the default): the line is the agent's name and "finished", for example "Backend finished". The name is the one the Left Bar shows. This needs no model.
- **A local model or an endpoint**: the model reads the start of your request (the first 400 characters) and the end of the agent's reply (the last 2,400 characters) and writes a short summary. Maestro puts the agent's name in front, for example "Backend finished: tests pass, two files changed". An assigned endpoint receives that text.

The task has no Utility Agent option. While notices are on, a line under the setting says which case applies: "The line adds a short summary written by" and the source when a model is ready, or how to assign one when the task is off. When the assigned model is not ready, the line turns yellow, names the problem and the fix, and ends "Until then the line is "<agent name> finished"."

If the assigned model is not ready, takes longer than 20 seconds, or gives no usable summary, the plain line is spoken instead, and a model that is not ready is reported once in a toast. A notice is never skipped because of the model.

The model follows the `spoken-notice-local` prompt: at most 12 words, no agent name, no paths or code, and it says so when the agent needs your input or failed. Edit it in **Settings -> Maestro Prompts**. Maestro removes code, links, and markup from the line and cuts it at a word after 220 characters, about 15 seconds of speech.

```bash
maestro-cli models assign spoken-notices local:<model-id>
maestro-cli models assign spoken-notices endpoint:<endpoint>:<model>
maestro-cli models assign spoken-notices off
maestro-cli models status spoken-notices   # would it run, and if not, why
```

#### The voice

The line is spoken on the computer that runs Maestro. No voice session starts and the microphone stays closed. It uses the voice, speed, and volume you chose for A Cappella when that voice is a local one, and your computer's own voice otherwise. A hosted voice is never used for a notice, because a notice is spoken without you asking and would send text to that service each time. If the local voice you chose cannot speak, the notice is not spoken and no other voice is used instead.

The voice settings are in A Cappella, so they are hidden while A Cappella is off. Notices then use whichever voice was last chosen there, and your computer's own voice when none was. The first notice after Maestro starts can wait up to 10 seconds while its audio starts.

#### When a notice waits or is not spoken

Notices never overlap. One line is spoken at a time, and the next starts 3 seconds after the last one ends. At most four notices wait: when another arrives, the oldest waiting one is dropped. A notice that has waited more than a minute is dropped as old news.

- Nothing is spoken while an A Cappella voice session is live. When a session starts, the notice being spoken is cut off and the waiting ones are dropped.
- A notice waits while you dictate, so the microphone does not record it.
- With **When Maestro is not focused**, nothing is spoken while a Maestro window has focus.

`maestro-cli notify speak` names each case with a code:

| Code                   | Message                                                               |
| ---------------------- | --------------------------------------------------------------------- |
| `setting-off`          | Speak when an agent finishes is off (Settings > Notifications).       |
| `app-focused`          | Maestro is focused, and notices are set to speak only when it is not. |
| `voice-session-active` | A voice session is live, so the notice was not spoken.                |
| `cancelled`            | A voice session started, so the notice was cut off.                   |
| `superseded`           | Newer notices arrived before this one could be spoken.                |
| `stale`                | The notice waited too long behind others to still be news.            |
| `empty`                | There is nothing to say.                                              |
| `no-speaker`           | Nothing in this process can speak a notice.                           |
| `speech-failed`        | The voice could not speak, and the message says why.                  |

#### In the web interface

From the [web interface](./remote-control) you can change the setting and press **Test**, but the line plays on the computer running Maestro, not in your browser. Only one client reports a finished turn, so a turn is never spoken twice. For **When Maestro is not focused**, only a desktop window counts: a browser tab in front does not stop a notice.

#### Speaking from the command line

`maestro-cli notify speak "<text>"` says a line of your own through the same voice and the same queue, waits until it was spoken, and prints `Spoken: <text>`. It ignores the setting and window focus, but not a live voice session. The desktop app must be running.

The text may be at most 600 characters. Empty or longer text exits with code 2. A line that was not spoken prints `Not spoken (<code>): <message>` and exits with code 1. With `--json` the result is `{"success":true,"spoken":true,"text":"..."}`, or `"spoken":false` with `code` and `error`.

### Voice routing

**Voice routing** is the Conductor Brain of [A Cappella](./voice-mode): the model that decides which agent and tab a spoken request is for. Assign it a model on this machine or on one of your [endpoints](#endpoints) and that model routes. Assign it **System One** and the [System One engine](#the-tasks-system-one-answers) picks the agent and tab, while the Brain chosen in A Cappella still writes what is spoken. Picking a model is the same choice as the **Conductor Brain** picker in **Settings > Plugins > A Cappella > Voice Providers**: picking an endpoint model there assigns it here, and an assignment made here shows there. There is one setting, not two.

**Off** (the default) means the Brain is the one chosen in A Cappella: the built-in keyword router, or a hosted model. Picking one of those in the Conductor Brain picker sets this task back to Off.

Your transcripts are sent to the endpoint you assign, and the line at the top of Voice Providers names it ("Audio stays on this machine. Text is sent to Ollama."). Audio is not sent there.

If the assigned model cannot answer (the server is down, the model is not loaded), the voice session says so by name and does not route on another Brain. A turn is given 30 seconds, because the first one can include the server loading the model.

```bash
maestro-cli models assign voice-routing endpoint:<endpoint>:<model>
maestro-cli models assign voice-routing system-one
maestro-cli models assign voice-routing off    # back to the Brain chosen in A Cappella
```

<Note>
	A model run on this machine can be the Conductor Brain too. Qwen3.5 4B is offered for it: in
	testing it sent every request to the agent it named, in about a second a turn. It opens a new
	tab more often than the built-in router where an old tab should be recalled. Qwen3 1.7B is not
	offered: it sent requests that named an agent to the Conductor instead of to that agent.
</Note>

### The secret screen

Maestro checks content for credentials before it publishes that content for you. Three actions are checked: **Publish as GitHub Gist**, **Send Feedback** (the issue text, a comment on an existing issue, and the support package if you attach one), and **Create Debug Package**.

The check looks for known token shapes (AWS access keys, GitHub tokens, Anthropic and OpenAI keys, Slack tokens, private key blocks), for `api_key = <random value>` style assignments, and for the values of the secret-named environment variables you have set in Maestro. This part needs no model and is always on.

When it finds something, nothing is sent. A **Possible Secrets Found** dialog lists what it found, with each value masked, and offers **Publish anyway** (**Create anyway** for a debug package) or **Cancel**. From the command line there is no dialog: the command stops, prints the masked list, and exits with an error. Pass `--allow-secrets` to `maestro-cli gist create`, `support-package`, `feedback submit`, or `feedback subscribe` to send the content as it is.

The **Secret screen** task adds a model pass on top of the pattern check. It is off by default. If you assign it a classifier, the content is also scored by that model, and a flag from the model is listed with the model's name and score. A model that cannot run does not block publishing and does not hide a pattern finding: the dialog says that only patterns ran. The catalog's classifiers are trained to detect prompt injection, not credentials, so treat a model flag as a reason to look, not as proof.

The check is a safety net. It does not find every secret, and a clean result is not a guarantee. Read what you publish.

## System One

System One answers a question with a judgment, not with text. A task hands it some text and a question with a fixed shape. It sends back a number or a pick, never a paragraph.

| Question         | What comes back                                                         |
| ---------------- | ----------------------------------------------------------------------- |
| Yes or no        | The probability of yes, from 0 to 1                                     |
| Pick one of N    | The option it chose, how likely each option is, and how sure it is      |
| Rate on a rubric | A level on a rubric of 2 to 10 described levels, and how likely each is |

A task uses it for a decision it must make fast and often. The Cue gate is the first: before an agent starts, it asks "should this run proceed?" about the event. Jev answers in about 0.1 to 0.2 seconds.

Do not confuse this with [System One and System Two](#system-one-and-system-two), the rule that sorts tasks onto two tabs. That rule says which tab a task's row sits on. This section is about the **engine** that can answer for the rows on the System One tab.

System One is **off** until you choose an engine. Only a task that asks typed questions is offered System One: the six in [The tasks System One answers](#the-tasks-system-one-answers). Every other task keeps the sources in [Assignments](#assignments).

Everything in this section is on **Settings -> Models -> System One** (`maestro-cli open settings --tab models --sub-tab system-one`), in this order: the **System One engine** card, the task list, **System One for agents**, and the **Decision ledger**. The command palette has no entry of its own: **Open Models Settings** opens the tab. There is no keyboard shortcut. Settings search finds **System One engine**, **Fail policy**, **System One tasks**, **System One for agents** and **Decision ledger**. System One is part of Local Models, not an Encore Feature.

### System One engines

| Engine                   | What it is                                                                   | Calibrated | Price                           | Named in the UI as                      |
| ------------------------ | ---------------------------------------------------------------------------- | ---------- | ------------------------------- | --------------------------------------- |
| **Jev (TypeSafe cloud)** | TypeSafe's hosted Jev, at `https://api.typesafe.ai`                          | Yes        | $0.042 per million input tokens | Jev (TypeSafe cloud)                    |
| **OpenJev**              | An OpenJev server you run, at a URL you give, with an optional key           | Yes        | None                            | OpenJev at `<host>`                     |
| **Local judge**          | A text model on this machine or on an endpoint, answering the same questions | No         | None                            | Local judge (`<model>`), not calibrated |

**Calibrated** means that when Jev says 0.9, it is right about nine times in ten. A local judge does not claim that. It names a side and says how sure it is, and the number is not a measured probability. Every surface says which engine answered: the Test result, the Cue event's reason, the decision ledger, and `maestro-cli s1`. A local judge is never shown as Jev.

OpenJev needs a CUDA GPU, so on a Mac it is a server at another address, not `localhost`.

<Warning>
	**Choosing Jev sends text to TypeSafe.** The text of every System One request, a Cue event for
	example, goes to `api.typesafe.ai` after Maestro removes secrets from it. Choosing OpenJev sends it
	to the server at the URL you give. Only the local judge keeps the text on your machine, and then
	only if its model is a download or a server on your own computer. Choose Jev only if you would send
	that text there yourself.
</Warning>

### Choosing an engine

Open **Settings -> Models -> System One**. The **System One engine** card is at the top.

- **Engine.** The picker: **Off** (the default), **Jev (TypeSafe cloud)**, **OpenJev**, or **Local judge, not calibrated**. One sentence under it says where the text goes. (`maestro-cli s1 set engine off|jev-cloud|openjev|local-judge`)
- **OpenJev server URL** (OpenJev only). The address of your OpenJev server, saved with **Save**. A URL may not hold credentials: store a key for OpenJev instead. In the card you can choose OpenJev before you type the URL: the card then says the URL is missing, and a request is refused ("OpenJev has no URL. Set it in Settings > Models > System One."). From the command line, `s1 set engine openjev` needs `--url <url>` the first time.
- **API key.** See [The key](#the-key).
- **Pinned model (optional)** (Jev and OpenJev). Empty, Jev uses `jev-latest`, which moves to each new release, and OpenJev sends no model, so the server answers on the one it was started with. If you tuned a threshold against one version, pin that version here and press **Save**. A model name has no spaces. A pin belongs to one engine, so switching engines does not carry a wrong version over. (`maestro-cli s1 set engine jev-cloud --model <model>`; `--model default` removes the pin)
- **Model** (local judge). The local judge has no pin: this row shows the model assigned to the **Local judge** task, or says none is assigned yet and points to the **Local judge** row below. A local judge with no model refuses every request by name.
- **Timeout (ms)** (Jev and OpenJev). How long one request may take, 1500 by default, from 100 to 60000. With no answer in time, the task applies its [fail policy](#when-there-is-no-answer). The local judge keeps its own 30 second budget, because the first answer after an idle spell has to load the model. (`maestro-cli s1 set timeout <ms>`)
- **Test.** Shown once an engine is chosen. It asks one fixed yes or no question about a fixed sentence ("The meeting was moved from Tuesday to Thursday at 3 pm.") and shows the answer, P(yes), the time it took, the model and the engine, for example "Jev (TypeSafe cloud) answered yes (P(yes) 0.97) in 180 ms on jev-latest." It sends nothing of yours. If the engine answers "no", the result adds "The right answer to the test question is yes." A failure shows the error. (`maestro-cli s1 test`, which exits non-zero when no answer came back)

Every state and question is checked for secrets before it leaves your machine, whichever engine you chose. A removed span is noted on the result.

If `TYPESAFE_BASE_URL` is set, Maestro sends hosted requests there, the way the `jev` command does, and the card warns you. A value that is not a URL is refused, not ignored.

### The key

A key is write-only. Maestro stores it sealed with your operating system's key store (or obscured, when the system offers none), and no screen and no command shows it again. A surface says only where the key in force comes from:

| Source                           | When                                                                                     |
| -------------------------------- | ---------------------------------------------------------------------------------------- |
| **Stored**                       | You saved it in the card or with `maestro-cli s1 key set`. Used first.                   |
| **`TYPESAFE_API_KEY`**           | Read from **Settings -> Environment**, then from the environment Maestro was started in. |
| **`~/.config/typesafe/api_key`** | The file the `jev` command reads.                                                        |

The **API key** row (Jev and OpenJev) has a field to paste a key and **Save** (**Replace** once one is stored), and **Clear** to remove a stored key. From the command line the key is read from standard input, never from an argument, and a terminal with nothing piped is refused:

```bash
pbpaste | maestro-cli s1 key set [--engine jev-cloud|openjev]   # default: the engine in force
maestro-cli s1 key clear [--engine jev-cloud|openjev]
```

`s1 key clear` says so when the engine still has a key from another source. A key is one line with no spaces. Jev with no key from any source refuses every request: "Jev (TypeSafe cloud) has no API key. Add one in Settings > Models > System One." OpenJev needs a key only when its server asks for one.

A key is set on the computer running Maestro. From the web interface the card shows where the key in force comes from, but has no field to paste one: it says "Keys are stored on the computer running Maestro: set this one in its Settings, or there with `pbpaste | maestro-cli s1 key set`." Keys never cross the web interface. The rest of System One (the engine, **Test**, fail policies, budgets, the ledger and the spend table) works from a browser too.

The last two are read-only fallbacks for Jev. An OpenJev server is only ever sent a key stored for it, so your TypeSafe key never goes to somebody else's machine. If a stored key cannot be opened (a reset key store, a file from another computer), Maestro says so and sends nothing. It does not fall through to another source. **Replace** or **Clear** is your call.

### The tasks System One answers

Six tasks can run on System One. Each asks its question in a fixed shape and keeps the thresholds and the output it had when a model answered, so nothing downstream can tell which engine decided except the [ledger](#the-decision-ledger) and the engine's name in the reason.

| Task                        | What it asks                                                                                              | When there is no answer                                        |
| --------------------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| **Cue gate**                | Yes or no: should this run proceed? About the gate's condition and the event                              | The [fail policy](#when-there-is-no-answer), `open` by default |
| **Prompt-injection screen** | Yes or no: does this text hold instructions aimed at an AI agent? It reads the whole text, uncut          | The fail policy, `closed` by default                           |
| **Secret screen**           | Yes or no: is there a credential here a pattern would miss? Extra coverage only                           | A note. It never blocks: the pattern scan already ran          |
| **Tab cleanup**             | One pick per tab: close, snooze or keep. Each tab's facts are in its own question                         | The run fails with the reason. Nothing is suggested            |
| **Voice routing**           | Which agent, which tab, and is it clear. Picked by id, never by position in a list                        | Refused by name. The Brain is not asked to route instead       |
| **Model routing**           | How much model and how much effort, as two ratings. See [Model routing and Auto](#model-routing-and-auto) | The turn runs at the agent's default. Not an error             |

Four things hold for all of them:

- **A secret never reaches an engine.** Every request is redacted on its way out. The secret screen's question says a `[REDACTED_...]` marker is not a finding, so an engine only adds coverage for what no pattern has a shape for.
- **The injection screen's fail policy only tightens Cue's rule.** `closed` blocks every action when the engine gives no answer. `open` leaves Cue's own rule in place, and under that rule a command is still blocked. One consequence: with System One on the default policy, a prompt subscription is blocked while Jev is down, where the classifier path lets it through with a warning.
- **Voice routing on System One is for command mode.** An engine writes no sentence, so a turn in which the Conductor may talk back stays with the Brain. The Brain also still writes everything spoken, and a new tab gets no suggested name. The assignment fills no Brain slot: the Voice Providers panel says who routes, beside the Brain picker.
- **Tab cleanup shows an engine's reason as a composed line**, for example "Jev (TypeSafe cloud) chose close, 87% likely." An engine does not write a sentence.

### Giving a task to System One

A task's source picker offers **System One (Jev)**, **System One (OpenJev)** or **System One (local judge)** when the task asks typed questions and an engine is chosen. The assignment names no engine. The engine in force answers for every task, and the label says which one that is. If you switch the engine off, a task left on System One shows **System One (no engine chosen)**.

```bash
maestro-cli models assign cue-gate system-one
```

The readiness line reads **Ready** when the engine in force is set up, and names what is missing when it is not. Nothing is sent to find out.

### When there is no answer

An engine can fail: no key, a timeout, a server that is down, a request that is too large, or no engine chosen. A task then applies its **fail policy**, shown in the **If no answer** column of the task list. The column's picker offers **Fail open** and **Fail closed**, with the task's default marked **(default)**:

| Policy          | What the task does             | Default for             |
| --------------- | ------------------------------ | ----------------------- |
| **Fail open**   | The work goes ahead, unchecked | Cue gate                |
| **Fail closed** | The work stops                 | Prompt-injection screen |

A task with no default policy has none to apply: it reports "unavailable", and its caller decides what no answer means. Model routing is one: a turn with no decision runs at the agent's default. Change a policy in the column, or with `maestro-cli s1 set fail-policy <task-id> open|closed|default` (`default` goes back to the task's own).

The ledger names why no answer came, as one of `auth`, `rate-limited`, `too-large`, `unavailable`, `timeout`, `invalid` or `cancelled`.

Two rules hold for every task:

- **No silent fallback.** If Jev gives no answer, Maestro does not ask OpenJev, the local judge, or a model instead. The task applies its policy and says why.
- **A subscription's own rule wins.** A Cue subscription with `gate_on_unavailable` set uses that rule for its gate, and the task's policy applies only when it is not set. The Cue event shows which rule skipped a run.

A gate answers **proceed** when the probability of yes is 0.5 or more. An event that does not say enough passes, as the local gate does.

### The decision ledger

Each run that reaches System One leaves one record, answered or not. The **Decision ledger** under the task list shows them, newest first. Filter by task (**All tasks**, or one task) and by outcome (**All outcomes**, or one below), and press **Refresh** to read again. Each row shows when it ran, its topic, the engine, the outcome, the decision and the time it took, a saved-question preview when inputs were kept, and the available agent, model, token, cache, and cost details. Expand it for **When**, **Model**, **Questions** (the question ids), **Why no answer**, **Tokens**, **Cost (est.)**, **Agent**, and the kept input. Without a saved question, the row says "Decision context unavailable: input was not kept."

| Outcome           | CLI id          | What happened                                   |
| ----------------- | --------------- | ----------------------------------------------- |
| **Answered**      | `ok`            | The engine answered every question              |
| **Failed open**   | `failed-open`   | No answer, and the policy let the work go ahead |
| **Failed closed** | `failed-closed` | No answer, and the policy stopped the work      |
| **No answer**     | `unavailable`   | No answer, for a task with no policy of its own |
| **Cancelled**     | `cancelled`     | The caller stopped the request                  |

A timeout is not an outcome of its own: it is a failed run whose reason is `timeout`, so the record still says whether the work went ahead. **Timed out** (`timeout`) is a filter that matches that reason.

A request from an agent is filed under the task **Agent: rank**, **Agent: yes** and so on, with the agent's name (`--task agent:rank` on the command line).

A record holds the task, the engine, the question ids and the typed answers. It holds **no text** unless you turn on **Keep inputs in the ledger**, which is off by default (`maestro-cli s1 set keep-inputs on|off`). When it is on, the state and the questions are kept with secrets removed, and cut at 20,000 characters. Turning it off later does not delete what was kept: those rows go with the rest after 30 days.

The ledger is kept for 30 days. It is written only while usage statistics are on, and a read says so when they are off: "Usage statistics are switched off, so new decisions are not kept." The panel shows at most the newest records it reads and says how to read the rest. From the command line:

```bash
maestro-cli s1 ledger [--task <task-id>] [--outcome <outcome>] [--since 2h] [--limit <n>] [--json]
```

`--limit` is 1 to 1000, 100 by default.

### System One for agents

An agent can ask System One too. While an engine is chosen and has passed its Test, each agent Maestro starts is told that System One exists and gets the `maestro-cli s1` verbs to ask it. It is for a judgment that repeats over many items the agent should not read into its own context: sort 400 commit messages, rank a list of candidates, check a draft against a source, or screen untrusted text for instructions aimed at an agent.

An agent does not use it for everything. It is told not to for text generation, math, counting, dates, or a list short enough to read. In a real run on Claude Opus 5.5, an agent given 40 one-line commit messages read them and answered itself. Given 400, it sized the job, read the guide, handed the file to `s1 rank`, never read the list into its context, and got all 120 right for less than a tenth of a cent of System One.

#### What an agent is told

Three levels, cheapest first. An agent pays for a level only when it decides it needs it.

| Level  | What the agent gets                                                                                        | When                                                           |
| ------ | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| **L0** | A section of its system prompt, about 18 lines: what System One is, when to use it, the engine, the budget | Each time the agent starts, while a request from it would work |
| **L1** | `maestro-cli s1 guide [topic]` and `maestro-cli s1 examples [name]`                                        | When the agent decides it needs System One                     |
| **L2** | The full reference, `maestro-cli prompts get _system-one`: every flag, output shape and pitfall            | When the agent needs exact detail                              |

The L0 section names the engine and says whether its numbers are calibrated. A local judge is always called **not calibrated**, so an agent never treats its number as a probability. It gives the budget as a band ("more than half is left"), not a figure: the system prompt is cached by its exact text, and a figure that changed after every request would cost every agent its cached prompt. The exact figure is on the line under every answer, and in `maestro-cli s1 usage`.

The section also states the rules an agent cannot wait for the guide to learn:

- **Key the items.** Never ask about a position in a list. Asked about items by their place in a list of 150, a model was wrong 27% of the time, against 0 wrong of 320 when each item was keyed. `s1 rank` and `s1 batch` key every item for the agent.
- **Single-quote a question that holds backticks**, or the shell runs the text inside them as a command.
- **A screen is not a permission.** System One answers questions about a text. It does not make the text safe to obey.
- **A refusal is final.** If System One is off or the budget is spent, the agent continues without it. It does not retry and does not route around the refusal.

The guide is plain prompts. Edit what your agents are taught in **Settings -> Maestro Prompts**, in the **System One** category.

The L0 section is there only while **all** of these hold. It is decided each time an agent starts, so turning System One off removes it from the next start. An agent that is already running keeps what it was told, and its verbs refuse by name.

| Condition                                                                        | If it fails                                   |
| -------------------------------------------------------------------------------- | --------------------------------------------- |
| An engine is chosen and set up                                                   | `engine-off` or `engine-not-ready`            |
| The engine has passed its Test as it is set up now                               | `engine-untested`                             |
| **Let agents use System One** is on                                              | `agents-off`                                  |
| This agent is not switched off in its own settings                               | `agent-opted-out`                             |
| The day's budget, for all agents and for this agent if you set one, is not spent | `budget-day` or `budget-agent`                |
| The agent runs on this computer                                                  | An SSH remote agent is never told (see below) |

Changing the engine, its URL, its model or its key makes the last Test stale. Press **Test** again, or run `maestro-cli s1 test`. An engine you set up before agents could ask needs one Test.

#### The verbs

Every verb takes `--json`. The state is `-s/--state TEXT` (`@path` reads a file, `-` reads standard input), `--state-file`, `--state-json`, `--field key=value`, or piped text. The flags are the `jev` command's, so an agent that knows one reads the other.

| Verb                                                   | Asks                                  | Returns                                                    |
| ------------------------------------------------------ | ------------------------------------- | ---------------------------------------------------------- |
| `s1 yes "<question>" -s TEXT [--threshold 0.5]`        | Is this true?                         | The probability of yes                                     |
| `s1 pick "<question>" a="desc" b="desc" -s TEXT`       | Which one of these?                   | The option, the probability of each, and how sure it is    |
| `s1 rate "<question>" "<level 1>" "<level 2>" -s TEXT` | Where on this rubric?                 | The level, and how sure it is                              |
| `s1 ask --noul ... --choice ... --score ... -s TEXT`   | Several questions in one request      | Every answer, keyed                                        |
| `s1 rank --query Q --candidates-file F [--top N]`      | Which of these items match?           | A ranked list, with a completeness marker                  |
| `s1 batch --input rows.jsonl --noul ... [--out F]`     | The same questions over many rows     | JSONL, with a completeness marker                          |
| `s1 usage [--agent <id>] [--since <d>]`                | What was spent, by which agent        | Requests, tokens, cost and latency, against today's budget |
| `s1 cost <state or file>`                              | Will this fit, and what will it cost? | Tokens against the request limit, and the price            |
| `s1 guide [topic] [--list]`, `s1 examples [name]`      | Nothing: they print the guide         | Text. They work while System One is off                    |

Each answer names its engine, whether it is calibrated, the model, the tokens, the latency and the cost. The answer goes to standard output and that line to standard error, so `$(maestro-cli s1 yes ...)` holds the answer alone. An item with no answer is **unknown**, never a low score, and `rank` and `batch` end with a marker that says how many items were judged. No marker means the output was cut.

Exit codes let a shell test them:

| Code | Meaning                                                                 |
| ---- | ----------------------------------------------------------------------- |
| 0    | Yes, or at or above `--min-confidence`, or a job that judged every item |
| 1    | No, uncertain, or under `--min-confidence`. Never an error              |
| 2    | A wrong command line or request                                         |
| 3-5  | The desktop app could not be reached, or does not know the verb         |
| 6    | System One refused: a switch, or the budget. Do not retry               |
| 7    | The engine gave no answer, or a `rank` or `batch` is incomplete         |

#### The budget

The **Daily budget (US dollars, all agents)** is a ceiling on what all agents spend on System One in a day. It is $1 by default, from 0 to 1000. An optional **Budget per agent (optional)** caps one agent inside it, with no cap by default (the field is empty).

- A request is checked before it is sent. A request over budget is refused by name (exit 6) and the agent is told to continue without System One. The day starts at local midnight.
- A day can pass its budget by at most the requests already in flight, which is four requests of a few tenths of a cent each.
- The count is kept in Maestro and seeded from the [decision ledger](#the-decision-ledger) once a day, so it survives a restart. While usage statistics are off the ledger keeps nothing new, and the count starts again when Maestro restarts.
- OpenJev and the local judge cost nothing, so a dollar budget never stops them. A budget of 0 stops every agent.
- Only agents' own requests count. A Cue gate's run is Maestro's spend, not an agent's, even when it names an agent.

Spend is on **Settings -> Models -> System One -> System One for agents**. **Spent today** reads, for example, "$0.03 of $1.00 by all agents, $0.97 left." **Spend per agent** is a table of **Requests**, **Cached**, **Tokens in**, **Cost** and **Avg ms** per agent, with a **Total** row, over **Today**, **Last 7 days** or **Last 30 days**, and a **Refresh** button. The same rows are in the decision ledger, labelled "Agent: rank" and so on, and `maestro-cli s1 usage` prints them.

A request is answered from a cache when the engine, the model, the state and the questions are the same as an earlier one in the last 7 days. It costs nothing and says "cached answer". `--no-cache` asks again.

#### The key stays in Maestro

The agent never holds the key. `maestro-cli` talks to the desktop over its local connection and the desktop asks the engine with the key it holds. A request cannot name a key, a model or a budget, and an agent's environment gets nothing new. Every request is checked for secrets before it leaves your machine, the same as every other System One request.

<Warning>
	**An agent's request goes where the engine goes.** With Jev, the text an agent hands System One goes to `api.typesafe.ai` after Maestro removes secrets from it. Do not choose Jev for agents that work on text you would not send there yourself.
</Warning>

#### Turning it off

| To switch off                        | Where                                                                                                            |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| System One for all agents            | **Settings -> Models -> System One -> Let agents use System One**, or `maestro-cli s1 set agents off`            |
| System One for one agent             | The **System One** switch on **Edit Agent -> Models**, or `maestro-cli update-agent <agent> --system-one off`    |
| System One for new agents in a group | The **System One** switch in **Group Settings**, or `maestro-cli update-group-settings <group> --system-one off` |
| System One for everything            | Set the engine to **Off**, or `maestro-cli s1 set engine off`                                                    |

Each takes effect on the next start of an agent, and the verbs refuse at once. The agent's switch says "This agent follows "Let agents use System One"." when on, and under it which engine answers its requests and what it has spent today. A worktree agent inherits its parent's switch, so an agent you switched off does not start asking from a worktree of the same project. A new agent follows the global switch, unless its group's **System One** switch is off: then it starts with System One switched off ("A new agent in this group starts with System One switched off."). The group switch does not change agents already in the group unless you [publish](./features#publishing-a-save-to-existing-agents) the save (`--publish` on `update-group-settings`).

Set the budgets with the fields beside the switch, or `maestro-cli s1 set budget <usd>` and `maestro-cli s1 set budget --per-agent <usd|none>`. `maestro-cli s1 status` prints what agents may do and what in the setup stops them.

#### With a `jev` install

You may also have the `jev` command and its skill. Maestro does not forbid them. Inside Maestro the L0 section tells an agent to prefer `maestro-cli s1`, because it uses the key, the budget and the ledger Maestro holds. A call to `jev` is not counted against the budget and is not in the ledger.

#### What does not apply

- **SSH remote agents are not told.** Their shell is on another host, where `maestro-cli` cannot reach this desktop. The Edit Agent pane says so.
- **Some runs do not name their agent.** A Cue run, a group chat participant and an agent answering an `@mention` are started without the identity `maestro-cli` reads. Their requests are held to the global switches and the daily budget. The per-agent cap and the per-agent switch do not reach them, and the ledger row names no agent.
- **The desktop app must be running.** With it closed, the verbs cannot work and the section is left out.
- **A stopped command does not stop its job.** If a shell tool kills a long `rank`, the desktop finishes the job and caches the answers. The same command again collects them at no cost.
- **Limits per request.** At most 250 questions and about 30,000 tokens go in one request, and 5,000 candidates or rows in one call. Maestro splits a large job. The local judge takes one question a request, so it is slower.

### System One from the command line

Every verb needs the desktop app running.

```bash
maestro-cli s1 status [--json]                   # engine, address, model, timeout, where each key comes from, fail policies, agents
maestro-cli s1 set engine off|jev-cloud|openjev|local-judge [--url <url>] [--model <model>]
maestro-cli s1 set timeout <ms>                  # 100 to 60000; Jev and OpenJev only
maestro-cli s1 set fail-policy <task-id> open|closed|default
maestro-cli s1 set keep-inputs on|off            # whether the ledger keeps what was asked
maestro-cli s1 set agents on|off                 # whether agents may ask System One
maestro-cli s1 set budget [<usd>] [--per-agent <usd|none>]   # the daily budget, and the optional cap for one agent
pbpaste | maestro-cli s1 key set [--engine jev-cloud|openjev]   # the key is read from stdin, never an argument
maestro-cli s1 key clear [--engine jev-cloud|openjev]
maestro-cli s1 test [--json]                     # one fixed question: answer, latency, engine
maestro-cli s1 ledger [--task <task-id>] [--outcome <outcome>] [--since 2h] [--limit <n>] [--json]
maestro-cli s1 usage [--agent <id>] [--since 7d] [--json]      # what agents spent
maestro-cli s1 route "<prompt>" [--agent <id>] [--correct <tier>] [--json]   # a dry run of the model router (see Model routing and Auto)
```

`s1 status` exits non-zero when the engine in force cannot answer as set up (no key, no URL, no judge model). Off is not a failure. `s1 test` exits non-zero when no answer came back. For the local judge, `--model` takes a source (`local:<model-id>` or `endpoint:<endpoint>:<model>`) and assigns it to the **Local judge** task, the same as `maestro-cli models assign local-judge <source>`. `--since` accepts `30m`, `2h`, `1d`, `1w`, an ISO-8601 time, or an epoch.

The verbs an agent asks with (`yes`, `pick`, `rate`, `ask`, `rank`, `batch`, `cost`, `guide`, `examples`) are in [System One for agents](#system-one-for-agents).

## Model server

The Maestro model server shares the models in your Library over HTTP, so an agent harness such as Claude Code, Codex, or OpenCode can use them. It is llama.cpp's own `llama-server`, which Maestro downloads as an [engine](#engines), starts, and watches. It speaks the three protocols a harness uses: OpenAI Chat Completions (`/v1/chat/completions`), OpenAI Responses (`/v1/responses`), and Anthropic Messages (`/v1/messages`). It serves text generation models only.

The card is on **Models -> Sources**, below the endpoints. It is a core part of Maestro, not an Encore Feature, and it has no shortcut; Settings search finds **Model server**. The card shows the state (**Stopped**, **Starting**, **Running**, **Restarting**, **Stopping**, or **Failed**), the build in use and what it **Runs on** (for example **Metal**, **Vulkan (NVIDIA ...)**, or **CPU**), the address, the key, and the models loaded now with the memory their weights take. `maestro-cli models server status` prints the same, plus the log path, and exits non-zero when the server is **Failed**.

- **It never starts on its own.** Press **Start** (`maestro-cli models server start`, which waits until the server answers). It also starts when something you turned on needs it, such as a task you assigned to it. It stops when you press **Stop** (`maestro-cli models server stop`) and when Maestro quits. **Start** stays disabled until the engine is installed, and a start with no text model downloaded is refused: "No text model is downloaded for the Maestro model server to serve. Download one in Settings > Models > Library."
- **Install the engine first.** Under **Hosting engine (llama-server)**, pick a build in **Engine build** and press **Install hosting engine** (**Install again** once one is installed). This is a separate install from the llama.cpp engine in **Models -> Library -> Engines**; both use the same downloaded model files. The default build is Metal on an Apple Silicon Mac, CPU on an Intel Mac, and Vulkan on Windows and Linux, which runs on any GPU vendor. Windows and Linux also offer the CPU build, and on x64 the CUDA and ROCm builds; those are large downloads and need a matching driver. Progress shows on the card in every window. A running server keeps serving while a new build installs, then restarts on it. (`maestro-cli models server set --build default|cpu|cuda|rocm`)
- **The card says what the build runs on.** After an install Maestro checks the build on this computer. If it finds no GPU, only a software renderer, or the Vulkan loader missing, the card says so and offers **Install the CPU build**. Maestro never swaps a build without telling you. A build older than the one Maestro expects shows "This build is older than the one Maestro expects. Install it again to update it."
- **The port is chosen once and kept.** The **Address** row shows `http://127.0.0.1:<port>` with a **Copy address** button; before the first start it says the port is chosen then. An address you gave a harness keeps working across restarts. If another program holds the port, the start fails and names the address; the server does not move.
- **One model is loaded at a time.** The server loads a model the first time a request names it and unloads the least recently used one when another arrives. A second copy of a 20 GB model is a real cost, so the default is one. **Models loaded at once** raises it, from 1 to 16. (`maestro-cli models server set --max-models <n>`)
- **Context is at least 40,960 tokens.** An agent's first prompt is about 14,000 tokens, and a smaller context fails with "Prompt is too long". Maestro sets this for each model.
- **Changes restart it.** The bind mode, the model count, and the key are read at launch, so changing one restarts a running server.
- **It is watched.** If the server stops answering, Maestro restarts it, up to 3 times in a row. After that it is left **Failed**, and a red "Maestro model server stopped" notification says why. A start that does not answer within 60 seconds is stopped.
- **Open log** opens `model-server.log` in Maestro's `logs` folder. From a terminal, `maestro-cli models server status` prints the path, and `maestro-cli open-file <path>` opens it.

### Local only or Network

**Who can reach it** on the card switches between the two modes. The default is **Local only**. (`maestro-cli models server set --bind local|network`)

| Mode           | Listens on  | Who can reach it                         |
| -------------- | ----------- | ---------------------------------------- |
| **Local only** | `127.0.0.1` | This machine                             |
| **Network**    | `0.0.0.0`   | Any machine that can reach this computer |

**Both modes require the key.** Local only uses it too, so another program on this machine, or a web page your browser has open, cannot use your models without it. Maestro generates the key, stores it sealed with the operating system's key store, and never writes it to a log. On a system with no key store (Linux with no keyring) the key is stored obscured, not encrypted, and the card and `maestro-cli models server status` say so. The key is made the first time you copy it or start the server. A harness sends it as `Authorization: Bearer` or `x-api-key`. **Copy** under **API key** puts it on the clipboard (`maestro-cli models server key` prints it). **Rotate** makes a new one after you confirm, because "Rotating makes the current key stop working. Anything set up with it needs the new key." (`maestro-cli models server set --rotate-key`). Network mode refuses to start without a key, and the card warns that anyone on the network who has the key can use the models and the memory they take.

Choose Network only on a network you trust. The key travels in clear text over plain HTTP.

### Point a harness at it by hand

To make one of your agents use the server, set its [Run on](#run-on) target: Maestro then sets the variables and arguments below for you, on every launch. Do it by hand only for a harness that Maestro does not run. Read the address with `maestro-cli models server status` and the key with `maestro-cli models server key`, then use the model's catalog id (for example `qwen3-1.7b-instruct-q4km`) as the model name.

```bash
# Claude Code
ANTHROPIC_BASE_URL=http://127.0.0.1:<port> \
ANTHROPIC_AUTH_TOKEN=<key> \
ANTHROPIC_DEFAULT_HAIKU_MODEL=<model-id> \
CLAUDE_CODE_MAX_CONTEXT_TOKENS=40960 \
claude --model <model-id>

# Codex (the key is read from the environment variable named by env_key)
MAESTRO_LOCAL_KEY=<key> codex \
  -c "model_providers.maestro={name='Maestro',base_url='http://127.0.0.1:<port>/v1',env_key='MAESTRO_LOCAL_KEY',wire_api='responses'}" \
  -c "model_provider='maestro'" exec -m <model-id> "your prompt"
```

The Codex values use single quotes inside and no spaces on purpose. Windows PowerShell does not pass a program an argument that holds double quotes whole, and Codex then refuses it. Written this way the two `-c` arguments work in bash, zsh, cmd.exe and PowerShell. On Windows, set the variables first (`$env:MAESTRO_LOCAL_KEY = "<key>"` in PowerShell) and put the command on one line.

Both were tested with Claude Code 2.1.296 and Codex CLI 0.162.1 on macOS. A small model follows an agent's tools less well than a hosted one, so expect a short turn to work and a long one to wander.

### Using the server for housekeeping tasks

The server is also an endpoint named **Maestro model server**. It is built in: it cannot be edited or removed, and only this card controls it. Pick it in an [assignment](#assignments) to run a task on it. Assigning a task to it starts the server and loads the model when the task runs. It serves text generation only, so a task that needs embeddings or speech is refused there, with a message to assign a local model or another endpoint.

You never pay for a second copy. If the server is running with a model loaded, a task assigned to that same local model goes to the server instead of loading the model inside Maestro.

From the command line:

```bash
maestro-cli models server status [--json]       # state, build, accelerator, address, loaded models
maestro-cli models server start
maestro-cli models server stop
maestro-cli models server set --bind local      # or network; --max-models <n>; --rotate-key; --build default|cpu|cuda|rocm
maestro-cli models server key                   # prints only the key, for $(...)
```

Every verb takes `--json`. `status` and `start` print the address, and `key` makes the key if none exists yet.

### Sources in the web interface

Everything on **Models -> Sources** runs on the computer running Maestro, whichever screen you press the button on. **Detect local servers** looks for Ollama and LM Studio on that computer, not on the device the browser runs on, and **Test** calls the endpoint from there.

- **The model server key stays on the host.** From a browser you can start, stop, install, change the bind mode and the model count, and **Rotate** the key, but **Copy** is refused. Read the key in the desktop app or with `maestro-cli models server key` on that computer.
- **Open log** downloads the log file to the browser's device.
- **VoiceStudio's Check connection** works only in the desktop app. Set its fields there, or with `maestro-cli settings set` (see [VoiceStudio](#voicestudio)).

## VoiceStudio

The last section of **Models -> Sources** points Maestro at VoiceStudio, a speech service you run on this computer that speaks with cloned voices. Maestro connects to it and never starts it. Choose VoiceStudio as the A Cappella Text-to-Speech provider to use its voices; [VoiceStudio voices](./voice-mode#voicestudio-voices) covers that part. The section is not behind an Encore Feature, and Settings search finds **VoiceStudio**.

| Field                 | Default                 | What it is                                                                     |
| --------------------- | ----------------------- | ------------------------------------------------------------------------------ |
| **Local service URL** | `http://127.0.0.1:3900` | Where VoiceStudio listens. Only `localhost` or a loopback address is accepted. |
| **Speech engine**     | `voxcpm2`               | The engine id installed in VoiceStudio, such as `voxcpm2` or `omnivoice`.      |
| **Sampling seed**     | `11`                    | Keeps the voice repeatable. A whole number from 0 to 2147483647.               |

- **Check connection** reports the VoiceStudio version and its voice profiles, or "No voice profiles available. Create a profile in VoiceStudio.", or what went wrong. It has no `maestro-cli` verb.
- **Save source** stores the fields. With A Cappella on, a change made during a voice session applies after the session ends, and the card says "Saved. End the current voice session to apply these settings."

From a terminal, set the same fields with `maestro-cli settings set acappella.voiceStudio.baseUrl <url>`, `acappella.voiceStudio.engine <id>`, and `acappella.voiceStudio.seed <n>`. They are checked by the same rules as the card.

## Run on

**Run on** keeps an agent's provider CLI and changes the model behind it. The agent is still Claude Code, Codex, OpenCode, or Copilot CLI. Its tool loop, permission prompts, transcripts and Maestro's session handling are the same. Only the model that answers changes, from the provider's cloud model to a model on one of your [sources](#endpoints): the [Maestro model server](#model-server), a server you run (Ollama, LM Studio), or a cloud endpoint you added.

Set it in the agent's **Models** tab, in **New Agent** or **Edit Agent**. **Group Settings -> Models** has the same field without **Test**: the target is copied onto each agent created in the group. The picker lists **Provider (default)**, then the models of each source, grouped by source. The Maestro model server comes first and lists the models you have installed. A saved source is listed only while it is enabled. Opening the tab starts nothing: the server's list comes from disk and the server is never started for it, and each enabled saved source is asked for its models.

| Control                   | What it does                                                                                                                                                                       |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Run on**                | The model, by source. Each model from the Maestro model server shows its [fit label](#will-it-run-on-this-computer) and **Agent-ready** when it passed with this agent's provider. |
| **Context size (tokens)** | The window the harness is told it has. It starts at the model's context on the server (40,960 for any other source) and cannot be lower than 40,960.                               |
| **Test**                  | Sends one short, read-only turn through the agent's real launch and shows the reply or the reason it failed.                                                                       |

Under the picker, Maestro says what the launch will do: that a source was removed or is disabled, that a loopback source cannot be reached from the agent's SSH remote, or that the agent's own variable takes precedence. A model without the **Agent-ready** badge shows "Not tested as an agent. Turns may fail or loop."

A turn's pill names where it ran, in place of the model: `gpt-oss 20B (MXFP4) · Maestro`, `qwen3:latest · Ollama`.

Before sending, the composer's model pill and the phone options sheet show the effective **Run on** model and source. A source target overrides named provider model choices; change it in **Edit Agent > Models**. Selecting **Auto** shows Auto instead, because routing can choose a different target for the turn.

The [Usage Dashboard](./usage-dashboard#models)'s **Models** tab has a **Run On Agents** card: one tile per agent whose turns ran on a Run on target, with **Turns**, **Tokens in**, **Tokens out** and **p50 turn**. `maestro-cli stats models` prints the same numbers under **Agents (Run on turns)**.

### Which providers can run on a source

Maestro maps a provider only after the recipe ran against the real CLI. A provider without a recipe keeps its picker disabled and says why.

| Provider                      | Runs on a source   | How Maestro points it at the source                                                                                                                                                                                                                                                     |
| ----------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code                   | Yes                | `ANTHROPIC_BASE_URL` (the server root, no `/v1`), `ANTHROPIC_AUTH_TOKEN`, the Haiku, Sonnet and Opus model variables, `CLAUDE_CODE_MAX_CONTEXT_TOKENS`, `CLAUDE_CODE_MAX_OUTPUT_TOKENS`, and `ANTHROPIC_API_KEY` set blank. Runs as `claude --print`. Uses the Anthropic Messages route |
| Codex                         | Yes                | A provider named `maestro` through `-c model_providers.maestro=...`, `-c model_provider='maestro'` and `-c model_context_window=<n>`, the key in `MAESTRO_RUN_ON_KEY`, and `-m <model>`. Runs as `codex exec`. Uses the Responses route                                                 |
| OpenCode                      | Yes (2.0 or newer) | A `maestro` provider added to `OPENCODE_CONFIG_CONTENT`, `--standalone`, `--model maestro/<model>`, and the key in `MAESTRO_RUN_ON_KEY`. Your config file is not touched. Uses the Chat Completions route                                                                               |
| Copilot CLI                   | Yes                | The `COPILOT_PROVIDER_*` variables (base URL, key, wire model, token limits, and a neutral `COPILOT_PROVIDER_MODEL_ID`) and `--model`. GitHub sign-in is not used. Uses the Chat Completions route                                                                                      |
| Qwen3 Coder, Oh My Pi, Hermes | No                 | Each documents a way to use another server. Maestro has not run it against the real CLI, so it stays off                                                                                                                                                                                |
| Factory Droid, Pi             | No                 | They take another model server only from a settings or models file, and Maestro does not write one for a launch                                                                                                                                                                         |
| Antigravity CLI, Gemini CLI   | No                 | They speak only the Gemini API, which no source serves                                                                                                                                                                                                                                  |
| Grok CLI                      | No                 | It has a base-URL variable but no way to give a launch a key for it                                                                                                                                                                                                                     |

Copilot CLI picks its tools from the model's name, and a name it takes for a GPT model gets a tool that `llama-server` rejects. Maestro therefore tells Copilot CLI the model is called `maestro-run-on` and sends the source the model's real name.

Maestro checks that the source lists the model. It does not check that the source speaks the route the harness uses. Ollama and LM Studio serve the routes above; a server that serves only Chat Completions works with OpenCode and Copilot CLI, and a turn from the others fails with the harness's own error. Claude Code was measured against Ollama and the Maestro model server, Codex against the Maestro model server, and OpenCode and Copilot CLI against the Maestro model server with `gpt-oss 20B`.

An agent on a source keeps to the mode its recipe was measured in. Claude Code runs as `claude --print`, never through the maestro-p TUI, so the **Token source** setting on the Provider tab does not apply. Codex runs as `codex exec`, so the **Codex transport** setting does not apply.

### The rules

- **It never falls back to the provider.** A target that cannot run refuses the launch and names the reason. Silently sending the turn to the provider's cloud model would spend money you chose not to spend and send the conversation where you chose not to send it.
- **Your own variable wins, one variable at a time.** If the agent's environment variables already set a variable the recipe sets, Maestro leaves yours. If you set the base-URL variable yourself, the source's key is withheld, so a key is never sent to an address its source does not own, and Maestro does not ask the source or start the model server for that launch.
- **The provider's own key never goes to the source.** Claude Code sends `ANTHROPIC_API_KEY` to its base URL beside the source's token (measured with 2.1.296). Maestro sets it blank for the launch, whoever set it. Copilot CLI's bearer token, key command and headers for another provider are set blank in the same way.
- **A launch refused for the target starts nothing.** Maestro decides the refusals that need no network first, so a launch that will be refused does not start the model server or load a model.
- **The Maestro model server starts for the launch.** An agent set to run on it is something you turned on, so its first turn starts the server and loads the model, as an assignment does.
- **A saved source is asked on every launch.** Maestro reads its model list (5 second budget) to know it answers and serves the model.

| What is wrong                                            | What you see                                                                  | Code                          |
| -------------------------------------------------------- | ----------------------------------------------------------------------------- | ----------------------------- |
| The provider has no recipe                               | The provider's reason, and "Set Run on to Provider to run the agent"          | `run-on-unsupported-provider` |
| The stored target is not a source and a model            | What is missing. Pick a model again                                           | `run-on-invalid-target`       |
| The source was removed                                   | "its source (`<id>`) is no longer configured"                                 | `run-on-source-missing`       |
| The source is disabled                                   | The source's name, and to enable it                                           | `run-on-source-disabled`      |
| The agent is on an SSH remote and the source is loopback | The remote's name and the address it cannot reach                             | `run-on-loopback-on-remote`   |
| The source did not answer                                | The source's name and what it said                                            | `run-on-source-unreachable`   |
| The source does not serve the model                      | The model, and up to five that the source does serve                          | `run-on-model-not-served`     |
| The Maestro model server could not serve it              | The server's own reason: engine not installed, port in use, not enough memory | `run-on-server-failed`        |

Every refusal says how to recover, and every one offers to set Run on to Provider. The same message is what a Cue run, an Auto Run and `maestro-cli send` report.

### What it covers

The target applies to the turns the agent runs: chat, Auto Run, Cue runs, `maestro-cli send`, the agent's turns as a Group Chat participant, its answers to another agent's `@mention` or `maestro-cli ask`, and the History synopsis, which resumes the same session and so runs on the same target.

<Warning>
	**Some short jobs still reach the provider.** Tab naming, context grooming, the Group Chat
	moderator, and the A Cappella voice Conductor are separate spawns, and they do not follow an
	agent's Run on target. For an agent on a source, the text they read can still reach the
	provider's cloud model. To keep tab naming and summaries on your machine, assign them to a
	local model on **Models -> System Two**.
</Warning>

### SSH remote agents

A remote host cannot reach `127.0.0.1` on this machine, so an agent on an SSH remote is refused when its source is a loopback address, with the same wording as the [gateway's](#gateway) refusal. The Maestro model server is always reached at `127.0.0.1`, so a remote agent cannot run on it, even in Network mode. Give the agent a source the remote host can reach, such as an Ollama server on your network.

Over SSH a blank variable is not exported. A provider key that the remote host's own shell profile exports (`ANTHROPIC_API_KEY`, or Copilot CLI's `COPILOT_PROVIDER_BEARER_TOKEN`, `COPILOT_PROVIDER_API_KEY_COMMAND` and `COPILOT_PROVIDER_HEADERS`) is outside what a launch controls.

### Run on and the gateway

Run on and the [gateway](#gateway) do not combine. A gateway routes requests to a cloud provider, and an agent on a source sends its requests to the source. While the target is a source, both gateway controls on the Models tab are disabled with that reason. A stored gateway URL stays in the field, and is used again when you set Run on back to Provider. The launch skips the gateway and logs that it did. `maestro-cli update-agent --gateway-url` and `--proxy-mode` are refused for such an agent, but clearing them is allowed.

### Which model should I pick?

- **Start with the Library's Agent Models section.** A model is in it only after it fixed a bug in a scratch repository through a real harness, and its badge names the harnesses it passed with. The picker shows the badge for this agent's provider, so a model that passed with Claude Code only carries no badge on a Codex agent.
- **Pick by what fits.** `gpt-oss 20B (MXFP4)` is the smallest that drives Claude Code and Codex (11.3 GB). `Gemma 4 E4B` (5.2 GB) is the one that fits a 16 GB computer, where `gpt-oss 20B` needs 32 GB. `Qwen3-Coder 30B-A3B` and `Qwen3-Coder-Next 80B-A3B` are the coding agents, and `gpt-oss 120B` is the strongest reasoner. The fit label is judged for the context you set.
- **A model outside that group is a bet.** Some of the Housekeeping models cannot start a turn through the server today: their chat templates reject a system message that arrives after the first, and Claude Code and Codex send one. The picker's warning is the signal.
- **Raise the context for a project with large instruction files.** At 40,960 tokens, OpenCode compacted before its first turn and Copilot CLI refused ("Static system messages and tool definitions exceed the model's usable context budget") in a repository whose instruction files and skills made a system prompt of about 290,000 characters. Both completed at a larger window. A larger context needs more memory.
- **Keep the context at or below what the model runs at.** The Maestro model server runs a model at its catalog context. A larger number tells the harness about a window the server does not have, and Maestro does not check it today.
- **Expect a smaller model to wander on a long task.** A short, well-bounded turn works. Use **Test** before you hand the agent real work.

On the same `gpt-oss 20B` at 40,960 tokens on an Apple M5 Max (128 GB), a one-word turn took 2.7 s with Claude Code, 2.2 s with Codex, 5.8 s with OpenCode and 6.1 s with Copilot CLI.

### Testing a target

**Test** sends `Reply with the single word: ready` through the agent's own launch: its provider, directory, path, arguments, variables and SSH remote, with the form's unsaved values on top. The turn is read-only, because the model may be one nobody has run as an agent in your project directory. It waits at most 5 minutes for the turn, and loading a model is outside that budget. A Provider target has nothing to test and is refused. A test leaves one short session in the provider's own session store for the agent's directory.

A test that passes reads `<target> answered in <n> s: <reply>`. In **New Agent**, **Test** waits for a directory ("Choose a working directory on the General tab first."), and an invalid context size blocks it ("Fix the context size first."). **Test** also works from the [web interface](./remote-control).

From the command line the test runs on what is stored, so set the target first.

### From the command line

```bash
maestro-cli models endpoints list                                           # source ids
maestro-cli update-agent <agent-id> --run-on maestro-server:<model-id>      # the Maestro model server
maestro-cli update-agent <agent-id> --run-on <source-id>:qwen3:latest --run-on-context 65536
maestro-cli update-agent <agent-id> --run-on-context 131072                 # the context alone
maestro-cli agent test-run-on <agent-id> [--json]                           # one short turn on the stored target
maestro-cli update-agent <agent-id> --run-on provider                       # back to the provider's model
maestro-cli create-agent "Local Coder" -d . -t claude-code --run-on maestro-server:<model-id>
maestro-cli update-group-settings <group-id> --run-on <source-id>:<model> [--run-on-context <tokens>]   # for new agents in the group
maestro-cli show agent <agent-id> --json   # runOn, runOnSpec, runOnLabel, runOnProblem
```

`show agent` without `--json` prints a `Run on:` line with the target and its context, or the reason the stored target cannot be used.

A target is written `provider` or `<source id>:<model>`. The source id ends at the first colon, so a model name may hold one. `maestro-server` is the Maestro model server; other ids are in `models endpoints list`. A source id that names nothing, a provider with no recipe, and a context under 40,960 are refused at the write. Whether the source serves the model is not asked at the write: `agent test-run-on` asks. A disabled source is accepted and is refused by name at launch until you enable it.

Two rules for what changes around a target. Switching an agent's provider keeps the target when the new provider has a recipe, and clears it when it has none. A worktree agent inherits its parent's target, for the reason it inherits the gateway.

## Tiers

A **tier** says how much model a job needs: `low`, `medium` or `high`. An Auto Run task asks for one with `<!-- MAESTRO:MODEL tier="low" -->` (see [Model Tier and Effort](./autorun-playbooks#model-tier-and-effort)), and a Cue subscription with `tier: low`. Maestro turns the tier into a model when the task launches.

Run on gives an agent one target. Tiers let one agent use several: a `low` task can launch on a model on this machine, and the next `high` task on the provider. A switch happens only between tasks, because each task is a new process.

A tier's **target** is one of two things:

| Target              | Spelling                          | What launches                                                                      |
| ------------------- | --------------------------------- | ---------------------------------------------------------------------------------- |
| A provider model    | `provider:<model>`, or `provider` | The provider's own model. `provider` alone means the agent's own model             |
| A model on a source | `<source id>:<model>`             | The same harness, running on that model, as if the agent's Run on target were that |

### Where a tier's target comes from

Maestro reads three layers when the task launches, and the first one that sets the tier wins.

| Layer               | Where you set it                                      | How it applies                                                                                                                                                                                              |
| ------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Agent**           | **Edit Agent -> Models -> Tiers**                     | Wins for the tiers it sets. A tier left on **Harness default** falls through                                                                                                                                |
| **Harness default** | **Settings -> Models -> System Two -> Tier defaults** | Every agent on that harness that does not set the tier follows it, and a change applies at the next launch                                                                                                  |
| **Built-in**        | Maestro's own table                                   | The starting value of the harness default, and what **Reset** goes back to. Claude Code `haiku`, `sonnet` and `opus`; Codex Luna, Sol and Astra; Factory Droid the Claude 4.5 Haiku, Sonnet and Opus models |

If no layer maps a tier (OpenCode, Copilot CLI and Grok CLI have no built-in row), the task runs on the agent's own model and its log says the tier was ignored. Maestro does not guess a model for it.

Every surface that shows a tier also shows which layer it came from: **Agent**, **Harness default** or **Built-in**, or **Not mapped** when no layer sets it.

### Tier defaults

**Settings -> Models -> System Two -> Tier defaults** has one row per installed harness that can select a model, with a picker for each of `low`, `medium` and `high`, and the layer beside each value. A picker lists what that harness can run on this computer:

- the harness's own list of models (Maestro reads it from the harness, for example Codex's model cache or `opencode models`), and
- every [Run on](#run-on) target the harness can use: the Maestro model server and each enabled source.

Opening System Two reads those lists. Nothing is written until you press **Save** on a row, because a document has to resolve the same way until you change it.

| Button      | What it does                                                              |
| ----------- | ------------------------------------------------------------------------- |
| **Suggest** | Fills the pickers from what the harness lists, with the reason under each |
| **Reset**   | Puts the pickers back on the built-in table                               |
| **Discard** | Drops your edits to the row                                               |
| **Save**    | Stores the row. Suggest and Reset change the pickers only                 |

**Suggest** uses a family Maestro knows for that harness (Claude Code's aliases, the newest Codex Luna, Sol and Astra), then the built-in model when the list holds it, then a description that says "fast" (for `low`) or "frontier" (for `high`), and, for `medium`, the model the catalogue ranks first. It does not pick a family out of another harness's list: OpenCode and Copilot CLI list several Claude and GPT models at once, so those tiers stay blank with the reason. When the harness's own list names no tier and the harness can [run on a source](#which-providers-can-run-on-a-source), Suggest ranks the local models that passed as agents with it by size: the smallest for `low`, the largest for `high`, and the middle one for `medium` when at least three sizes are listed. A tier with no suggestion keeps the value it has.

A value the harness no longer lists is flagged on its row, with the model **Suggest** would put in its place. **Refresh lists** reads every harness's list again. The table works the same from the [web interface](./remote-control).

### Per agent

**Edit Agent -> Models -> Tiers** has one picker per tier. The first choice is **Harness default (`<value>`)**, which follows the table above. The others are the same targets the Tier defaults table offers. Tiers save with the dialog, like Run on. Switching an agent's provider starts its tiers over, because a tier names a model. New Agent has no Tiers block: a new agent follows the harness defaults, and you can edit it afterwards. **Group Settings -> Models -> Tiers** has the same pickers, and copies them onto each agent created in the group.

### The rules

- **A tier that names a target that cannot run fails the task by name.** The task does not start, and it does not fall through to the next layer or to the provider. A layer you wrote is never replaced by one you did not.
- **The built-in table does not apply to an agent that runs on a source.** The table names the provider's cloud models, and sending that agent there is the spend Run on is meant to prevent. Such an agent keeps its own Run on target, and the task says the tier was ignored. A tier you set on the agent or in the harness default does move it.
- **A source target launches at the default context**, 40,960 tokens. The tiers have no context field.
- **The pill names the target.** An Auto Run marker reads `low · qwen3.5-4b · Maestro` or `high · opus`. A tier no layer maps keeps the plain `low model`.
- **Auto Run splits a document where the model or the place changes.** A `low` task on the Maestro model server and a `high` task on the provider run as two dispatches.

### What it covers

Tiers apply to Auto Run (in the app and from `maestro-cli`) and to Cue subscriptions, and to a turn on [Auto](#model-routing-and-auto), where a router picks the tier for you. Tab naming, summaries and context grooming are not tiered: they ask for the provider's own cheap model and run on the agent's own target. `maestro-cli send` takes no `--tier`; `--model auto` asks the router for one.

To run one playbook without its tiers, check **Ignore model hints in documents** in the Auto Run dialog (see [Model Tier and Effort](./autorun-playbooks#model-tier-and-effort)).

### From the command line

```bash
maestro-cli models tiers list [--harness <id>]            # each tier, its value and the layer
maestro-cli models tiers options <harness> [--refresh]    # what the harness can launch a tier on
maestro-cli models tiers suggest <harness> [--apply]      # a suggestion per tier, with the reason
maestro-cli models tiers set <harness> low maestro-server:<model-id>
maestro-cli models tiers set <harness> high provider:opus
maestro-cli models tiers reset <harness> [--tier low]     # back to the built-in table

maestro-cli update-agent <agent-id> --tier low=<source id>:<model> --tier high=provider:opus
maestro-cli update-agent <agent-id> --tier low=default    # back to the harness default
maestro-cli update-group-settings <group-id> --tier low=<source id>:<model>   # for new agents in the group
maestro-cli show agent <agent-id> --json                  # tiers: value, spelling and layer of each
maestro-cli cue model <subscription> --tier low [--effort low]   # the tier a Cue subscription asks for
```

A target is written `default`, `provider`, `provider:<model>` or `<source id>:<model>`. The source id ends at the first colon. `--tier` is repeatable and changes only the tiers it names. `models tiers set` and `reset` write at once; the table in Settings writes on **Save**.

## Model routing and Auto

**Auto** is a model choice that lets Maestro decide how much model a turn needs. Set an agent's model to Auto. When you send, a fast **router** rates the request and the turn launches on the [tier](#tiers) it chose, at the effort it chose. A lookup runs on a small model. A hard design problem runs on the largest.

Auto does two jobs, and each needs a setting:

| Job                                | Where it is set                                                                                  |
| ---------------------------------- | ------------------------------------------------------------------------------------------------ |
| **Which router rates the request** | One global choice: **Settings -> Models -> System One -> Model routing**. Off by default         |
| **What each tier runs on**         | The agent's [tier map](#per-agent), the [harness default](#tier-defaults), or the built-in table |

Model routing works fully offline. Jev is one router among several, never a requirement.

### The routers

The **Model routing** row takes one source, and the source names the router:

| Router               | Source you pick                                          | How it decides                                                                                               | Calibrated           |
| -------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | -------------------- |
| **Embedding router** | An installed embedding model                             | Embeds the request, and its 5 nearest labeled requests vote on the tier and the effort. No text is generated | No                   |
| **Local judge**      | A text model, or any model on an endpoint                | Answers two rating questions, one for the tier and one for the effort                                        | No                   |
| **System One**       | **System One (Jev)**, **(OpenJev)** or **(local judge)** | The engine in force answers the same two questions                                                           | Jev and OpenJev only |

The picker lists the local routers first and says beside each one which router it is and whether it is calibrated. System One appears only while an [engine](#system-one-engines) is chosen. A model on an endpoint is always used as a local judge, because an endpoint does not say what kind of model it serves.

The embedding router also learns from you. `maestro-cli s1 route "<prompt>" --correct <tier>` records the tier you say that request needs, and a request like it votes that way from then on. A correction sets the tier only, never the effort, and only the embedding router reads it. A second correction for the same text replaces the first. The newest 500 corrections are kept on this computer, in `model-routing-corrections.json` in Maestro's data directory. Maestro has no control or verb that clears them. Corrections are made from the command line only.

#### How well they decide

Measured on 2026-10-12 (Apple M5 Max) over 40 hand-labeled coding requests: 13 `low`, 13 `medium` and 14 `high`. A router that answers one level for everything is right on 14 of 40.

| Router                                | Right on the tier | Typical time (p50)                      | Inside the 400 ms a typed send waits | Cost per 1,000 decisions |
| ------------------------------------- | ----------------- | --------------------------------------- | ------------------------------------ | ------------------------ |
| Jev                                   | 39 of 40          | 123 ms                                  | 40 of 40                             | $0.02                    |
| Embedding router, EmbeddingGemma 300M | 26 of 40          | 21 ms, on the CPU                       | 40 of 40                             | $0                       |
| Embedding router, BGE Small           | 24 of 40          | 4 ms, on the CPU                        | 40 of 40                             | $0                       |
| Local judge, Qwen3.5 4B               | 22 to 25 of 40    | 0.5 to 1 s with a GPU, 3.8 s on the CPU | 0 to 3 of 40                         | $0                       |

What that means:

- **Jev is the only router that agrees with careful labels**, and it answers inside a typed send's wait every time. It sends the request text to TypeSafe.
- **The embedding router is fast on any computer and right about six times in ten.** It misses in both directions, so it sometimes gives a hard request a small model. Corrections improve it for the requests you make.
- **The Qwen3.5 4B judge leans towards more model**, which is safe but costs more. On this Mac it answers in about a second, too slow for a typed send, so typed turns read **Auto (no decision)** and run at the agent's default. It suits turns nobody is typing at (Auto Run, Cue, `maestro-cli send`), which wait 5 seconds.
- **Qwen3 1.7B is not offered for model routing.** It rated every one of the 40 requests as needing the most model. An assignment you make anyway is honored, and `maestro-cli models assign` says why it is not recommended.

A vote margin of 0.5 or more was right 79 to 100% of the time, but only 15 to 30% of requests reached it, so Maestro applies no confidence floor. The labels are one person's, and 40 requests cannot tell the two embedding models apart.

### Where Auto is offered

Maestro offers **Auto** only where it would change something. Its tooltip names the axes it acts on and which router decides, for example "Auto: picks effort; map tiers in the Models tab to also pick the model."

| Harness             | Picks the model                                             | Picks the effort |
| ------------------- | ----------------------------------------------------------- | ---------------- |
| Claude Code         | Yes (haiku, sonnet, opus)                                   | Yes              |
| Codex               | Yes (Luna, Sol, Astra)                                      | Yes              |
| Factory Droid       | Yes                                                         | Yes              |
| Copilot CLI         | Only through a tier map: the agent's or the harness default | Yes              |
| Grok CLI            | Only through a tier map: the agent's or the harness default | Yes              |
| OpenCode and others | Only through a tier map: the agent's or the harness default | No               |

If neither axis is true, Auto is not in the list. It is in these places, and nowhere else:

- The **Provider** tab of **New Agent**, **Edit Agent** and **Group Settings**. In Edit Agent, mapping a tier on the **Models** tab makes Auto appear before you save.
- The composer's model pill, and its phone sheet.
- The **Change Tabs Model and Effort** console (`Opt+Cmd+.`).
- The queued-message editor.

The Group Chat moderator and the wizard do not offer it, because their turns are never routed. The Auto Run dialog's model picker does not offer it either, but an agent set to Auto is still routed there. A Cue subscription asks for it in YAML with `model: auto`.

If the router is off and an agent is on Auto, the agent runs at its default and its pill says **Auto (router off)**. That is not an error.

### The three rules

1. **The model is kept while the provider's cache is warm.** Inside a live session, Auto may change the effort on every turn but changes the model only at a session start, or after the session has been idle for more than 5 minutes (the provider's prompt-cache lifetime). Switching models mid-session throws the cache away and costs more than it saves. The router's tier is still recorded, and the pill says **(kept)**.
2. **A send never waits and never fails on the router.** The router has 400 ms for a typed message and 5 seconds for a turn nobody is typing at. With no decision (router off, too slow, not ready, down), the turn runs on the agent's default: no model is named, so your provider setting and then the harness default apply, and the agent's own effort stays. A model kept by rule 1 is still kept.
3. **The choice is locked at send.** What the router said is stored with the turn and shown on its pill. A message queued behind a busy agent is routed when it is queued, not when it starts. Editing its text asks the router again. Resending a failed turn keeps the answer.

A tier that names a target that cannot run fails the turn by name. It does not fall through to another model.

If a provider refuses an effort level, a toast says `<Provider> rejected effort "<value>"`. Until Maestro restarts, tab naming, synopses and effort hints that map to that value use the agent's configured effort instead.

### What Auto routes

| Surface                                  | What happens                                                                                                                                                         |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A message you type                       | Routed in the moment before the turn starts. Your message appears at once                                                                                            |
| A message queued behind a busy agent     | Routed when queued                                                                                                                                                   |
| An [Auto Run](./autorun-playbooks) task  | Each dispatch is routed on the text of the tasks it will work, not on the playbook's instructions. A `MAESTRO:MODEL` marker always wins on the axis it sets          |
| A [Cue](./maestro-cue-configuration) run | Only when the subscription says `model: auto`. An agent on Auto whose subscription does not opt in runs its Cue turns at its default. A subscription's `effort` wins |
| `maestro-cli send --model auto`          | Routed through the desktop. With no desktop running, there is no decision                                                                                            |

A group chat turn, an `@mention` answer, a History synopsis and tab naming are never routed. They run the agent on its default.

### What the pills mean

A finished turn shows one pill in the model pill's place. Hover it for one sentence on who decided and what was done with the answer.

| Pill                                  | Meaning                                                                              |
| ------------------------------------- | ------------------------------------------------------------------------------------ |
| **Auto → medium · sonnet**            | The router chose `medium`, and the turn ran on `sonnet`                              |
| **Auto → low · qwen3.5-4b · Maestro** | The tier is mapped to a model on a source, and the pill names where it ran           |
| **Auto → haiku (kept)**               | Rule 1: the session was warm, so the turn kept `haiku`. The effort was still applied |
| **Auto (router off)**                 | The Model routing task is off. The turn ran at the agent's default                   |
| **Auto (no decision)**                | A router was asked and gave none in time, or could not run. The tooltip says why     |
| **Auto**                              | A queued message the router has not answered yet                                     |

A routed queued message shows no effort pill until it starts, because the effort it will run at is the router's. Turn pills are hidden on a phone screen.

The [Usage Dashboard](./usage-dashboard#models)'s **Models** tab has an **Auto routing, by tier** chart: the turns sent on the Auto model, by the tier the router chose. Turns that read **Auto (router off)** or **Auto (no decision)** are not counted.

### From the command line

```bash
maestro-cli models assign model-routing local:<embedding-model-id>      # the embedding router
maestro-cli models assign model-routing local:<text-model-id>           # a local judge
maestro-cli models assign model-routing endpoint:<endpoint>:<model>     # a judge on an endpoint
maestro-cli models assign model-routing system-one                      # the System One engine in force
maestro-cli models assign model-routing off

maestro-cli update-agent <agent-id> --model auto       # as the Provider tab's picker; refused where Auto would change nothing
maestro-cli tab model <tab-id> auto                    # the composer's choice, for one tab
maestro-cli send <agent> "<message>" --model auto      # route this one turn
maestro-cli s1 route "<prompt>" [--agent <id>] [--json]  # a dry run: tier, effort, router, latency. Sends nothing
maestro-cli s1 route "<prompt>" --correct <tier>         # teach the embedding router
```

`send --model` takes any model name, and `auto` routes. The JSON a `send` on Auto prints carries an `auto` field with the same label and sentence as the pill. `s1 route` exits 0 on a decision, 6 when the router is off and 7 when a router was asked and gave none. A dry run waits up to 5 seconds, flags an answer slower than 400 ms (`withinSendTimeout: false`), and is kept in the [decision ledger](#the-decision-ledger).

### Privacy

The router reads the request you are sending and the last user message and last assistant message, each cut to 600 characters after secrets are replaced. It never reads the whole transcript. The embedding router reads the request alone. A local router keeps all of it on this computer. With Jev it goes to TypeSafe, and with OpenJev to the server you named. Every routing is one row in the [decision ledger](#the-decision-ledger) under the task `model-routing`.

## Gateway

A gateway is an HTTP proxy that an agent's requests go through on the way to its provider. People run one to cut the tokens an agent sends ([Headroom](https://github.com/chopratejas/headroom) compresses large tool results), or to route and meter traffic ([LiteLLM](https://github.com/BerriAI/litellm)).

The gateway table is on **Settings -> Models -> Gateway** (`maestro-cli open settings --tab models --sub-tab gateway`). It lists the agents with a gateway URL or a Maestro proxy mode; terminals are never listed. Its columns are **Agent**, **Provider** (with the SSH remote for a remote agent), **Maestro proxy**, and **Gateway URL**. Use **Add agent** to put another agent in the table, then type its URL and press Enter or leave the field. Each row's **Remove gateway** button clears the URL, or sets the proxy mode Off when the row has only a mode.

The same field is **Local Models Gateway** in each agent's **Edit Agent -> Models** and in the **New Agent** dialog, and a group can give it to new agents as a default in **Group Settings**. A gateway is set per agent and is off until you type a URL. When the agent next starts, Maestro points the provider's CLI at that URL:

| Provider    | How it is pointed at the gateway                                                                                                       |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code | `ANTHROPIC_BASE_URL`                                                                                                                   |
| Codex       | `OPENAI_BASE_URL`, and the argument `-c openai_base_url="<url>"`                                                                       |
| OpenCode    | `OPENCODE_CONFIG_CONTENT`: the `anthropic` and `openai` providers get the gateway as `baseURL`, and `opencode run` gets `--standalone` |
| Others      | Nothing. The field is disabled and says why (see the next table).                                                                      |

Codex gets both because Codex CLI does not read `OPENAI_BASE_URL` on a ChatGPT login (tested with 0.162.1); the argument is what it honors.

OpenCode reads no base-URL variable. Maestro adds the gateway to the inline config document it already gives each OpenCode launch, merged over your own config files, and limits the run to the `anthropic` and `openai` providers. An OpenCode agent whose model is from any other provider (`openrouter/...`, `google/...`) fails by name instead of running direct. For OpenCode a gateway URL you type is the API root with `/v1` (`http://127.0.0.1:8787/v1`), because OpenCode appends only `/messages` or `/responses`; the Maestro proxy adds the `/v1` itself. Tested with OpenCode 2.2.7.

Maestro maps a provider only after a test proves its CLI reads the setting: the setting is pointed at a closed port, and the turn must fail to connect. A setting that is only documented is not enough, because a CLI that ignores it runs direct while the app says it goes through the gateway. These providers have no gateway:

| Provider                | Why not                                                                                                                                                                                                                                                                                                                                 |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Copilot CLI             | It reads a base URL (`COPILOT_PROVIDER_BASE_URL`) only for a provider you bring your own key for, and that takes the turn off your Copilot subscription. To carry a subscription a proxy would have to do the Copilot token exchange, which Maestro does not. With your own key, set the variable in the agent's environment variables. |
| Factory Droid           | Not tested yet. It sets a base URL per custom model in `~/.factory/settings.json`: point a custom model at the gateway there.                                                                                                                                                                                                           |
| Qwen3 Coder             | Not tested yet. With an OpenAI-compatible key it is documented to read `OPENAI_BASE_URL`: set it in the agent's environment variables.                                                                                                                                                                                                  |
| Hermes                  | Not tested yet. It sets a custom endpoint in `~/.hermes/config.yaml` (`model.base_url`).                                                                                                                                                                                                                                                |
| Pi, Oh My Pi            | Not tested yet. Each sets a provider's base URL in its own models file (`~/.pi/agent/models.json`, `~/.omp/agent/models.yml`).                                                                                                                                                                                                          |
| Grok CLI                | Not tested yet. If it reads a base-URL variable, set it in the agent's environment variables.                                                                                                                                                                                                                                           |
| Antigravity, Gemini CLI | No base-URL variable is known.                                                                                                                                                                                                                                                                                                          |

Maestro does not check a setting you make yourself in an agent's environment variables or a provider's config file.

A gateway sends an agent's requests to its cloud provider by another route. To send them to a model on another server instead, use [Run on](#run-on). The two do not combine: while an agent's Run on target is a source, its gateway is not applied, and the field says "Not applied while Run on is a source".

Under the field a line says what happens at the next start: "Sets `<variable>` when this agent starts." for Claude Code and Codex, "Adds the gateway to `OPENCODE_CONFIG_CONTENT` when this agent starts." for OpenCode. A URL must be `http://` or `https://` with a host and no query or fragment; a trailing slash is removed. A blank field, or `none` on the command line, clears it. Setting a gateway URL of your own also clears the agent's Maestro proxy mode, Retrieval, and Background requests target.

Four rules:

- **Your own variable wins.** If the agent's environment variables already set the base-URL variable, Maestro leaves your value alone and the gateway is not applied. The field says so. The gateway does win over a value set for every agent in Settings -> Environment, because a gateway on one agent is the more specific choice.
- **A gateway that cannot be used stops the agent.** The agent does not start, and the message names the gateway. Maestro never sends the turn to a different endpoint than the one you chose. If a gateway you run yourself is not running, the agent's own connection error is what you see. If the gateway is the Maestro proxy and it cannot start, the message ends "The turn was not sent."
- **A loopback gateway does not work for an SSH remote agent.** `http://127.0.0.1:8787` on this machine is a different machine from the remote host's point of view, so the agent is refused at launch. Give it a URL the remote host can reach.
- **It covers the turns the agent runs.** Chat, Auto Run, Cue runs, `maestro-cli send`, the agent's turns as a Group Chat participant, and its answers to another agent's `@mention` or `maestro-cli ask` go through the gateway. Short jobs Maestro runs beside an agent (tab naming, context grooming, Director's Notes) and the Group Chat moderator do not: they reach the provider direct.

Each row with a gateway has **Show environment**, which lists the agent's effective environment variables and where each came from. The base-URL variable is marked **Local Models gateway**, or marked with the layer that beat it.

An agent on a subscription login (Claude or Codex) saves quota, not dollars. Sending its traffic through a proxy is your choice for each agent, and you are responsible for your provider's terms.

From the command line:

```bash
maestro-cli update-agent <agent-id> --gateway-url http://127.0.0.1:8787
maestro-cli update-agent <agent-id> --gateway-url none
maestro-cli create-agent <name> --gateway-url http://127.0.0.1:8787   # at creation
maestro-cli update-group-settings <group-id> --gateway-url http://127.0.0.1:8787   # default for the group's new agents
maestro-cli show agent <agent-id> --json   # gatewayUrl
```

### The Maestro proxy

Maestro has a proxy of its own, so you do not need to run one to save tokens. Each row of the Gateway table has a **Maestro proxy** control, and **Edit Agent -> Models** has the same control as **Maestro Token Proxy**, above the gateway field. It has four modes (this page calls the middle two Passthrough and Compress):

| Mode                         | What happens to the agent's requests                                       |
| ---------------------------- | -------------------------------------------------------------------------- |
| **Off**                      | They do not go through Maestro's proxy. This is the default.               |
| **Passthrough (count only)** | They go through it unchanged. Maestro only counts them.                    |
| **Compress tool results**    | A large tool result is shortened after the model has read it once in full. |
| **Compress early**           | A large tool result is shortened before the model first reads it.          |

A mode applies as soon as you choose it, from the agent's next request, even in the middle of a turn. Choosing any mode but Off sets the agent's gateway URL to the proxy for you. Choosing Off clears it, and leaves a gateway to another proxy alone. The **New Agent** dialog has no mode: choose it in Edit Agent once the agent exists. While a provider change in Edit Agent is unsaved, the control waits: "Save the provider change first: the proxy route depends on the provider."

The proxy listens on `127.0.0.1` only, on one port for every provider. It starts when an agent that uses it launches (from the app, a Cue run, a Group Chat or a consult) and listens only while some local agent's gateway points at it. The port is chosen on first use and saved, and it never moves. If another program holds it, the proxy does not start and says so: "another program is using 127.0.0.1:`<port>`. Quit that program, or clear the gateway on the agents that point at this port". The proxy forwards headers and bodies unchanged and passes a provider's own errors back whole. An error the proxy raises itself is JSON with the type `maestro_token_proxy_error`; one of them refuses a WebSocket, because the proxy carries HTTP requests only.

**A default for new agents.** Above the table, **Set Maestro proxy for all agents** has one button per mode: **All: Off**, **All: Passthrough (count only)**, **All: Compress tool results**, and **All: Compress early**. The current default is highlighted, and "Default for new agents:" names it. A button does two things:

- It sets that mode on every existing local agent with gateway support. A compress or passthrough mode skips agents on an SSH remote, agents whose provider has no gateway, and agents whose Run on is a source; the status line counts them as skipped. Enabling replaces a gateway URL the agent already has. **All: Off** reaches every agent, and leaves gateways to other proxies alone.
- It saves the mode as the default for agents you create later. A new agent gets it when it has no gateway URL, no proxy mode and no Run on target of its own, is not on an SSH remote, and has a provider with gateway support. A group's own proxy default wins over it. A worktree agent takes its parent's settings. If the default cannot be set on a new agent, a toast says **Proxy default was not applied** with the agent's name and the reason, and the agent stays off the proxy.

From the command line, `maestro-cli settings set defaultTokenProxyMode <mode>` saves the default for new agents only; it does not change existing agents the way the buttons do. `maestro-cli update-group-settings <group-id> --proxy-mode <mode>` sets a group's default (it cannot be combined with `--gateway-url`).

**Which compress mode to pick.** The note under the control says the same thing in one sentence.

- **Compress** changes nothing about what the model works from: it reads every tool result in full, and the result is shortened only once it is history. The cost is that the result is written to your provider's prompt cache twice, in full and then shortened. Measured on Claude Code, that made a short session (4 to 6 requests) cost between 2% and 36% more than Passthrough, depending on the output, and it pays back only in a longer one. Pick it for long sessions where you want the model to see everything once.
- **Compress early** shortens a result before the model sees it, so nothing is ever cached in full and it is the cheapest mode. In a measured four-turn session it cost 14% less than Passthrough, where Compress cost 36% more. Because the model never reads the original, Compress early only uses reductions that leave nothing out: it minifies JSON, uses lossless tables, strips terminal escapes, folds repeated lines into one copy and a count, and groups Git status. It never samples a list, cuts a line, or asks a local model to summarize, so a result that only those would shorten goes out whole. Pick it when the tool output is mostly build logs, test runs, and JSON. Turn on **Retrieval** (below) to let Compress early leave lines out too.

**Retrieval.** In **Edit Agent -> Models**, a **Retrieval** switch sits beside the Maestro proxy control while the mode is Compress or Compress early. It is off by default. When it is on, the agent's model gets one more tool, `retrieve_compressed_original`: it passes the `sha256=` value from a block's marker and, optionally, a line range, and gets back the original lines (200 at a time by default, at most 1,000 lines or 256 KiB per call) with a first line that says which lines came back and whether more exist. What that changes:

- **Compress early may leave content out.** With the tool, Compress early uses every reduction Compress uses, including sampling a list and summarizing with a local model, because the model can read past anything that was dropped. Without the tool it keeps the reductions that leave nothing out, as above. A launch without the tool never gets a block it could not recover, even in a conversation an earlier launch with the tool shortened.
- **Compress does not change.** It already lets the model read every result in full once; the switch only gives that model a way to look again.
- **The tool reaches only originals this machine still holds.** Originals unused for 30 days are pruned (see below). Asking for a pruned or unknown hash is a tool error that says so, and the model works from the shortened text.
- **A retrieved original is never shortened again.**
- **Which launches get it.** Claude Code (in both its `claude --print` and its interactive mode) and Codex agents on this machine, in the turns you send from the app. Maestro gives the tool through the same per-launch MCP server it uses for plugin tools, so it works with Plugins off and edits no global config. An OpenCode agent does not get it yet, because Maestro has not verified that server for OpenCode. Nor do an agent on an SSH remote, an Auto Run task, a Cue run, a Group Chat, a consult, or `maestro-cli send`. Those turns keep the lossless reductions.
- **Applies from the agent's next start.** Setting the proxy mode to Off, a gateway URL of your own, or another provider turns it off with the proxy. In Passthrough the switch is hidden and has no effect.

What both compress modes do, and do not do:

- **They shorten only tool results**, and only ones over about 1,000 tokens. Your messages, the system prompt, tool definitions, and the agent's own text are never changed.
- **Explicit failures and recognized original-recovery commands stay whole.** These checks run before cached replacements are used. Unknown tool status is not treated as success.
- **The same text always shortens to the same bytes while you use it.** Each result is stored under a SHA-256 key made from its content and the first result is kept, so your provider's prompt cache keeps working. Compress early keeps its own results, apart from Compress.
- **The originals do not stay forever.** The proxy prunes its cache once a day while it runs: entries unused for 30 days, then the least recently used while the cache is over 512 MB. Nothing used in the last day is removed. A conversation you resume after its entries were pruned has those results shortened again, which costs nothing, because your provider's prompt cache expired long before.
- **Every change is marked and kept.** A shortened block ends with `[maestro-compressed sha256=... original_tokens=...]`, and the original stays on this machine. The `sha256=` value names the cache entry that holds the original (pass it to `maestro-cli models proxy block`). In Compress early it is not the hash of the content, because that mode keeps its own entries.
- **If shortening fails, the request is sent as it arrived.** You do not lose a turn to it.
- **A local model is optional.** Rules handle JSON, repeated logs, protected diagnostic lines, and recognized Git, search, successful test/build, and warning-only lint output. Eligible scalar JSON rows use a labelled table that preserves key/value lexemes and distinguishes missing keys from null. Other JSON can still use lossy array sampling. Assign the **Token proxy** task a model on **Models -> System Two** to also summarize results that are still very large.

Under the table, the **Maestro token proxy** card (with **Refresh**) shows what it did. Its first line says where it listens: "Not set up. Choose Passthrough or Compress for an agent to turn it on.", "Listening on 127.0.0.1:`<port>` for `<n>` agents.", "Stopped. It starts on 127.0.0.1:`<port>` when an agent uses it.", or why it could not start. The **Last 30 days** table has a row for **All agents** and one per agent, with **Requests**, **Tokens saved (est.)**, and **Average added latency** (the time a request was held to be shortened). An agent with no compressed request shows a dash. A request from outside the app is listed as "No agent (started outside the app)". Tokens saved is an estimate at 4 characters per token. On output full of paths, digits and stack traces the real saving can be about twice the figure shown. Below the table, **Provider counted** sums what your provider itself reported for each request, in every mode including Passthrough: input, cache read, cache write, and output. Those are exact. Compare a Passthrough week with a Compress week to see what compression really saved. **Recent compressions** lists the last 25 blocks it shortened, each with its hash, its size before and after, the rules that shortened it (`json-table`, `json`, `git-status`, `git-log`, `search`, `test-output`, `build-output`, `lint-output`, `logs`, `long-lines`, or `model` for the local model), the agent and the time. **Show diff** compares what the agent sent with what was sent in its place; once the cache has pruned the original it says so.

The card reads the usage statistics database: with usage statistics off it says "Usage statistics are not available.", and the proxy records nothing.

The proxy reaches the providers in the first table above: Claude Code, Codex, and OpenCode (for an `anthropic/...` or `openai/...` model; any other model is refused when you pick a mode). It cannot be used by an agent on an SSH remote (the remote host cannot reach this machine's `127.0.0.1`) or by a provider in the second table. The control is disabled for those and says why. A turn started with `maestro-cli send` goes through the proxy unchanged and is counted without an agent name, because only the app tells the proxy which agent a request belongs to.

```bash
maestro-cli update-agent <agent-id> --proxy-mode compress   # off | passthrough | compress | compress-early
maestro-cli update-agent <agent-id> --proxy-retrieval on     # on | off; only while compressing
maestro-cli show agent <agent-id> --json                    # tokenProxyMode, tokenProxyRetrieval
maestro-cli models proxy status                             # the listener, agents, totals, recent compressions, read opportunities
maestro-cli models proxy block <hash>                       # a diff of one shortened block
maestro-cli models proxy block <hash> --original --lines 10:30
maestro-cli models proxy cache                              # entries, size, least recent use
maestro-cli models proxy cache prune --older-than 7d        # prune now (never below 1 day)
```

`--lines` selects inclusive, 1-based original lines, with a maximum of 1,000 lines and 256 KiB returned text. It requires `--original`. Standard output contains the exact selected text; standard error reports which lines were returned and whether the selection is complete. With `--json`, that metadata is in `block.originalRange`. A request past EOF can return fewer lines; a scan or byte limit fails explicitly. Token totals and the compressed side still describe the whole block. The marker names the archive by hash and carries no shell command; a model reads an original through the Retrieval tool, a person through `models proxy block`.

**Read opportunities.** `maestro-cli models proxy status` also lists what the proxy could have shortened and did not. For an agent in a compress mode, the proxy looks at the file reads in the newest tool results of each request and finds three things: a file read again that is identical to the earlier read, a file read again with a few changed lines, and a source file (TypeScript, JavaScript or Python) that an outline of its imports and signatures could stand in for. It measures each against the text the agent sent. This is observation only. None of it is applied: no tool result is replaced because of these figures, what the model sees is decided by the agent's compress mode alone, and each figure is a potential reduction that is never part of "tokens saved". A re-read preview and an outline can describe the same result, so their figures are alternatives and are not added together.

- **What it can and cannot see.** The proxy knows an agent from its gateway URL. It cannot see which tab, native session, subagent or context window a request belongs to, and the report lists those as not available. A read is compared only with an earlier read in the same request, and nothing is remembered between requests. A passthrough request is streamed unread, so it is never examined.
- **Coverage is stated.** The tallies start when the app starts. The report counts the requests it did not examine (an earlier request was still being examined, the body was over the limit, the agent has no working directory) and gives a reason for every read it could not compare, such as `partial-range` or `outside-workspace`.
- **Previews are redacted.** The recent previews hold lines of a file. Maestro replaces secret-shaped text and cuts each preview before it leaves the proxy.

### Background requests

Claude Code sends work that is not your conversation on its small model: a session title, and the summary of a web page the agent fetched. **Background requests** sends exactly those to a model on one of your [sources](#endpoints), while the agent's own turns keep going to the provider. It is off until you pick a target.

It is on **Edit Agent -> Models**, under the Maestro proxy mode, and is shown only for a Claude Code agent whose proxy mode is not Off. The picker lists the models of the sources that serve the Anthropic Messages route: the [Maestro model server](#model-server), Ollama and LM Studio. An OpenAI-compatible source is not listed, because Maestro cannot tell that it serves that route. The first choice, **Off (send them to the provider)**, turns it off. Like the mode above it, the choice applies at once, with no restart. A group can give new agents a target as a default in **Group Settings** (**Background requests**).

**What is routed.** The proxy decides per request. A request goes to the target only when it names the provider's small model and shows no sign of being a turn. Everything else reaches the provider exactly as it arrived.

| A request that...                                       | Goes to      |
| ------------------------------------------------------- | ------------ |
| Does not name the small model (Claude's `haiku`)        | The provider |
| Carries a `thinking` or `redacted_thinking` block       | The provider |
| Has a cache breakpoint anywhere but the system prompt   | The provider |
| Carries a tool result, or declares tools                | The provider |
| Asks for one token or fewer (Claude Code's quota probe) | The provider |
| Is none of the above                                    | The target   |

The agent's main loop never changes model in the middle of a session. A routed request is the client's request with one value changed, the model's name.

**The rules.**

- **A target that cannot answer fails the request, and it is not retried on the provider.** The agent sees the target's own error, or a `502 background-target-unavailable` from the proxy that names the target when it cannot be used at all (the source was removed or disabled, the model server cannot serve the model). Retrying on the provider would hide the failure and spend the money you chose to save.
- **The provider's credentials never go to the target.** A routed request carries the target's key as a bearer token. The client's `Authorization`, `x-api-key` and `cookie` headers are removed from it.
- **Nothing starts for a turn.** The target is looked up, and the Maestro model server started, only for a request already decided to be a background request.
- **A model that thinks makes a page take a minute.** The request states no thinking setting, so the server applies the model's own template, and a thinking model reasons first. Pick a model that answers without thinking.
- **The target leaves with the proxy.** Turning the proxy mode Off, setting another gateway URL, or switching the agent's provider clears the background target. An agent whose [Run on](#run-on) is a source is not on the proxy, so it cannot have one.

**What a session showed.** Measured on Claude Code 2.1.296 with a three-turn session (a build log, a fetched page, a one word reply) and Qwen3.5 4B on the Maestro model server:

| Mode             | Requests | Routed                                 | Share of the prompt cost |
| ---------------- | -------- | -------------------------------------- | ------------------------ |
| `claude --print` | 7        | 1 (the page summary)                   | 0.7%                     |
| The TUI          | 13       | 2 (the session title and page summary) | 2.1%                     |

- **Print mode, which is how Maestro starts Claude Code unless the agent uses the TUI token source, routes one kind of request: the page summary.** A session that fetches no page routes nothing. The TUI also sends a session title, and in a `maestro-p` turn nothing reads it, because the TUI exits when the turn ends.
- **The agent reads the local model's summary of the page.** The summary is the web fetch tool's result, so it is not a side effect. Every summary was right on a one paragraph page.
- **The saving per session is small.** It is the provider's own count for the requests that were routed, so it grows with the size and number of the pages fetched.
- **The cost is time, and it depends on the model.** A page summary took 1 to 3 s on the provider, 0.56 s on Qwen3 Coder 30B, 2.1 s on gpt-oss 20B, and 49 to 84 s on Qwen3.5 4B, which wrote 4,860 to 8,241 tokens of reasoning first.

A permission check on the small model was not seen in either session. The only shell command, `cat`, was allowed by a rule, so this is "not sent here", not "never sent".

```bash
maestro-cli update-agent <agent-id> --proxy-mode passthrough --background-requests maestro-server:<model-id>
maestro-cli update-agent <agent-id> --background-requests none
maestro-cli update-group-settings <group-id> --background-requests <source-id>:<model>   # for new agents in the group
maestro-cli show agent <agent-id> --json   # backgroundRequests, backgroundRequestsSpec, backgroundRequestsProblem
```

A target is written `<source id>:<model>`, or `none`. A target is refused for an agent that is not on the proxy, and for a provider other than Claude Code. The app's system log names each routed request and its target.

## Privacy

A downloaded model runs inside Maestro, so the text it reads never leaves your machine. An endpoint at a loopback address (`127.0.0.1`, `localhost`, `::1`) is also on your machine.

An endpoint at any other address is a network service. Text sent to it leaves this machine, the same as text sent to an agent's provider. Point a task at a remote endpoint only if you would send that text there yourself.

An agent set to [Run on](#run-on) a source sends it the whole conversation: your prompts, the files the agent reads, and every tool result. A model on this machine keeps that text here. A cloud endpoint, or a server at another address, receives it, so choose one only if you would send that text there yourself.

[System One](#system-one) on Jev sends the text of each request (a Cue event, for the Cue gate) to TypeSafe, and on OpenJev to the server you named. Secrets are removed first. The local judge sends it to the model assigned to the Local judge task, which is on this machine unless that task is on a remote endpoint. System One is off until you choose an engine.

[Model routing](#model-routing-and-auto) reads each request an Auto agent sends, and the last message each way, cut short, to the router you chose. A local router keeps it on this computer.

An agent with [tiers](#tiers) set to a source sends that source each task that asks for the tier, with the same conversation. An agent with [background requests](#background-requests) sends its target the page a web fetch read, or the text a session title is made from. Both go where you picked, and neither goes to the provider as well.

## Disk and memory

Models install under `models` inside Maestro's user data directory. The Models section shows the total, and removing a model gives the space back.

The models also need an [engine](#engines) to run. ONNX Runtime (about 100 MB) runs the embedding, classifier, speech, and wake word models, and llama.cpp (about 41 MB) runs the text model. Neither is bundled in the installer. Each is downloaded from a pinned release and checked against a hash recorded in the app, either with the first model that needs it or from the Engines card. [Voice Setup](./voice-mode#downloading-the-models) downloads ONNX Runtime together with the speech models.

A model uses memory only while it works. It loads the first time a task needs it and unloads after five minutes without use. While loaded, a model uses about as much memory as its size on disk: tens of megabytes for BGE Small and Prompt Guard, several hundred for Parakeet or DeBERTa, and about 1.5 GB for Qwen3 1.7B. An endpoint uses the memory of the server you run, not Maestro's.

## Licenses

Each model arrives under its own license, shown on its row with a link to the full text. Read it before you download. Three are worth knowing:

- **BGE Small** is MIT: use it for anything.
- **EmbeddingGemma** is under the [Gemma Terms of Use](https://ai.google.dev/gemma/terms), which include a prohibited-use policy.
- **Llama Prompt Guard 2** is under the [Llama 4 Community License](https://www.llama.com/llama4/license/), which has its own use policy and attribution terms. DeBERTa v3 Prompt Injection v2 is the Apache-2.0 alternative for the same job, at a much larger download.

The "Hey Jarvis" wake phrase is CC-BY-NC-SA-4.0, which does not allow commercial use.

## From the command line

Everything in the tab has a `maestro-cli models` verb, so an agent can set this up for you. Verbs that touch downloads or servers need the desktop app running; `assign` and `endpoints add` / `update` / `remove` work with it closed. The System One engine, its key, and its ledger have their own `maestro-cli s1` verbs: see [System One from the command line](#system-one-from-the-command-line).

```bash
maestro-cli models list [--kind <kind>] [--fit]  # the Library in its sections and groups, with status, what each model is good at, and what uses it; --fit adds Fits / Tight / Too large
maestro-cli models install <model-id>            # download and verify, with its engine; waits until done; resumes a paused download
maestro-cli models pause <model-id>              # stop a running download, keep what arrived
maestro-cli models cancel <model-id>             # stop a download and delete its partial files
maestro-cli models verify <model-id>             # re-hash; never deletes or re-downloads
maestro-cli models remove <model-id> [--force]   # refuses a model a task uses, unless --force
maestro-cli models add-hf <repo> <file> [--dry-run]  # add a GGUF from Hugging Face; prints its license; downloads nothing
maestro-cli models remove-hf <model-id> [--force]    # take an added model out of the Library and delete its files
maestro-cli models config show                   # the download base in force
maestro-cli models config set download-base <url|default>  # a mirror for Hugging Face; works with Maestro closed
maestro-cli models runtimes list                 # the engines: state, size, and the models each runs
maestro-cli models runtimes install <onnx|llama> # install or update one engine on its own

maestro-cli models endpoints list
maestro-cli models endpoints detect              # probe for Ollama and LM Studio; adds nothing
maestro-cli models endpoints add --kind ollama [--url <url>] [--name <name>] [--api-key-env <VAR>] [--disabled]
maestro-cli models endpoints update <endpoint> [--name <name>] [--url <url>] [--kind <kind>] [--api-key-env <VAR> | --clear-api-key-env] [--enable | --disable]
maestro-cli models endpoints models <endpoint>   # the models the server lists now, for `assign endpoint:...`
maestro-cli models endpoints test <endpoint> [--model <model>]
maestro-cli models endpoints remove <endpoint>

maestro-cli models server status [--json]        # the Maestro model server (see "Model server")
maestro-cli models server start|stop
maestro-cli models server set [--bind local|network] [--max-models <n>] [--rotate-key] [--build default|cpu|cuda|rocm]
maestro-cli models server key                    # prints only the key

maestro-cli models tasks                         # every task, its assignment, and readiness
maestro-cli models assign <task-id> off
maestro-cli models assign <task-id> utility-agent
maestro-cli models assign <task-id> local:<model-id>
maestro-cli models assign <task-id> endpoint:<endpoint>:<model>
maestro-cli models assign cue-gate system-one    # ask the System One engine in force (a task with typed questions only)
maestro-cli models assign model-routing local:<model-id>   # the router Auto uses (see Model routing and Auto)
maestro-cli models status [task-id]              # would it run, and if not, why and what to do
maestro-cli models index                         # the semantic index: state, and how much is indexed
maestro-cli models proxy status                  # the Maestro token proxy: agents, tokens saved, added latency
maestro-cli search "<query>" --semantic          # find past work by meaning (drop --semantic for exact text)
maestro-cli models run <task-id> --input "..."   # run a text-generation task once
maestro-cli models run git-drafts --cwd <repo> [--base <branch>]   # draft a pull request title and body
maestro-cli models run dictation --audio <file.wav>   # transcribe a 16-bit PCM WAV file with the Dictation model
maestro-cli tab suggest-cleanup                  # tabs to close, snooze, or wake; prints them, changes nothing
maestro-cli notify speak "<text>"                # say one line aloud with the spoken-notices voice; waits until heard
```

An endpoint can be named by its id, an id prefix, or its name. Every verb takes `--json`. See the [CLI reference](./cli-reference#maestro-cli-models) for every option.
