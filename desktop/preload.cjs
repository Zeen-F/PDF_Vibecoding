const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('paperdeskDesktop', {
  openVaultNote(documentId) {
    return ipcRenderer.invoke('paperdesk:open-vault-note', documentId);
  },
  onLibrarySwitch(handler) {
    const listener = (_event, active) => handler(active === true);
    ipcRenderer.on('paperdesk:library-switch', listener);
    return () => ipcRenderer.removeListener('paperdesk:library-switch', listener);
  },
  onFlushRequest(handler) {
    const listener = async (_event, id) => {
      if (typeof id !== 'string') return;
      try {
        await handler();
        ipcRenderer.send('paperdesk:flush-result', { id, ok: true });
      } catch (error) {
        ipcRenderer.send('paperdesk:flush-result', { id, ok: false, error: String(error?.message || '笔记保存未完成。').slice(0, 300) });
      }
    };
    ipcRenderer.on('paperdesk:flush-request', listener);
    return () => ipcRenderer.removeListener('paperdesk:flush-request', listener);
  },
});
