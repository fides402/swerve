import { readFileSync, writeFileSync } from 'fs';

const html = readFileSync('C:/Users/User/Downloads/neu/index.html', 'utf8');
const data = readFileSync('C:/Users/User/Downloads/neu/tracks-data.json', 'utf8');

const injected = html.replace(
  '<script id="catalog-data" type="application/json">[]</script>',
  `<script id="catalog-data" type="application/json">${data}</script>`
);

writeFileSync('C:/Users/User/Downloads/neu/index.html', injected);
console.log('Data injected. HTML size:', Math.round(injected.length / 1024), 'KB');
