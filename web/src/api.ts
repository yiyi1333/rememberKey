let bearer:string|null=null;
export function clearSession(){bearer=null;}
export class ApiError extends Error {constructor(public status:number,public code:string,message:string){super(message);}}
let refreshing:Promise<void>|null=null;
export async function api<T>(path:string,options:RequestInit={},retry=true):Promise<T>{
  const headers=new Headers(options.headers);if(options.body)headers.set('Content-Type','application/json');if(bearer)headers.set('Authorization',`Bearer ${bearer}`);
  const response=await fetch(`/api/v1${path}`,{...options,headers,credentials:'include',cache:'no-store'});
  if(response.status===401 && retry && !path.startsWith('/auth/')){try{await (refreshing??=refresh().finally(()=>{refreshing=null;}));return api<T>(path,options,false);}catch{clearSession();throw new ApiError(401,'UNAUTHORIZED','登录已过期或设备已撤销，请重新解锁登录');}}
  if(response.status===204)return undefined as T;
  const json=await response.json();if(!response.ok)throw new ApiError(response.status,json.error?.code??'HTTP_ERROR',json.error?.message??'请求失败');
  return json.data as T;
}
export const post=<T>(path:string,body?:unknown)=>api<T>(path,{method:'POST',body:body===undefined?undefined:JSON.stringify(body)});
export async function refresh(){const session=await post<{accessToken:string}>('/auth/refresh');bearer=session.accessToken;}
export async function authenticate(accountId:string,deviceId:string,sign:(message:string)=>string){const challenge=await post<{id:string;message:string}>('/auth/challenges',{accountId,deviceId});const session=await post<{accessToken:string}>('/auth/sessions',{challengeId:challenge.id,signature:sign(challenge.message)});bearer=session.accessToken;}
export async function logout(){try{await api('/auth/sessions',{method:'DELETE'});}finally{clearSession();}}
