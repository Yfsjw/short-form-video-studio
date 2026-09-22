import { createApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const { app } = await createApp(config);
const server = app.listen(config.PORT, config.HOST, () => {
  console.info(`API listening at http://${config.HOST}:${config.PORT}`);
});
// Node's defaults (60s headers / 5min full-request) are tuned for typical APIs, not
// someone uploading a large video over a slow mobile connection -- confirmed live:
// real uploads in the 11-99MB range were failing with "Request aborted" well before
// the video data (let alone whisper's own processing) had a chance to matter.
server.headersTimeout = 120_000;
server.requestTimeout = 20 * 60_000;
