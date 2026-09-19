#!/bin/zsh
set -eu
unset ANTHROPIC_API_KEY OPENAI_API_KEY CODEX_API_KEY CLAUDECODE NODE_OPTIONS
if [[ -x "$HOME/.local/bin/claude" ]]; then
  exec "$HOME/.local/bin/claude" auth login --claudeai
fi
print 'The native Claude Code CLI was not found at ~/.local/bin/claude.'
print 'Install Claude Code, then run: claude auth login --claudeai'
read '?Press Return to close.'
