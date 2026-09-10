/** Registry of every supported local source. */
"use strict";

const zcode = require("./sources/zcode");
const workbuddy = require("./sources/workbuddy");
const claude = require("./sources/claude");
const codex = require("./sources/codex");
const opencode = require("./sources/opencode");
const pi = require("./sources/pi");

const ADAPTERS = [zcode, workbuddy, claude, codex, opencode, pi];

function getAdapter(source) {
  return ADAPTERS.find((a) => a.source === source) ?? null;
}

module.exports = { ADAPTERS, getAdapter };
