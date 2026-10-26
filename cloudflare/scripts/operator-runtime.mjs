const legacy=['MODEL_SECRETS','MODEL_CONFIG','WEBHOOK_ROUTES'];
export function operatorRuntime(runtime){
 if(!runtime || typeof runtime!=='object')throw Error('operator_package_invalid');
 const names=Object.keys(runtime),additional=names.length===1 && /^CUSE_AGENT_[A-Z0-9_]{1,48}$/.test(names[0]);
 if((!additional && (names.length!==legacy.length || names.some(n=>!legacy.includes(n)))) || names.some(n=>typeof runtime[n]!=='string' || Buffer.byteLength(runtime[n])>5000))throw Error('operator_package_invalid');
 const item=additional?JSON.parse(runtime[names[0]]):undefined;
 const key=additional?names[0].slice('CUSE_AGENT_'.length).toLowerCase():undefined;
 const bindings=additional?{[key]:item?.binding}:JSON.parse(runtime.WEBHOOK_ROUTES);
 if(!Object.keys(bindings).length || Object.values(bindings).some(b=>b?.activationPending!==true) || (additional && (!item.modelConfig || !item.modelSecrets)))throw Error('operator_delivery_gate_required');
 return {names,additional,bindings,enable(routeKey){
  if(additional){if(routeKey!==key)throw Error('operator_route_mismatch');delete item.binding.activationPending;return {[names[0]]:JSON.stringify(item)};}
  for(const binding of Object.values(bindings))delete binding.activationPending;
  return {WEBHOOK_ROUTES:JSON.stringify(bindings)};
 }};
}
