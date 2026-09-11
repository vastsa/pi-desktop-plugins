/**
 * Driver registry — the half of the extensibility layer that is code.
 *
 * Adding a *new app* does not touch this file: it only needs a spec (JSON)
 * naming one of the registered drivers. This file only grows when a genuinely
 * new on-disk format appears (a 4th driver), which is the rare case.
 */
"use strict";

const jsonlTranscript = require("./jsonl-transcript");
const sqliteSession = require("./sqlite-session");
const jsonTree = require("./json-tree");

const DRIVERS = {
  "jsonl-transcript": jsonlTranscript,
  "sqlite-session": sqliteSession,
  "json-tree": jsonTree,
};

function getDriver(name) {
  return DRIVERS[name] ?? null;
}

function driverNames() {
  return Object.keys(DRIVERS);
}

module.exports = { DRIVERS, getDriver, driverNames };
