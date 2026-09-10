import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parse, filterSeverity, rank } from '../lib/parser.js';

const here = dirname(fileURLToPath(import.meta.url));
const fx = (n) => JSON.parse(readFileSync(join(here, 'fixtures', n), 'utf8'));

test('parses v2 results shape and normalizes fixed versions', () => {
  const { findings, errors } = parse(fx('osv-v2.json'));
  assert.equal(errors.length, 0);
  assert.equal(findings.length, 3, 'expected 3 findings (lodash + minimist + django)');
  // lodash
  const lodash = findings.find((f) => f.package === 'lodash');
  assert.ok(lodash, 'lodash finding missing');
  assert.equal(lodash.id, 'GHSA-p6mc-m468-83gw');
  assert.deepEqual(lodash.fixed, ['4.17.21']);
  assert.equal(lodash.severity, 'high');
  assert.ok(lodash.aliases.includes('CVE-2020-8203'));
  assert.equal(lodash.ecosystem, 'npm');
  assert.equal(lodash.installed, '4.17.20');
  assert.equal(lodash.source, 'package.json');
  assert.ok(lodash.references.length >= 1);
  // minimist is CRITICAL with CVSS 9.8
  const minimist = findings.find((f) => f.package === 'minimist');
  assert.equal(minimist.severity, 'critical');
  assert.deepEqual(minimist.fixed, ['1.2.6']);
  // django: no fixed version
  const django = findings.find((f) => f.package === 'django');
  assert.equal(django.severity, 'medium');
  assert.deepEqual(django.fixed, []);
});

test('findings are sorted by severity desc, then package', () => {
  const { findings } = parse(fx('osv-v2.json'));
  // critical (minimist) → high (lodash) → medium (django)
  assert.equal(findings[0].package, 'minimist');
  assert.equal(findings[1].package, 'lodash');
  assert.equal(findings[2].package, 'django');
});

test('parses legacy shape with .vulns array', () => {
  const { findings, errors } = parse(fx('osv-legacy.json'));
  assert.equal(errors.length, 0);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].package, 'left-pad');
  assert.equal(findings[0].ecosystem, 'npm');
  assert.deepEqual(findings[0].fixed, ['1.0.1']);
  // CVSS 5.0 buckets as medium
  assert.equal(findings[0].severity, 'medium');
});

test('parses bare array shape', () => {
  const { findings } = parse(fx('osv-bare-array.json'));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].id, 'CVE-2022-9999');
  assert.equal(findings[0].package, 'colors');
});

test('handles invalid JSON gracefully', () => {
  const r = parse('{ not json');
  assert.equal(r.findings.length, 0);
  assert.ok(r.errors[0].startsWith('invalid JSON'));
});

test('handles unrecognized shape gracefully', () => {
  const r = parse({ unexpected: 'shape' });
  assert.equal(r.findings.length, 0);
  assert.ok(r.errors[0].includes('unrecognized'));
});

test('filterSeverity cuts findings below the threshold', () => {
  const { findings } = parse(fx('osv-v2.json'));
  assert.equal(filterSeverity(findings, 'high').length, 2); // critical + high
  assert.equal(filterSeverity(findings, 'critical').length, 1);
  assert.equal(filterSeverity(findings, 'low').length, 3);
  assert.equal(filterSeverity(findings, 'unknown').length, 3); // unknown threshold → passthrough
});

test('rank is monotone with severity', () => {
  assert.ok(rank('critical') > rank('high'));
  assert.ok(rank('high') > rank('medium'));
  assert.ok(rank('medium') > rank('low'));
  assert.equal(rank(null), -1);
});

test('CVSS-only severity is bucketed correctly', () => {
  // 9.5 → critical, 7.0 → high, 5.0 → medium, 3.0 → low
  const wrapper = (score) => ({
    results: [{
      source: { path: 'x' },
      packages: [{
        package: { name: 'a', version: '1', ecosystem: 'npm' },
        vulnerabilities: [{
          id: 'X', summary: 't',
          severity: [{ type: 'CVSS_V3', score: String(score) }],
          affected: [], references: [],
        }],
      }],
    }],
  });
  assert.equal(parse(wrapper('9.5')).findings[0].severity, 'critical');
  assert.equal(parse(wrapper('7.0')).findings[0].severity, 'high');
  assert.equal(parse(wrapper('5.0')).findings[0].severity, 'medium');
  assert.equal(parse(wrapper('3.0')).findings[0].severity, 'low');
});
