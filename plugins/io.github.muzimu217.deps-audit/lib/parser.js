/**
 * Parse osv-scanner v1 / v2 JSON output into a normalized finding list.
 *
 * osv-scanner's output schema has changed across versions; we accept both the
 * legacy single-file format and the current v2 results-with-packages format
 * and return a single shape:
 *
 *   {
 *     id: string,                  // OSV vulnerability id
 *     ecosystem: string,           // npm | PyPI | crates.io | Go | Maven | RubyGems | Packagist
 *     package: string,
 *     installed: string,
 *     fixed: string[],             // fix versions (empty = none known)
 *     severity: 'low'|'medium'|'high'|'critical' | null,
 *     cvss: number | null,
 *     summary: string,
 *     aliases: string[],
 *     references: {type, url}[],
 *     source: string,              // which manifest the finding came from
 *   }
 *
 * Defensive: unknown shapes yield a structured error rather than throw.
 */
'use strict';

const SEVERITY_RANK = { low: 0, medium: 1, high: 2, critical: 3 };

function rank(sev) {
  if (!sev) return -1;
  return SEVERITY_RANK[sev.toLowerCase()] ?? -1;
}

function normalizeSeverity(vuln) {
  // Prefer the explicit severity list (CVSS_V3 / CVSS_V2 entries).
  const sevs = Array.isArray(vuln.severity) ? vuln.severity : [];
  let best = null;
  let bestScore = -1;
  for (const s of sevs) {
    const score = Number(s.score);
    if (Number.isFinite(score) && score > bestScore) {
      bestScore = score;
    }
    // osv-scanner also has a database_specific.severity string
    if (typeof s.type === 'string' && s.type.toLowerCase().includes('cvss')) {
      best = s;
    }
  }
  const dbSpecific = vuln.database_specific && vuln.database_specific.severity;
  const label = (dbSpecific || (best && best.type) || '').toLowerCase();
  if (label.includes('crit')) return 'critical';
  if (label.includes('high')) return 'high';
  if (label.includes('med')) return 'medium';
  if (label.includes('low')) return 'low';
  // CVSS bucket fallback
  if (bestScore >= 9) return 'critical';
  if (bestScore >= 7) return 'high';
  if (bestScore >= 4) return 'medium';
  if (bestScore > 0) return 'low';
  return null;
}

function normalizeFixed(vuln) {
  const out = [];
  const affected = Array.isArray(vuln.affected) ? vuln.affected : [];
  for (const a of affected) {
    const ranges = Array.isArray(a.ranges) ? a.ranges : [];
    for (const r of ranges) {
      if (r.type !== 'ECOSYSTEM' && r.type !== 'SEMVER') continue;
      const events = Array.isArray(r.events) ? r.events : [];
      for (const e of events) {
        if (typeof e.fixed === 'string') out.push(e.fixed);
      }
    }
  }
  return Array.from(new Set(out));
}

function normalizeOne({ vuln, pkg, source }) {
  const id = vuln.id;
  const summary = (vuln.summary || vuln.details || '').slice(0, 400);
  const references = Array.isArray(vuln.references)
    ? vuln.references.filter((r) => r && r.url).map((r) => ({ type: r.type || 'WEB', url: r.url }))
    : [];
  return {
    id,
    ecosystem: (pkg && pkg.ecosystem) || '',
    package: (pkg && pkg.name) || '',
    installed: (pkg && pkg.version) || '',
    fixed: normalizeFixed(vuln),
    severity: normalizeSeverity(vuln),
    cvss: null,
    summary,
    aliases: Array.isArray(vuln.aliases) ? vuln.aliases : [],
    references,
    source: source || '',
  };
}

/**
 * Parse osv-scanner JSON output. Accepts:
 *   - object with `results: [{ source, packages: [{ package, vulnerabilities: [...] }] }]`
 *   - legacy array of vulnerability objects (`[ { id, package, ... } ]`)
 *   - object with `vulns: [...]` from older osv-scanner
 *
 * @param {string|object} raw
 * @returns {{ findings: object[], errors: string[] }}
 */
function parse(raw) {
  const errors = [];
  let parsed;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      return { findings: [], errors: [`invalid JSON: ${e.message}`] };
    }
  } else {
    parsed = raw;
  }

  const findings = [];

  if (parsed && Array.isArray(parsed.results)) {
    // v2 results shape
    for (const r of parsed.results) {
      const source = (r.source && (r.source.path || r.source.name)) || '';
      const packages = Array.isArray(r.packages) ? r.packages : [];
      for (const p of packages) {
        const pkg = p.package || {};
        const vulns = Array.isArray(p.vulnerabilities) ? p.vulnerabilities : [];
        for (const v of vulns) {
          if (!v || !v.id) continue;
          findings.push(normalizeOne({ vuln: v, pkg, source }));
        }
      }
    }
  } else if (Array.isArray(parsed)) {
    // legacy: array of vulnerabilities
    for (const v of parsed) {
      if (!v || !v.id) continue;
      const pkg = v.package || {};
      findings.push(normalizeOne({ vuln: v, pkg, source: pkg.source || '' }));
    }
  } else if (parsed && Array.isArray(parsed.vulns)) {
    // older single-file shape
    for (const v of parsed.vulns) {
      if (!v || !v.id) continue;
      const pkg = v.package || {};
      findings.push(normalizeOne({ vuln: v, pkg, source: pkg.source || '' }));
    }
  } else {
    errors.push('unrecognized osv-scanner output shape (no results/vulns/array)');
  }

  // Stable order: severity desc, then package, then id
  findings.sort((a, b) => {
    const d = rank(b.severity) - rank(a.severity);
    if (d !== 0) return d;
    if (a.ecosystem !== b.ecosystem) return a.ecosystem < b.ecosystem ? -1 : 1;
    if (a.package !== b.package) return a.package < b.package ? -1 : 1;
    return a.id < b.id ? -1 : 1;
  });

  return { findings, errors };
}

function filterSeverity(findings, min) {
  if (!min) return findings;
  const threshold = SEVERITY_RANK[String(min).toLowerCase()] ?? -1;
  if (threshold < 0) return findings;
  return findings.filter((f) => rank(f.severity) >= threshold);
}

module.exports = { parse, filterSeverity, rank, SEVERITY_RANK };
