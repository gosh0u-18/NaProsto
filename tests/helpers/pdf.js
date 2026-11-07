// Small, valid PDFs generated in memory. No test documents are written to disk.
function makePdf(texts, { imageOnly = false } = {}) {
  const characters = [...new Set(texts.join(''))];
  const codes = new Map(characters.map((character, index) => [character, index + 1]));
  const hex = (value, width) => value.toString(16).padStart(width, '0');
  const mappings = characters.map((character) =>
    `<${hex(codes.get(character), 2)}> <${hex(character.charCodeAt(0), 4)}>`).join('\n');
  const cmap = `/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap
/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def
/CMapName /TestUnicode def /CMapType 2 def
1 begincodespacerange\n<00> <ff>\nendcodespacerange
${characters.length} beginbfchar\n${mappings}\nendbfchar\nendcmap
CMapName currentdict /CMap defineresource pop\nend\nend`;
  const stream = (data) => `<< /Length ${Buffer.byteLength(data)} >>\nstream\n${data}\nendstream`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Count ${texts.length} /Kids [${texts.map((_, i) => `${5 + i * 2} 0 R`).join(' ')}] >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /ToUnicode 4 0 R >>',
    stream(cmap),
  ];
  texts.forEach((text, index) => {
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${6 + index * 2} 0 R >>`);
    const encoded = [...text].map((character) => hex(codes.get(character), 2)).join('');
    const chunks = encoded.match(/.{1,100}/g) || [''];
    objects.push(stream(imageOnly
      ? 'q 10 0 0 10 50 700 cm BI /W 1 /H 1 /BPC 8 /CS /RGB ID abc EI Q'
      : `BT /F1 12 Tf ${chunks.map((chunk) => `1 0 0 1 50 700 Tm <${chunk}> Tj`).join('\n')} ET`));
  });
  let body = '%PDF-1.7\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body);
}

module.exports = { makePdf };
