/** Shared user-facing desktop links and status for native and Worker hosts. */
export function desktopViewerUrl(id:string,appUrl='https://app.computeruse.site'):string{
 const base=new URL(appUrl);
 if((base.protocol!=='https:' && !['localhost','127.0.0.1'].includes(base.hostname)) || base.username || base.password || base.search || base.hash)throw Error('desktop_viewer_configuration');
 return base.toString().replace(/\/+$/,'')+'/sessions/'+encodeURIComponent(id);
}
export function desktopStatusLine(id:string,state:string,paused:boolean,viewer:string):string{
 return `desktop ${id}: ${state}${paused?' (queue paused; ,desktop start to resume)':''} — ${viewer}`;
}
