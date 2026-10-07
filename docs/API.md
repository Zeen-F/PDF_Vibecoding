# Paperdesk local API contract

All routes same origin, JSON error `{error: string}`. Node >=22.13, Express, node:sqlite, pdfjs-dist legacy. PORT defaults 4317, bind 127.0.0.1. PAPERDESK_DATA_DIR overrides default ./data. No external requests during app use.

Document: `{id,title,filename,pageCount,byteSize,createdAt,updatedAt,textAvailable,notesZh,notesEn,lastPage}`; id is UUID. Annotation: `{id,documentId,page,quote,comment,color,rects,createdAt,updatedAt}`. Rectangles `{x,y,width,height}` are normalized 0..1, top-left origin on the default PDF.js viewport including intrinsic PDF rotation. Color enum yellow,green,pink. All UI pages 1-based.

- GET /api/health => `{ok:true}`
- GET /api/documents => `{documents: Document[]}` (notes may be included)
- POST /api/documents multipart field `file` (PDF max 50 MiB). Server parses all pages and metadata, hash dedup. => 201 `{document,duplicate:false}` or 200 `{document,duplicate:true}`. Scanned PDF allowed with textAvailable:false. Reject encrypted files with readable error. Store original bytes unchanged.
- GET /api/documents/:id => `{document,annotations: Annotation[]}`
- GET /api/documents/:id/file => PDF bytes
- PATCH /api/documents/:id JSON partial `{title?,notesZh?,notesEn?,lastPage?}` => `{document}`. Updates only supplied fields; strict bounded validation.
- POST /api/documents/:id/annotations JSON `{page,quote,comment,color,rects}` => 201 `{annotation}`
- PATCH /api/documents/:id/annotations/:annotationId JSON `{comment?,color?}` => `{annotation}`
- DELETE /api/documents/:id/annotations/:annotationId => `{ok:true}`
- GET /api/search?q=... => `{results:[{documentId,title,page,snippet,source}]}`. source = text|title|notes|annotation. Case-insensitive literal substring, Unicode CJK supported; excerpts near match; maximum 100 results. Return pages across all docs, cap/snippet behavior documented.
- GET /api/documents/:id/export => text/markdown UTF-8 download containing title, original filename, Chinese/English notes, all annotations with page, quote, comment, color. Escape metadata and quote text as appropriate; user note bodies preserve Markdown. Ensure safe Content-Disposition.

Frontend owns src/**, index.html, vite.config.js, package.json, scripts launcher. Backend owns server/** only. QA owns tests/**, public/examples/** and sample creator work files only. Reviewer read-only. Root handles integration and documentation. No agent touches another agent's files without coordination.

Integration clarification: normalized rectangles refer to the intrinsic/default PDF.js viewport (including the PDF's intrinsic rotation); UI offers zoom but no extra rotation. Title/notes results use page 1; annotation results use their own page. Empty rectangle lists and rectangles extending beyond page bounds are invalid. Frontend uses q to mark matching PDF text spans after navigation (for text hits), and focuses notes/annotations for their respective source.
