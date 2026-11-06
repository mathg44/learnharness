# Getting started

Download LearnHarness from [learnharness.ai](https://learnharness.ai) or [GitHub Releases](https://github.com/amosblomqvist/learnharness/releases). For running from source, see [Development](development.md).

## Connect models

Open **Settings → Providers** and configure a connection:

- **Provider API keys:** use your own account and pay that provider's rates.
- **Subscription connections:** ChatGPT, GitHub Copilot, and Grok use their respective sign-in flows and account limits. They do not silently fall back to API-key billing.
- **[Claude Code](claude-code.md):** use a separately installed and authenticated CLI. Its own configuration controls routing and billing; this is not a subscription-only guarantee.
- **[Custom endpoint](custom-providers.md):** connect one OpenAI-compatible server, including a local model server. LearnHarness does not install or download models.

Choose **Strong**, **Cheap**, and **Vision** models in Settings. There are no factory model selections. New sessions start with Strong; background roles use their assigned slots or role overrides. A model selected inside an existing session belongs to that session and does not change background-role choices.

Optional web search supports Tavily, Brave, Exa, Firecrawl, and hosted Ollama search; configure a key for the engine you want to use. Research can still fetch known URLs without a search key. Dictation has its own service key below.

## Start a session

Choose **Teach** and describe what you want to understand. The agent probes your starting point, presents a plan, and teaches through explanations and checks. Reply naturally to accept or revise the plan.

Use the thinking fields to explain your reasoning, uncertainty, or reaction—not only your selected answer. You can type or dictate. Your confidence is self-reported, not an independent assessment.

Choose **Practice** for problems rather than a lesson. Start from selected graph material or describe material directly. Submit your thinking as you work; the model's committed solution is revealed when the problem concludes. Use **Next problem** when ready to continue.

Sessions are saved locally, including earlier messages when context is compacted. The [keyboard guide](keyboard.md) covers submission, focus, question controls, and cancellation.

## Dictation

1. Create a [Deepgram API key](https://console.deepgram.com/) with the **Member role or higher**, required for [short-lived token minting](https://developers.deepgram.com/reference/auth/tokens/grant).
2. Add it under **Settings → Providers → Dictation** and choose the language below the key. **Multilingual** supports automatic recognition and mixed-language speech.
3. Use the microphone or **Mod+D** to start and stop. Review the text before sending. **Esc cancellation discards the pending transcript**; stop normally to keep it.

Audio streams from your browser directly to Deepgram using a short-lived token. A `403 Insufficient permissions` error while obtaining that token can mean the key's role is insufficient.

## Attach material to a session

### Browser uploads

When you use LearnHarness on a remote server, use the paperclip or drag files into the session to upload files from your computer. PDFs, supported raster images, and UTF-8 text files such as Markdown and source code are supported. Paste a screenshot or copied image into the composer to add it alongside files you've already selected. Folder uploads and Office documents are not supported here.

Files stay in the draft until you press Send. Review the filenames and image previews, remove anything you do not want, then send with or without a text message. Upload or processing failures keep the draft available for retry. Attachments can be sent when the current reply has finished. Text-only messages can still steer an active reply. Question-answer fields do not accept uploads.

The server reads text and normalizes images locally. It transcribes every PDF page through the session's selected model and existing connection, not a separate service or the Vision slot. Your model must support images for PDFs or pictures. Transcription uses that connection's normal usage allowance; the app does not switch providers or fall back to API billing. Check important PDF details against the original, since transcription can misread handwriting, equations, and labels and does not preserve drawings.

A message can carry up to 100 attachments, limited to 25 MiB in total. PDFs are limited to 1,000 pages. Images use the app's existing size and dimension limits. Unsupported or oversized content is refused, not silently shortened.

Processed contents are saved with the session on the server and survive reloads and server restarts. Original PDFs are not retained for download. Deleting the session removes its saved attachment content. Session attachments do not run the graph's file-import flow. This works in the private server trial without enabling server filesystem tools.

### Desktop file paths

In the desktop app, use the paperclip's **Files** or **Folder** choice, or drag files/folders into the content area, to insert their local paths. Files supports any file type and multiple selections; Folder attaches one directory path, including an empty folder, without expanding or reading its contents. Newly picked or dropped known folders get a trailing directory separator so their Folder icon survives saved messages and reloads; files stay unchanged. Older unmarked paths are not retrospectively classified. The agent can then locate/read supported content on the machine running LearnHarness under the existing file-access guards; attaching a path does not grant permissions. This is **not an upload**: originals stay where they are. Ordinary browsers cannot expose these local paths through the picker or drag-and-drop. Use browser uploads instead when the original is on your computer and the app runs on a server.

The teacher can show a local raster image or request an annotated visual based on it. Displayed/annotated pictures are saved as session-owned snapshots, so those saved results no longer depend on the original file. This does not snapshot every file attachment. Offline regression tests cover snapshot/payload behavior, not the quality of model-generated annotations.

File tools are read-only but have broad filesystem access under the server's user; they are not confined to a selected folder. The sensitive-path guard blocks known credential/private locations, not all sensitive content. Review what you make available: file content read by an agent may be sent to its configured model provider. See [file-access boundaries](architecture.md#file-access-and-external-services).

## Extract into the graph

For lessons, attach material to a session instead. Use the graph's **Extract files… → Files** or **Folder** picker for Markdown, plain text, or PDFs. This is a separate import flow, not a session attachment. Each supported file is uploaded for processing; folders organize imported sources.

- Files are limited to **25 MiB each**. Imports queue independently, with up to three files in flight.
- PDFs are limited to **1,000 pages**. Every page is rendered locally and sent to the configured PDF-reader model, normally the Vision slot, for transcription. This includes typed pages, scans, and handwriting. Configure an image-capable model and its connection before importing.
- Transcription preserves page order and requests text, equations, tables, and diagram labels. Uncertain readings use `[unclear]`; recognized blank pages use `[blank page]`. Models can still miss or misread details. Check the import's notices and compare important material with the original.
- Page images go to your configured provider and can incur usage charges. Transcription usage, including failed attempts, appears under **PDF transcription** in graph costs. Markdown and plain-text imports do not use this step.
- The complete transcription then goes through model-based proposition/chain extraction. If any page fails or its response is truncated, that PDF fails before graph extraction rather than silently skipping pages.
- Completed chunks survive later failures. Retry is explicit and reprocesses the file; unchanged content is not automatically skipped. The file queue does not survive a page reload.

The graph stores propositions and reasoning chains with source provenance, **not mastery scores**. A proposition's presence is not proof that you understood or retained it. Automatic session extraction can be disabled independently of graph rendering.

## Data, privacy, and usage

Chats, graph records, settings, and credentials live on your machine. Packaged desktop data normally lives under:

| OS | Learning-data folder |
| --- | --- |
| macOS | `~/Library/Application Support/LearnHarness/data` |
| Windows | `%APPDATA%\LearnHarness\data` |
| Linux | `$XDG_CONFIG_HOME/LearnHarness/data`, or `~/.config/LearnHarness/data` |

API-key files sit beside `data`, not inside it. They are plaintext with restrictive file permissions, not an encrypted vault. Keep complete profiles private; do not share credential files or raw debug captures in bug reports.

**Local storage does not mean local-only processing.** Configured models, subscription/CLI services, web research, and dictation can receive content. A local custom model is a separate setup choice, not an offline guarantee for other enabled services.

Click the context/cost row beneath the composer for Session stats. Dollar figures estimate known API costs; subscription, CLI, and custom-endpoint usage are not treated as free. See [context, caching, and costs](compaction-accounting.md) for the details.

Packaged apps support updates under **Settings → General**. Development builds do not run the updater. Report problems through [GitHub Issues](https://github.com/amosblomqvist/learnharness/issues), with reproduction steps and the app/OS version rather than private learning records or keys.
