/** Never requests mail or changes a real account. No response bodies in logs. */
import { randomBytes, randomUUID } from 'node:crypto';
import { gate } from './auth-local-core.js';

function errorCode(value:unknown):unknown {
  if(!value || typeof value!=='object' || !('error' in value)) return undefined;
  const error=value.error;
  return error && typeof error==='object' && 'code' in error ? error.code : undefined;
}
async function smoke():Promise<void> {
  const [port,...extra]=process.argv.slice(2);gate(['3000','3001'].includes(port ?? '') && !extra.length);
  const base=`http://127.0.0.1:${port}/api`;
  const post=(route:string,body:unknown)=>fetch(`${base}${route}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
  gate((await fetch(`${base}/health`,{signal:AbortSignal.timeout(5000)})).status===200);
  const invalid=await post('/auth/password-recovery/verify',{});gate(invalid.status===400 && invalid.headers.get('cache-control')==='no-store');
  const payload={email:`smoke-${randomUUID()}@example.test`,resetToken:randomBytes(32).toString('base64url'),password:'Abcdef!'};
  const short=await post('/auth/password-recovery/complete',payload);gate(short.status===400 && errorCode(await short.json())==='VALIDATION_ERROR');
  const eight=await post('/auth/password-recovery/complete',{...payload,password:'Abcdefg!'});gate(eight.status===400 && errorCode(await eight.json())==='INVALID_RECOVERY_CODE' && eight.headers.get('cache-control')==='no-store');
  gate((await fetch(`${base}/platform/companies`,{signal:AbortSignal.timeout(5000)})).status===401);
  gate((await post('/invitations/accept',{})).status===404);
  console.log(`RECOVERY_DEV_SMOKE_OK port=${port} health=true verifyRoute=true min8=true noContextDenied=true invitationsDisabled=true noEmailRequested=true`);
}
await smoke().catch(()=>{console.error('RECOVERY_DEV_SMOKE_FAILED; sin detalles privados.');process.exitCode=1;});
