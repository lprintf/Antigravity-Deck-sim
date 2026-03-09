// === Cascade Relay ===
// Stateless module. Waits for cascade to finish, extracts full response.
// Zero knowledge of Discord/Telegram/bridge state.
//
// Edge cases handled:
//   - Intermediate IDLE: cascade pauses between thinking + tool execution
//   - Thinking-only steps: PLANNER_RESPONSE with toolCalls (no visible text)
//   - ERROR/CANCELLED status: detect and return early
//   - Empty/whitespace-only response: treated as no content
//   - Consecutive API errors: detect CSRF/connectivity failure, abort early
//   - Adaptive poll interval: fast at start (500ms), slower over time (3s)

const { getStepCountAndStatus, stepCache, ensureCached, detectApiStartIndex } = require('./step-cache');
const { callApi } = require('./api');

// ── Status classification ────────────────────────────────────────────────────

const DONE_STATUSES = new Set([
    'CASCADE_RUN_STATUS_IDLE',
    'CASCADE_RUN_STATUS_DONE',
    'CASCADE_RUN_STATUS_COMPLETED',
    '',  // empty = idle (LS may return empty for idle cascades)
]);

const ERROR_STATUSES = new Set([
    'CASCADE_RUN_STATUS_ERROR',
    'CASCADE_RUN_STATUS_CANCELLED',
    'CASCADE_RUN_STATUS_FAILED',
]);

// ── Adaptive poll interval ───────────────────────────────────────────────────
// Fast at start (catch quick responses), slower over time (reduce load)

function getPollInterval(elapsedMs) {
    if (elapsedMs < 5000) return 500;    // first 5s: 500ms
    if (elapsedMs < 15000) return 1000;  // 5-15s: 1s
    if (elapsedMs < 30000) return 2000;  // 15-30s: 2s
    return 3000;                          // 30s+: 3s
}

/**
 * Poll cascade until agent finishes, then extract complete response text.
 *
 * @param {string} cascadeId
 * @param {object} opts
 * @param {object} opts.inst          - LS instance { port, csrfToken, useTls }
 * @param {number} opts.fromStepIndex - scan from this index + 1 (default: -1)
 * @param {number} [opts.timeoutMs]   - max wait (default: 120000)
 * @param {function} [opts.log]       - (type, msg) logging callback
 * @param {function} [opts.shouldAbort] - () => bool, cancel early
 * @returns {Promise<{text:string|null, stepIndex:number, stepCount:number, stepType:string|null}>}
 */
async function waitAndExtractResponse(cascadeId, opts = {}) {
    const {
        inst = null,
        fromStepIndex = -1,
        timeoutMs = 1800000, // 30 minutes
        log = () => { },
        shouldAbort = () => false,
    } = opts;

    const callApiForCascade = (method, body = {}) => callApi(method, body, inst);
    const sid = cascadeId ? cascadeId.substring(0, 8) : '--------';
    const start = Date.now();
    let consecutiveErrors = 0;
    const MAX_CONSECUTIVE_ERRORS = 10; // likely CSRF expired or LS down

    while (Date.now() - start < timeoutMs) {
        if (shouldAbort()) {
            log('system', `[relay] Aborted for ${sid}`);
            return noResult(0);
        }

        // Poll cascade status
        let status = '', stepCount = 0;
        try {
            const info = await getStepCountAndStatus(cascadeId, callApiForCascade);
            status = info.status || '';
            stepCount = info.stepCount || 0;
            consecutiveErrors = 0; // reset on success
        } catch (e) {
            consecutiveErrors++;
            log('system', `[relay] Status poll error for ${sid} (${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS}): ${e.message}`);
            if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
                log('error', `[relay] Too many consecutive errors for ${sid} — aborting (CSRF expired or LS down?)`);
                return noResult(0);
            }
            await sleep(getPollInterval(Date.now() - start));
            continue;
        }

        // Check for error/cancelled status — abort immediately
        if (ERROR_STATUSES.has(status)) {
            log('system', `[relay] Cascade ${sid} is ${status} — attempting final scan`);
            // Try to extract any last response before the error
            const result = await fetchAndScan(cascadeId, fromStepIndex, inst, log);
            if (result.text) return result;
            log('system', `[relay] No response found in errored cascade ${sid}`);
            return noResult(stepCount);
        }

        // Check if cascade is done (not RUNNING or WAITING)
        if (DONE_STATUSES.has(status) && stepCount > 0) {
            log('system', `[relay] ${sid} is ${status || 'IDLE'} (${stepCount} steps) — scanning for response`);

            const result = await fetchAndScan(cascadeId, fromStepIndex, inst, log);

            if (result.text) {
                log('system', `[relay] ✓ Found response at step ${result.stepIndex} (${result.stepType}): "${result.text.substring(0, 80)}..."`);
                return result;
            }

            // No content found — likely intermediate IDLE (between thinking + tool execution)
            // Keep polling, cascade may go back to RUNNING
            log('system', `[relay] No content yet in ${sid} — intermediate IDLE, keep polling`);
        }

        await sleep(getPollInterval(Date.now() - start));
    }

    // Timeout
    log('system', `[relay] Timeout (${timeoutMs / 1000}s) for ${sid}`);
    return noResult(0);
}

// ── Internal: Fetch steps + scan for response ────────────────────────────────

async function fetchAndScan(cascadeId, fromStepIndex, inst, log) {
    const callApiForCascade = (method, body = {}) => callApi(method, body, inst);
    const sid = cascadeId.substring(0, 8);

    // Ensure cache exists (for new cascades not yet polled)
    let cache = stepCache[cascadeId];
    if (!cache || !cache.steps) {
        log('system', `[relay] No cache for ${sid} — fetching via ensureCached`);
        await ensureCached(cascadeId, inst);
        cache = stepCache[cascadeId];
        if (!cache || !cache.steps) return noResult(0);
    }

    // Get real step count from API (cache may be stale)
    let realStepCount = cache.steps.length;
    try {
        const info = await getStepCountAndStatus(cascadeId, callApiForCascade);
        realStepCount = Math.max(info.stepCount || 0, cache.steps.length);
    } catch { }

    // Expand cache if server has more steps
    while (cache.steps.length < realStepCount) cache.steps.push(null);
    cache.stepCount = realStepCount;

    // Fetch tail steps (last 10)
    const TAIL = 10;
    const fetchFrom = Math.max(0, realStepCount - TAIL);
    try {
        const fresh = await callApiForCascade('GetCascadeTrajectorySteps', {
            cascadeId,
            startIndex: fetchFrom,
            endIndex: realStepCount,
        });
        if (fresh?.steps) {
            const expectedRange = realStepCount - fetchFrom;
            const apiStartedAt = detectApiStartIndex(fresh.steps.length, expectedRange, fetchFrom);
            fresh.steps.forEach((s, i) => {
                const idx = apiStartedAt + i;
                if (idx < cache.steps.length) cache.steps[idx] = s;
            });
            log('system', `[relay] Refreshed ${fresh.steps.length} tail steps for ${sid} (range ${fetchFrom}-${realStepCount})`);
        }
    } catch (e) {
        log('system', `[relay] Tail fetch failed for ${sid}: ${e.message}`);
    }

    // Scan FORWARD from fromStepIndex+1 for response WITH content
    for (let i = fromStepIndex + 1; i < cache.steps.length; i++) {
        const s = cache.steps[i];
        if (!s) continue;

        // NOTIFY_USER — always user-visible
        if (s.type === 'CORTEX_STEP_TYPE_NOTIFY_USER' && s.notifyUser) {
            const text = extractContent(s);
            if (text) return { text, stepIndex: i, stepCount: realStepCount, stepType: s.type };
        }

        // PLANNER_RESPONSE — skip thinking steps (have toolCalls = agent planning, not responding)
        if (s.type === 'CORTEX_STEP_TYPE_PLANNER_RESPONSE' && s.plannerResponse) {
            // Case 40: if step has toolCalls, it's a thinking/planning step → skip
            if (s.plannerResponse.toolCalls && s.plannerResponse.toolCalls.length > 0) continue;

            const text = extractContent(s);
            if (text) return { text, stepIndex: i, stepCount: realStepCount, stepType: s.type };
            // No content → continue scanning
        }
    }

    log('system', `[relay] No response step found in ${sid} (${cache.steps.length} steps, scanning from ${fromStepIndex + 1})`);
    return noResult(realStepCount);
}

// ── Content Extraction ───────────────────────────────────────────────────────

function extractContent(step) {
    if (!step) return null;
    const raw =
        // NOTIFY_USER
        step.notifyUser?.notificationContent
        || step.notifyUser?.message
        || step.notifyUser?.text
        || step.notifyUser?.content
        // PLANNER_RESPONSE — modifiedResponse = full, response = short summary
        || step.plannerResponse?.modifiedResponse
        || step.plannerResponse?.response
        || step.plannerResponse?.content?.[0]?.text
        || step.plannerResponse?.text
        || step.plannerResponse?.message
        || step.plannerResponse?.rawText
        || (Array.isArray(step.plannerResponse?.content)
            && step.plannerResponse.content.map(c => c?.text || c?.parts?.[0]?.text || '').join('').trim() || null)
        // Generic fallbacks
        || step.response?.message
        || step.response?.text
        || step.message
        || step.text
        || step.content
        || null;

    // Case 48: check for empty/whitespace-only
    if (raw && typeof raw === 'string' && raw.trim().length > 0) return raw;

    // Deep-scan fallback
    const obj = step.plannerResponse || step.notifyUser;
    if (obj) {
        const deepText = findDeepText(obj);
        if (deepText && deepText.trim().length > 0) return deepText;
    }

    return null;
}

// Recursively find the longest string value in an object
function findDeepText(obj, depth = 0) {
    if (depth > 5) return null;
    if (typeof obj === 'string' && obj.trim().length > 10) return obj;
    if (Array.isArray(obj)) {
        for (const item of obj) {
            const found = findDeepText(item, depth + 1);
            if (found) return found;
        }
    } else if (obj && typeof obj === 'object') {
        const skipKeys = new Set(['type', 'status', 'metadata', 'stopReason', 'trajectoryId', 'toolCalls']);
        let longest = null;
        for (const [key, val] of Object.entries(obj)) {
            if (skipKeys.has(key)) continue;
            const found = findDeepText(val, depth + 1);
            if (found && (!longest || found.length > longest.length)) longest = found;
        }
        return longest;
    }
    return null;
}

// ── Utils ────────────────────────────────────────────────────────────────────

function noResult(stepCount) {
    return { text: null, stepIndex: -1, stepCount, stepType: null };
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

module.exports = { waitAndExtractResponse, extractContent };
