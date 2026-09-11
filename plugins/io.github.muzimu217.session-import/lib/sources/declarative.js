/**
 * Turns a declarative spec into an adapter with exactly the same contract as
 * the hand-written sources in lib/sources/*.js:
 *   { source, label, scan(), convert(summary) }
 *
 * scan() -> summaries[]   (empty when the app's data is absent)
 * convert(summary) -> { session, messages }
 */
"use strict";

const { getDriver } = require("../drivers");

/**
 * @param {object} spec  validated spec (see lib/custom-sources.js)
 * @returns {{source:string,label:string,custom:true,driver:string,dataPath:string,scan:Function,convert:Function}}
 */
function makeDeclarativeSource(spec) {
  const driver = getDriver(spec.driver);
  if (!driver) {
    throw new Error(`unknown driver "${spec.driver}"`);
  }
  const sourceId = spec.id;

  return {
    source: sourceId,
    label: spec.label || sourceId,
    custom: true,
    driver: spec.driver,
    dataPath: spec.root || spec.db || "",

    async scan() {
      try {
        const summaries = await driver.scan(spec, sourceId);
        return Array.isArray(summaries) ? summaries : [];
      } catch {
        // A broken spec must never break the whole panel.
        return [];
      }
    },

    async convert(summary) {
      try {
        const out = await driver.convert(spec, summary);
        return out && out.session ? out : { session: null, messages: [] };
      } catch {
        return { session: null, messages: [] };
      }
    },
  };
}

module.exports = { makeDeclarativeSource };
