import { readFileSync, writeFileSync } from 'fs';

const content = readFileSync('./spreadsheet.csv', 'utf8');
const lines = content.trim().split('\n');

function parseCSVLine(line) {
  const result = [];
  let inQuotes = false, field = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { inQuotes = !inQuotes; }
    else if (c === ',' && !inQuotes) { result.push(field); field = ''; }
    else { field += c; }
  }
  result.push(field);
  return result;
}

const headers = parseCSVLine(lines[0]);
const tracks = [];
for (let i = 1; i < lines.length; i++) {
  if (!lines[i].trim()) continue;
  const cols = parseCSVLine(lines[i]);
  const row = {};
  headers.forEach((h, idx) => row[h] = cols[idx] || '');
  const uri = row['URI della traccia'] || '';
  const sid = uri.replace('spotify:track:', '');
  const year = (row["Data di rilascio dell'album"] || '').substring(0, 4);
  tracks.push({
    sid,
    t: row['Nome della traccia'] || '',
    a: row["Nome dell'artista"] || '',
    al: row["Nome dell'album"] || '',
    art: row["URL dell'immagine dell'album"] || '',
    pre: row['URL di anteprima della traccia'] || '',
    d: parseInt(row['Durata della traccia (ms)'] || 0) || 0,
    isrc: row['ISRC'] || '',
    y: year,
    pop: parseInt(row['Popolarità'] || 0) || 0
  });
}

const withPreview = tracks.filter(t => t.pre).length;
console.error(`Tracks: ${tracks.length}, With preview: ${withPreview}`);
const json = JSON.stringify(tracks);
console.error(`JSON size: ${json.length} bytes / ${Math.round(json.length / 1024)}KB`);
writeFileSync('./tracks-data.json', json);
console.log('Done');
