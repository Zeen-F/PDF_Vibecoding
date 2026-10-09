import { createApp } from './app.mjs';
import { createServer } from 'node:http';

const port = Number(process.env.PORT || 4317);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('PORT 必须是 1 至 65535 的整数。');
  process.exit(1);
}
let application;
let stopping = false;
// Reserve the port before touching the library. A concurrent startup losing
// the bind race must not create files or migrate an unrelated target library.
const server = createServer((request, response) => {
  if (application) return application.app(request, response);
  response.writeHead(503, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ error: '纸间正在启动，请稍后重试。' }));
});
server.listen(port, '127.0.0.1', async () => {
  try {
    application = createApp();
    await application.ready;
    console.log(`Paperdesk 已启动：http://127.0.0.1:${port}`);
    if (process.connected) process.send({ type: 'paperdesk-ready' }, () => {});
  } catch (error) {
    console.error(`纸间启动失败：${error.message}`);
    process.exitCode = 1;
    shutdown();
  }
});
server.on('error', async (error) => {
  console.error(error.code === 'EADDRINUSE' ? `端口 ${port} 已被占用。请关闭其他实例，或设置 PORT 后重试。` : error.message);
  process.exitCode = 1;
  shutdown();
});
function shutdown() {
  if (stopping) return;
  stopping = true;
  server.close(async () => { await application?.close(); process.exit(process.exitCode || 0); });
  setTimeout(() => { server.closeAllConnections(); }, 5000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
// Windows cannot deliver POSIX signals gracefully to a child Node process.
// Only the owning local parent has this IPC channel; no shutdown API is exposed.
if (process.send) {
  process.on('message', message => { if (message?.type === 'paperdesk-shutdown') shutdown(); });
  process.on('disconnect', shutdown);
}
