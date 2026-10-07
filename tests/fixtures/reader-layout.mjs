// Original, generated multi-page material for reader layout tests. Every page
// has its own selectable evidence line and vector drawing; no personal PDFs.
export const READER_LAYOUT_PAGE_COUNT = 23;

export function readerLayoutText(page) {
  const number = String(page).padStart(2, '0');
  return `Evidence from page ${number} stays on page ${number}.`;
}

export function readerLayoutSize(page, mixedSizes = false) {
  return mixedSizes && page === 2 ? { width: 900, height: 500 } : mixedSizes && page === 3 ? { width: 450, height: 1000 } : { width: 600, height: 800 };
}

export function readerLayoutPdf({ pageCount = READER_LAYOUT_PAGE_COUNT, variant = 'layout', mixedSizes = false } = {}) {
  if (!Number.isInteger(pageCount) || pageCount < 1 || pageCount > 100) throw new Error('Invalid fixture page count');
  if (!/^[a-z0-9-]+$/.test(variant)) throw new Error('Invalid fixture variant');
  const fontId = 3 + pageCount * 2;
  const pageIds = Array.from({ length: pageCount }, (_, index) => 3 + index * 2);
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Count ${pageCount} /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] >>`,
  ];
  for (let index = 0; index < pageCount; index++) {
    const page = index + 1, number = String(page).padStart(2, '0');
    const size = readerLayoutSize(page, mixedSizes);
    const content = [
      `BT /F1 20 Tf 60 740 Td (Original reader exercise - page ${number}) Tj ET`,
      `BT /F1 14 Tf 60 690 Td (${readerLayoutText(page)}) Tj ET`,
      `BT /F1 12 Tf 60 650 Td (Fixture ${variant}: page identity must survive layout changes.) Tj ET`,
      `q 0.2 0.4 0.3 RG 3 w 70 370 420 170 re S ${(.35 + index % 5 * .08).toFixed(2)} 0.75 0.6 rg 100 420 150 80 re f Q`,
      `BT /F1 12 Tf 70 340 Td (Vector drawing for region selection on page ${number}.) Tj ET`,
      `BT /F1 10 Tf 60 50 Td (Original synthetic material - physical PDF page ${page}) Tj ET`,
    ].join('\n') + '\n';
    const stream = mixedSizes ? `q ${size.width / 600} 0 0 ${size.height / 800} 0 0 cm\n${content}Q\n` : content;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${size.width} ${size.height}] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${pageIds[index] + 1} 0 R >>`);
    objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`);
  }
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  let output = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(output));
    output += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(output);
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  output += offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(output);
}
