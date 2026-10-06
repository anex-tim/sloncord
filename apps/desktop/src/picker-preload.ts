import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("sloncordPicker", {
  list: (tab: "screen" | "window"): Promise<{ id: string; name: string; thumbnail: string }[]> =>
    ipcRenderer.invoke("display-picker:list", tab),
  getOptions: (): Promise<{ audioRequested: boolean }> =>
    ipcRenderer.invoke("display-picker:get-options"),
  confirm: (
    id: string,
    withSystemAudio: boolean,
    maxHeight: number,
    frameRate: number
  ): Promise<void> =>
    ipcRenderer.invoke("display-picker:confirm", id, withSystemAudio, maxHeight, frameRate),
  cancel: (): Promise<void> => ipcRenderer.invoke("display-picker:cancel"),
});
