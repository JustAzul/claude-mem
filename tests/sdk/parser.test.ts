import { describe, it, expect, mock } from 'bun:test';

// Mock ModeManager before importing parser (it's used at module load time)
mock.module('../../src/services/domain/ModeManager.js', () => ({
  ModeManager: {
    getInstance: () => ({
      getActiveMode: () => ({
        observation_types: [{ id: 'bugfix' }, { id: 'discovery' }, { id: 'refactor' }],
      }),
    }),
  },
}));

import { parseObservations } from '../../src/sdk/parser.js';

describe('parseObservations', () => {
  it('returns a populated observation when title is present', () => {
    const xml = `<observation>
      <type>discovery</type>
      <title>Found a bug in auth module</title>
      <narrative>The token refresh logic skips expired tokens.</narrative>
    </observation>`;

    const result = parseObservations(xml);

    expect(result).toHaveLength(1);
    expect(result[0].title).toBe('Found a bug in auth module');
    expect(result[0].type).toBe('discovery');
    expect(result[0].narrative).toBe('The token refresh logic skips expired tokens.');
  });

  it('returns a populated observation when only narrative is present (no title)', () => {
    const xml = `<observation>
      <type>bugfix</type>
      <narrative>Patched the null pointer dereference in session handler.</narrative>
    </observation>`;

    const result = parseObservations(xml);

    expect(result).toHaveLength(1);
    expect(result[0].title).toBeNull();
    expect(result[0].narrative).toBe('Patched the null pointer dereference in session handler.');
  });

  it('returns a populated observation when only facts are present', () => {
    const xml = `<observation>
      <type>discovery</type>
      <facts><fact>File limit is hardcoded to 5</fact></facts>
    </observation>`;

    const result = parseObservations(xml);

    expect(result).toHaveLength(1);
    expect(result[0].facts).toEqual(['File limit is hardcoded to 5']);
  });

  it('returns a populated observation when only concepts are present', () => {
    const xml = `<observation>
      <type>refactor</type>
      <concepts><concept>dependency-injection</concept></concepts>
    </observation>`;

    const result = parseObservations(xml);

    expect(result).toHaveLength(1);
    expect(result[0].concepts).toEqual(['dependency-injection']);
  });

  // Regression test for issue #1625:
  // Ghost observations (all content fields null/empty) must be filtered out.
  it('filters out ghost observations where all content fields are null (#1625)', () => {
    const xml = `<observation>
      <type>bugfix</type>
    </observation>`;

    const result = parseObservations(xml);

    expect(result).toHaveLength(0);
  });

  it('filters out ghost observation with empty tags but no text content (#1625)', () => {
    const xml = `<observation>
      <type>discovery</type>
      <title></title>
      <narrative>   </narrative>
      <facts></facts>
      <concepts></concepts>
    </observation>`;

    const result = parseObservations(xml);

    expect(result).toHaveLength(0);
  });

  it('filters out multiple ghost observations while keeping valid ones (#1625)', () => {
    const xml = `
      <observation><type>bugfix</type></observation>
      <observation>
        <type>discovery</type>
        <title>Real observation</title>
      </observation>
      <observation><type>refactor</type><title></title><narrative>  </narrative></observation>
    `;

    const result = parseObservations(xml);

    expect(result).toHaveLength(1);
    expect(result[0].title).toBe('Real observation');
  });

  // Subtitle alone is explicitly excluded from the content guard (see parser comment).
  // An observation with only a subtitle is too thin to be useful and must be filtered.
  it('filters out observation with only a subtitle (excluded from survival criteria) (#1625)', () => {
    const xml = `<observation>
      <type>discovery</type>
      <subtitle>Only a subtitle, no real content</subtitle>
    </observation>`;

    const result = parseObservations(xml);

    expect(result).toHaveLength(0);
  });

  it('uses discovery as fallback when type is missing', () => {
    const xml = `<observation>
      <title>Missing type field</title>
    </observation>`;

    const result = parseObservations(xml);

    expect(result).toHaveLength(1);
    // Fallback changed from mode's first type (bugfix) to 'discovery' — observational
    // work is the most common ambiguous case; 'bugfix' was the worst default because
    // it implied a problem existed. See ObservationTypeNormalizer alias expansion.
    expect(result[0].type).toBe('discovery');
  });

  it('normalizes known aliases like code-path-inspection to discovery before fallback', () => {
    const xml = `<observation>
      <type>code-path-inspection</type>
      <title>Traced the scheduler path</title>
    </observation>`;

    const result = parseObservations(xml);

    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('discovery');
    expect(result[0].original_type).toBe('code-path-inspection');
    expect(result[0].normalized_type_strategy).toBe('alias');
  });

  it('returns empty array when no observation blocks are present', () => {
    const result = parseObservations('Some text without any observations.');
    expect(result).toHaveLength(0);
  });

  it('parses files_read and files_modified arrays correctly', () => {
    const xml = `<observation>
      <type>bugfix</type>
      <title>File read tracking</title>
      <files_read><file>src/utils.ts</file><file>src/parser.ts</file></files_read>
      <files_modified><file>src/utils.ts</file></files_modified>
    </observation>`;

    const result = parseObservations(xml);

    expect(result).toHaveLength(1);
    expect(result[0].files_read).toEqual(['src/utils.ts', 'src/parser.ts']);
    expect(result[0].files_modified).toEqual(['src/utils.ts']);
  });

  // Decision DNA fields: why, alternatives_rejected, related_observation_ids

  it('parses <why> field when present', () => {
    const xml = `<observation>
      <type>decision</type>
      <title>Chose SQLite over Redis</title>
      <why>Lock ordering was reversed because the prior order deadlocked under concurrent writes.</why>
    </observation>`;

    const result = parseObservations(xml);

    expect(result).toHaveLength(1);
    expect(result[0].why).toBe('Lock ordering was reversed because the prior order deadlocked under concurrent writes.');
  });

  it('returns why: null when <why> tag is absent', () => {
    const xml = `<observation>
      <type>feature</type>
      <title>Added OAuth2 support</title>
      <narrative>OAuth2 with PKCE flow was implemented.</narrative>
    </observation>`;

    const result = parseObservations(xml);

    expect(result).toHaveLength(1);
    expect(result[0].why).toBeNull();
  });

  it('parses <alternatives_rejected> when present', () => {
    const xml = `<observation>
      <type>decision</type>
      <title>Skipped Redis</title>
      <narrative>Chose local SQLite for simplicity.</narrative>
      <alternatives_rejected>Considered Redis but rejected due to ops overhead; considered Postgres but rejected as overkill.</alternatives_rejected>
    </observation>`;

    const result = parseObservations(xml);

    expect(result).toHaveLength(1);
    expect(result[0].alternatives_rejected).toBe('Considered Redis but rejected due to ops overhead; considered Postgres but rejected as overkill.');
  });

  it('returns alternatives_rejected: null when tag is absent', () => {
    const xml = `<observation>
      <type>bugfix</type>
      <title>Fixed null pointer</title>
      <narrative>Added null guard.</narrative>
    </observation>`;

    const result = parseObservations(xml);

    expect(result).toHaveLength(1);
    expect(result[0].alternatives_rejected).toBeNull();
  });

  it('parses <related> block with multiple integer IDs', () => {
    const xml = `<observation>
      <type>feature</type>
      <title>Extended parser</title>
      <narrative>Added new fields to parser.</narrative>
      <related><id>9783</id><id>9784</id></related>
    </observation>`;

    const result = parseObservations(xml);

    expect(result).toHaveLength(1);
    expect(result[0].related_observation_ids).toEqual([9783, 9784]);
  });

  it('returns related_observation_ids: [] when <related> block is absent', () => {
    const xml = `<observation>
      <type>discovery</type>
      <title>No relations</title>
      <narrative>Standalone finding.</narrative>
    </observation>`;

    const result = parseObservations(xml);

    expect(result).toHaveLength(1);
    expect(result[0].related_observation_ids).toEqual([]);
  });

  it('silently skips malformed (non-integer) IDs inside <related>', () => {
    const xml = `<observation>
      <type>decision</type>
      <title>Mixed related IDs</title>
      <narrative>Some IDs are bad.</narrative>
      <related><id>abc</id><id>42</id><id>3.14</id><id>99</id></related>
    </observation>`;

    const result = parseObservations(xml);

    expect(result).toHaveLength(1);
    // Order matches XML: <id>abc</id><id>42</id><id>3.14</id><id>99</id>
    // 'abc' → parseInt → NaN → skipped
    // '42'  → 42 (valid)
    // '3.14'→ parseInt → 3 (valid, parseInt truncates)
    // '99'  → 99 (valid)
    expect(result[0].related_observation_ids).toEqual([42, 3, 99]);
  });

  it('filters ghost observation that has only <why> (no title/narrative/facts/concepts)', () => {
    const xml = `<observation>
      <type>decision</type>
      <why>Some rationale here.</why>
    </observation>`;

    const result = parseObservations(xml);

    // why alone does not count as sufficient content — ghost guard unchanged
    expect(result).toHaveLength(0);
  });
});
