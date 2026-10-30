# JavaScript Runtime

Run JavaScript and TypeScript with `js-exec <file>`. It uses QuickJS and supports ESM imports, top-level await, TypeScript syntax, `fetch`, and `node:child_process`. The `node` command does not run code.

## Modules and globals

The runtime exposes a partial Node.js surface. These modules are unavailable:

`node:zlib`, `node:crypto`, `node:net`, `node:http`, `node:https`, `node:dns`, `node:tls`, `node:readline`, `node:vm`, `node:v8`, `node:worker_threads`, `node:module`, `node:timers`, `node:tty`, and `node:sqlite3`.

These browser and JavaScript globals are unavailable:

`TextEncoder`, `TextDecoder`, `atob`, `btoa`, `setTimeout`, `setInterval`, `queueMicrotask`, `structuredClone`, `performance`, `WebAssembly`, and `crypto`.

Use the synchronous filesystem API or `fs.promises` for file work. Use `Buffer` for UTF-8 and base64 conversion.

## Filesystem API

The workspace bootstrap supplies common Node `fs` behavior, including:

- `Stats` and `Dirent` instances, `fs.constants`, `fs.accessSync`, and recursive `readdir`
- callback, promise, and synchronous forms for common file and directory methods
- file URL path arguments and `Buffer` results from `fs.readFileBuffer`
- Node-shaped error fields such as `code`, `errno`, `syscall`, `path`, and `dest`

The `node:fs` module loader publishes a fixed set of named exports. Use the default import when accessing bootstrap additions: `import fs from 'node:fs'`. Namespace imports expose the upstream method list, so additions such as `fs.constants`, `fs.Stats`, `fs.Dirent`, and `fs.accessSync` are absent from `import * as fs`.

The sandbox does not expose file descriptors or streams. `openSync`, `readSync`, `writeSync`, `createReadStream`, and `createWriteStream` are absent. `cp`, `truncate`, `utimes`, `mkdtemp`, `watch`, and `opendir` are also absent. Use whole-file reads and writes, or run a shell command for unsupported operations.

## Async callbacks

QuickJS stops when the script's synchronous top level finishes. Keep the script alive with top-level `await` until callback work completes, or use `fs.promises`:

```js
await new Promise((resolve, reject) => {
  fs.readFile("/home/workspace/input.txt", "utf8", (error, text) => {
    if (error) reject(error);
    else {
      console.log(text);
      resolve();
    }
  });
});
```
