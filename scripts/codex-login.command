#!/bin/zsh
set -eu
unset ANTHROPIC_API_KEY OPENAI_API_KEY CODEX_API_KEY CLAUDECODE NODE_OPTIONS
for codex in /Applications/ChatGPT.app/Contents/Resources/codex /Applications/Codex.app/Contents/Resources/codex "$HOME/.local/bin/codex" /opt/homebrew/bin/codex /usr/local/bin/codex; do
  if [[ -x "$codex" ]]; then
    exec "$codex" login
  fi
done
print 'The Codex CLI was not found (ChatGPT.app, Codex.app, ~/.local/bin or Homebrew).'
print 'Install Codex, then run: codex login'
read '?Press Return to close.'
