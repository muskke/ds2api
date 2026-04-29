'use strict';

const crypto = (function() {
  try { return require('crypto'); } catch (_) { return null; }
})();

function formatOpenAIStreamToolCalls(calls, idStore) {
  if (!Array.isArray(calls) || calls.length === 0) {
    return [];
  }
  return calls.map((c, idx) => ({
    index: idx,
    id: ensureStreamToolCallID(idStore, idx),
    type: 'function',
    function: {
      name: c.name,
      arguments: JSON.stringify(c.input || {}),
    },
  }));
}

function ensureStreamToolCallID(idStore, index) {
  if (!(idStore instanceof Map)) {
    return `call_${newCallID()}`;
  }
  const key = Number.isInteger(index) ? index : 0;
  const existing = idStore.get(key);
  if (existing) {
    return existing;
  }
  const next = `call_${newCallID()}`;
  idStore.set(key, next);
  return next;
}

function newCallID() {
  try {
    const c = crypto || (typeof globalThis !== 'undefined' ? globalThis.crypto : null);
    if (c && typeof c.randomUUID === 'function') {
      return c.randomUUID().replace(/-/g, '');
    }
  } catch (_err) {
    // Fallback
  }
  return `${Date.now()}${Math.floor(Math.random() * 1e9)}`;
}

module.exports = {
  formatOpenAIStreamToolCalls,
};
