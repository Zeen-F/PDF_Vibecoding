// Original, generated PDFs for browser regression. No personal reading material.
import { open } from 'node:fs/promises';

function pdf(objects) {
  let content = '%PDF-1.4\n';
  const offsets = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(content));
    content += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(content);
  content += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  content += offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  content += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(content);
}

function textStream(lines) {
  return lines.map((line, index) => {
    const escaped = line.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)');
    return `BT /F1 ${index === 0 ? 20 : 12} Tf 72 ${720 - index * 36} Td (${escaped}) Tj ET`;
  }).join('\n') + '\n';
}

function baseDocument(pageLines) {
  const fontId = 3 + pageLines.length * 2;
  const pageIds = pageLines.map((_, index) => 3 + index * 2);
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Count ${pageLines.length} /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] >>`,
  ];
  for (const [index, lines] of pageLines.entries()) {
    const stream = textStream(lines);
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${pageIds[index] + 1} 0 R >>`);
    objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`);
  }
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  return { objects, pageIds };
}

export function bookmarkedPdf() {
  const { objects, pageIds } = baseDocument([
    ['An original navigation exercise', 'Six pages with nested PDF bookmarks.'],
    ['1 Introduction', 'A short introduction for navigation checks.'],
    ['1.1 Scope', 'Scope is a child of Introduction.'],
    ['2 Methods', 'Methods starts the second chapter.'],
    ['2.1 Results', 'Results is a child of Methods.'],
    ['Appendix', 'Final page of the original test document.'],
  ]);
  const outlines = objects.length + 1;
  const introduction = outlines + 1;
  const scope = outlines + 2;
  const methods = outlines + 3;
  const results = outlines + 4;
  objects[0] = `<< /Type /Catalog /Pages 2 0 R /Outlines ${outlines} 0 R >>`;
  objects.push(`<< /Type /Outlines /First ${introduction} 0 R /Last ${methods} 0 R /Count 4 >>`);
  objects.push(`<< /Title (1 Introduction) /Parent ${outlines} 0 R /Next ${methods} 0 R /First ${scope} 0 R /Last ${scope} 0 R /Count 1 /Dest [${pageIds[1]} 0 R /Fit] >>`);
  objects.push(`<< /Title (1.1 Scope) /Parent ${introduction} 0 R /Dest [${pageIds[2]} 0 R /Fit] >>`);
  objects.push(`<< /Title (2 Methods) /Parent ${outlines} 0 R /Prev ${introduction} 0 R /First ${results} 0 R /Last ${results} 0 R /Count 1 /Dest [${pageIds[3]} 0 R /Fit] >>`);
  objects.push(`<< /Title (2.1 Results) /Parent ${methods} 0 R /Dest [${pageIds[4]} 0 R /Fit] >>`);
  return pdf(objects);
}

export function unverifiedContentsPdf() {
  // Printed pages 1/3 correspond to PDF pages 3/5. Body headings intentionally
  // differ, so multiple title anchors cannot silently verify this offset.
  const { objects } = baseDocument([
    ['Original contents exercise', 'Manual page calibration test.'],
    ['Contents', '1 First chapter ............... 1', '2 Second chapter .............. 3'],
    ['Chapter body A', 'This is the physical third page.'],
    ['A continued', 'The chapter continues.'],
    ['Chapter body B', 'This is the physical fifth page.'],
    ['B continued', 'The original exercise ends here.'],
  ]);
  return pdf(objects);
}

export function verifiedContentsPdf() {
  const { objects } = baseDocument([
    ['Original verified contents exercise', 'Two independent chapter titles confirm a page offset.'],
    ['Contents', '1 Introduction ................ 1', '2 Methods ..................... 3'],
    ['1 Introduction', 'The introduction begins on physical page three.'],
    ['Introduction continued', 'Another page in the chapter.'],
    ['2 Methods', 'The methods begin on physical page five.'],
    ['Methods continued', 'The original exercise ends here.'],
  ]);
  return pdf(objects);
}

export async function writeLargeUploadPdf(filePath) {
  // Write an unreferenced padding stream incrementally, so testing the former
  // 50 MiB boundary does not send an oversized base64 fixture through Playwright.
  const { objects } = baseDocument([
    ['Original large upload exercise', 'This one-page PDF deliberately exceeds 50 MiB.'],
  ]);
  const file = await open(filePath, 'wx');
  const offsets = [];
  let position = 0;
  const append = async value => {
    await file.writeFile(value);
    position += Buffer.byteLength(value);
  };
  try {
    await append('%PDF-1.4\n');
    for (const [index, object] of objects.entries()) {
      offsets.push(position);
      await append(`${index + 1} 0 obj\n${object}\nendobj\n`);
    }
    const paddingId = objects.length + 1;
    const block = Buffer.alloc(1024 * 1024, 32);
    offsets.push(position);
    await append(`${paddingId} 0 obj\n<< /Length ${51 * block.length} >>\nstream\n`);
    for (let index = 0; index < 51; index++) await append(block);
    await append('\nendstream\nendobj\n');
    const xref = position;
    await append(`xref\n0 ${paddingId + 1}\n0000000000 65535 f \n`);
    await append(offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join(''));
    await append(`trailer\n<< /Size ${paddingId + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
    return position;
  } finally { await file.close(); }
}
