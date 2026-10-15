# IQ Code 1.1.0

IQ Code is a Claude Code plugin from IQ Routing. With routing on, the band shows one line: `IQ · Sonnet 5.5 · high`. It shows your current model and thinking level, omitting the thinking level when there is none. Routing off hides the band; paused routing shows `IQ · paused (/iq)`. Open `/iq` for Home, Routing, Cost, Plan, and Settings.

Dollar figures are **API-equivalent**: what the same usage would cost at API prices, rather than your subscription bill. Savings are labelled **est.** Estimates can be off and are never a promise.

## What you can do

- Follow measured prompt and session cost in `/iq`. A `+` after a dollar figure (`$12.40+`) means it is at least that: it leaves out calls IQ Code cannot price, including the advisor's, and, in the session total, anything a resumed session held before IQ Code started.
- Check the prompt cache countdown and your 5-hour and weekly plan pace in `/iq`.
- See the model and thinking level in the band. Open `/iq` for the last decision, rating and reason, this prompt's cost and calls, session cost and pace, plan percentages, monthly decision count, and Est. saved.
- Use the waving iQ flag, or switch animation off in Settings.
- Turn routing on with your IQ key and Personal plan or higher. It stays on in new sessions on this device until `/iq-route off`. IQ picks the model and thinking for each prompt: the model and thinking in your settings are a starting point; an explicit /model, --model, /effort or ultrathink still decides. A stronger model uses more of your plan. Your tokens still go straight to Anthropic on your own plan. If you start with --model set to the same model as your settings file, IQ treats it as your settings model. Settings aliases and [1m] names are resolved to the host model for this comparison. With no model set in your user, project or local settings, the startup model, including the plain default, stays capped.

Once you turn routing on, it stays on in new interactive sessions on this device until `/iq-route off`. Turning it off stops routing for this and future sessions. Kill switches still win; non-interactive runs never route. If IQ is unavailable, you can keep working with your chosen model. Measured usage remains available in `/iq` when a cost estimate is unavailable. Normal turns add nothing to the chat. When IQ pauses, refuses your key or cannot answer, you see one short line.

## The IQ look

IQ Code ships two themes: pick **IQ Light** or **IQ Dark** in `/theme`. In those two, the band, the IQ text mark and the headings in `/iq` are IQ blue. Other themes show them in their own accent colour, and the warning colour always comes from the theme.

A plugin cannot paint your terminal's background, so the background comes from your terminal profile. Optional profiles for Terminal.app, iTerm2 and Ghostty are in `extras/terminal/`, and its README says how to import each one. Nothing is installed for you.

## Install

The public release is intended for macOS, Linux and Windows, in the terminal. The installers need Claude Code 2.1.287 or later. Windows needs Git for Windows. The desktop app's Code tab is not verified for IQ Code yet.

The public repository is [IQ-Routing/IQ-Code](https://github.com/IQ-Routing/IQ-Code). Its marketplace is named `iq-routing`.

| Setup | Route |
| --- | --- |
| Any terminal | The marketplace commands below. They do not ask for a key. |
| macOS or Linux terminal | The `curl` installer below. It can ask for your key at the end. |
| Windows PowerShell | The `irm` one-liner or `install.ps1` below. It can ask for your key at the end. |
| Windows Command Prompt | The `curl` line for `install.cmd` below. It can ask for your key at the end. |
| Claude desktop app, Code tab | Not verified yet. Install from a terminal, then check that `/iq` opens in the Code tab. |

In your terminal:

```sh
claude plugin marketplace add IQ-Routing/IQ-Code
claude plugin install iq-code@iq-routing
```

For a local preview of the exported release:

```sh
claude --plugin-dir /path/to/iq-code-public
```

Or use the installer on macOS or Linux:

```sh
curl -fsSL https://iq-routing.com/install.sh | sh
```

In Windows PowerShell:

```powershell
irm https://iq-routing.com/install.ps1 | iex
```

In Windows Command Prompt:

```bat
curl -fsSL https://iq-routing.com/install.cmd -o install.cmd && install.cmd && del install.cmd
```

If you downloaded `install.ps1`, you can also run it as a file:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

To uninstall, see [Uninstall](#uninstall).

## Commands

| Command | What you can do |
| --- | --- |
| `/iq` | Open Home, Routing, Cost, Plan, and Settings. |
| `/iq feedback` | Open bug, feature and routing question links with five diagnostic values. |
| `/cost-read` | Open measured cost for the current session. |
| `/iq-route on` | Turn routing on until `/iq-route off`, including new sessions on this device. Needs a usable IQ key and Personal plan or higher. |
| `/iq-route off` | Turn routing off for this and future sessions on this device. |
| `/iq-route status` | Check routing status. |
| `/iq-route reset` | Request a fresh routing decision for your next prompt. |
| `/iq-route subagents on` | Let IQ rate subagent tasks while routing is on, for this session. On by default in every new session. |
| `/iq-route subagents off` | Stop subagent routing for this session. Each subagent keeps the model Claude Code gives it. |
| `/iq-budget <amount> usd` | Set a measured API-equivalent dollar budget. |
| `/iq-budget off` | Clear the budget. |
| `/iq-budget status` | Check the budget. |

`/iq-budget <amount> usd` sets a limit in API-equivalent dollars for your measured spend. When spend nears or reaches the limit, you see one short line and `/iq` shows the budget's status. Nothing else changes: the session continues, and the budget does not change the model. The limit stays until `/iq-budget off`, or until you start a new session.

## Settings

Routing waits up to 7 seconds for the first route call in a session or after at least ten minutes without a route call, and 4 seconds for later calls. `IQ_ROUTER_DEADLINE_MS` overrides this for every call (1000 to 8000 milliseconds). The wait is counted from prompt submit for main routes and from the spawn for subagent routes. If IQ does not answer in time, you keep your model.

With an IQ key, IQ Code reads your dashboard's session defaults at startup and at most every ten minutes, applies changes on the next prompt, and gives this session's explicit Settings choices priority.

## Free and Personal

The cost meter, cache clock, plan pace, budgets, and themes are free.

- **Free:** IQ Code's cost meter, cache clock, plan pace, budgets, and themes, plus gateway routing for API traffic with an IQ API key. IQ Code routing needs Personal or higher.
- **Personal:** **$6/month**, with **2,000 routing decisions a month** for IQ Code. `/iq` Home and Cost show measured session cost and pace on every plan. Paying Team and Enterprise plans also include IQ Code routing.

A routing decision is one request to IQ, made for each new prompt you send while routing is on and for each subagent task Claude starts in that session (not forks, workflow agents or teammates). A message sent while Claude is still working makes no new request. Subagent-heavy sessions use decisions faster.

Get Personal from your IQ dashboard at https://iq-routing.com/billing.

## Your IQ key

Create an IQ key on the API Keys page of your IQ dashboard, at https://iq-routing.com/keys. In Claude Code, run:

```text
/plugin configure iq-code@iq-routing
/reload-plugins
```

Enter your key in the masked **IQ API key** field. The key is optional; the display features work without it. Key changes apply after `/reload-plugins` or a restart. Then use `/iq-route on` to enable routing with Personal or higher. It stays on in new sessions on this device until `/iq-route off`. Without a usable key, `/iq-route on` leaves routing off and tells you how to add one. A key identified as Free leaves routing off and shows: “Routing needs the Personal plan ($6/month). Nothing was sent to IQ for routing. iq-routing.com/billing See /iq.” With routing on, the prompt as submitted, including pasted text, and recent submitted prompts go to IQ after a best-effort scrub and removal of known host context. The scrubbed brief of each subagent task is sent too. See [Privacy](#privacy).

Claude Code stores the key in the macOS Keychain, falling back to `~/.claude/.credentials.json` if the Keychain rejects the write. Linux and Windows use `~/.claude/.credentials.json` (`%USERPROFILE%\.claude\.credentials.json` on Windows). `CLAUDE_CONFIG_DIR` changes the credentials file location. Uninstalling the plugin from its last install scope removes the key Claude Code stores for it. `--keep-data` keeps the plugin's data folder.

The installers optionally ask for the key with hidden input after installing. Enter skips. They pass it to `claude plugin configure iq-code@iq-routing --values-stdin` through stdin as JSON, never in command arguments or a file. You can configure it later with the command above.

The plugin setting takes priority. An empty setting falls back to the legacy `~/.claude/iq/key` file (`%USERPROFILE%\.claude\iq\key` on Windows). Keep that plain text file private: mode 0600 inside a mode 0700 directory on macOS and Linux, or a protected ACL on Windows. If the file exists but cannot be read, is empty, or is malformed, IQ Code sends nothing. If it is absent, the legacy `IQ_ROUTER_KEY` in the `env` block of your **user-level** Claude Code settings still works. Project settings and the merged process environment cannot supply the fallback key.

A legacy local plugin named `iq` in `CLAUDE_CODE_PLUGIN_DIRS` loads alongside `iq-code` and doubles the hooks. Remove its exact directory entry from that variable in your shell startup file or Claude settings, then restart Claude Code. The installers show the entry and a command for your current shell; they do not edit settings.

## Privacy

With a usable IQ key, IQ Code reads session defaults from IQ through the body-free `GET /v1/claude-code/settings` at startup and at most once every ten minutes, even with routing off; this GET sends no prompt content. Routing requests remain off until routing is on. Without a usable IQ key, it sends nothing to IQ. Before arming routing, it checks your plan with the usage-only `GET /v1/claude-code/usage` request. That request contains no prompt or task brief. If the response identifies the key as Free, routing stays off in this and future sessions, and no prompt or task brief is sent for routing. If the usage check fails or is unavailable, routing can turn on; a plan-required response to a routing request then pauses it. Requests use the sensitive plugin setting first, then the legacy key file at `~/.claude/iq/key`, with `IQ_ROUTER_KEY` accepted only from user-level Claude Code settings.

With routing on, requests go to `https://gateway.iq-routing.com/v1`. Routing sends the prompt as submitted, including pasted text, after a best-effort scrub and removal of known host context. Recent submitted prompts from this session share a limit of about 8,000 tokens with the current prompt; a long prompt is cut in the middle. Requests also include model, thinking-level and agent-type labels, and conversation size and cache timing facts. Pasted files, logs, and tool output can be included in the submitted text. The model-written subagent brief can also quote files or tool output. With routing on, the scrubbed subagent brief (at most 16,000 characters) is sent to IQ. Subagent tasks are rated while routing is on; `/iq-route subagents off` stops that for the session. Secret filtering is best-effort and can miss secrets; avoid putting secrets in prompts or subagent tasks. To rate a prompt, IQ may send a short excerpt to OpenAI: recent messages cut short plus your latest prompt, about 5,200 characters at most, or for a subagent the task description, up to about 2,000 characters. Some requests skip this step, IQ does not store the excerpt, and OpenAI handles it under its API terms. Your model tokens still go straight to Anthropic on your plan.

In `/iq` Settings, “Share usage facts” controls whether IQ may keep derived numbers about routed requests without prompt text. IQ Code sends the choice on each routing request (`X-IQ-Data-Features: on` or `off`), and IQ keeps these facts only when it is on. It is on by default.

Session cost and pace are measured locally from reported usage. IQ Code does not request server forecasts for these measured sessions. Pace appears after three minutes of active time; a partial spend total carries a `+` when a call could not be fully priced.

Use `/iq-route off` to stop routing requests for this and future sessions on this device. To stop every IQ request, including session defaults, set `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` (any value, even empty or `0`), set `IQ_ROUTER_DISABLED=1`, or create `~/.claude/iq/router/OFF`. A failed kill-switch read blocks requests. The public routing destination is fixed.

The key remains in Claude Code’s secure storage, or in your legacy key file or user setting. It is never copied into IQ Code’s stored state, logs, UI, or errors. IQ Code writes settings, onboarding state, capped error logs, routing decision metadata, and the size each session's prompt cache started at under `~/.claude/iq/`. Prompt history stays in memory and is cleared on `/clear` and in-process resume. IQ Code does not deliberately write prompts, answers, or tool text to disk; error text is scrubbed on a best-effort basis. Decision logs contain usage and validated model/effort labels, not the raw model string returned by IQ.

The host HTTP API cannot refuse redirects. The installed host strips Authorization on cross-origin redirects; IQ Code relies on that host behaviour.

What IQ keeps once a request reaches it is described at https://iq-routing.com/privacy.

## Themes

Pick IQ Light or IQ Dark with `/theme`. For a matching terminal background, import a profile from `extras/terminal/` using its README instructions.

## Uninstall

Restart Claude Code after changing plugins. Use the command that matches how you installed IQ Code.

Marketplace install, in your terminal on any OS:

```sh
claude plugin uninstall iq-code@iq-routing --scope user
```

Add `--keep-data` to keep the plugin's data folder. Inside Claude Code, `/plugin uninstall iq-code@iq-routing` also removes the plugin.

macOS or Linux installer:

```sh
curl -fsSL https://iq-routing.com/install.sh | sh -s -- --uninstall
```

Add `--purge` to also delete `~/.claude/iq/`:

```sh
curl -fsSL https://iq-routing.com/install.sh | sh -s -- --uninstall --purge
```

Windows PowerShell installer:

```powershell
$env:IQ_CODE_UNINSTALL = '1'
irm https://iq-routing.com/install.ps1 | iex
Remove-Item Env:IQ_CODE_UNINSTALL
```

Also set `IQ_CODE_PURGE` to delete `%USERPROFILE%\.claude\iq`:

```powershell
$env:IQ_CODE_UNINSTALL = '1'
$env:IQ_CODE_PURGE = '1'
irm https://iq-routing.com/install.ps1 | iex
Remove-Item Env:IQ_CODE_UNINSTALL, Env:IQ_CODE_PURGE
```

Downloaded `install.ps1`:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -Uninstall
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -Uninstall -Purge
```

Windows Command Prompt installer:

```bat
curl -fsSL https://iq-routing.com/install.cmd -o install.cmd && install.cmd --uninstall && del install.cmd
curl -fsSL https://iq-routing.com/install.cmd -o install.cmd && install.cmd --uninstall --purge && del install.cmd
```

Notes:

- The installers do not pass `--keep-data`. They keep `~/.claude/iq/` (IQ settings, logs and any legacy key file) unless you use `--purge`.
- The CLI command does not delete `~/.claude/iq/`. Delete that folder yourself to remove it.
- Uninstall removes the IQ key that Claude Code stores. Add the key again after you reinstall.
- The `iq-routing` marketplace stays registered. To remove it, run `claude plugin marketplace remove iq-routing`.
- For a local preview, stop passing `--plugin-dir`.

## Support

Open `/iq feedback` for links to [report a bug, request a feature or ask a routing question](https://github.com/IQ-Routing/IQ-Code/issues/new/choose). Bugs are things that are broken or differ from the docs; routing questions are things you see in `/iq` that you do not understand.

For account, billing or sign-in questions, email [support@iq-routing.com](mailto:support@iq-routing.com). Please do not put account details in a public issue. We read issues, but cannot promise a reply or a fix on any timeline.

The feedback pane shows five values before you open a link: IQ Code version, OS, Claude Code version, routing status and last error code. The link includes only those values, never prompts, keys or file paths. Building the link makes no network call. Your browser contacts GitHub and sends those values when you open it.

## License

IQ Code is source-available under the PolyForm Shield License 1.0.0 (see LICENSE). It is not open source.
You can read it, use it at work or at home, with IQ or without, and change it for your own use.
You cannot sell it or ship a product that competes with IQ Code or IQ Routing. Copies you pass on keep the LICENSE file.
