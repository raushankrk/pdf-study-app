const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const state = read('static/js/state.js');
const html = read('static/index.html');
const search = read('static/js/search.js');
const filemanager = read('static/js/filemanager.js');
const css = read('static/css/style.css');
let passed = 0;
function check(name, condition) {
  if (!condition) {
    console.error(`FAIL: ${name}`);
    process.exitCode = 1;
  } else {
    console.log(`PASS: ${name}`);
    passed++;
  }
}
check('sidebar search defaults to PDF content mode', /searchMode:\s*'content'/.test(state));
check('sidebar search placeholder and label describe content search', html.includes('placeholder="Search PDF content..."') && /id="search-mode-label">CONTENT</.test(html));
check('duplicate per-viewport Find controls are hidden', (html.match(/class="relative group\/search hidden"/g) || []).length === 2);
check('tag rail has a quick-search action that opens unified search', filemanager.includes('function focusUnifiedContentSearch()') && filemanager.includes('searchButton.onclick = focusUnifiedContentSearch'));
check('active PDF and current page are prioritized in content results', search.includes('Prefer results from the active PDF') && search.includes('a.page === activePage'));
check('opening a result keeps redundant viewport search controls hidden', search.includes('input.classList.add(\'hidden\')') && search.includes('document.getElementById(`${side}-search-nav`).classList.add(\'hidden\')'));
check('tag rail search icon has visible styling', css.includes('.tag-rail-search') && css.includes('.tag-rail-search:hover'));
console.log(`\nUnified search regression tests: ${passed}/7 passed`);
