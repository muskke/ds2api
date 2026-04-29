package promptcompat

import (
	"strings"

	"ds2api/internal/prompt"
)

const CurrentInputContextFilename = "history.txt"

func BuildOpenAIHistoryTranscript(messages []any) string {
	return buildOpenAIInjectedFileTranscript(messages)
}

func BuildOpenAICurrentUserInputTranscript(text string) string {
	if strings.TrimSpace(text) == "" {
		return ""
	}
	return BuildOpenAICurrentInputContextTranscript([]any{
		map[string]any{"role": "user", "content": text},
	})
}

func BuildOpenAICurrentInputContextTranscript(messages []any) string {
	return buildOpenAIInjectedFileTranscript(messages)
}

func buildOpenAIInjectedFileTranscript(messages []any) string {
	normalized := NormalizeOpenAIMessagesForPrompt(messages, "")
	transcript := strings.TrimSpace(prompt.MessagesPrepare(normalized))
	if transcript == "" {
		return ""
	}
	return transcript
}
