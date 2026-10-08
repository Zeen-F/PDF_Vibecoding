# Paperdesk local API contract

All routes same origin, JSON error `{error: string}`. Node >=24.0.0, Express, node:sqlite, pdfjs-dist legacy. PORT defaults 4317, bind 127.0.0.1. PAPERDESK_DATA_DIR overrides default ./data. Ordinary reading/editing uses no external service. The optional MCP bridge can provide the user's requested document data or explicitly shared selection to Codex.

Document: `{id,title,filename,pageCount,byteSize,createdAt,updatedAt,textAvailable,notesZh,notesEn,notesRevision,lastPage,folderId}`; id is UUID and folderId is one folder UUID or null (unclassified). `notesRevision` is lowercase SHA-256 of `JSON.stringify([raw notesZh, raw notesEn])`. Annotation: `{id,documentId,page,kind,quote,comment,color,rects,createdAt,updatedAt}`. `kind` is `text` or `region`. Rectangles `{x,y,width,height}` are normalized 0..1, top-left origin on the default PDF.js viewport including intrinsic PDF rotation. Color enum yellow,green,pink. All UI pages 1-based.

- GET /api/health => `{ok:true}`
- GET /api/documents => `{documents: Document[]}` (notes may be included)
- POST /api/documents multipart field `file` (one PDF per request; no fixed byte-size cap). Multipart data is spooled to a random temporary file under the local library's `pdfs/.incoming/`; SHA-256 is computed from a file stream. PDF parsing runs through a single local queue, then original bytes are moved into the library and metadata/page text is committed. => 201 `{document,duplicate:false}` or 200 `{document,duplicate:true}`. Scanned PDF allowed with textAvailable:false. Reject encrypted files with readable error. Page count (2,000) and extracted text (20 million characters) limits remain; parsing and storage are also bounded by actual machine resources. Temporary input files are cleaned up on completion or failure.
- GET /api/documents/:id => `{document,annotations: Annotation[]}`
- GET /api/documents/:id/file => PDF bytes
- GET /api/documents/:id/toc => `TableOfContents` (see below). Extracted locally on demand for existing or newly imported PDFs; no reimport or database migration required.
- PATCH /api/documents/:id JSON partial `{title?,notesZh?,notesEn?,lastPage?,expectedNotesRevision?,positionWriterId?,positionSequence?}` => `{document}` (sequenced position responses also include `positionStale` and `positionReplayed`). Updates only supplied fields; strict bounded validation. When changing notes, a supplied revision must match the current raw fields or the whole request returns 409 without writing. New UI clients always supply it; omitting it remains compatible with old clients. Title/page-only updates do not compare note revisions. See ordered reading positions below.
- POST /api/documents/:id/annotations JSON `{page,kind?,quote?,comment?,color,rects,requestId?}` => 201 `{annotation,replayed:false}`, or 200 `{annotation,replayed:true}` for a matching protected retry. Omitted `kind` defaults to `text` for existing clients. Text annotations require a nonempty `quote` and 1–200 rectangles. Regions require exactly one rectangle and an omitted or empty `quote`; any nonempty region quote is rejected. Omitted `comment` defaults to an empty string. Canvas preview data is not an API field and is never persisted. See annotation retries below.
- PATCH /api/documents/:id/annotations/:annotationId JSON `{comment?,color?,expectedAnnotationUpdatedAt?}` => `{annotation}`. An optional nonempty saved `updatedAt` token protects another window's edit: a stale token returns 409 without changing content. If supplied comment/color already match saved content, this is a no-op success even with an old token, allowing recovery from a lost successful response. Each actual edit receives a strictly newer token. Old clients may omit the token.
- DELETE /api/documents/:id/annotations/:annotationId => `{ok:true}`
- GET /api/search?q=... => `{results:[{documentId,title,page,snippet,source}]}`. source = text|title|notes|annotation. Case-insensitive literal substring, Unicode CJK supported; excerpts near match; maximum 100 results. Return pages across all docs, cap/snippet behavior documented.
- GET /api/documents/:id/export => text/markdown UTF-8 download containing title, original filename, one `笔记` section, and all annotations with page, quote, comment, color. Legacy note fields are combined for display/export without rewriting the stored fields. Escape metadata and quote text as appropriate; user note bodies preserve Markdown. Ensure safe Content-Disposition.

The document API retains `notesZh` and `notesEn` for storage compatibility; they are not two editors in the current UI. `shared/notes.mjs` combines two nonempty values with exactly `\n\n---\n\n`, retaining their original contents and order. With one empty value it returns the other without a separator. Opening, unchanged saving and exporting a legacy document do not consolidate its raw fields. An actual single-editor edit saves the complete displayed text to `notesZh` and clears `notesEn`; existing two-field local drafts are recovered into the same editor. Schema 3 preserves both note fields. The combined note is capped at 500,007 UTF-16 code units, retaining the previous two-field capacity plus the separator; the legacy `notesEn` field remains capped at 250,000. Over-limit updates reject the whole request without changing either field.

Region exports identify `区域批注`, physical page, color, comment and the `x`, `y`, `width`, `height` coordinates normalized to 0–1. They do not fabricate quotation text or include a screenshot. Region comments participate in annotation search; words contained only in page images do not become searchable. PATCH cannot change an annotation's `kind`, page, quote or geometry.

### Annotation writes and retries

Creating, editing or deleting a saved annotation, updating its document timestamp and reading the result run in one SQLite transaction. Any write failure rolls back the complete mutation; a 500 must not leave a partial annotation change.

New clients use an independent UUID `requestId` for each creation and keep the **original submitted payload and ID** for an uncertain retry. UUIDs are case-insensitive; default `kind`, `comment` and empty region `quote`, field order and rectangle property order are normalized before comparison. A matching ID is scoped to its document and returns the current saved annotation without touching timestamps. Reusing an ID with different content returns 409. If the originally created annotation was later deleted, retry returns 409 and never recreates it. Omitting the ID preserves the legacy create behavior without duplicate protection.

The main database stores only the request hash, annotation ID and timestamp, preserving retry protection through restart. Records remain valid for 30 days after successful creation and are capped at 10000 across the library; expired records are removed transactionally during protected creation. Capacity returns 429 without creating an annotation or evicting any valid record. After expiry, re-read saved annotations and reconcile an uncertain result instead of blindly replaying or generating a new ID.

### Ordered reading positions

A position-only request may supply `{lastPage,positionWriterId,positionSequence}`. Both optional ordering fields are required together: `positionWriterId` is a case-insensitive UUID identifying one writing window, and `positionSequence` is a positive safe integer increasing for that writer and document. Such requests cannot include title, notes or note-revision fields, so ignoring a stale position cannot accidentally acknowledge another edit.

The highest accepted sequence and its page persist in SQLite in the same transaction as the document update. A lower sequence returns `{document,positionStale:true,positionReplayed:false}` without writing. An equal sequence with the original page returns a no-op `{document,positionStale:false,positionReplayed:true}`; using that sequence for a different page returns 409. A higher sequence updates the position and returns both flags false. A replay returns the current document even if another writing window subsequently saved a different page.

Writers are independent across documents and windows; this prevents request reordering within a writer and does not impose a global navigation order on separate windows. The browser preserves its sequence across refresh, serializes requests and keeps a pending local recovery entry for failures. The tracker retains each writer for 30 days after its last newly accepted sequence, with at most 10000 active writer/document pairs in a library. Expired pairs are cleared during ordered writes; capacity returns 429 and preserves existing protection. This covers delayed requests and refresh/restart within that retention period. Legacy requests without ordering fields remain accepted and have no ordering guarantee.

## Local Codex bridge

These routes keep the existing Host/Origin validation and work with schema 4. They add no cloud account, filesystem access or model API. The bridge verifies `service`, `apiVersion` and the configured `libraryId` before every MCP operation.

- GET /api/plugin/status => `{service:'paperdesk',apiVersion:1,instanceId,libraryId,productVersion,launcherProtocol:1}`. `instanceId` is a UUID regenerated at service startup. `libraryId` hashes the resolved data directory; it identifies the local binding without returning a filesystem path. It is not an authentication secret. The browser launcher reuses a service only when its library ID, API version, product version and launcher protocol all match and `/api/health` reports healthy. Missing identity or older protocols are refused without opening a browser.
- GET /api/documents/:id/pages/:page => `{documentId,page,text,textAvailable}`. Page must be a canonical positive integer within this document. `textAvailable` describes that page, and false does not trigger OCR. The MCP reader bounds/paginates the returned text.
- POST /api/reader-sessions/:UUID JSON `{documentId,page,selection,notesDirty,visible}` => `{session:{sessionId,documentId,page,updatedAt},document}`. All fields are required. Selection is null until the user shares it, or `{kind:'text'|'region',text,rects,preview?}`. Text selections require a nonempty string (at most 50,000 UTF-16 units); regions require empty text and exactly one normalized rectangle. Optional preview is a validated PNG data URL at most 2 MiB including its prefix, with bounded decompression. This route alone accepts a 2.5 MiB JSON body.
- GET /api/reader-context?sessionId=UUID => `{sessionId,documentId,title,page,selection,notesDirty,updatedAt,notesRevision}`. Hidden, closed or expired sessions return 404. Without an ID, exactly one visible session is required; multiple visible sessions return 409 with metadata-only `sessions`, never a guessed selection.
- DELETE /api/reader-sessions/:UUID => `{ok:true}`. Idempotently forgets the transient session.
- POST /api/documents/:id/notes/append JSON `{text,expectedNotesRevision,requestId,page?}` => `{document,appended,requestId}`. Revision and UUID requestId are mandatory. The service atomically checks the revision and any live unsaved draft for this document, merges legacy fields, appends the text (optional `### 第 N 页` heading), and saves to the single note. Conflict returns 409 without changing saved content. Combined length obeys the same note limit. The MCP tool further limits an individual addition to 50,000 characters.

Sessions live only in memory, expire after 30 seconds without a heartbeat, and are limited to 8. The browser refreshes them every 3 seconds; previews never enter SQLite, annotations or exports. Page/document/selection changes or cancelling sharing clear the shared selection. Hidden sessions cannot supply current context but still block note append while a live draft is dirty.

Append idempotency remembers up to 512 successful request IDs for 10 minutes in the current service process. Retry an uncertain request with its **original complete payload**, including its revision, and the same request ID. A matching retry returns `appended:false` without another write; reusing the ID for different content returns 409. Capacity returns 429 instead of discarding a still-valid record. Restart/expiry clears this protection; re-read saved notes and reconcile an uncertain result before making a new request.

The UI uses revision checks for ordinary note saves and receives clean external additions through heartbeat responses. A conflicting draft remains in the editor/local recovery storage with autosave paused. An old draft without a known base revision cannot automatically overwrite a different saved note. Draft slots are independent per window; losing the session pointer still leaves a read-only historical recovery entry. Explicit preservation uses individual UUID archive keys (with legacy-array compatibility), avoiding cross-window archive overwrites. The user can preserve a draft and load saved notes; loading never silently discards the draft. A session is advisory coordination for this single local service, not multi-user authentication or a global lock across other processes.

## Storage version

Schema 4 adds `annotation_requests` (document/request UUID, hash, annotation ID and creation time) and `reading_position_writers` (document/writer UUID, highest sequence, page and update time). Both reference documents with `ON DELETE CASCADE`; annotation request records intentionally survive deletion of the annotation itself for their finite retention period. No original content fields are changed. Schema 3 adds `folders`, nullable `documents.folder_id` referencing folders with `ON DELETE SET NULL`, and one `library_preferences` row for theme. Names have a unique NFKC/lowercase `name_key`. Legacy documents begin unclassified and theme defaults to forest. The earlier schema 2 migration still adds `annotations.kind` with a `text` default and `text`/`region` validation when needed.

Startup applies all schema changes in one transaction, without rewriting original document metadata, raw notes, saved reading positions, page text, annotations or PDF bytes. Existing note revisions remain identical. Repeated startup is idempotent; migration errors roll back tables, columns and version together. A database with `user_version > 4` is rejected rather than downgraded. Before first opening a library with this build, stop its service and back up the complete directory (all databases, sidecars and PDFs). Migration from schema 3 is additive and failure restores schema 3; reverting to beta.4 requires restoring the pre-migration backup, rather than deleting tables or changing `user_version` by hand.

## Library folders and theme

Folders are one level deep; each document belongs to zero or one folder. Folder metadata is `{id,name,documentCount,createdAt,updatedAt}`. Counts are computed from current membership. List order is normalized name, then ID.

- GET /api/library => `{folders: Folder[],theme:'forest'|'sand'|'slate'|'night'}`.
- POST /api/folders JSON `{name}` => 201 `{folder}`.
- PATCH /api/folders/:id JSON `{name}` => `{folder}`.
- DELETE /api/folders/:id with no body or `{}` => `{ok:true}`. Documents become unclassified; their PDF, notes, annotations and reading position remain.
- PATCH /api/documents/:id/folder JSON `{folderId:UUID|null}` => `{document}`. This is the drag/drop and menu classification endpoint. It changes only membership and document update time; it neither compares nor changes notesRevision, and cannot accept note fields.
- PATCH /api/library/theme JSON `{theme}` => `{theme}`. The theme persists for the whole library across browser/plugin sessions and restarts. Labels are forest 森林, sand 暖砂, slate 雾蓝 and night 夜读.

All bodies reject unsupported fields. Names are trimmed and must contain 1–80 UTF-16 units; Unicode control/format characters are rejected even before trimming. NFKC plus lowercase is used only for uniqueness, preserving the trimmed display spelling. Conflicting creation/renaming returns 409, malformed UUID/name/theme/body returns 400, and an unknown document or folder returns 404. IDs may use either hex case. These routes inherit the same Host/Origin protections, including rejection of foreign websites and `Origin: null`. Folder renaming, deletion, movement and theme changes never rewrite note content or invalidate a valid note revision; clients must also avoid replacing an unsaved editor draft with metadata responses.

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

## Independent text-selection translation (0.9.0)

These opt-in loopback endpoints retain Host/Origin validation and no-store. Supported provider IDs: `baidu`, `azure`, `deepl`, `openai-compatible`. Reading, rendering, configuration saving, and importing never automatically send text externally.

| Method/path | Body | Response |
| --- | --- | --- |
| `GET /api/translation/settings?provider=ID` | none | `{ settings }`; omitted provider reads active profile |
| `PUT /api/translation/settings` | `{ provider?, appId?, apiKey?, tier?, monthlyLimit?, endpoint?, region?, model? }` | `{ settings }`; saves and activates selected profile |
| `DELETE /api/translation/settings?provider=ID` | none | `{ settings }`; clears selected credentials/cache, preserves usage/other profiles |
| `POST /api/translation` | `{ text, from: 'auto'|'en'|'zh', to: 'zh'|'en' }` | `{ translation, settings }`; uses active profile |

`settings` contains `provider`, `activeProvider`, `configured`, masked `appIdHint`, `tier`, `monthlyLimit`, `month`, `usedCharacters`, `remainingCharacters`, `maxCharacters`, `maxBytes`, and public `endpoint`, `region`, `model` where applicable. It never returns the saved API key. Profiles persist separately. Omitted/blank credentials reuse the selected provider's stored credentials only when account/endpoint binding remains valid; changing the endpoint host requires an explicitly supplied new key. Baidu requires APPID and matching key, Azure/DeepL require a key, and OpenAI-compatible requires key, full endpoint and model.

Baidu monthlyLimit is 0..50000 (standard) or 0..1000000 (advanced); others allow 0..10000000. Zero pauses new sends. Defaults are Baidu tier allowance, Azure 2000000, DeepL/custom 50000; these local settings do not assert actual provider free entitlement. The local counter uses Unicode code points and UTC+8 months, reserves before send, retains failed/timeouts, and cannot see other apps/devices or infer account relationships after key rotation. Cache hits do not reserve. Budgets and cache are scoped to provider/credential identity; endpoint path/model changes invalidate relevant cache without resetting usage.

Request guards: Baidu 1000/6000 characters plus 6000 UTF-8 bytes; others 10000 characters/40000 bytes. Invalid or oversized input is rejected, never truncated. `translation` contains actual `provider`, `translatedText`, `from`, `to`, `cached`, `characters`. Provider output is untrusted plain display data, not commands or instructions.

Azure uses its v3 text translation JSON protocol and subscription-key/region headers; DeepL uses its v2 text translation JSON protocol and `DeepL-Auth-Key` authorization; custom uses a full `/chat/completions` endpoint, Bearer authentication, user-selected model and non-streamed text messages, with no tools or automatic model substitution. External endpoints require HTTPS; custom HTTP is limited to loopback. Userinfo/query/fragment endpoints and redirects are rejected. Azure/DeepL configuration is distinct from their subscription tiers.

Requests are serialized and deadline-limited including queue wait. Expired queued requests cannot send late; failures have no automatic retry/provider fallback. Queued profile/config changes reject before send. Known errors are sanitized; raw provider errors, input, keys and signatures are not logged or echoed. Private `translation.sqlite` stores profiles, active choice, usage and bounded cache, with lazy creation and compatibility migration; translation does not change the main library schema (currently 4). Backups must include both databases and PDFs and stay out of Git/static resources.

Native `paperdesk_reader_translation` is app-only: operations status/configure/clear/translate, with optional provider for profile selection and configuration fields above. Results remain private `_meta.translationSettings`/`_meta.translation`, never model-visible content. Translation does not send conversation messages/context or save notes. Existing Work discussion is separate.

### Draft configuration test (0.10.0)

`POST /api/translation/test` accepts the same candidate configuration fields as settings PUT. It validates and merges stored credentials with the same account/host binding rules, then translates fixed `Hello, Paperdesk.` from English to Chinese. No caller text, documents or notes are accepted. The draft is not saved or activated, including successful tests.

Response: `{ test: { provider, sourceText, translatedText, characters, elapsedMs } }`. Each click uses a fresh provider call, bypassing both cache reads and writes. The shared queue, 1 QPS pacing, deadline, cancellation and budget reservation apply; retries are never automatic. Character use is charged conservatively to the tested credential identity, including failures, without resetting that identity's usage. A queued test checks the tested saved profile revision; unrelated active-provider changes do not activate or redirect it.

Test errors add a finite `category`: authentication, quota, timeout, connection, configuration, response, changed, stopped or unknown. Messages remain sanitized; raw upstream payloads, draft secrets and request bodies are not returned or logged. Existing API error shapes remain unchanged. Native operation `test` uses config arguments (no text/from/to) and returns only `_meta.translationTest`; both success and categorized failure remain outside model context. UI results belong to that form snapshot and are invalidated by edits, profile changes or closure.
