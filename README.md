# Postman-CLI: Fullstack API Debugging Engine

[![Node.js version](https://img.shields.io/badge/Node.js-v18+-green.svg)](https://nodejs.org/)
[![React SPA](https://img.shields.io/badge/UI-React_SPA-61DAFB.svg)](https://react.dev/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Postman-CLI is a fast, terminal-first HTTP networking tool with a built-in React dashboard. It is designed to bypass browser CORS restrictions and execute low-latency API requests with zero external backend dependencies.

![Dashboard Demo](./assets/demo.gif)**

## Technical Architecture

Postman-CLI abandons bloated Electron wrappers in favor of a native Node.js routing engine and a compiled React frontend, ensuring millisecond boot times and minimal memory overhead:

* **Network Bridge:** The engine bypasses browser Same-Origin Policies by utilizing a custom preflight (`OPTIONS`) handshake. React sends local instructions to the Node backend, which opens raw TCP sockets to the target API, enabling 100% reachability.
* **Zero-Dependency Native File Server:** Instead of relying on Express.js, the backend utilizes native `node:fs` and `node:path` modules to serve the highly-optimized, minified React build (`<150KB`) directly from the CLI's memory space.
* **O(1) Memory Streaming:** The execution engine implements low-level chunked stream processing (`for await...of`). It intercepts raw `Uint8Array` binary network buffers and decodes them into UTF-8 JSON payloads on the fly, preventing memory spikes during massive payload transfers.
* **Declarative Matrix UI:** The dashboard is built with React and a custom CSS Grid design system, featuring dynamic layout reflows and real-time state management (`useState`) to track network latency and HTTP status codes.

## Tech Stack

* **Core Engine:** Node.js (Native `http`, `fs`, `path`, `util` modules)
* **Frontend UI:** React.js, Vite
* **Styling:** Custom CSS-in-JS / CSS Grid
* **Architecture:** Fullstack SPA served via CLI local proxy

## Installation & Setup

Ensure you have **Node.js (v18+)** and **npm** installed on your system. 

### 1. Clone & Build
```bash
# Clone the repository
git clone [https://github.com/](https://github.com/)[YOUR-GITHUB-USERNAME]/postman-cli.git
cd postman-cli

# Install frontend dependencies and compile the React SPA
cd ui
npm install
npm run build
cd ..
```

### 2. Global installation (linux/macOS/Windows)
Link the package to your systmes global binaries so you can execute it from any dir.

```bash
npm link 
```
## Control Interface 

It can be entirely used from terminal using keybaord or launched into ui.

Command/Flag | Description | Example |
| --- |  --- |  --- | 
|`--ui`. `-U`| Boot Dashboard| `req --ui`|
|`--url`, `-u`| Target API URL| `req -u https://api.com/data`|
|`--method`, `-m`| HTTP Method | `req -u <url> -m POST`|
|`--header`, `-H`| Inject Custom Headers| `req -u <url> -H "Auth: Bearer 123"`|
|`--body`, `-b`| Inline JSON payload| `req -u <url> -m POST -b '{"key":"val"}'` |
|`--file`, `-f`| Pipe local file to request body|`req -u <url> -m POST -f data.json`|
|`--timeout`, `-t`| Custom abort delay in ms| `req -u <url> -t 2000`|

## License
[License](https://github.com/Vaibhavtripathi7/postman-cli/blob/master/LICENSE)