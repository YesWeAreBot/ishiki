# Ishiki Core Runtime

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/YesWeAreBot/ishiki/main/docs/public/logo.en-dark.svg">
  <img src="https://raw.githubusercontent.com/YesWeAreBot/ishiki/main/docs/public/logo.en.svg" alt="Ishiki: A runtime for consciousness. A home for personality." width="740">
</picture>

[中文](README.md) · [Project](https://github.com/YesWeAreBot/ishiki/README.en.md) · [Documentation](https://ishiki.js.org/docs/) · [Extension API](https://ishiki.js.org/docs/reference/api/)

`koishi-plugin-ishiki` is Ishiki's Koishi-based core runtime. It brings together the [yesimagent](https://github.com/YesWeAreBot/yesimagent) Agent loop, a model gateway, and Koishi platform integration. Profiles run Agents with stable identities, their own experiences, and customizable behavior.

Three mutually exclusive engine families cover **Context** construction, **Toolcall** model interaction, and **Wakeup** scheduling. Extensions add tools and instructions, resources use scheme URLs, and each profile can enable codemode and toolsearch.

## Install and connect

Prepare:

- Koishi **4.18.11 or a later 4.x release**, with a configured chat-platform adapter.
- Node.js **20+** and Bun.
- A working model API and credentials. The default `native` toolcall engine requires native tool-calling support.

The current setup builds from source. These commands assume sibling directories named `koishi-app` and `ishiki`, starting from their common parent:

```bash
git clone https://github.com/YesWeAreBot/ishiki.git
cd ishiki
bun install
bun run build

cd packages/koishi-plugin-ishiki
bun link
cd ../../../koishi-app
bun link koishi-plugin-ishiki
```

Enable the plugin in your Koishi application's `koishi.yml`:

```yaml
plugins:
  ishiki: {}
```

The default data directory is `data/ishiki/` inside the Koishi application. Change it with the plugin's `dataPath` setting.

## Create your first Agent

On the first start with a fresh data directory, the plugin releases an editable preset at `data/ishiki/models.yaml` and `data/ishiki/profiles/default/`, including `profile.yaml` and `PERSONA.md`.

The preset uses the `chat` context engine, `standard` wakeup, `native` tool calling, and enables codemode. Existing data directories are left untouched.

### 1. Declare a model

Edit `data/ishiki/models.yaml` and replace the provider name, endpoint, credential, and model name:

```yaml
providers:
  openai:
    api: openai-completions
    baseUrl: https://api.openai.com/v1
    apiKey: YOUR_API_KEY
    models:
      - id: gpt-4.1-mini
        toolCall: true
        input: [text]
        contextWindow: 1047576
        maxTokens: 32768
```

Set the context window and output limit to match the model. The `api` field selects the interface dialect; see [model providers](https://ishiki.js.org/docs/guides/models/) for other providers and model groups.

Credentials are stored as plain text. Restrict access to this file and keep the data directory out of version control.

### 2. Declare a profile

Edit `data/ishiki/profiles/default/profile.yaml` and replace the account placeholder:

```yaml
model: openai:gpt-4.1-mini
mode: channel

channels:
  "onebot:BOT_ID":
    - "*"

context:
  engine: chat
wakeup:
  engine: standard
toolcall:
  engine: native
codemode:
  enable: true
```

Replace `onebot:BOT_ID` with the adapter's `platform:selfId`. Claims support exact matches, trailing `*` prefix matches, and `!` exclusions. `"*"` claims all channels on that account.

The preset selects explicit engines for all three families. Each family chooses one variant through `engine`, with variant settings in a subsection of the same name.

### 3. Write the instruction files

Edit `PERSONA.md` in the same profile directory (the default value of `instructions`):

```markdown
You are a clear, patient, and reliable conversation partner.

Understand the problem the other person is trying to solve before giving a direct, actionable response. Use tools to verify facts when needed. Complete operations you can carry out and explain the result clearly.

Keep a stable judgment. Do not flatter or push the responsibility back to the other person.
```

`instructions` takes a list of files, concatenated in declaration order and appended to the end of the system prompt. Relative paths resolve against the profile directory; absolute paths are also accepted. A missing file logs a warning and does not block startup.

### 4. Start and check

Start Koishi and look for the profile activation log. In a claimed channel, mention the bot or quote one of its messages to trigger the default wakeup rules. Claimed private conversations also trigger execution. The default visible reply is sent through `send_message`.

Runtimes are created on demand. Their session logs and resources are stored under the profile's `runtimes/` directory. The [quick start](https://ishiki.js.org/docs/tutorial/quickstart/) covers the full procedure and troubleshooting.

## Choose an instance model

| Mode                | Runtimes                   | History and resources              | Message destination              |
| ------------------- | -------------------------- | ---------------------------------- | -------------------------------- |
| `channel` (default) | One per channel, on demand | Isolated by channel                | The runtime's own channel        |
| `cross`             | One for the profile        | Shared across all claimed channels | `send_message` requires `target` |

To share one persona's experiences across multiple channels, change the profile's `mode` and `channels`:

```yaml
mode: cross
channels:
  "onebot:BOT_ID": ["CHANNEL_A", "CHANNEL_B"]
```

Cross-mode context includes source-channel coordinates. The Agent uses them to choose a destination within the profile's claims. Multiple profiles can run concurrently with distinct channel claims.

[Profile activation, runtime creation, and sharing →](https://ishiki.js.org/docs/explanations/profiles-runtimes/)

## Enable code tool programming

Add to the profile:

```yaml
codemode:
  enable: true
  direct: []
```

It is on by default. codemode moves business tools into a QuickJS sandbox: the model writes a JavaScript program that calls them, and intermediate data never enters the context. `send_message` works both directly and from a program; `finish` and `wait` stay directly callable. Tools listed in `direct` also remain in the model catalog.

The sandbox exposes a fixed environment: `tools["name"]` calls host tools, `searchTools(query)` and `describeTool(name)` look declarations up by keyword, `text()` and `console.log()` emit output, `image()` stores images, and `store()`/`load()` keep small session state. Results come back in STATUS, WALL TIME, RESULT, TEXT, CONSOLE, ATTACHMENTS and ERROR sections, and `// @options` overrides the timeout and output budget for one call.

Resources in tool results can be carried as URLs. The core provides `asset://`, `artifact://`, and `local://`. Extensions can add schemes that use the same `read` interface. Each runtime has its own resource center.

[Tool calls and resources →](https://ishiki.js.org/docs/explanations/tools-pipeline/)

## Connect extensions and engines

Build and link an extension package, enable its Koishi plugin, then enable its capabilities for a persona through the profile's `extends`. For workspace:

```yaml
# The plugins section in koishi.yml
plugins:
  ishiki: {}
  ishiki-workspace: {}
```

```yaml
# profile.yml
extends:
  workspace:
    config:
      backend: sandbox
```

Workspace adds file and command tools. MCP integration and OneBot-specific operations have their own extensions; see the [ecosystem](../../README.en.md#ecosystem-and-participation).

Select engine variants through `context.engine`, `toolcall.engine`, and `wakeup.engine`. Enable the Koishi plugin providing the engine service, then use its name in the profile. For example, narrative provides cooperating context and toolcall engines.

Developers have three extension points:

- **Extension** adds tools and instructions, and manages the lifecycle of instance resources.
- **Engine variants** customize context, model interaction, or execution scheduling.
- **SchemeHandler** adds a resource source through the existing `read` interface.

[Write extensions, engines, and resource handlers →](https://ishiki.js.org/docs/reference/api/)

## Management console

With `@koishijs/plugin-console` enabled alongside this plugin, the console registers a single Ishiki entry. Models, profiles, sessions, runtimes, usage, audit and cache pages switch through the in-page sidebar. Pages read snapshots from `src/management/` and write through authority-checked console listeners.

- Model saves compare a revision digest and replace `models.yaml` atomically. Secrets report configuration state only; plaintext never reaches pages, logs or audit records.
- Profile save and apply are separate: save writes files, apply re-resolves the config and rebuilds the runtime. Removal requires typing the full profile id.
- Sessions page through `events.jsonl` with byte cursors; corrupt lines are reported individually while the remaining entries stay readable.
- Usage and audit come from real messages and lifecycle events; missing cache data produces an explicit status.

Build the console bundle:

```bash
bun run --cwd packages/koishi-plugin-ishiki console:build
```

The console entry serves the built `dist` directory; rebuild after changing files under `client/`.

## Startup issues

| Symptom                                            | Check and recovery                                                                       |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `missing required service`                         | Check engine and extension names, and whether the corresponding Koishi plugin is enabled |
| Profile skipped because of overlapping claims      | Adjust `channels`, using `!` exclusions for overlaps                                     |
| Active profile, but input does not start execution | Check account and channel identifiers, then the selected wakeup engine's conditions      |
| Model request fails                                | Check the API dialect, endpoint, credentials, model name, and tool-calling support       |

Reload the plugin after changing configuration. The [debugging guide](https://ishiki.js.org/docs/guides/debugging/) covers request records and logs. The documentation site is currently in Chinese.

## License

[MIT](../../LICENSE) · [Yes! We Are Bot!](https://github.com/YesWeAreBot)
