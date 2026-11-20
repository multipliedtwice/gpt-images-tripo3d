# GPT Images to Tripo3d MCP helper

Version @VERSION@. Companion for extension @VERSION@. Node.js 20+ required. No Python, npm install, or extra packages needed.

## Setup

1. Extract ZIP into permanent `mcp-helper` folder. Keep all extracted files together.
2. Install matching browser extension. Open extension MCP dropdown → One-time setup.
3. Create output folder. Use existing absolute path; folder symlinks rejected.
4. Copy Claude JSON or Codex TOML config from dropdown. Set helper path to extracted `mcp-helper/mcp/server.js`; set output folder path. Extension ID already filled.
5. Add config to MCP client. Keep **Allow agent control** enabled. Client starts helper automatically. Keep Chrome and control dashboard open; sign in to ChatGPT or Tripo as needed.

Use absolute Node executable path when client cannot find `node`.

## Config

- `RUNNER_EXTENSION_ID`: extension ID shown in dropdown.
- `RUNNER_OUTPUT_DIR`: existing absolute output folder. Omit only when using manual browser folder picker.
- `RUNNER_MCP_PORT`: default `17321`; keep default for browser discovery.
- `RUNNER_MCP_TOKEN`: optional; generated automatically. No manual token setup needed.

Multiple agents can use same config. Shared broker requires matching extension ID, output folder, and explicit token settings. One control dashboard owns browser work. Closing one client leaves other clients and connected dashboard available. Broker stops after clients and dashboard disconnect.

Accepted work can continue after timeout or client disconnect. Inspect state before retrying. No automatic mutation replay. Use stable `requestId` for each GPT batch; preserve ID across retries. Separate requests use separate worker tabs.

## Updates

Download helper from matching extension after extension update. Finish active queue work first. Then stop MCP clients and disconnect agent control before replacing helper files. Extract new helper into permanent folder; update client path if folder changed. Restart clients and enable agent control. Existing extension queue and output files stay in place.
