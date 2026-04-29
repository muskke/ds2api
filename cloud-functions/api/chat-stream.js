'use strict';

import { setCorsHeaders as setCorsHeadersCore } from '../../internal/js/chat-stream/cors.js';
import {
  writeOpenAIError,
  openAIErrorType,
} from '../../internal/js/chat-stream/error_shape.js';
import {
  readRawBody,
  fetchStreamPrepare,
  fetchStreamPow,
  relayPreparedFailure,
  createLeaseReleaser,
  isAbortError,
  asString,
} from '../../internal/js/chat-stream/http_internal.js';
import {
  parseChunkForContent,
  isCitation,
} from '../../internal/js/chat-stream/sse_parse.js';
import {
  resolveToolcallPolicy,
  formatIncrementalToolCallDeltas,
  filterIncrementalToolCallDeltasByAllowed,
  boolDefaultTrue,
  resetStreamToolCallState,
} from '../../internal/js/chat-stream/toolcall_policy.js';
import { buildUsage } from '../../internal/js/chat-stream/token_usage.js';
import {
  createToolSieveState,
  processToolSieveChunk,
  flushToolSieve,
  parseStandaloneToolCalls,
  formatOpenAIStreamToolCalls,
} from '../../internal/js/helpers/stream-tool-sieve.js';
import { trimContinuationOverlap } from '../../internal/js/chat-stream/dedupe.js';

const DEEPSEEK_COMPLETION_URL = 'https://chat.deepseek.com/api/v0/chat/completion';
const DEEPSEEK_CONTINUE_URL = 'https://chat.deepseek.com/api/v0/chat/continue';
const EMPTY_OUTPUT_RETRY_SUFFIX = 'Previous reply had no visible output. Please regenerate the visible final answer or tool call now.';
const EMPTY_OUTPUT_RETRY_MAX_ATTEMPTS = 1;
const AUTO_CONTINUE_MAX_ROUNDS = 8;

/**
 * EdgeOne Pages Function entry for streaming chat completions.
 * Called when a POST request hits /v1/chat/completions via edgeone.json rewrite.
 */
export async function onRequestPost(context) {
  const { request, env } = context;
  const method = request.method;

  // Handle CORS pre-flight
  if (method === 'OPTIONS') {
    return createCorsResponse();
  }
  if (method !== 'POST') {
    return createErrorResponse(405, 'method not allowed');
  }

  // Read the raw body (keep as Buffer for compatibility with existing pipeline)
  const rawBody = Buffer.from(await request.arrayBuffer());

  let payload;
  try {
    payload = JSON.parse(rawBody.toString('utf8') || '{}');
  } catch (_err) {
    return createErrorResponse(400, 'invalid json');
  }

  if (!payload.stream) {
    // Non-streaming – shouldn't happen due to routing, but fall back to Go
    return proxyToGoFallback(request, rawBody, env);
  }

  // ----------------------------------------------------------------
  //  Prepare phase: call the Go Cloud Function to obtain session info
  // ----------------------------------------------------------------
  // In EdgeOne, Go Cloud Function is accessed at the deployment host
  const goBackendUrl = env.DS2API_BACKEND_URL;
  if (!goBackendUrl) {
    console.error('[edgeone-stream] DS2API_BACKEND_URL not set');
    return createErrorResponse(500, 'Internal configuration error');
  }

  const prep = await prepareStream(goBackendUrl, request, rawBody, env);
  if (!prep.ok) {
    return handlePrepareFailure(prep);
  }

  // Extract required fields
  const model = asString(prep.body.model) || asString(payload.model);
  const sessionID = asString(prep.body.session_id) || `chatcmpl-${Date.now()}`;
  const leaseID = asString(prep.body.lease_id);
  const deepseekToken = asString(prep.body.deepseek_token);
  const initialPowHeader = asString(prep.body.pow_header);
  const completionPayload = prep.body.payload && typeof prep.body.payload === 'object' ? prep.body.payload : null;
  const finalPrompt = asString(prep.body.final_prompt);
  const thinkingEnabled = toBool(prep.body.thinking_enabled);
  const searchEnabled = toBool(prep.body.search_enabled);
  const toolPolicy = resolveToolcallPolicy(prep.body, payload.tools);
  const toolNames = toolPolicy.toolNames;
  const emitEarlyToolDeltas = toolPolicy.emitEarlyToolDeltas;
  const stripReferenceMarkers = boolDefaultTrue(prep.body.compat && prep.body.compat.strip_reference_markers);

  if (!model || !leaseID || !deepseekToken || !initialPowHeader || !completionPayload) {
    return createErrorResponse(500, 'invalid vercel prepare response');
  }

  // ----------------------------------------------------------------
  //  Set up streaming infrastructure
  // ----------------------------------------------------------------
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  let clientClosed = false;
  let reader = null; // used for cancellation

  const upstreamController = new AbortController();
  const releaseLease = createLeaseReleaserUsingEnv(goBackendUrl, request, leaseID, env);

  const markClientClosed = () => {
    if (clientClosed) return;
    clientClosed = true;
    upstreamController.abort();
    if (reader && typeof reader.cancel === 'function') {
      Promise.resolve(reader.cancel()).catch(() => {});
    }
    writer.close().catch(() => {});
  };

  // Detect client disconnect via abort controller signal
  if (request.signal) {
    request.signal.addEventListener('abort', () => {
      markClientClosed();
    }, { once: true });
  }

  // ----------------------------------------------------------------
  //  Start the streaming process in the background
  // ----------------------------------------------------------------
  (async () => {
    try {
      await runStreamLoop({
        model,
        sessionID,
        leaseID,
        deepseekToken,
        initialPowHeader,
        completionPayload,
        finalPrompt,
        thinkingEnabled,
        searchEnabled,
        toolNames,
        emitEarlyToolDeltas,
        stripReferenceMarkers,
        toolPolicy,
        goBackendUrl,
        request,
        env,
        writer,
        encoder,
        clientClosed: () => clientClosed,
        upstreamController,
        releaseLease,
        readerRef: (r) => { reader = r; },
      });
    } catch (err) {
      console.error('[edgeone-stream] unexpected error:', err);
      markClientClosed();
    }
  })();

  // ----------------------------------------------------------------
  //  Return the streaming response
  // ----------------------------------------------------------------
  return new Response(readable, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}

// ----------------------------------------------------------------
//  Helpers
// ----------------------------------------------------------------

function createErrorResponse(status, message) {
  return new Response(JSON.stringify({
    error: {
      message,
      type: openAIErrorType(status),
    },
  }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function createCorsResponse() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, PUT, DELETE',
      'Access-Control-Max-Age': '600',
    },
  });
}

async function prepareStream(goBackendUrl, request, rawBody, env) {
  const targetUrl = new URL(goBackendUrl + '/v1/chat/completions');
  targetUrl.searchParams.set('__go', '1');
  targetUrl.searchParams.set('__stream_prepare', '1');

  const headers = new Headers({
    authorization: request.headers.get('authorization') || '',
    'x-api-key': request.headers.get('x-api-key') || '',
    'x-ds2-target-account': request.headers.get('x-ds2-target-account') || '',
    'content-type': request.headers.get('content-type') || 'application/json',
  });
  const internalToken = asString(env.DS2API_ADMIN_KEY) || 'admin';
  headers.set('x-ds2-internal-token', internalToken);

  const resp = await fetch(targetUrl.toString(), {
    method: 'POST',
    headers,
    body: rawBody,
  });

  const text = await resp.text();
  let body = {};
  try {
    body = JSON.parse(text || '{}');
  } catch (_) {
    body = {};
  }

  return {
    ok: resp.ok,
    status: resp.status,
    contentType: resp.headers.get('content-type') || 'application/json',
    text,
    body,
  };
}

function handlePrepareFailure(prep) {
  // Simplified error handling – no Vercel-specific auth page detection
  return new Response(prep.text || 'Prepare failed', {
    status: prep.status || 500,
    headers: { 'Content-Type': prep.contentType || 'application/json' },
  });
}

function createLeaseReleaserUsingEnv(goBackendUrl, request, leaseID, env) {
  let released = false;
  return async () => {
    if (released || !leaseID) return;
    released = true;
    try {
      const targetUrl = new URL(goBackendUrl + '/v1/chat/completions');
      targetUrl.searchParams.set('__go', '1');
      targetUrl.searchParams.set('__stream_release', '1');

      const headers = new Headers({
        authorization: request.headers.get('authorization') || '',
        'x-ds2-target-account': request.headers.get('x-ds2-target-account') || '',
        'content-type': 'application/json',
      });
      const internalToken = asString(env.DS2API_ADMIN_KEY) || 'admin';
      headers.set('x-ds2-internal-token', internalToken);

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 1500);
      try {
        await fetch(targetUrl.toString(), {
          method: 'POST',
          headers,
          body: JSON.stringify({ lease_id: leaseID }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeout);
      }
    } catch (_err) {
      // Ignore release errors
    }
  };
}

async function fetchPow(goBackendUrl, request, leaseID, env) {
  try {
    const targetUrl = new URL(goBackendUrl + '/v1/chat/completions');
    targetUrl.searchParams.set('__go', '1');
    targetUrl.searchParams.set('__stream_pow', '1');

    const headers = new Headers({
      authorization: request.headers.get('authorization') || '',
      'x-ds2-target-account': request.headers.get('x-ds2-target-account') || '',
      'content-type': 'application/json',
    });
    const internalToken = asString(env.DS2API_ADMIN_KEY) || 'admin';
    headers.set('x-ds2-internal-token', internalToken);

    const resp = await fetch(targetUrl.toString(), {
      method: 'POST',
      headers,
      body: JSON.stringify({ lease_id: leaseID }),
    });
    const text = await resp.text();
    let body = {};
    try {
      body = JSON.parse(text || '{}');
    } catch (_) {
      body = {};
    }
    return {
      ok: resp.ok,
      status: resp.status,
      text,
      body,
    };
  } catch (err) {
    return { ok: false, status: 0, text: '', body: {} };
  }
}

async function runStreamLoop({
  model,
  sessionID,
  leaseID,
  deepseekToken,
  initialPowHeader,
  completionPayload,
  finalPrompt,
  thinkingEnabled,
  searchEnabled,
  toolNames,
  emitEarlyToolDeltas,
  stripReferenceMarkers,
  toolPolicy,
  goBackendUrl,
  request,
  env,
  writer,
  encoder,
  clientClosed,
  upstreamController,
  releaseLease,
  readerRef,
}) {
  const sendSSE = (data) => {
    if (clientClosed()) return;
    writer.write(encoder.encode(`data: ${JSON.stringify(data)}\n\n`)).catch(() => {});
  };

  const sendFrame = (obj) => {
    if (clientClosed()) return;
    writer.write(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`)).catch(() => {});
  };

  let firstChunkSent = false;
  const sendDeltaFrame = (delta) => {
    if (clientClosed()) return;
    const payloadDelta = { ...delta };
    if (!firstChunkSent) {
      payloadDelta.role = 'assistant';
      firstChunkSent = true;
    }
    sendFrame({
      id: sessionID,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ delta: payloadDelta, index: 0 }],
    });
  };

  const created = Math.floor(Date.now() / 1000);
  let currentType = thinkingEnabled ? 'thinking' : 'text';
  let thinkingText = '';
  let outputText = '';
  let usagePrompt = finalPrompt;
  const toolSieveEnabled = toolPolicy.toolSieveEnabled;
  const toolSieveState = createToolSieveState();
  let toolCallsEmitted = false;
  let toolCallsDoneEmitted = false;
  const streamToolCallIDs = new Map();
  const streamToolNames = new Map();
  const decoder = new TextDecoder();
  let buffered = '';
  let ended = false;

  const finish = async (reason, options = {}) => {
    if (ended) return true;
    if (clientClosed()) {
      ended = true;
      await releaseLease();
      return true;
    }
    const detected = parseStandaloneToolCalls(outputText, toolNames);
    if (detected.length > 0 && !toolCallsDoneEmitted) {
      toolCallsEmitted = true;
      toolCallsDoneEmitted = true;
      sendDeltaFrame({ tool_calls: formatOpenAIStreamToolCalls(detected, streamToolCallIDs) });
    } else if (toolSieveEnabled) {
      const tailEvents = flushToolSieve(toolSieveState, toolNames);
      for (const evt of tailEvents) {
        if (evt.type === 'tool_calls' && Array.isArray(evt.calls) && evt.calls.length > 0) {
          toolCallsEmitted = true;
          toolCallsDoneEmitted = true;
          sendDeltaFrame({ tool_calls: formatOpenAIStreamToolCalls(evt.calls, streamToolCallIDs) });
          resetStreamToolCallState(streamToolCallIDs, streamToolNames);
          continue;
        }
        if (evt.text) {
          sendDeltaFrame({ content: evt.text });
        }
      }
    }
    if (detected.length > 0 || toolCallsEmitted) {
      reason = 'tool_calls';
    }
    if (detected.length === 0 && !toolCallsEmitted && outputText.trim() === '') {
      if (options.deferEmpty && reason !== 'content_filter') {
        return false;
      }
      ended = true;
      const detail = upstreamEmptyOutputDetail(reason === 'content_filter', outputText, thinkingText);
      sendFailedSSE(detail.status, detail.message, detail.code);
      await releaseLease();
      writer.close().catch(() => {});
      return true;
    }
    ended = true;
    sendFrame({
      id: sessionID,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ delta: {}, index: 0, finish_reason: reason }],
      usage: buildUsage(usagePrompt, thinkingText, outputText),
    });
    writer.write(encoder.encode('data: [DONE]\n\n')).catch(() => {});
    await releaseLease();
    writer.close().catch(() => {});
    return true;
  };

  const sendFailedSSE = (status, message, code) => {
    const payload = {
      status_code: status,
      error: {
        message,
        type: openAIErrorType(status),
        code,
        param: null,
      },
    };
    writer.write(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`)).catch(() => {});
    writer.write(encoder.encode('data: [DONE]\n\n')).catch(() => {});
  };

  let currentPowHeader = initialPowHeader;
  const refreshPowHeader = async (roundType) => {
    try {
      const pow = await fetchPow(goBackendUrl, request, leaseID, env);
      const nextPowHeader = asString(pow.body && pow.body.pow_header);
      if (pow.ok && nextPowHeader) {
        currentPowHeader = nextPowHeader;
        return currentPowHeader;
      }
      console.warn('[edgeone-stream-pow] refresh failed, reusing previous PoW', {
        round_type: roundType,
        status: pow.status || 0,
      });
    } catch (err) {
      if (clientClosed() || isAbortError(err)) {
        return '';
      }
      console.warn('[edgeone-stream-pow] refresh failed, reusing previous PoW', {
        round_type: roundType,
        error: err,
      });
    }
    return currentPowHeader;
  };

  const fetchDeepSeekStream = async (url, bodyPayload, powHeader) => {
    try {
      return await fetch(url, {
        method: 'POST',
        headers: {
          Host: 'chat.deepseek.com',
          Accept: 'application/json',
          'Content-Type': 'application/json',
          authorization: `Bearer ${deepseekToken}`,
          'x-ds-pow-response': powHeader,
        },
        body: JSON.stringify(bodyPayload),
        signal: upstreamController.signal,
      });
    } catch (err) {
      if (clientClosed() || isAbortError(err)) {
        return null;
      }
      throw err;
    }
  };

  const fetchCompletion = (bodyPayload) => fetchDeepSeekStream(DEEPSEEK_COMPLETION_URL, bodyPayload, currentPowHeader);
  const fetchContinue = async (messageID) => {
    const powHeader = await refreshPowHeader('continue');
    if (!powHeader) {
      return null;
    }
    return fetchDeepSeekStream(DEEPSEEK_CONTINUE_URL, {
      chat_session_id: sessionID,
      message_id: messageID,
      fallback_to_resume: true,
    }, powHeader);
  };

  // Main processing loop
  let retryAttempts = 0;
  let completionRes = await fetchCompletion(completionPayload);
  if (completionRes === null || clientClosed()) {
    await finish('stop');
    return;
  }
  if (!completionRes.ok || !completionRes.body) {
    const detail = completionRes.body ? await completionRes.text() : '';
    const status = completionRes.ok ? 500 : completionRes.status || 500;
    sendFailedSSE(status, detail, '');
    await releaseLease();
    writer.close().catch(() => {});
    return;
  }

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const processed = await processSingleStream({
      initialResponse: completionRes,
      allowDeferEmpty: retryAttempts < EMPTY_OUTPUT_RETRY_MAX_ATTEMPTS,
      sessionID,
      thinkingEnabled,
      currentType,
      thinkingText,
      outputText,
      toolSieveEnabled,
      toolSieveState,
      toolNames,
      emitEarlyToolDeltas,
      stripReferenceMarkers,
      streamToolCallIDs,
      streamToolNames,
      decoder,
      clientClosed,
      sendFrame,
      sendDeltaFrame,
      fetchContinue,
      finish,
      readerRef,
    });

    if (processed.terminal) {
      return;
    }
    if (!processed.retryable || retryAttempts >= EMPTY_OUTPUT_RETRY_MAX_ATTEMPTS) {
      await finish('stop');
      return;
    }
    retryAttempts += 1;
    console.info('[openai_empty_retry] attempting synthetic retry', {
      surface: 'chat.completions',
      stream: true,
      retry_attempt: retryAttempts,
      parent_message_id: processed.responseMessageID || 0,
    });
    currentPowHeader = await refreshPowHeader('retry');
    if (!currentPowHeader) {
      await finish('stop');
      return;
    }
    completionRes = await fetchDeepSeekStream(
      DEEPSEEK_COMPLETION_URL,
      clonePayloadForEmptyOutputRetry(completionPayload, processed.responseMessageID),
      currentPowHeader,
    );
    if (completionRes === null || clientClosed()) {
      await finish('stop');
      return;
    }
    if (!completionRes.ok || !completionRes.body) {
      await finish('stop');
      return;
    }
  }
}

function clonePayloadForEmptyOutputRetry(payload, parentMessageID) {
  const clone = {
    ...(payload || {}),
    prompt: appendEmptyOutputRetrySuffix(asString(payload && payload.prompt)),
  };
  if (parentMessageID && parentMessageID > 0) {
    clone.parent_message_id = parentMessageID;
  }
  return clone;
}

function appendEmptyOutputRetrySuffix(prompt) {
  const base = asString(prompt).trimEnd();
  if (!base) {
    return EMPTY_OUTPUT_RETRY_SUFFIX;
  }
  return `${base}\n\n${EMPTY_OUTPUT_RETRY_SUFFIX}`;
}

function upstreamEmptyOutputDetail(contentFilter, _text, thinking) {
  if (contentFilter) {
    return {
      status: 400,
      message: 'Upstream content filtered the response and returned no output.',
      code: 'content_filter',
    };
  }
  if (thinking !== '') {
    return {
      status: 429,
      message: 'Upstream account hit a rate limit and returned reasoning without visible output.',
      code: 'upstream_empty_output',
    };
  }
  return {
    status: 429,
    message: 'Upstream account hit a rate limit and returned empty output.',
    code: 'upstream_empty_output',
  };
}

function toBool(v) {
  return v === true;
}

function createContinueState(sessionID) {
  return {
    sessionID: asString(sessionID),
    responseMessageID: 0,
    lastStatus: '',
    finished: false,
  };
}

function prepareContinueStateForNextRound(state) {
  return {
    ...state,
    lastStatus: '',
    finished: false,
  };
}

function observeContinueState(state, chunk) {
  if (!state || !chunk || typeof chunk !== 'object') return;
  const topID = numberValue(chunk.response_message_id);
  if (topID > 0) state.responseMessageID = topID;
  if (chunk.p === 'response/status') {
    setContinueStatus(state, asString(chunk.v));
  }
  const response = chunk.v && typeof chunk.v === 'object' ? chunk.v.response : null;
  if (response && typeof response === 'object') {
    const id = numberValue(response.message_id);
    if (id > 0) state.responseMessageID = id;
    setContinueStatus(state, asString(response.status));
    if (response.auto_continue === true) {
      state.lastStatus = 'AUTO_CONTINUE';
    }
  }
  const messageResponse = chunk.message && typeof chunk.message === 'object' && chunk.message.response;
  if (messageResponse && typeof messageResponse === 'object') {
    const id = numberValue(messageResponse.message_id);
    if (id > 0) state.responseMessageID = id;
    setContinueStatus(state, asString(messageResponse.status));
  }
}

function setContinueStatus(state, status) {
  const normalized = asString(status).trim();
  if (!normalized) return;
  state.lastStatus = normalized;
  if (normalized.toUpperCase() === 'FINISHED') {
    state.finished = true;
  }
}

function shouldAutoContinue(state) {
  if (!state || state.finished || !state.sessionID || state.responseMessageID <= 0) return false;
  return ['WIP', 'INCOMPLETE', 'AUTO_CONTINUE'].includes(asString(state.lastStatus).trim().toUpperCase());
}

function numberValue(v) {
  if (typeof v === 'number' && Number.isFinite(v)) {
    return Math.trunc(v);
  }
  const parsed = Number.parseInt(asString(v), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function processSingleStream({
  initialResponse,
  allowDeferEmpty,
  sessionID,
  thinkingEnabled,
  currentType: startType,
  thinkingText: startThinkingText,
  outputText: startOutputText,
  toolSieveEnabled,
  toolSieveState,
  toolNames,
  emitEarlyToolDeltas,
  stripReferenceMarkers,
  streamToolCallIDs,
  streamToolNames,
  decoder,
  clientClosed,
  sendFrame,
  sendDeltaFrame,
  fetchContinue,
  finish,
  readerRef,
}) {
  const handleResponse = async (response) => {
    const reader = response.body.getReader();
    readerRef(reader);
    let buffered = '';
    let currentType = startType;
    let thinkingText = startThinkingText;
    let outputText = startOutputText;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (clientClosed()) {
        await finish('stop');
        return { terminal: true, retryable: false };
      }
      const { value, done } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      const lines = buffered.split('\n');
      buffered = lines.pop() || '';

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line.startsWith('data:')) continue;
        const dataStr = line.slice(5).trim();
        if (!dataStr) continue;
        if (dataStr === '[DONE]') {
          // End of stream
          continue; // handled in outer loop
        }
        let chunk;
        try {
          chunk = JSON.parse(dataStr);
        } catch (_) { continue; }
        observeContinueState(continueState, chunk);
        const parsed = parseChunkForContent(chunk, thinkingEnabled, currentType, stripReferenceMarkers);
        if (!parsed.parsed) continue;
        currentType = parsed.newType;
        if (parsed.errorMessage) {
          return { terminal: await finish('content_filter'), retryable: false };
        }
        if (parsed.contentFilter) {
          return { terminal: await finish(outputText.trim() === '' ? 'content_filter' : 'stop'), retryable: false };
        }
        if (parsed.finished) {
          // Will break out of inner loop after processing parts
        }
        for (const p of parsed.parts) {
          if (!p.text) continue;
          if (p.type === 'thinking') {
            if (thinkingEnabled) {
              const trimmed = trimContinuationOverlap(thinkingText, p.text);
              if (!trimmed) continue;
              thinkingText += trimmed;
              sendDeltaFrame({ reasoning_content: trimmed });
            }
          } else {
            const trimmed = trimContinuationOverlap(outputText, p.text);
            if (!trimmed) continue;
            if (searchEnabled && isCitation(trimmed)) continue;
            outputText += trimmed;
            if (!toolSieveEnabled) {
              sendDeltaFrame({ content: trimmed });
              continue;
            }
            const events = processToolSieveChunk(toolSieveState, trimmed, toolNames);
            for (const evt of events) {
              if (evt.type === 'tool_call_deltas') {
                if (!emitEarlyToolDeltas) continue;
                const filtered = filterIncrementalToolCallDeltasByAllowed(evt.deltas, toolNames, streamToolNames);
                const formatted = formatIncrementalToolCallDeltas(filtered, streamToolCallIDs);
                if (formatted.length > 0) {
                  toolCallsEmitted = true;
                  sendDeltaFrame({ tool_calls: formatted });
                }
                continue;
              }
              if (evt.type === 'tool_calls') {
                toolCallsEmitted = true;
                toolCallsDoneEmitted = true;
                sendDeltaFrame({ tool_calls: formatOpenAIStreamToolCalls(evt.calls, streamToolCallIDs) });
                resetStreamToolCallState(streamToolCallIDs, streamToolNames);
                continue;
              }
              if (evt.text) {
                sendDeltaFrame({ content: evt.text });
              }
            }
          }
        }
        if (parsed.finished) {
          break;
        }
      }
    }
    return { terminal: false, retryable: true };
  };

  let currentResponse = initialResponse;
  let continueState = createContinueState(sessionID);
  let continueRounds = 0;

  const heartbeatTimer = setInterval(() => {
    if (clientClosed()) {
      clearInterval(heartbeatTimer);
      return;
    }
    writer.write(encoder.encode(': heartbeat\n\n')).catch(() => {});
  }, 15000);

  try {
    while (true) {
      if (clientClosed()) {
        await finish('stop');
        return { terminal: true, retryable: false };
      }
      const result = await handleResponse(currentResponse);
      if (result.terminal) {
        return result;
      }
      if (shouldAutoContinue(continueState) && continueRounds < AUTO_CONTINUE_MAX_ROUNDS) {
        continueRounds += 1;
        const nextRes = await fetchContinue(continueState.responseMessageID);
        if (nextRes === null) {
          return { terminal: true, retryable: false };
        }
        if (!nextRes.ok || !nextRes.body) {
          return { terminal: await finish('stop'), retryable: false };
        }
        continueState = prepareContinueStateForNextRound(continueState);
        currentResponse = nextRes;
        continue;
      }
      break;
    }
  } finally {
    clearInterval(heartbeatTimer);
  }

  const terminal = await finish('stop', { deferEmpty: allowDeferEmpty });
  return { terminal, retryable: !terminal && allowDeferEmpty, responseMessageID: continueState.responseMessageID };
}

function isEdgeOneRuntime() {
  return asString(process.env.EDGEONE_RUNTIME) !== '' || asString(process.env.EDGEONE) !== '';
}

async function proxyToGoFallback(request, rawBody, env) {
  const goBackendUrl = env.DS2API_BACKEND_URL;
  if (!goBackendUrl) {
    return createErrorResponse(500, 'Internal configuration error');
  }
  const targetUrl = new URL(goBackendUrl + request.url.slice(request.url.indexOf('/', 8)));
  const headers = new Headers(request.headers);
  headers.set('x-ds2-internal-token', asString(env.DS2API_ADMIN_KEY) || 'admin');
  try {
    const resp = await fetch(targetUrl.toString(), {
      method: request.method,
      headers,
      body: rawBody,
    });
    return new Response(resp.body, {
      status: resp.status,
      headers: resp.headers,
    });
  } catch (err) {
    return createErrorResponse(502, 'Bad Gateway');
  }
}
