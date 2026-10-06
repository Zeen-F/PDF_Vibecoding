import { createApp } from './app.mjs';

const port = Number(process.env.PORT || 4317);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('PORT 必须是 1 至 65535 的整数。');
  process.exit(1);
}
const { app, close } = createApp();
const server = app.listen(port, '127.0.0.1', () => {
  console.log(`Paperdesk 已启动：http://127.0.0.1:${port}`);
});
server.on('error', (error) => {
  console.error(error.code === 'EADDRINUSE' ? `端口 ${port} 已被占用。请关闭其他实例，或设置 PORT 后重试。` : error.message);
  close();
  process.exitCode = 1;
});
let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  server.close(async () => { await close(); process.exit(0); });
  setTimeout(() => { server.closeAllConnections(); }, 5000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
