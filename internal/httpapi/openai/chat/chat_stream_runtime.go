package chat

import (
	"encoding/json"
	"net/http"
	"strings"

	openaifmt "ds2api/internal/format/openai"
	"ds2api/internal/sse"
	streamengine "ds2api/internal/stream"
	"ds2api/internal/toolstream"
)

type chatStreamRuntime struct {
	w        http.ResponseWriter
	rc       *http.ResponseController
	canFlush bool

	completionID string
	created      int64
	model        string
	finalPrompt  string
	toolNames    []string
	toolsRaw     any

	thinkingEnabled       bool
	searchEnabled         bool
	stripReferenceMarkers bool

	firstChunkSent       bool
	bufferToolContent    bool
	emitEarlyToolDeltas  bool
	toolCallsEmitted     bool
	toolCallsDoneEmitted bool

	toolSieve             toolstream.State
	streamToolCallIDs     map[int]string
	streamToolNames       map[int]string
	rawThinking           strings.Builder
	thinking              strings.Builder
	toolDetectionThinking strings.Builder
	rawText               strings.Builder
	text                  strings.Builder
	responseMessageID     int

	finalThinking     string
	finalText         string
	finalFinishReason string
	finalUsage        map[string]any
	finalErrorStatus  int
	finalErrorMessage string
	finalErrorCode    string
}

func newChatStreamRuntime(
	w http.ResponseWriter,
	rc *http.ResponseController,
	canFlush bool,
	completionID string,
	created int64,
	model string,
	finalPrompt string,
	thinkingEnabled bool,
	searchEnabled bool,
	stripReferenceMarkers bool,
	toolNames []string,
	toolsRaw any,
	bufferToolContent bool,
	emitEarlyToolDeltas bool,
) *chatStreamRuntime {
	return &chatStreamRuntime{
		w:                     w,
		rc:                    rc,
		canFlush:              canFlush,
		completionID:          completionID,
		created:               created,
		model:                 model,
		finalPrompt:           finalPrompt,
		toolNames:             toolNames,
		toolsRaw:              toolsRaw,
		thinkingEnabled:       thinkingEnabled,
		searchEnabled:         searchEnabled,
		stripReferenceMarkers: stripReferenceMarkers,
		bufferToolContent:     bufferToolContent,
		emitEarlyToolDeltas:   emitEarlyToolDeltas,
		streamToolCallIDs:     map[int]string{},
		streamToolNames:       map[int]string{},
	}
}

func (s *chatStreamRuntime) sendKeepAlive() {
	if !s.canFlush {
		return
	}
	_, _ = s.w.Write([]byte(": keep-alive\n\n"))
	_ = s.rc.Flush()
}

func (s *chatStreamRuntime) sendChunk(v any) {
	b, _ := json.Marshal(v)
	_, _ = s.w.Write([]byte("data: "))
	_, _ = s.w.Write(b)
	_, _ = s.w.Write([]byte("\n\n"))
	if s.canFlush {
		_ = s.rc.Flush()
	}
}

func (s *chatStreamRuntime) sendDone() {
	_, _ = s.w.Write([]byte("data: [DONE]\n\n"))
	if s.canFlush {
		_ = s.rc.Flush()
	}
}

func (s *chatStreamRuntime) sendFailedChunk(status int, message, code string) {
	s.finalErrorStatus = status
	s.finalErrorMessage = message
	s.finalErrorCode = code
	s.sendChunk(map[string]any{
		"status_code": status,
		"error": map[string]any{
			"message": message,
			"type":    openAIErrorType(status),
			"code":    code,
			"param":   nil,
		},
	})
	s.sendDone()
}

func (s *chatStreamRuntime) resetStreamToolCallState() {
	s.streamToolCallIDs = map[int]string{}
	s.streamToolNames = map[int]string{}
}

func (s *chatStreamRuntime) finalize(finishReason string, deferEmptyOutput bool) bool {
	s.finalErrorStatus = 0
	s.finalErrorMessage = ""
	s.finalErrorCode = ""
	finalThinking := s.thinking.String()
	finalToolDetectionThinking := s.toolDetectionThinking.String()
	finalText := cleanVisibleOutput(s.text.String(), s.stripReferenceMarkers)
	s.finalThinking = finalThinking
	s.finalText = finalText
	detected := detectAssistantToolCalls(s.rawText.String(), finalText, s.rawThinking.String(), finalToolDetectionThinking, s.toolNames)
	if len(detected.Calls) > 0 && !s.toolCallsDoneEmitted {
		finishReason = "tool_calls"
		delta := map[string]any{
			"tool_calls": formatFinalStreamToolCallsWithStableIDs(detected.Calls, s.streamToolCallIDs, s.toolsRaw),
		}
		if !s.firstChunkSent {
			delta["role"] = "assistant"
			s.firstChunkSent = true
		}
		s.sendChunk(openaifmt.BuildChatStreamChunk(
			s.completionID,
			s.created,
			s.model,
			[]map[string]any{openaifmt.BuildChatStreamDeltaChoice(0, delta)},
			nil,
		))
		s.toolCallsEmitted = true
		s.toolCallsDoneEmitted = true
	} else if s.bufferToolContent {
		for _, evt := range toolstream.Flush(&s.toolSieve, s.toolNames) {
			if len(evt.ToolCalls) > 0 {
				finishReason = "tool_calls"
				s.toolCallsEmitted = true
				s.toolCallsDoneEmitted = true
				tcDelta := map[string]any{
					"tool_calls": formatFinalStreamToolCallsWithStableIDs(evt.ToolCalls, s.streamToolCallIDs, s.toolsRaw),
				}
				if !s.firstChunkSent {
					tcDelta["role"] = "assistant"
					s.firstChunkSent = true
				}
				s.sendChunk(openaifmt.BuildChatStreamChunk(
					s.completionID,
					s.created,
					s.model,
					[]map[string]any{openaifmt.BuildChatStreamDeltaChoice(0, tcDelta)},
					nil,
				))
				s.resetStreamToolCallState()
			}
			if evt.Content == "" {
				continue
			}
			cleaned := cleanVisibleOutput(evt.Content, s.stripReferenceMarkers)
			if cleaned == "" || (s.searchEnabled && sse.IsCitation(cleaned)) {
				continue
			}
			delta := map[string]any{
				"content": cleaned,
			}
			if !s.firstChunkSent {
				delta["role"] = "assistant"
				s.firstChunkSent = true
			}
			s.sendChunk(openaifmt.BuildChatStreamChunk(
				s.completionID,
				s.created,
				s.model,
				[]map[string]any{openaifmt.BuildChatStreamDeltaChoice(0, delta)},
				nil,
			))
		}
	}

	if len(detected.Calls) > 0 || s.toolCallsEmitted {
		finishReason = "tool_calls"
	}
	if len(detected.Calls) == 0 && !s.toolCallsEmitted && strings.TrimSpace(finalText) == "" {
		status, message, code := upstreamEmptyOutputDetail(finishReason == "content_filter", finalText, finalThinking)
		if deferEmptyOutput {
			s.finalErrorStatus = status
			s.finalErrorMessage = message
			s.finalErrorCode = code
			return false
		}
		s.sendFailedChunk(status, message, code)
		return true
	}
	usage := openaifmt.BuildChatUsage(s.finalPrompt, finalThinking, finalText)
	s.finalFinishReason = finishReason
	s.finalUsage = usage
	s.sendChunk(openaifmt.BuildChatStreamChunk(
		s.completionID,
		s.created,
		s.model,
		[]map[string]any{openaifmt.BuildChatStreamFinishChoice(0, finishReason)},
		usage,
	))
	s.sendDone()
	return true
}

func (s *chatStreamRuntime) onParsed(parsed sse.LineResult) streamengine.ParsedDecision {
	if !parsed.Parsed {
		return streamengine.ParsedDecision{}
	}
	if parsed.ResponseMessageID > 0 {
		s.responseMessageID = parsed.ResponseMessageID
	}
	if parsed.ContentFilter {
		if strings.TrimSpace(s.text.String()) == "" {
			return streamengine.ParsedDecision{Stop: true, StopReason: streamengine.StopReason("content_filter")}
		}
		return streamengine.ParsedDecision{Stop: true, StopReason: streamengine.StopReasonHandlerRequested}
	}
	if parsed.ErrorMessage != "" {
		return streamengine.ParsedDecision{Stop: true, StopReason: streamengine.StopReason("content_filter")}
	}
	if parsed.Stop {
		return streamengine.ParsedDecision{Stop: true, StopReason: streamengine.StopReasonHandlerRequested}
	}

	newChoices := make([]map[string]any, 0, len(parsed.Parts))
	contentSeen := false
	for _, p := range parsed.ToolDetectionThinkingParts {
		trimmed := sse.TrimContinuationOverlap(s.toolDetectionThinking.String(), p.Text)
		if trimmed != "" {
			s.toolDetectionThinking.WriteString(trimmed)
		}
	}
	for _, p := range parsed.Parts {
		delta := map[string]any{}
		if !s.firstChunkSent {
			delta["role"] = "assistant"
			s.firstChunkSent = true
		}
		if p.Type == "thinking" {
			rawTrimmed := sse.TrimContinuationOverlap(s.rawThinking.String(), p.Text)
			if rawTrimmed != "" {
				s.rawThinking.WriteString(rawTrimmed)
				contentSeen = true
			}
			if s.thinkingEnabled {
				cleanedText := cleanVisibleOutput(rawTrimmed, s.stripReferenceMarkers)
				if cleanedText == "" {
					continue
				}
				trimmed := sse.TrimContinuationOverlap(s.thinking.String(), cleanedText)
				if trimmed == "" {
					continue
				}
				s.thinking.WriteString(trimmed)
				delta["reasoning_content"] = trimmed
			}
		} else {
			rawTrimmed := sse.TrimContinuationOverlap(s.rawText.String(), p.Text)
			if rawTrimmed == "" {
				continue
			}
			s.rawText.WriteString(rawTrimmed)
			contentSeen = true
			cleanedText := cleanVisibleOutput(rawTrimmed, s.stripReferenceMarkers)
			if s.searchEnabled && sse.IsCitation(cleanedText) {
				continue
			}
			trimmed := sse.TrimContinuationOverlap(s.text.String(), cleanedText)
			if trimmed != "" {
				s.text.WriteString(trimmed)
			}
			if !s.bufferToolContent {
				if trimmed == "" {
					continue
				}
				delta["content"] = trimmed
			} else {
				events := toolstream.ProcessChunk(&s.toolSieve, rawTrimmed, s.toolNames)
				for _, evt := range events {
					if len(evt.ToolCallDeltas) > 0 {
						if !s.emitEarlyToolDeltas {
							continue
						}
						filtered := filterIncrementalToolCallDeltasByAllowed(evt.ToolCallDeltas, s.streamToolNames)
						if len(filtered) == 0 {
							continue
						}
						formatted := formatIncrementalStreamToolCallDeltas(filtered, s.streamToolCallIDs)
						if len(formatted) == 0 {
							continue
						}
						tcDelta := map[string]any{
							"tool_calls": formatted,
						}
						s.toolCallsEmitted = true
						if !s.firstChunkSent {
							tcDelta["role"] = "assistant"
							s.firstChunkSent = true
						}
						newChoices = append(newChoices, openaifmt.BuildChatStreamDeltaChoice(0, tcDelta))
						continue
					}
					if len(evt.ToolCalls) > 0 {
						s.toolCallsEmitted = true
						s.toolCallsDoneEmitted = true
						tcDelta := map[string]any{
							"tool_calls": formatFinalStreamToolCallsWithStableIDs(evt.ToolCalls, s.streamToolCallIDs, s.toolsRaw),
						}
						if !s.firstChunkSent {
							tcDelta["role"] = "assistant"
							s.firstChunkSent = true
						}
						newChoices = append(newChoices, openaifmt.BuildChatStreamDeltaChoice(0, tcDelta))
						s.resetStreamToolCallState()
						continue
					}
					if evt.Content != "" {
						cleaned := cleanVisibleOutput(evt.Content, s.stripReferenceMarkers)
						if cleaned == "" || (s.searchEnabled && sse.IsCitation(cleaned)) {
							continue
						}
						contentDelta := map[string]any{
							"content": cleaned,
						}
						if !s.firstChunkSent {
							contentDelta["role"] = "assistant"
							s.firstChunkSent = true
						}
						newChoices = append(newChoices, openaifmt.BuildChatStreamDeltaChoice(0, contentDelta))
					}
				}
			}
		}
		if len(delta) > 0 {
			newChoices = append(newChoices, openaifmt.BuildChatStreamDeltaChoice(0, delta))
		}
	}

	if len(newChoices) > 0 {
		s.sendChunk(openaifmt.BuildChatStreamChunk(s.completionID, s.created, s.model, newChoices, nil))
	}
	return streamengine.ParsedDecision{ContentSeen: contentSeen}
}
