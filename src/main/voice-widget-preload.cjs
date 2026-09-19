const {contextBridge,ipcRenderer}=require('electron');
const invoke=name=>()=>ipcRenderer.invoke(`summon:widget-${name}`);
contextBridge.exposeInMainWorld('summonWidget',{
  snapshot:invoke('snapshot'),toggleListening:invoke('toggle'),openSummon:invoke('open'),hide:invoke('hide'),
  onUpdate(callback){const listener=(_event,value)=>callback(value);ipcRenderer.on('summon:widget-update',listener);return()=>ipcRenderer.removeListener('summon:widget-update',listener);}
});
