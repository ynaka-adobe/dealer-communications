const assert = require('assert');
const {
  createAdobeTemplate, adobeCss, commonPlt, plainSvg, START, END,
} = require('../lib/fmc/adobeTemplate');

const DEALER = `h1{color:#0A1A5C}\n/* ===== FMCDealer sidebar layout (managed by the service) ===== */\n.section{border-left:3pt solid #d9dce6}\n/* ===== end FMCDealer sidebar layout ===== */\n`;

// the sheet takes the Adobe colours, keeps the Dealer layout block, and is the same when run twice
const once = adobeCss(DEALER);
assert.match(once, /color:#2c2c2c/);
assert.match(once, /solid #e1e1e1/);
assert.ok(!/#0a1a5c|#d9dce6/i.test(once), 'no Dealer colours left');
assert.ok(once.includes('FMCDealer sidebar layout'), 'the left details column layout stays');
assert.equal(adobeCss(once), once);
assert.equal(once.split(START).length, 2);
assert.ok(once.includes(END));
assert.match(once, /h1, h2, h3, h4, h5, h6[^{]*\{ color: #eb1000; \}/, 'every heading is Adobe red');

// the page layout: wordmark, red title, a red rule under the header
const plt = commonPlt();
assert.match(plt, /src="adobe-logo\.svg"/);
assert.match(plt, /border-bottom: 2px solid #eb1000/);
assert.match(plt, /Dealer Communications/);

// only a plain svg is accepted as the logo
assert.ok(plainSvg('<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>'));
assert.ok(!plainSvg('<svg><script>alert(1)</script></svg>'));
assert.ok(!plainSvg('<svg onload="x()"></svg>'));
assert.ok(!plainSvg('<html></html>'));
assert.ok(!plainSvg(''));

(async () => {
  const uploads = [];
  const aem = {
    async getText(p) { assert.equal(p, '/content/dam/dita-templates/pdf/Dealer/content.css'); return DEALER; },
    async uploadText(folder, name, text) { uploads.push([folder, name, text.length]); },
    async titleAdobeTemplate(title) { uploads.push(['title', title]); },
  };
  const r = await createAdobeTemplate(aem, '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
  assert.deepEqual(uploads.map((u) => u[1]), ['adobe-logo.svg', 'content.css', 'Common.plt', 'Adobe']);
  assert.equal(r.folder, '/content/dam/dita-templates/pdf/Adobe');
  console.log('adobe-template: ok');
})().catch((e) => { console.error(e); process.exit(1); });
