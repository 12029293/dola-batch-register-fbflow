// preload.js · 渲染层桥：contextBridge 暴露受控 IPC
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  invoke: (channel, payload) => ipcRenderer.invoke(channel, payload),
  on: (channel, cb) => {
    const valid = [
      'env:changed',
      'register:progress',
      'register:batch:progress',
      'register:batch:done',
      'batch:account',   // 批量引擎：单号状态变化
      'batch:stats',     // 批量引擎：统计（节流）
      'batch:done',      // 批量引擎：批量结束（汇总）
      'setup:progress',  // 向导/设置测试进度（预留）
      'win:maximized',   // 自绘标题栏：最大化状态变化
    ];
    if (!valid.includes(channel)) return;
    ipcRenderer.on(channel, (event, data) => cb(data));
  },
  // 自绘标题栏：窗口控制（受控白名单通道）
  win: {
    minimize: () => ipcRenderer.send('win:minimize'),
    maximize: () => ipcRenderer.send('win:maximize'),
    close: () => ipcRenderer.send('win:close'),
    isMaximized: () => ipcRenderer.invoke('win:isMaximized'),
  },
});
