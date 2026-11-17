# Agent subscriptions

In the native Agents window, open **Agent Subscriptions** from the title bar, account menu, or Command Palette. The command uses the existing keyboard-accessible Quick Pick. It is hidden in the browser preview, which cannot launch local clients.

| Provider | Connection | Where you work |
| --- | --- | --- |
| Codex | Enables the existing native Codex provider and starts its ChatGPT account sign-in when needed. An already signed-in account is reused. | Native agent picker and chat. |
| Anthropic | Opens the unmodified official Claude Code executable. **Sign in** runs `claude auth login`; **Open Claude Code** uses the client's saved account. | Editor terminal in the focused session's local working directory. |
| Devin | Opens the official Devin CLI. **Sign in** runs `devin auth login`; **Open Devin** uses the client's saved account. | Editor terminal in the focused session's local working directory. |

Executable paths are machine-scoped settings: `agents.subscriptions.claudeExecutable` and `agents.subscriptions.devinExecutable`. Defaults are `claude` and `devin` on PATH. These fields accept an executable path, with arguments passed separately. A virtual workspace is rejected before starting a local client. Without a session working directory, the action uses the editor's first local workspace folder.

Authentication and credential storage stay with the official provider clients. The fork does not collect subscription passwords or extract tokens. Terminal launch clears the Claude API key/auth token environment overrides, or Devin's `WINDSURF_API_KEY`, for this process only. Other client configuration and organizational controls still apply; the official client determines account entitlement and billing. Codex enablement respects managed policy. The isolated development launcher gives Codex and Claude separate configuration homes; Devin CLI uses its own existing credential store.

Claude subscriptions are hosted through the official Claude Code client because Anthropic distinguishes that usage from third-party Agent SDK authentication. No custom Claude OAuth implementation is added. Devin's native ACP chat adapter is not implemented by this change; Devin currently runs in the editor terminal.

Official references: [Codex authentication](https://developers.openai.com/codex/auth), [Claude authentication](https://code.claude.com/docs/en/authentication), [Claude credential and embedding policy](https://code.claude.com/docs/en/legal-and-compliance), [Devin commands and ACP](https://docs.devin.ai/cli/reference/commands).

Validation: focused tests cover Codex enable/sign-in ordering, reuse of an authenticated account, managed-policy rejection, both launch actions for both CLI providers, executable paths and working directories containing spaces, credential environment overrides, terminal activation, and rejection of virtual folders. A completed provider-backed model turn has not been verified.

Manual test: open **Agent Subscriptions**, choose **Anthropic**, then **Sign in**. Complete Claude Code's own login in the editor terminal, reopen **Agent Subscriptions → Anthropic → Open Claude Code**, and confirm it opens in your selected local project. Codex and Devin are available in the same menu.
