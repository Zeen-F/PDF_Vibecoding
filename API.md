# Paperdesk local API contract

All routes same origin, JSON error `{error: string}`. Node >=24.0.0, Express, node:sqlite, pdfjs-dist legacy. PORT defaults 4317, bind 127.0.0.1. PAPERDESK_DATA_DIR overrides default ./data. No external requests during app use.

Document: `{id,title,filename,pageCount,byteSize,createdAt,updatedAt,textAvailable,notesZh,notesEn,lastPage}`; id is UUID. Annotation: `{id,documentId,page,quote,comment,color,rects,createdAt,updatedAt}`. Rectangles `{x,y,width,height}` are normalized 0..1, top-left origin on the default PDF.js viewport including intrinsic PDF rotation. Color enum yellow,green,pink. All UI pages 1-based.

- GET /api/health => `{ok:true}`
- GET /api/documents => `{documents: Document[]}` (notes may be included)
- POST /api/documents multipart field `file` (one PDF per request; no fixed byte-size cap). Multipart data is spooled to a random temporary file under the local library's `pdfs/.incoming/`; SHA-256 is computed from a file stream. PDF parsing runs through a single local queue, then original bytes are moved into the library and metadata/page text is committed. => 201 `{document,duplicate:false}` or 200 `{document,duplicate:true}`. Scanned PDF allowed with textAvailable:false. Reject encrypted files with readable error. Page count (2,000) and extracted text (20 million characters) limits remain; parsing and storage are also bounded by actual machine resources. Temporary input files are cleaned up on completion or failure.
- GET /api/documents/:id => `{document,annotations: Annotation[]}`
- GET /api/documents/:id/file => PDF bytes
- GET /api/documents/:id/toc => `TableOfContents` (see below). Extracted locally on demand for existing or newly imported PDFs; no reimport or database migration required.
- PATCH /api/documents/:id JSON partial `{title?,notesZh?,notesEn?,lastPage?}` => `{document}`. Updates only supplied fields; strict bounded validation.
- POST /api/documents/:id/annotations JSON `{page,quote,comment,color,rects}` => 201 `{annotation}`
- PATCH /api/documents/:id/annotations/:annotationId JSON `{comment?,color?}` => `{annotation}`
- DELETE /api/documents/:id/annotations/:annotationId => `{ok:true}`
- GET /api/search?q=... => `{results:[{documentId,title,page,snippet,source}]}`. source = text|title|notes|annotation. Case-insensitive literal substring, Unicode CJK supported; excerpts near match; maximum 100 results. Return pages across all docs, cap/snippet behavior documented.
- GET /api/documents/:id/export => text/markdown UTF-8 download containing title, original filename, Chinese/English notes, all annotations with page, quote, comment, color. Escape metadata and quote text as appropriate; user note bodies preserve Markdown. Ensure safe Content-Disposition.

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
