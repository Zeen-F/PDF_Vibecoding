// Original vector-only pages emulate a scan's lack of a selectable text layer.
// There are no third-party images, hidden words, OCR text, or private documents.
export function graphicsOnlyPdf() {
  const streams = [
    'q 0.97 0.96 0.90 rg 0 0 600 800 re f 0.20 0.35 0.27 RG 3 w 60 490 220 150 re S 0.76 0.64 0.38 rg 330 480 170 180 re f 0.2 0.2 0.2 RG 2 w 70 420 m 520 420 l S 70 390 m 490 390 l S 70 360 m 450 360 l S Q\n',
    'q 0.93 0.96 0.97 rg 0 0 600 800 re f 0.30 0.46 0.60 RG 4 w 70 500 430 160 re S 0.77 0.84 0.66 rg 100 250 160 160 re f 0.65 0.38 0.35 rg 330 250 160 160 re f Q\n',
  ];
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Count 2 /Kids [3 0 R 5 0 R] >>',
  ];
  streams.forEach((stream, index) => {
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << >> /Contents ${4 + index * 2} 0 R >>`);
    objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`);
  });
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
