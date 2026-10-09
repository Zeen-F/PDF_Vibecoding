// This preloader lets an owned Node child receive a cooperative shutdown on
// Windows, where child.kill(SIGTERM) terminates it without running handlers.
function shutdown(signal = 'SIGTERM') {
  if (process.listenerCount(signal)) process.emit(signal);
  else process.exit(signal === 'SIGINT' ? 130 : 143);
}
process.on('message', message => {
  if (message?.type !== 'paperdesk-test-shutdown') return;
  const signal = message.signal === 'SIGINT' ? 'SIGINT' : 'SIGTERM';
  shutdown(signal);
});
if (!process.env.NODE_TEST_CONTEXT) process.on('disconnect', () => shutdown());
process.channel?.unref();
