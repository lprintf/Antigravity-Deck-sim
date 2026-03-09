// === Cache Module (Backward-Compatible Facade) ===
// This file re-exports from the split modules for backward compatibility.
// New code should import directly from the specific modules:
//   ws.js, step-cache.js, poller.js, auto-accept.js

const { setupWebSocket: _setupWS } = require('./ws');
const { stepCache, ensureCached } = require('./step-cache');
const { startPolling, startSSE } = require('./poller');
const { getAutoAccept, setAutoAccept, buildAcceptPayload } = require('./auto-accept');

// Wrap setupWebSocket to inject deps — server.js calls setupWebSocket(wss) without extra args
function setupWebSocket(wss) {
    return _setupWS(wss, { ensureCached, stepCache });
}

module.exports = {
    stepCache,
    setupWebSocket,
    startPolling,
    ensureCached,
    // Auto-accept API
    getAutoAccept,
    setAutoAccept,
    buildAcceptPayload,
};
