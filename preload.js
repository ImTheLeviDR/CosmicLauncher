const { ipcRenderer } = require('electron')

window.ipcRenderer = ipcRenderer

console.log('Preload loaded')