"use strict";

(function exposeQuery(root, factory) {
  const api = factory(
    typeof module === "object" && module.exports ? require("./level.js") : root.LogLevel,
  );
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.LogQuery = api;
})(typeof globalThis === "object" ? globalThis : this, (levelApi) => {
  const MAX_REGEX_LEN = 200;
  const LEVEL_ALIASES = Object.freeze({
    error: "error",
    fatal: "error",
    warn: "warn",
    warning: "warn",
    info: "info",
    debug: "debug",
    trace: "debug",
    other: "other",
  });

  function assertSafeRegex(source) {
    if (!source || source.length > MAX_REGEX_LEN) {
      throw new Error(`regex too long (max ${MAX_REGEX_LEN} chars)`);
    }
    const nestedQuantifier =
      /\((?:[^()\\]|\\.)*[*+](?:[^()\\]|\\.)*\)\s*(?:[*+]|\{\d+,?\d*\})/.test(source) ||
      /(?:\[[^\]]*\]|\\[dws])\s*[*+]\s*(?:[*+]|\{\d+,?\d*\})/i.test(source);
    if (nestedQuantifier) {
      throw new Error("regex rejected: nested quantifiers may hang (e.g. (a+)+)");
    }
  }

  function tokenize(source, { isRegex = false } = {}) {
    const tokens = [];
    let value = "";
    let quoted = false;
    let escaped = false;
    let hadQuote = false;
    for (let i = 0; i < source.length; i += 1) {
      const ch = source[i];
      if (escaped) {
        value += ch;
        escaped = false;
      } else if (ch === "\\") {
        const next = source[i + 1];
        if (isRegex && next && !(/["\\\s]/.test(next))) value += "\\";
        else escaped = true;
      } else if (ch === '"') {
        quoted = !quoted;
        hadQuote = true;
      } else if (/\s/.test(ch) && !quoted) {
        if (value || hadQuote) tokens.push({ value, quoted: hadQuote });
        value = "";
        hadQuote = false;
      } else {
        value += ch;
      }
    }
    if (escaped) value += "\\";
    if (quoted) throw new Error("unclosed quote in query");
    if (value || hadQuote) tokens.push({ value, quoted: hadQuote });
    return tokens;
  }

  function parseLevelList(value) {
    const levels = value
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean);
    if (!levels.length) throw new Error("level filter requires a value");
    const result = new Set();
    for (const item of levels) {
      const mapped = LEVEL_ALIASES[item];
      if (!mapped) throw new Error(`unknown log level: ${item}`);
      result.add(mapped);
    }
    return result;
  }

  function parseQuery(source, { isRegex = false } = {}) {
    const tokens = tokenize(String(source || ""), { isRegex });
    if (!tokens.length) throw new Error("query required");
    const includeLevels = new Set();
    const excludeLevels = new Set();
    const includeTerms = [];
    const excludeTerms = [];
    for (const token of tokens) {
      const negative = !token.quoted && token.value.startsWith("-") && token.value.length > 1;
      const body = negative ? token.value.slice(1) : token.value;
      const levelMatch = /^level:(.+)$/i.exec(body);
      if (levelMatch) {
        const target = negative ? excludeLevels : includeLevels;
        for (const item of parseLevelList(levelMatch[1])) target.add(item);
        continue;
      }
      if (!body) throw new Error("query term cannot be empty");
      (negative ? excludeTerms : includeTerms).push(body);
    }
    return { source: String(source || ""), includeLevels, excludeLevels, includeTerms, excludeTerms };
  }

  function normaliseLevelFilter(value) {
    if (!value) return null;
    const include = new Set();
    const exclude = new Set();
    if (Array.isArray(value)) {
      for (const raw of value) {
        const mapped = levelApi.normalise(raw) || (String(raw) === "other" ? "other" : null);
        if (mapped) include.add(mapped);
      }
    } else if (typeof value === "object") {
      for (const raw of value.include || []) {
        const mapped = levelApi.normalise(raw) || (String(raw) === "other" ? "other" : null);
        if (mapped) include.add(mapped);
      }
      for (const raw of value.exclude || []) {
        const mapped = levelApi.normalise(raw) || (String(raw) === "other" ? "other" : null);
        if (mapped) exclude.add(mapped);
      }
    }
    return include.size || exclude.size ? { include, exclude } : null;
  }

  function matchesLevelFilter(line, filter) {
    const normalised =
      filter && filter.include instanceof Set && filter.exclude instanceof Set ? filter : normaliseLevelFilter(filter);
    if (!normalised) return true;
    const level = levelApi.levelFromLine(line);
    if (normalised.exclude.has(level)) return false;
    return !normalised.include.size || normalised.include.has(level);
  }

  function compileTerm(term, isRegex, caseSensitive) {
    if (isRegex) {
      assertSafeRegex(term);
      const regex = new RegExp(term, caseSensitive ? "" : "i");
      return (line) => regex.test(line);
    }
    const needle = caseSensitive ? term : term.toLowerCase();
    return (line) => (caseSensitive ? line : line.toLowerCase()).includes(needle);
  }

  function compileQuery({ query, isRegex = false, caseSensitive = false }) {
    if (isRegex && String(query || "").length > MAX_REGEX_LEN) {
      throw new Error(`regex too long (max ${MAX_REGEX_LEN} chars)`);
    }
    const parsed = parseQuery(query, { isRegex });
    const positive = parsed.includeTerms.map((term) => compileTerm(term, isRegex, caseSensitive));
    const negative = parsed.excludeTerms.map((term) => compileTerm(term, isRegex, caseSensitive));
    const test = (value) => {
      const line = String(value || "");
      const level = levelApi.levelFromLine(line);
      if (parsed.excludeLevels.has(level)) return false;
      if (parsed.includeLevels.size && !parsed.includeLevels.has(level)) return false;
      return positive.every((match) => match(line)) && negative.every((match) => !match(line));
    };
    return {
      query: parsed.source,
      regex: Boolean(isRegex),
      caseSensitive: Boolean(caseSensitive),
      includeLevels: parsed.includeLevels,
      excludeLevels: parsed.excludeLevels,
      test,
    };
  }

  return { assertSafeRegex, compileQuery, matchesLevelFilter, normaliseLevelFilter, parseQuery, tokenize };
});
