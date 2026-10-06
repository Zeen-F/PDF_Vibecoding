# Paperdesk local API contract

All routes same origin, JSON error `{error: string}`. Node >=24.0.0, Express, node:sqlite, pdfjs-dist legacy. PORT defaults 4317, bind 127.0.0.1. PAPERDESK_DATA_DIR overrides default ./data. Ordinary reading/editing uses no external service. The optional MCP bridge can provide the user's requested document data or explicitly shared selection to Codex. The explicitly submitted ChatGPT job API below can operate ordinary ChatGPT through a Paperdesk-managed browser and return its response; it does not modify notes.

Document: `{id,title,filename,pageCount,byteSize,createdAt,updatedAt,textAvailable,notesZh,notesEn,notesRevision,lastPage}`; id is UUID. `notesRevision` is lowercase SHA-256 of `JSON.stringify([raw notesZh, raw notesEn])`. Annotation: `{id,documentId,page,kind,quote,comment,color,rects,createdAt,updatedAt}`. `kind` is `text` or `region`. Rectangles `{x,y,width,height}` are normalized 0..1, top-left origin on the default PDF.js viewport including intrinsic PDF rotation. Color enum yellow,green,pink. All UI pages 1-based.

- GET /api/health => `{ok:true}`
- GET /api/documents => `{documents: Document[]}` (notes may be included)
- POST /api/documents multipart field `file` (one PDF per request; no fixed byte-size cap). Multipart data is spooled to a random temporary file under the local library's `pdfs/.incoming/`; SHA-256 is computed from a file stream. PDF parsing runs through a single local queue, then original bytes are moved into the library and metadata/page text is committed. => 201 `{document,duplicate:false}` or 200 `{document,duplicate:true}`. Scanned PDF allowed with textAvailable:false. Reject encrypted files with readable error. Page count (2,000) and extracted text (20 million characters) limits remain; parsing and storage are also bounded by actual machine resources. Temporary input files are cleaned up on completion or failure.
- GET /api/documents/:id => `{document,annotations: Annotation[]}`
- GET /api/documents/:id/file => PDF bytes
- GET /api/documents/:id/toc => `TableOfContents` (see below). Extracted locally on demand for existing or newly imported PDFs; no reimport or database migration required.
- PATCH /api/documents/:id JSON partial `{title?,notesZh?,notesEn?,lastPage?,expectedNotesRevision?}` => `{document}`. Updates only supplied fields; strict bounded validation. When changing notes, a supplied revision must match the current raw fields or the whole request returns 409 without writing. New UI clients always supply it; omitting it remains compatible with old clients. Title/page-only updates do not compare note revisions.
- POST /api/documents/:id/annotations JSON `{page,kind?,quote?,comment?,color,rects}` => 201 `{annotation}`. Omitted `kind` defaults to `text` for existing clients. Text annotations require a nonempty `quote` and 1–200 rectangles. Regions require exactly one rectangle and an omitted or empty `quote`; any nonempty region quote is rejected. Omitted `comment` defaults to an empty string. Canvas preview data is not an API field and is never persisted.
- PATCH /api/documents/:id/annotations/:annotationId JSON `{comment?,color?}` => `{annotation}`
- DELETE /api/documents/:id/annotations/:annotationId => `{ok:true}`
- GET /api/search?q=... => `{results:[{documentId,title,page,snippet,source}]}`. source = text|title|notes|annotation. Case-insensitive literal substring, Unicode CJK supported; excerpts near match; maximum 100 results. Return pages across all docs, cap/snippet behavior documented.
- GET /api/documents/:id/export => text/markdown UTF-8 download containing title, original filename, one `笔记` section, and all annotations with page, quote, comment, color. Legacy note fields are combined for display/export without rewriting the stored fields. Escape metadata and quote text as appropriate; user note bodies preserve Markdown. Ensure safe Content-Disposition.

The document API retains `notesZh` and `notesEn` for storage compatibility; they are not two editors in the current UI. `shared/notes.mjs` combines two nonempty values with exactly `\n\n---\n\n`, retaining their original contents and order. With one empty value it returns the other without a separator. Opening, unchanged saving and exporting a legacy document do not consolidate its raw fields. An actual single-editor edit saves the complete displayed text to `notesZh` and clears `notesEn`; existing two-field local drafts are recovered into the same editor. The schema remains version 2. The combined note is capped at 500,007 UTF-16 code units, retaining the previous two-field capacity plus the separator; the legacy `notesEn` field remains capped at 250,000. Over-limit updates reject the whole request without changing either field.

Region exports identify `区域批注`, physical page, color, comment and the `x`, `y`, `width`, `height` coordinates normalized to 0–1. They do not fabricate quotation text or include a screenshot. Region comments participate in annotation search; words contained only in page images do not become searchable. PATCH cannot change an annotation's `kind`, page, quote or geometry.

## Local Codex bridge

These routes keep the existing Host/Origin validation and schema 2. They add no cloud account, filesystem access or model API. The bridge verifies `service`, `apiVersion` and the configured `libraryId` before every MCP operation.

- GET /api/plugin/status => `{service:'paperdesk',apiVersion:1,instanceId,libraryId}`. `instanceId` is a UUID regenerated at service startup. `libraryId` hashes the resolved data directory; it identifies the local binding without returning a filesystem path. It is not an authentication secret.
- GET /api/documents/:id/pages/:page => `{documentId,page,text,textAvailable}`. Page must be a canonical positive integer within this document. `textAvailable` describes that page, and false does not trigger OCR. The MCP reader bounds/paginates the returned text.
- POST /api/reader-sessions/:UUID JSON `{documentId,page,selection,notesDirty,visible}` => `{session:{sessionId,documentId,page,updatedAt},document}`. All fields are required. Selection is null until the user shares it, or `{kind:'text'|'region',text,rects,preview?}`. Text selections require a nonempty string (at most 50,000 UTF-16 units); regions require empty text and exactly one normalized rectangle. Optional preview is a validated PNG data URL at most 2 MiB including its prefix, with bounded decompression. This route accepts a 2.5 MiB JSON body, as does the separate ChatGPT jobs API.
- GET /api/reader-context?sessionId=UUID => `{sessionId,documentId,title,page,selection,notesDirty,updatedAt,notesRevision}`. Hidden, closed or expired sessions return 404. Without an ID, exactly one visible session is required; multiple visible sessions return 409 with metadata-only `sessions`, never a guessed selection.
- DELETE /api/reader-sessions/:UUID => `{ok:true}`. Idempotently forgets the transient session.
- POST /api/documents/:id/notes/append JSON `{text,expectedNotesRevision,requestId,page?}` => `{document,appended,requestId}`. Revision and UUID requestId are mandatory. The service atomically checks the revision and any live unsaved draft for this document, merges legacy fields, appends the text (optional `### 第 N 页` heading), and saves to the single note. Conflict returns 409 without changing saved content. Combined length obeys the same note limit. The MCP tool further limits an individual addition to 50,000 characters.

Sessions live only in memory, expire after 30 seconds without a heartbeat, and are limited to 8. The browser refreshes them every 3 seconds; previews never enter SQLite, annotations or exports. Page/document/selection changes or cancelling sharing clear the shared selection. Hidden sessions cannot supply current context but still block note append while a live draft is dirty.

Append idempotency remembers up to 512 successful request IDs for 10 minutes in the current service process. Retry an uncertain request with its **original complete payload**, including its revision, and the same request ID. A matching retry returns `appended:false` without another write; reusing the ID for different content returns 409. Capacity returns 429 instead of discarding a still-valid record. Restart/expiry clears this protection; re-read saved notes and reconcile an uncertain result before making a new request.

The UI uses revision checks for ordinary note saves and receives clean external additions through heartbeat responses. A conflicting draft remains in the editor/local recovery storage with autosave paused. An old draft without a known base revision cannot automatically overwrite a different saved note. Draft slots are independent per window; losing the session pointer still leaves a read-only historical recovery entry. Explicit preservation uses individual UUID archive keys (with legacy-array compatibility), avoiding cross-window archive overwrites. The user can preserve a draft and load saved notes; loading never silently discards the draft. A session is advisory coordination for this single local service, not multi-user authentication or a global lock across other processes.

## Storage version

Schema 2 adds `annotations.kind` with a `text` default and `text`/`region` validation. Startup upgrades existing records in a transaction without rewriting their IDs, quotes, comments or rectangles; repeated startup is idempotent and migration errors roll back. A database with `user_version > 2` is rejected rather than downgraded. Back up the complete library before first opening it with this version; reverting to an older application requires restoring the pre-migration backup.

## Table of contents

```ts
type TocEntry = {
  id: string;
  title: string;
  page: number | null;
  printedPage: string | null;
  children: TocEntry[];
};

type TableOfContents = {
  source: 'bookmarks' | 'contents' | 'none';
  entries: TocEntry[];
  pageOffset: number | null;
  offsetVerified: boolean;
  scannedPages: number;
  truncated: boolean;
};
```

- `page` is the resolved 1-based physical PDF page. `null` is not a navigable target. `printedPage` is the text printed in a contents entry, including Roman numerals; it is not itself a physical PDF page.
- Native PDF bookmarks take priority when at least one local target resolves, and preserve their hierarchy. Local destinations are resolved with PDF.js; unsupported, external or invalid targets in the returned tree remain non-navigable. This endpoint never opens a bookmark URL. If none of the native targets resolve, textual contents detection may be used instead.
- Without native bookmarks, the service examines at most the first 40 pages for a textual `Contents`, `Table of Contents` or `目录` heading and recognizable title/page lines. `scannedPages` describes the inspected fallback range; this is text extraction, not OCR. Complex layout, missing text and unusual numbering may yield `source: 'none'` with an empty entry list.
- Fallback page mapping requires PDF page-label evidence or consistent matches from multiple distinct printed pages and chapter headings. A known numeric offset follows `physical PDF page = printed Arabic page + pageOffset`; unverified mapping is left `null` rather than guessed. Use the resolved `page` per entry for navigation.
- Page labels can validate individual targets without proving one uniform numeric offset: `offsetVerified: true` may therefore coexist with `pageOffset: null`. Native bookmarks already point to physical pages and return `pageOffset: null`, `offsetVerified: false`; those two fields describe contents-page calibration only.
- The frontend may apply a user-provided numeric offset to Arabic printed pages and store it per document in browser local storage. This does not change the endpoint response, database, original PDF or other browsers. Unresolved Roman page labels remain non-navigable without a verified mapping.
- `truncated` flags an extraction limit; the result must not be presented as a guaranteed complete table of contents. Extraction caps are 2,000 entries, 12 hierarchy levels, 500 characters per title, and 40 fallback pages. Results are cached in server memory and rebuilt after restart. The source PDF and schema are unchanged.

Missing document IDs return 404 through the same document lookup as other endpoints. Other errors use the existing JSON error shape.

Integration clarification: normalized rectangles refer to the intrinsic/default PDF.js viewport (including the PDF's intrinsic rotation); UI offers zoom but no extra rotation. Title/notes results use page 1; annotation results use their own page. Empty rectangle lists and rectangles extending beyond page bounds are invalid. Frontend uses q to mark matching PDF text spans after navigation (for text hits), and focuses notes/annotations for their respective source.


## Native component single-page rendering

`GET /api/documents/:id/reader-page?page=N&width=1200` renders one database-known document page on the local server. `page` is required and must be a positive physical PDF page; `width` is optional, integer 600–1600. Unknown arguments and malformed values are rejected. The response is `{ documentId, page, width, height, mimeType: 'image/png', image: '<base64>', text, textTruncated }`. `width`/`height` are actual pixels, scaled proportionally within 1600×2400. Text is limited to 12000 UTF-16 units without splitting a surrogate pair. No PDF file-byte limit is added.

Rendering uses a terminable worker with a bounded queue and a 30-second request deadline. Source PDFs, notes and saved reading position are not modified. Errors use the existing JSON shape; the same Host/Origin validation still blocks `Origin: null` and foreign sites. MCP accesses this endpoint server-side and exposes display data only in private component `_meta`.

Transient `kind: 'text'` reader-session selections may use `rects: []` when copied from the native plain-text excerpt view, which has no PDF geometry. `kind: 'region'` still requires one real normalized rectangle. Saved text and region annotations still reject empty geometry; this exception does not manufacture on-page highlights.

## Ordinary ChatGPT connection and jobs (plugin 0.6.0)

These local routes require an explicit user click after previewing the question and selection. They retain Host/Origin checks and do not expose an arbitrary browser, file or private ChatGPT HTTP API. The default runner owns a dedicated Chromium profile, `~/.config/paperdesk/chatgpt-browser/`, separate from the PDF library and daily Chrome/EGO profiles. A prepared Chromium runtime is required; a separate EGO app is not. Login, verification and user-control requests remain user actions in the connection window. Only an explicit `PAPERDESK_CHATGPT_ENGINE=ego` selects the legacy runner; connection failure does not cause an automatic fallback. The runner verifies ordinary Chat, Latest and Extra High (`xhigh`) in the mounted UI before sending. Missing or unverified settings cause a pause, never a fallback model.

```ts
type ChatgptConnection = {
  engine: 'managed-browser';
  state: 'closed' | 'ready' | 'needs_user' | 'connecting';
  message: string;
};
```

- `GET /api/chatgpt/connection` => **200** `{connection: ChatgptConnection}`. Read-only status; it does not launch a browser. `ready` means the managed window is available, not that login is verified. Display the returned `message`.
- `POST /api/chatgpt/connection/open` JSON `{}` => **200** `{connection: ChatgptConnection}`. User-requested opening or focusing of the dedicated connection window, without submitting a question.
- `POST /api/chatgpt/connection/close` JSON `{}` => **200** `{connection: ChatgptConnection}`. Returns 409 when a task is executing or queued. Otherwise closes the managed window while retaining local login configuration. A paused, unsent `needs_user` task is changed to non-resumable `failed`; already dispatched questions are not withdrawn.

Connection routes reject unknown body fields, keep the same local identity/Origin protections, and return 503 when the connection environment is unavailable. They never accept arbitrary URLs, executable commands or browser profiles from request bodies. Closing the reading panel is distinct from closing this managed connection.

```ts
type ChatgptSelection =
  | { kind: 'text'; text: string }
  | { kind: 'region'; text: ''; preview: string };
type ChatgptJob = {
  id: string; requestId: string; parentJobId?: string; documentId: string; title: string; page: number;
  state: 'queued' | 'connecting' | 'uploading' | 'sending' | 'waiting'
    | 'needs_user' | 'completed' | 'failed' | 'uncertain';
  message: string; canResume: boolean; dispatchInvoked: boolean;
  response?: string; chatUrl?: string; modelLabel?: string; depthLabel?: string;
  createdAt: string; updatedAt: string; startedAt?: string; completedAt?: string;
};
```

- `POST /api/chatgpt/jobs` JSON `{requestId,documentId,page,question,selection,parentJobId?}` => **202** `{job: ChatgptJob}`. Only `parentJobId` is optional; unknown fields are rejected. IDs are UUIDs; the job ID equals the normalized request ID. The document must exist and the physical PDF page must be in range. The question is nonblank, at most 4,000 UTF-16 units. Text selections are nonblank, at most 50,000 units, and cannot include `preview`; regions require exactly empty `text` and a valid PNG data URL of at most 2 MiB including the prefix. No geometry, PDF bytes, notes, arbitrary path or client-supplied title is accepted. The route's JSON body cap is 2.5 MiB.
- `GET /api/chatgpt/jobs/:UUID` => **200** `{job: ChatgptJob}`. Poll the exact original ID; no new execution is dispatched by a read. The UI polls active jobs approximately every 1.5 seconds. Missing jobs return 404; retained receipts for expired full results return 410.
- `POST /api/chatgpt/jobs/:UUID/resume` JSON `{}` => **202** `{job: ChatgptJob}`. Allowed only when `state === 'needs_user'`, `canResume === true`, and the job is not still executing; otherwise 409. This endpoint is called only after the user completes the requested action and clicks “我已完成，继续连接”. It must not be used to retry an `uncertain` dispatch.

A follow-up supplies a new `requestId` and the completed `parentJobId`, while repeating the original document, page and selection. The parent must still have a full retained result: missing parent returns 404, an expired receipt 410, and a noncompleted parent or changed document/page/selection 409. The server clones the parent's original selection and builds `followupContext` from its saved question/answer history; client-supplied history or answers are rejected. A chain may include at most 6 prior question/answer pairs and 100,000 UTF-16 units of JSON-encoded context; exceeding either limit returns 400, without truncating or sending. Each follow-up uses a new dedicated browser page with the retained background, not the same ChatGPT webpage conversation. Parent linkage is included in the idempotency fingerprint and public job metadata; private history is not returned as a separate field.

Responses omit the original question, selection text, PNG, digest, local files and execution ledger. `response` is exposed only in `completed`, capped at 500,000 UTF-16 units. `chatUrl`, when supplied, is restricted to an HTTPS `chatgpt.com/c/...` conversation URL without credentials, query or fragment. `dispatchInvoked` records crossing the send boundary; it does not alone prove delivery or a completed answer.

The same `requestId` and identical normalized document/page/question/selection/parentJobId payload return the existing task without running the browser again. A different payload under that ID returns 409. An ambiguous submission response is recovered by querying the original UUID, not creating another request. The UI may explicitly reconfirm the original submission with the exact same body; it does not automatically resubmit. Once a send may have occurred, the state becomes `uncertain` rather than automatically retrying.

Execution is serialized. `needs_user` and `uncertain` pause the queue; while an uncertain task exists, new submissions return 429. The durable journal retains at most 8 full jobs. At capacity, only the oldest completed job or a failed job known not to have dispatched can be evicted; otherwise new submissions return 429. Eviction retains a permanent lightweight receipt (request ID, payload digest, terminal state and dispatch flag) and attempts to remove private input/PNG files. Repeating an expired receipt with the same payload returns 410, never a new dispatch; a changed payload still returns 409.

State acknowledgements use an atomically replaced, fsynced journal under `<dataDir>/chatgpt-jobs/`. Input, response, execution ledger and PNG files are personal data; directories use 0700; journal/input/ledger files use 0600 and upload PNG snapshots use read-only 0400. They must remain outside Git. Startup preserves terminal jobs and marks interrupted nonterminal work `uncertain`; it does not reconstruct a queue for redispatch. Invalid/unwritable records fail closed with 503. Do not delete the journal or receipts to force a retry.

There is no task-cancellation route in this version. Closing a preview, webpage or native panel does not cancel an already started browser execution. Connection close rejects active/queued jobs. Service shutdown closes the managed browser and conservatively records unfinished tasks; already sent content cannot be withdrawn, and uncertain dispatch is never automatically repeated. Closing/reopening only the preview or changing PDF pages retains the current UI instance's job IDs; a new webpage/panel instance does not automatically restore the task list yet. Jobs do not change the source PDF, saved notes, annotations or database schema 2.

Native components call `paperdesk_reader_chatgpt_submit` (the POST body), `paperdesk_reader_chatgpt_get` (`{jobId}`) and `paperdesk_reader_chatgpt_resume` (`{jobId}`). Each verifies the local service/library and returns job data only in `_meta.chatgptJob`, with generic success text in ordinary content. These 3 app-only tools set `openWorldHint: true`; no job question or answer is injected through `ui/message` or model context. The connection tools `paperdesk_reader_chatgpt_connection_get/open/close` accept `{}` and return `_meta.chatgptConnection`; open/close also declare `openWorldHint: true`, while status reads do not launch the browser. The native resource is `ui://paperdesk/reader-v6.html`, with 20 tools total, 12 app-only. Empty network/resource/frame CSP lists remain unchanged.
