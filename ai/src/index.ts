import { createApp } from './app';

const port = Number(process.env.AI_PORT ?? 5000);
const server = createApp().listen(port, () => process.stdout.write(`AI service listening on :${port}\n`));
const stop = (): void => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
