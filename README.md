# GetStream: Fullstack API Debugging tool

[![Node.js version](https://img.shields.io/badge/Node.js-v18+-green.svg)](https://nodejs.org/)
[![React SPA](https://img.shields.io/badge/UI-React_SPA-61DAFB.svg)](https://react.dev/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

GetStream is a **fast, terminal-first API testing** and debugging client. It serves as a lightweight alternative to Postman and comes with built-in react dashboard. It is meant to get around browser CORS restrictions and make API requests with **no external backend dependencies and low latency**.


## Technical Architecture

GetStream gets rid of heavy **Electron** wrappers and uses a **native Node.js routing** and a compiled React frontend instead. This makes boot times very fast and uses very little memory.

* **Network Bridge:** The engine uses a custom preflight (`OPTIONS`) handshake to get around browser Same-Origin Policies. React sends local commands to the Node backend, which opens raw TCP sockets to the target API. This makes it possible for 100% of requests to reach the API.

* **Zero-Dependency Native File Server:** Instead of using Express.js, the backend uses the built-in `node:fs` and `node:path` modules to serve the highly optimized, minified React build (`<150KB`) directly from the CLI's memory space.

* **Constant Memory Streaming:** The execution engine uses low-level chunked stream processing, which is called `for await...of`. It takes raw `Uint8Array` binary network buffers and decodes them into `UTF-8` JSON payloads on the fly. This stops memory spikes when large payloads are sent.

* **Declarative Matrix UI:** The dashboard is made with React and a custom CSS Grid design system. It has dynamic layout reflows and real-time state management (`useState`) to keep track of HTTP status codes and network latency.


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
git clone https://github.com/Vaibhavtripathi7/GetStream.git
cd GetStream

# Install frontend dependencies and compile the React SPA
cd ui
npm install
npm run build
cd ..
```

### 2. Global installation (linux/macOS/Windows)
Link the package to your systems global binaries so you can execute it from any directory.

`NOTE:` *Untested in macOS and windows.* 

```bash
npm link 
```
## Control Interface 

It can be entirely used from terminal using keybaord or launched into ui.

Command/Flag | Description | Example |
| --- |  --- |  --- | 
|`--ui`, `-U`| Boot Dashboard| `req --ui`|
|`--url`, `-u`| Target API URL| `req -u https://api.com/data`|
|`--method`, `-m`| HTTP Method | `req -u <url> -m POST`|
|`--header`, `-H`| Inject Custom Headers| `req -u <url> -H "Auth: Bearer 123"`|
|`--body`, `-b`| Inline JSON payload| `req -u <url> -m POST -b '{"key":"val"}'` |
|`--file`, `-f`| Pipe local file to request body|`req -u <url> -m POST -f data.json`|
|`--timeout`, `-t`| Custom abort delay in ms| `req -u <url> -t 2000`|

## License
[License](https://github.com/Vaibhavtripathi7/GetStream/blob/master/LICENSE)