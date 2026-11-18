const { parse } = require('csv-parse/sync');

const fields = ['testId', 'createdBy', 'createdOn', 'updatedBy', 'updatedOn', 'labels'];

function splitMetadata(content) {
  const text = String(content || '').replace(/^\uFEFF/, '');
  if (!/^#meta(?:,|\r?\n|$)/i.test(text)) return { metadata: null, content: text };
  const records = parse(text, { to: 1, relax_column_count: true });
  const row = records[0];
  if (!row || row.length !== 7) throw new Error('Metadata row must have seven columns: #meta,testId,createdBy,createdOn,updatedBy,updatedOn,labels.');
  let inQuotes = false;
  let end = text.length;
  for (let index = 0; index < text.length; index++) {
    if (text[index] === '"') {
      if (inQuotes && text[index + 1] === '"') { index++; continue; }
      inQuotes = !inQuotes;
    }
    if (text[index] === '\n' && !inQuotes) { end = index + 1; break; }
  }
  return {
    metadata: Object.fromEntries(fields.map((field, index) => [field, row[index + 1]])),
    content: text.slice(end),
  };
}

function serializeMetadata(metadata) {
  return ['#meta', ...fields.map((field) => String(metadata[field] ?? ''))]
    .map((value) => /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value).join(',');
}

function prepareMetadataSave(content, suppliedMetadata, existingContent, isNew, isFlow, username, timestamp) {
  const incoming = splitMetadata(content);
  const existing = splitMetadata(existingContent || '');
  const metadata = { ...Object.fromEntries(fields.map((field) => [field, ''])), ...existing.metadata, ...incoming.metadata, ...suppliedMetadata };
  metadata.testId = isFlow ? 'NA' : String(metadata.testId || '').trim();
  metadata.createdBy = isNew ? username : String(existing.metadata?.createdBy ?? incoming.metadata?.createdBy ?? '');
  metadata.createdOn = isNew ? timestamp : String(existing.metadata?.createdOn ?? incoming.metadata?.createdOn ?? '');
  if (!suppliedMetadata && incoming.metadata && !isNew) {
    metadata.createdBy = incoming.metadata.createdBy;
    metadata.createdOn = incoming.metadata.createdOn;
  }
  metadata.updatedBy = username;
  metadata.updatedOn = timestamp;
  return { metadata, content: `${serializeMetadata(metadata)}\n${incoming.content}` };
}

module.exports = { splitMetadata, serializeMetadata, prepareMetadataSave };