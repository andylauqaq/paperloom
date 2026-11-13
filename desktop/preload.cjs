const { contextBridge, ipcRenderer, webUtils } = require('electron')

// 仅向界面暴露固定业务方法，参数由桌面进程再次检查。
contextBridge.exposeInMainWorld('paperloom', {
  call: (method, args) => ipcRenderer.invoke('paperloom:call', method, args),
  droppedPaths: (files) =>
    Array.from(files)
      .map((file) => webUtils.getPathForFile(file))
      .filter(Boolean),
  subscribe: (callback) => {
    const listener = () => callback()
    ipcRenderer.on('paperloom:changed', listener)
    return () => ipcRenderer.removeListener('paperloom:changed', listener)
  },
})
