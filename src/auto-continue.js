// === Auto-Continue Logic ===
// Detects retryable error messages (503 high traffic, network timeouts)
// and automatically sends "," after a delay to retry the cascade.

const { lsInstances, getSettings, saveSettings } = require('./config');
const { sendMessage } = require('./cascade');
// Lazy-load ws.js to avoid circular dependency
function _broadcast(data, targetConvId) { return require('./ws').broadcast(data, targetConvId); }
function _broadcastAll(data) { return require('./ws').broadcastToGlobal(data); }

// State — persisted in settings.json
let autoContinueEnabled = !!(getSettings().autoContinue);

// Per-cascade retry tracking: cascadeId → { count, lastStepIndex, timer }
const retryState = new Map();

// --- Configuration ---
const RETRY_DELAY_MS = 60_000;   // Wait 60s before retrying
const MAX_RETRIES = 9;           // Max consecutive retries per cascade

// --- Retryable error patterns ---
// Matched against errorMessage.error.userErrorMessage (case-insensitive)
const RETRYABLE_PATTERNS = [
    /high traffic/i,
    /try again/i,
    /retryable error/i,
    /network issue/i,
    /capacity available/i,
    /stream reading error/i,
    /connect(ion)? (timed? out|refused|reset)/i,
    /503/,
    /502/,
    /504/,
    /UNAVAILABLE/i,
];

// Errors that should NOT be retried even if they match above
const EXCLUDE_PATTERNS = [
    /INVALID_ARGUMENT/i,
    /does not support/i,
    /permission denied/i,
    /authentication/i,
    /unauthorized/i,
    /quota exceeded/i,
    /billing/i,
];

// --- Public API ---

function getAutoContinue() { return autoContinueEnabled; }

function setAutoContinue(val) {
    autoContinueEnabled = !!val;
    if (!autoContinueEnabled) {
        // Cancel all pending retries
        for (const [id, state] of retryState) {
            if (state.timer) clearTimeout(state.timer);
        }
        retryState.clear();
    }
    saveSettings({ autoContinue: autoContinueEnabled });
    console.log(`[AutoContinue] ${autoContinueEnabled ? 'ENABLED' : 'DISABLED'} (saved to settings)`);
}

/**
 * Check if a step is a retryable error and schedule auto-continue.
 * Called from poller.js when new steps are detected.
 *
 * @param {string} cascadeId
 * @param {number} stepIndex
 * @param {object} step - The step object from LS API
 * @param {object} inst - The LS instance that owns this cascade
 */
function handleAutoContinue(cascadeId, stepIndex, step, inst) {
    if (!autoContinueEnabled) return;

    const stepType = (step.type || '').replace('CORTEX_STEP_TYPE_', '');
    if (stepType !== 'ERROR_MESSAGE') return;

    // Extract error text
    const errorObj = step.errorMessage?.error || {};
    const userMsg = errorObj.userErrorMessage || '';
    const modelMsg = errorObj.modelErrorMessage || '';
    const fullMsg = `${userMsg} ${modelMsg}`;

    // Check exclusions first
    for (const pattern of EXCLUDE_PATTERNS) {
        if (pattern.test(fullMsg)) {
            console.log(`[AutoContinue] Skip (excluded): ${userMsg.substring(0, 60)}`);
            return;
        }
    }

    // Check if it matches any retryable pattern
    let matched = false;
    for (const pattern of RETRYABLE_PATTERNS) {
        if (pattern.test(fullMsg)) {
            matched = true;
            break;
        }
    }
    if (!matched) {
        console.log(`[AutoContinue] Skip (not retryable): ${userMsg.substring(0, 60)}`);
        return;
    }

    // Check retry count for this cascade
    let state = retryState.get(cascadeId);
    if (!state) {
        state = { count: 0, lastStepIndex: -1, timer: null };
        retryState.set(cascadeId, state);
    }

    // Same step — already handled
    if (state.lastStepIndex === stepIndex) return;

    // Max retries exceeded
    if (state.count >= MAX_RETRIES) {
        console.log(`[AutoContinue] Max retries (${MAX_RETRIES}) reached for ${cascadeId.substring(0, 8)}, stopping`);
        _broadcast({
            type: 'auto_continue',
            conversationId: cascadeId,
            event: 'max_retries',
            count: state.count,
        }, cascadeId);
        return;
    }

    // Cancel any existing timer for this cascade
    if (state.timer) clearTimeout(state.timer);

    state.lastStepIndex = stepIndex;
    state.count++;

    const retryNum = state.count;
    console.log(`[AutoContinue] Retryable error detected on ${cascadeId.substring(0, 8)} step[${stepIndex}]: "${userMsg.substring(0, 60)}"`);
    console.log(`[AutoContinue] Scheduling retry ${retryNum}/${MAX_RETRIES} in ${RETRY_DELAY_MS / 1000}s...`);

    // Notify frontend: retry scheduled
    _broadcast({
        type: 'auto_continue',
        conversationId: cascadeId,
        event: 'scheduled',
        retryNum,
        maxRetries: MAX_RETRIES,
        delayMs: RETRY_DELAY_MS,
        errorMessage: userMsg.substring(0, 100),
    }, cascadeId);

    // Schedule the retry
    state.timer = setTimeout(async () => {
        state.timer = null;
        try {
            console.log(`[AutoContinue] >>> Sending retry ${retryNum} for ${cascadeId.substring(0, 8)}...`);
            await sendMessage(cascadeId, ',', { inst });
            console.log(`[AutoContinue] +++ Retry ${retryNum} sent for ${cascadeId.substring(0, 8)}`);
            _broadcast({
                type: 'auto_continue',
                conversationId: cascadeId,
                event: 'sent',
                retryNum,
            }, cascadeId);
        } catch (e) {
            console.error(`[AutoContinue] !!! Retry ${retryNum} failed for ${cascadeId.substring(0, 8)}: ${e.message}`);
            _broadcast({
                type: 'auto_continue',
                conversationId: cascadeId,
                event: 'failed',
                retryNum,
                error: e.message,
            }, cascadeId);
        }
    }, RETRY_DELAY_MS);
}

/**
 * Reset retry counter for a cascade (call when cascade transitions to non-error state).
 * This allows fresh retries if a new error occurs after successful steps.
 */
function resetRetryCount(cascadeId) {
    const state = retryState.get(cascadeId);
    if (state) {
        if (state.timer) clearTimeout(state.timer);
        retryState.delete(cascadeId);
    }
}

/**
 * Cancel pending retry for a cascade (e.g. user manually intervened).
 */
function cancelRetry(cascadeId) {
    const state = retryState.get(cascadeId);
    if (state?.timer) {
        clearTimeout(state.timer);
        state.timer = null;
        console.log(`[AutoContinue] Cancelled pending retry for ${cascadeId.substring(0, 8)}`);
        _broadcast({
            type: 'auto_continue',
            conversationId: cascadeId,
            event: 'cancelled',
        }, cascadeId);
    }
}

module.exports = {
    getAutoContinue,
    setAutoContinue,
    handleAutoContinue,
    resetRetryCount,
    cancelRetry,
};
