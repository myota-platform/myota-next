import { readFileSync } from 'node:fs';
import {
  AWARD_DEFINITION_INPUT_FIELDS,
  validateAwardConfiguration,
} from '../../../contracts/award-definition.js';

const reference = readFileSync(
  new URL(
    '../../../web/admin/public/award-configuration-reference.html',
    import.meta.url,
  ),
  'utf8',
);

describe('award configuration reference', () => {
  it('keeps every accepted top-level input field documented', () => {
    for (const field of AWARD_DEFINITION_INPUT_FIELDS)
      expect(reference).toContain(`<code>${field}</code>`);
  });

  it('keeps the copyable example valid against the runtime contract', () => {
    const match = reference.match(
      /<pre[^>]*id="canonical-award-example"[^>]*>\s*<code>([\s\S]*?)<\/code>\s*<\/pre>/,
    );
    expect(match).not.toBeNull();
    const example = JSON.parse(match![1]);
    const fixture = JSON.parse(
      readFileSync(
        new URL(
          '../../../contracts/fixtures/award-definition-valid.json',
          import.meta.url,
        ),
        'utf8',
      ),
    );
    expect(example).toEqual(fixture);
    expect(validateAwardConfiguration(example)).toEqual([]);
  });
});
