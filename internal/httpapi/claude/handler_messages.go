package claude

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"

	"ds2api/internal/config"
	streamengine "ds2api/internal/stream"
	"ds2api/internal/translatorcliproxy"
	"ds2api/internal/util"

	sdktranslator "github.com/router-for-me/CLIProxyAPI/v6/sdk/translator"
)

func (h *Handler) Messages(w http.ResponseWriter, r *http.Request) {
	if strings.TrimSpace(r.Header.Get("anthropic-version")) == "" {
		r.Header.Set("anthropic-version", "2023-06-01")
	}
	if h.OpenAI == nil {
		writeClaudeError(w, http.StatusInternalServerError, "OpenAI proxy backend unavailable.")
		return
	}
	if h.proxyViaOpenAI(w, r, h.Store) {
		return
	}
	writeClaudeError(w, http.StatusBadGateway, "Failed to proxy Claude request.")
}

func (h *Handler) proxyViaOpenAI(w http.ResponseWriter, r *http.Request, store ConfigReader) bool {
	raw, err := io.ReadAll(r.Body)
	if err != nil {
		writeClaudeError(w, http.StatusBadRequest, "invalid body")
		return true
	}
	var req map[string]any
	if err := json.Unmarshal(raw, &req); err != nil {
		writeClaudeError(w, http.StatusBadRequest, "invalid json")
		return true
	}
	model, _ := req["model"].(string)
	stream := util.ToBool(req["stream"])

	// Use the shared global model resolver so Claude/OpenAI/Gemini stay consistent.
	translateModel := model
	if store != nil {
		if norm, normErr := normalizeClaudeRequest(store, cloneMap(req)); normErr == nil && strings.TrimSpace(norm.Standard.ResolvedModel) != "" {
			translateModel = strings.TrimSpace(norm.Standard.ResolvedModel)
		}
	}
	translatedReq := translatorcliproxy.ToOpenAI(sdktranslator.FormatClaude, translateModel, raw, stream)
	translatedReq, exposeThinking := applyClaudeThinkingPolicyToOpenAIRequest(translatedReq, req, stream)

	isVercelPrepare := strings.TrimSpace(r.URL.Query().Get("__stream_prepare")) == "1"
	isVercelRelease := strings.TrimSpace(r.URL.Query().Get("__stream_release")) == "1"

	if isVercelRelease {
		proxyReq := r.Clone(r.Context())
		proxyReq.URL.Path = "/v1/chat/completions"
		proxyReq.Body = io.NopCloser(bytes.NewReader(raw))
		proxyReq.ContentLength = int64(len(raw))
		rec := httptest.NewRecorder()
		h.OpenAI.ChatCompletions(rec, proxyReq)
		res := rec.Result()
		defer func() { _ = res.Body.Close() }()
		body, _ := io.ReadAll(res.Body)
		for k, vv := range res.Header {
			for _, v := range vv {
				w.Header().Add(k, v)
			}
		}
		w.WriteHeader(res.StatusCode)
		_, _ = w.Write(body)
		return true
	}

	proxyReq := r.Clone(r.Context())
	proxyReq.URL.Path = "/v1/chat/completions"
	proxyReq.Body = io.NopCloser(bytes.NewReader(translatedReq))
	proxyReq.ContentLength = int64(len(translatedReq))

	if stream && !isVercelPrepare {
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache, no-transform")
		w.Header().Set("Connection", "keep-alive")
		w.Header().Set("X-Accel-Buffering", "no")
		streamWriter := translatorcliproxy.NewOpenAIStreamTranslatorWriter(w, sdktranslator.FormatClaude, model, raw, translatedReq)
		h.OpenAI.ChatCompletions(streamWriter, proxyReq)
		return true
	}

	rec := httptest.NewRecorder()
	h.OpenAI.ChatCompletions(rec, proxyReq)
	res := rec.Result()
	defer func() { _ = res.Body.Close() }()
	body, _ := io.ReadAll(res.Body)
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		for k, vv := range res.Header {
			for _, v := range vv {
				w.Header().Add(k, v)
			}
		}
		w.WriteHeader(res.StatusCode)
		_, _ = w.Write(body)
		return true
	}
	if isVercelPrepare {
		for k, vv := range res.Header {
			for _, v := range vv {
				w.Header().Add(k, v)
			}
		}
		w.WriteHeader(res.StatusCode)
		_, _ = w.Write(body)
		return true
	}
	converted := translatorcliproxy.FromOpenAINonStream(sdktranslator.FormatClaude, model, raw, translatedReq, body)
	if !exposeThinking {
		converted = stripClaudeThinkingBlocks(converted)
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(converted)
	return true
}

func applyClaudeThinkingPolicyToOpenAIRequest(translated []byte, original map[string]any, stream bool) ([]byte, bool) {
	req := map[string]any{}
	if err := json.Unmarshal(translated, &req); err != nil {
		return translated, false
	}
	enabled, ok := util.ResolveThinkingOverride(original)
	if !ok {
		if _, translatedHasOverride := util.ResolveThinkingOverride(req); translatedHasOverride {
			return translated, false
		}
		enabled = !stream
	}
	typ := "disabled"
	if enabled {
		typ = "enabled"
	}
	req["thinking"] = map[string]any{"type": typ}
	out, err := json.Marshal(req)
	if err != nil {
		return translated, ok && enabled
	}
	return out, ok && enabled
}

func stripClaudeThinkingBlocks(raw []byte) []byte {
	var payload map[string]any
	if err := json.Unmarshal(raw, &payload); err != nil {
		return raw
	}
	content, _ := payload["content"].([]any)
	if len(content) == 0 {
		return raw
	}
	filtered := make([]any, 0, len(content))
	for _, item := range content {
		block, _ := item.(map[string]any)
		blockType, _ := block["type"].(string)
		if strings.TrimSpace(blockType) == "thinking" {
			continue
		}
		filtered = append(filtered, item)
	}
	payload["content"] = filtered
	out, err := json.Marshal(payload)
	if err != nil {
		return raw
	}
	return out
}

func (h *Handler) handleClaudeStreamRealtime(w http.ResponseWriter, r *http.Request, resp *http.Response, model string, messages []any, thinkingEnabled, searchEnabled bool, toolNames []string, toolsRaw any) {
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		writeClaudeError(w, http.StatusInternalServerError, string(body))
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache, no-transform")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	rc := http.NewResponseController(w)
	_, canFlush := w.(http.Flusher)
	if !canFlush {
		config.Logger.Warn("[claude_stream] response writer does not support flush; streaming may be buffered")
	}

	streamRuntime := newClaudeStreamRuntime(
		w,
		rc,
		canFlush,
		model,
		messages,
		thinkingEnabled,
		searchEnabled,
		h.compatStripReferenceMarkers(),
		toolNames,
		toolsRaw,
	)
	streamRuntime.sendMessageStart()

	initialType := "text"
	if thinkingEnabled {
		initialType = "thinking"
	}
	streamengine.ConsumeSSE(streamengine.ConsumeConfig{
		Context:             r.Context(),
		Body:                resp.Body,
		ThinkingEnabled:     thinkingEnabled,
		InitialType:         initialType,
		KeepAliveInterval:   claudeStreamPingInterval,
		IdleTimeout:         claudeStreamIdleTimeout,
		MaxKeepAliveNoInput: claudeStreamMaxKeepaliveCnt,
	}, streamengine.ConsumeHooks{
		OnKeepAlive: func() {
			streamRuntime.sendPing()
		},
		OnParsed:   streamRuntime.onParsed,
		OnFinalize: streamRuntime.onFinalize,
	})
}
