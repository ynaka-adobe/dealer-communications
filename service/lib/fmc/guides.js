/*
 * AEM Guides files that are not per-communication: the DITAVAL filters the PDF output presets use.
 * They are uploaded once, to a shared folder, and reused by every communication's map.
 *
 *   dealer.ditaval  dealer PDF: drops the internal, field-only sections
 *   field.ditaval   internal PDF: keeps everything
 */
const GUIDES_FOLDER = '/content/dam/dealer-communications/guides';

const DITAVAL = {
  'dealer.ditaval': `<?xml version="1.0" encoding="UTF-8"?>
<val>
  <prop att="audience" val="field"  action="exclude"/>
  <prop att="audience" val="dealer" action="include"/>
</val>
`,
  'field.ditaval': `<?xml version="1.0" encoding="UTF-8"?>
<val>
  <prop att="audience" val="field"  action="include"/>
  <prop att="audience" val="dealer" action="include"/>
</val>
`,
};

/** Create the shared folder and upload each DITAVAL that is not already there. */
async function setupGuides(aem) {
  await aem.ensureFolder(GUIDES_FOLDER, 'Guides filters');
  const result = {};
  for (const [name, xml] of Object.entries(DITAVAL)) {
    // eslint-disable-next-line no-await-in-loop
    const exists = await aem.getMetadata(`${GUIDES_FOLDER}/${name}`);
    if (exists) {
      result[name] = 'already there';
    } else {
      // eslint-disable-next-line no-await-in-loop
      await aem.uploadText(GUIDES_FOLDER, name, xml, 'application/xml');
      result[name] = 'uploaded';
    }
  }
  return result;
}

module.exports = { setupGuides, DITAVAL, GUIDES_FOLDER };
