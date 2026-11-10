# Research PDF verification

## Prerequisites

- [ ] Use this work branch with the lockfile's dependencies and Node 26. Use synthetic providers, synthetic PDFs and a disposable data/auth profile. Do not supply real keys or learner records.
- [ ] Keep production research and PDF readiness disabled. This PR adds application protections; #27 must supply outbound enforcement before runtime enablement. Do not alter readiness checks, deploy or restart the live service to run this checklist.

## Automated checks

- [ ] Run `npm run typecheck` and `npm run lint`. Expect no errors. The existing `tests/source-name-ui.test.tsx` lint warning is unrelated.
- [ ] Run `NODE_ENV=test node --import tsx --test tests/server-research-pdf.test.ts tests/server-pdf-jobs.test.ts`. Expect public PDF download, page extraction/search, page-cited briefs, native rendering and background delivery to pass with controlled DNS/sockets and synthetic engines. No external connection is needed.
- [ ] In those tests, confirm private URLs/redirects, mapped IPv6, mixed DNS answers, DNS changes and a mismatched connected peer are refused. No Jina, Chrome or ambient fetch is used. Public IPv6 succeeds.
- [ ] Confirm declared, chunked and decompressed oversized bodies are refused; malformed and over-1,000-page PDFs leave no downloaded file. Four successful downloads are allowed per job; a fifth is refused. Long tool results stay within 40,000 characters.
- [ ] Confirm cancellation during download and after writing removes temporary files. Job success, failure and learner cancellation remove the job directory. A recovered research job downloads into a fresh directory and preserves the pending-delivery contract.
- [ ] Confirm unavailable PDF tools reject stale/direct calls. Research PDF readiness alone must not expose local-path PDF jobs or permit recovered local-path jobs to run.
- [ ] Run `NODE_ENV=test node --import tsx --test tests/pdf-ops.test.ts tests/pdf-native-render.test.ts tests/pdf-reader.test.ts tests/researcher-pdf.test.ts tests/pdf-transcription.test.ts tests/notes-pdf-import.test.ts tests/session-attachments.test.ts tests/session-attachments.test.tsx tests/saved-session-attachments.test.tsx`. Expect existing native PDF reading and the separate upload/transcription flows to remain supported.
- [ ] Run `npm test` once after all implementation changes. Expect the full suite to pass on Node 26.

## Manual user verification after authorized enablement

Entry point: the authenticated server's `/chat/new` page, accessed from the learner's laptop browser. These steps need a later approved deployment with #27's outbound restrictions, researcher model configuration, and a search engine key if testing discovery rather than a known source URL. They are not instructions to enable the feature in this PR.

- [ ] Open Settings from the sidebar, then Agent, and enable research. Start a lesson at `/chat/new` and ask the teacher to research a question whose authoritative source is a public PDF. Expect background research to acknowledge dispatch while the lesson continues.
- [ ] When research finishes, expect a brief delivered to the same lesson with the PDF's source link and page citations. The researcher can search and extract PDF text; it does not visually interpret diagrams or scanned pages. It should report a reading limitation rather than invent content.
- [ ] Ask about a public PDF over the limits or an unreadable PDF. Expect an honest limitation or error in the research result, not a hung lesson or a reader-service retry.
- [ ] Cancel active research using the background activity control titled "End this background process". Expect research to stop without a later successful brief replacing the cancellation.
- [ ] Separately, attach a synthetic PDF from the laptop's disk using the browser composer and send a question about it. Expect the existing upload/transcription workflow to work. It must not require a public URL, search credentials or server file access.

## Operator checks

- [ ] Before #27, verify `SERVER_CAPABILITIES.research.ready()` and `SERVER_CAPABILITIES.pdf.ready()` still return false. Settings must not bypass them.
- [ ] After an authorized synthetic research run, inspect only that run's temporary storage. Expect its private `lh-research-*` directory to be removed, with no original PDF copied into chat/job records or persistent document storage. Findings and source references remain in the result.
- [ ] If the process died abruptly, treat any remaining copies as private temporary data. They are not reused on recovery and have no automatic expiry. Under the approved maintenance procedure, stopping/starting or recreating the container clears its `/tmp` tmpfs. Do not delete unrelated host `/tmp` files or restart the live service without authorization.

PDF parsing and rendering use in-process pdfjs and Skia. Cancellation is cooperative around synchronous work, not a hard CPU or total-memory sandbox. Native rendering remains bounded to 16 megapixels and 8192 pixels per side.
