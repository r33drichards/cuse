/** Deliberately recognizes only the legacy URL/body inspection expression.
 * No evaluation, substitutions, arbitrary JavaScript, navigation or actions. */
export function readOnlyBrowserProbe(code:unknown):boolean {
 return typeof code==='string' && /^console\.log\(\(await mcp\.callTool\('browser','browser_execute',\{tab:'[A-Za-z0-9_-]{1,100}',operations:\[\{type:'evaluate',params:\{script:'\(\{url:location\.href,text:document\.body\.innerText\.slice\(0,[1-9][0-9]{0,5}\)\}\)'\}\}\]\}\)\)\.content\[0\]\.text\);$/.test(code);
}
