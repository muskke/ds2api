package main

import (
	"net/http"
	"os"

	"ds2api/app"
	"ds2api/internal/config"
)

func main() {
	// Standard output for debugging local startup
	println("Go Cloud Function starting...")
	println("CWD:", config.BaseDir())
	println("Config Path:", config.ConfigPath())

	if err := config.LoadDotEnv(); err != nil {
		config.Logger.Warn("[dotenv] load failed", "error", err)
	}
	config.RefreshLogger()

	h := app.NewHandler()

	port := os.Getenv("PORT")
	if port == "" {
		port = __edgeoneGetPort("9000")
	}

	config.Logger.Info("starting ds2api (edgeone cloud function)", "port", port)
	if err := http.ListenAndServe(":"+port, h); err != nil {
		config.Logger.Error("server failed", "error", err)
		os.Exit(1)
	}
}

// __edgeoneGetPort 从环境变量 PORT 获取端口，如果未设置则使用默认值
// 由 EdgeOne Pages CLI 自动注入
func __edgeoneGetPort(defaultPort string) string {
	if port := os.Getenv("PORT"); port != "" {
		return port
	}
	return defaultPort
}
