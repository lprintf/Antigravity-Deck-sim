// === Cascade Submit: StartCascade + SendUserCascadeMessage ===
// Programmatically submit user input to Antigravity IDE
const { callApi, callApiStream } = require('./api');

// Create a new Cascade conversation
// inst: optional LS instance to route to (default: global lsConfig)
async function startCascade(inst = null) {
    const result = await callApi('StartCascade', {}, inst);
    return result.cascadeId;
}

// Send a user message to an existing Cascade conversation
// This is a server-streaming RPC — the connection stays open while the AI generates its response.
// options.media = array of { mimeType, inlineData, uri, thumbnail } (from SaveMediaAsArtifact flow)
async function sendMessage(cascadeId, text, options = {}) {
    const {
        modelId = 'MODEL_PLACEHOLDER_M26',
        timeoutMs = 120000,
        media = null,        // array of media objects (new multi-image approach)
        imageBase64 = null,  // legacy single-image (kept for backward compat)
    } = options;

    const items = [{ text }];

    // Check if auto-accept is enabled — new LS versions use autoExecutionPolicy
    // in the cascadeConfig to auto-execute commands without IDE approval UI.
    // Policy: 0=OFF (user confirms), 3=EAGER (auto-execute all)
    let autoExecPolicy = 0; // default: needs user approval
    try {
        const { getAutoAccept } = require('./auto-accept');
        if (getAutoAccept()) autoExecPolicy = 3; // EAGER
    } catch { }

    const body = {
        metadata: {},
        cascadeId,
        items,
        cascadeConfig: {
            plannerConfig: {
                plannerTypeConfig: {
                    case: 'conversational',
                    value: {}
                },
                planModel: modelId,
                requestedModel: { modelId },
                toolConfig: {
                    runCommand: {
                        autoCommandConfig: {
                            autoExecutionPolicy: autoExecPolicy,
                        }
                    }
                }
            }
        }
    };

    // Attach media[] at top level — matching the actual LS API spec
    if (media && media.length > 0) {
        body.media = media;
    } else if (imageBase64) {
        // Legacy fallback: wrap single image into media[] format
        body.media = [{
            mimeType: 'image/png',
            inlineData: imageBase64,
        }];
    }

    return callApiStream('SendUserCascadeMessage', body, timeoutMs, options.inst || null);
}

// Convenience: create a new conversation and send a message in one call
async function startAndSend(text, options = {}) {
    const inst = options.inst || null;
    const cascadeId = await startCascade(inst);
    console.log(`[Cascade] New conversation: ${cascadeId}`);
    const result = await sendMessage(cascadeId, text, { ...options, inst });
    return { cascadeId, result };
}

module.exports = { startCascade, sendMessage, startAndSend };
