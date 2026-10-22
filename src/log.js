'use strict';

function makeLogger(nodeId, { quiet = false } = {}) {
  return (text) => {
    if (quiet) return;
    const t = new Date().toTimeString().slice(0, 8);
    console.log(`[${t}] [${nodeId}] ${text}`);
  };
}

module.exports = { makeLogger };
