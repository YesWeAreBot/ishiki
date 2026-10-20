# Ishiki Core Runtime

**Give consciousness a form. Let every Agent find its own character.**

[中文](README.md) · [Project](../../README.en.md) · [Documentation](https://ishiki.js.org/docs/) · [Extension API](https://ishiki.js.org/docs/reference/api/)

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

### 1. Declare a model

Create `data/ishiki/models.yaml`:

```yaml
providers:
  my-api:
    api: openai-completions
    baseUrl: https://api.example.com/v1
    apiKey: YOUR_API_KEY
    models:
      - id: your-model-name
        input: [text]
        contextWindow: 128000
        maxTokens: 8192
```

Replace `baseUrl`, `apiKey`, and the model `id`. Set the context window and output limit to match the model. The `api` field selects the interface dialect; see [model providers](https://ishiki.js.org/docs/guides/models/) for other providers and model groups.

Credentials are stored as plain text. Restrict access to this file and keep the data directory out of version control.

### 2. Declare a profile

Create `data/ishiki/profiles/my-first/profile.yml`:

```yaml
model: my-api:your-model-name
mode: channel

channels:
  "onebot:BOT_ID":
    - "CHANNEL_ID"

context:
  engine: standard
wakeup:
  engine: standard
toolcall:
  engine: native
```

Replace `onebot:BOT_ID` with the adapter's `platform:selfId`, and `CHANNEL_ID` with the actual channel identifier. Claims support exact matches, trailing `*` prefix matches, and `!` exclusions. `"*"` claims all channels on that account.

The example's engines are also the defaults, so these three sections may be omitted. Each family selects one variant through `engine`, with variant settings in a subsection of the same name.

### 3. Write the persona

Create `persona.md` in the same profile directory:

```markdown
You are Yuki. Speak clearly, with your own judgment and curiosity.
Remember what you are working on, and use tools to carry out tasks.
When you have something to communicate, explain the result directly.
```

`persona.md` is included in the system instructions. All runtimes derived from the profile use this persona declaration.

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

## Enable code and on-demand tool discovery

Add to the profile:

```yaml
codemode:
  enable: true
toolsearch:
  enable: true
```

Both features are disabled by default. codemode exposes business tools through a QuickJS program entry point. toolsearch makes non-resident tools discoverable through `search`, with matches entering the available catalog from the next step. `send_message` supports direct and programmatic calls; `finish` and `wait` stay directly callable.

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
