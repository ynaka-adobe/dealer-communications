const assert = require('assert');
const {
  withLayout, withHeaderSpacing, deployTemplate, START, END, TEMPLATE_CSS, COMMON_PLT,
} = require('../lib/fmc/template');

const base = 'body { color: red; }\n/* ===== FMCDealer Ford branding (appended) ===== */\nh1 { font-size: 20pt; }\n';

(async () => {
  // adds the block once, keeps everything that was there
  const once = withLayout(base);
  assert.ok(once.startsWith(base.trimEnd()));
  assert.equal(once.split(START).length - 1, 1);
  assert.match(once, /h1\.chapter:before \{ content: none; \}/);
  assert.match(once, /\.section\.fmc-sidebar \{[^}]*float: left;/);
  // running it again replaces the block; it never stacks, and a second run changes nothing
  const twice = withLayout(once);
  assert.equal(twice, once);
  assert.equal(twice.split(START).length - 1, 1);
  assert.equal(twice.split(END).length - 1, 1);
  // an edited older block is replaced, not left behind
  const stale = base + `\n${START}\n.old { x: 1 }\n${END}\n` + '/* after */\n';
  const fixed = withLayout(stale);
  assert.ok(!fixed.includes('.old'));
  assert.ok(fixed.includes('/* after */'));

  // the header in Common.plt: no rule, room above and below; running it again changes nothing
  const plt = '<title>T</title><table style="width: 100%; border-collapse: collapse; border-bottom: 2px solid #0a1a5c;"><tr><td style="width: 150px; padding: 0 0 8px 0; vertical-align: middle;">x</td><td style="padding: 0 0 8px 12px; vertical-align: middle; font-size: 22px;">y</td></tr></table>';
  const spaced = withHeaderSpacing(plt);
  assert.ok(!spaced.includes('border-bottom: 2px'));
  assert.ok(spaced.includes('padding: 0 0 8px 0;') && spaced.includes('padding: 0 0 8px 12px;'), 'cell padding stays as it was');
  assert.equal(spaced.split('page-style').length - 1, 1);
  assert.ok(spaced.includes('<meta name="page-style" content="margin-top: 64pt;" />'));
  // a header padded by the earlier version is put back
  assert.ok(!withHeaderSpacing(plt.replace(/padding: 0 0 8px/g, 'padding: 28pt 0 22pt')).includes('28pt 0 22pt'));
  assert.equal(withHeaderSpacing(spaced), spaced);

  // the deploy: each file as a new version; nothing is written when both are current
  const writes = [];
  const texts = { [TEMPLATE_CSS]: base, [COMMON_PLT]: plt };
  const aem = { async getText(p) { return texts[p]; }, async uploadText(f, n, t, m, o) { writes.push([f, n, m, o && o.newVersion]); texts[`${f}/${n}`] = t; } };
  const first = await deployTemplate(aem);
  assert.equal(first.changed, true);
  assert.deepEqual(writes, [
    ['/content/dam/dita-templates/pdf/Ford', 'content.css', 'text/css', true],
    ['/content/dam/dita-templates/pdf/Ford', 'Common.plt', 'text/html', true],
  ]);
  writes.length = 0;
  assert.equal((await deployTemplate(aem)).changed, false);
  assert.equal(writes.length, 0);
  const dry = await deployTemplate({ async getText(p) { return p === TEMPLATE_CSS ? base : plt; }, async uploadText() { throw new Error('dry run must not write'); } }, { dryRun: true });
  assert.equal(dry.dryRun, true);
  await assert.rejects(deployTemplate({ async getText() { return null; } }), /not found/);
  console.log('fmc-template: ok');
})().catch((e) => { console.error(e); process.exit(1); });
