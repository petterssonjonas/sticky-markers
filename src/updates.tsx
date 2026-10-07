import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ArrowDownToLine, RefreshCw, X, Bell } from "lucide-react";
import { desktop } from "./api";
import { version } from "../package.json";

export interface UpdateStatus {
  phase: "idle" | "checking" | "available" | "downloading" | "ready" | "installing" | "error" | "upToDate";
  currentVersion: string;
  version: string | null;
  notes: string | null;
  progress: number;
  ready: boolean;
  error: string | null;
  message: string | null;
  method: "appimage" | "flatpak" | "native";
}
const initial: UpdateStatus = {phase:"idle",currentVersion:version,version:null,notes:null,progress:0,ready:false,error:null,message:null,method:"native"};
function useUpdates() {
  const [status,setStatus]=useState(initial);
  useEffect(()=>{
    if (!desktop) return;
    let live=true;
    void invoke<UpdateStatus>("update_status").then(s=>{if(live)setStatus(s);});
    const un=listen<UpdateStatus>("update-status", e=>{if(live)setStatus(e.payload);});
    return ()=>{live=false;void un.then(f=>f());};
  },[]);
  return {status,setStatus};
}
export function UpdatePanel() {
  const {status,setStatus}=useUpdates();
  const [error,setError]=useState("");
  const [working,setWorking]=useState(false);
  const busy=working || ["checking","downloading","installing"].includes(status.phase);
  const run=async(command:string)=>{
    setError("");
    if(!desktop){setError("Update checks and installation are available in the desktop app. This browser preview is a UI demo.");return;}
    setWorking(true);
    try{
      const next=await invoke<UpdateStatus|null>(command);
      if(next)setStatus(next);
    }catch(e){setError(String(e));}finally{setWorking(false);}
  };
  return <div className="update-panel">
    <div className="update-heading"><RefreshCw size={22}/><div><h3>Keep your little space up to date.</h3><p>Installed version {status.currentVersion}</p></div></div>
    <p>Updates come from Sticky Markers releases on GitHub. Downloads are signed and verified before installation. Every open note is saved before restarting.</p>
    <button className="secondary" disabled={busy || status.ready} onClick={()=>void run("update_check")}><RefreshCw size={16}/>{status.phase==="checking"?"Checking…":"Check for updates"}</button>
    {status.phase==="upToDate"&&<p role="status" className="success-banner">You have the latest published version.</p>}
    {status.version&&<div className="update-release"><strong>Version {status.version}</strong>{status.notes&&<pre className="release-notes">{status.notes}</pre>}</div>}
    {status.method==="appimage"&&<p className="muted">Linux updates install an AppImage for your user account. Your notes stay in the same folders. Your original system package remains installed and can also be updated through your package manager.</p>}
    {status.method==="flatpak"&&<p className="muted">This updates your user Flatpak installation from the signed bundle in the GitHub release.</p>}
    {status.message&&<p role="status">{status.message}</p>}
    {status.phase==="downloading"&&<div className="update-progress"><progress max={100} value={status.progress}/><span>{status.progress?`${status.progress}%` : "Downloading…"}</span></div>}
    {(error||status.error)&&<p role="alert" className="error-banner">{error||status.error}</p>}
    {status.version&&!status.ready&&<button className="primary" disabled={busy} onClick={()=>void run("update_download")}><ArrowDownToLine size={16}/>{status.phase==="downloading"?"Downloading…":"Download update"}</button>}
    {status.ready&&<button className="primary" disabled={busy} onClick={()=>void run("update_restart")}><RefreshCw size={16}/>{status.phase==="installing"?"Saving notes and installing…":"Restart and install"}</button>}
  </div>;
}
export function UpdateNotice() {
  const {status}=useUpdates();
  const [open,setOpen]=useState(new URLSearchParams(location.search).has("updates"));
  const [dismissed,setDismissed]=useState("");
  useEffect(()=>{
    if(!desktop)return;
    const un=listen("show-updates",()=>setOpen(true));
    return()=>{void un.then(f=>f());};
  },[]);
  const visible=status.version&&dismissed!==status.version;
  return <>
    {visible&&!open&&<div className="update-notice" role="status"><Bell size={16}/><span>{status.ready?"Update ready to install":"Update available"} · {status.version}</span><button onClick={()=>setOpen(true)}>Review</button><button aria-label="Dismiss update notification" onClick={()=>setDismissed(status.version!)}><X size={14}/></button></div>}
    {open&&<div className="modal-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget)setOpen(false);}}><section className="update-dialog" role="dialog" aria-modal="true" aria-label="App updates"><header><h2>App updates</h2><button className="icon-button" aria-label="Close app updates" onClick={()=>setOpen(false)}><X size={18}/></button></header><UpdatePanel/></section></div>}
  </>;
}
