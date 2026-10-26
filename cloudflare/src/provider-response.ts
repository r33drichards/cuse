import {defineDocFamily} from '@earendil-works/pi-durable';
import type {ProviderResponse} from '@earendil-works/pi-ai';

export type ResponseMetadata={status:number;rayId:string|null;contentType:string|null;at:number};
/** Existing family stays compatible; older records simply have no HTTP metadata. */
export const ModelFailure=defineDocFamily<{category:string|null;http?:ResponseMetadata},null>({family:true,kind:'cuse.model-failure',version:1,scope:'session',initial:()=>({category:null})});

/** Deliberate allowlist: never retain arbitrary response headers or body data. */
export function responseMetadata(response:ProviderResponse,at=Date.now()):ResponseMetadata|undefined{
 if(!Number.isInteger(response.status) || response.status<100 || response.status>599)return;
 const header=(name:string)=>Object.entries(response.headers).find(([key])=>key.toLowerCase()===name)?.[1];
 const ray=header('cf-ray'),mime=header('content-type')?.split(';')[0].trim().toLowerCase();
 return {status:response.status,rayId:ray && /^[a-f0-9]{16}(?:-[a-z0-9]{3,10})?$/i.test(ray)?ray:null,contentType:mime && mime.length<=80 && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(mime)?mime:null,at};
}
