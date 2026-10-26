/** Deliberately recognizes only the legacy URL/body inspection expression.
 * No evaluation, substitutions, arbitrary JavaScript, navigation or actions. */
export function readOnlyBrowserProbe(code:unknown):boolean {
 return typeof code==='string' && /^console\.log\(\(await mcp\.callTool\('browser','browser_execute',\{tab:'[A-Za-z0-9_-]{1,100}',operations:\[\{type:'evaluate',params:\{script:'\(\{url:location\.href,text:document\.body\.innerText\.slice\(0,[1-9][0-9]{0,5}\)\}\)'\}\}\]\}\)\)\.content\[0\]\.text\);$/.test(code);
}

/** Only typed adapters whose contract cannot dispatch a user action. */
export function isReadOnlyRemoteTool(target:string,name:string):boolean {
  return target==='irc' && name==='weechat_buffers'
    || target==='desktop' && ['skills_list','skills_read'].includes(name);
}
