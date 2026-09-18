import { createApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const { app } = await createApp(config);
app.listen(config.PORT, config.HOST, () => {
  console.info(`API listening at http://${config.HOST}:${config.PORT}`);
});
