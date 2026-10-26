import wasm from '../node_modules/@bokuweb/zstd-wasm/dist/esm/zstd.wasm';
import {Module,waitInitialized} from '../node_modules/@bokuweb/zstd-wasm/dist/esm/module.js';
import {compress} from '../node_modules/@bokuweb/zstd-wasm/dist/esm/simple/compress.js';
import {codexRequestFetch} from './codex-encoding.ts';
let ready:Promise<void>|undefined;
async function initialize():Promise<void>{
 Module.instantiateWasm=(imports:WebAssembly.Imports,receive:(instance:WebAssembly.Instance,module:WebAssembly.Module)=>void)=>{
  const instance=new WebAssembly.Instance(wasm,imports);receive(instance,wasm);return instance.exports;
 };
 Module.init('');await waitInitialized();
}
/** Precompiled module import: no runtime WASM compilation, filesystem or network. */
export async function compressCodexRequest(input:Uint8Array):Promise<Uint8Array>{
 await (ready??=initialize());return compress(input,3);
}
export const workerCodexFetch=codexRequestFetch(compressCodexRequest);
