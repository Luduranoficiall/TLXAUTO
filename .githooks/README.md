# Hooks do Git (TLXAUTO)

Este projeto usa hooks versionados em `.githooks/`.

## Auto-push após commit

O hook `.githooks/post-commit` roda automaticamente **depois de cada `git commit`** e executa um `git push`.

### Como ativar

Execute:

- `git config core.hooksPath .githooks`

### Como desativar

- Temporário (só na sessão): `export TLXAUTO_AUTOPUSH=0`
- Definitivo: `git config --unset core.hooksPath`

> Observação: o auto-push só funciona depois que você configurar o remote `origin` e tiver autenticação (PAT/SSH) funcionando.
