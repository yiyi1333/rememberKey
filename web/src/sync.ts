import type {LocalAccount,RemoteRecord} from './types';
import {api,post} from './api';
import {verifyOperation} from './crypto';
import {acknowledge,applyChanges,getCursor,getOutbox} from './store';
let running:Promise<void>|null=null;
function check(account:LocalAccount,record:RemoteRecord){if(!verifyOperation(account,record))throw Error('同步签名校验失败，已拒绝不可信的远端记录');if(record.revision!==record.baseRevision+1)throw Error('远端版本信息无效');}
async function pull(account:LocalAccount){
  let more=true;
  while(more){const cursor=await getCursor();const page=await api<{changes:RemoteRecord[];cursor:number;hasMore:boolean}>(`/sync/changes?cursor=${cursor}&limit=100`);if(!Number.isSafeInteger(page.cursor)||page.cursor<cursor||page.hasMore&&page.cursor===cursor)throw Error('无效同步游标');for(const record of page.changes)check(account,record);await applyChanges(page.changes,page.cursor);more=page.hasMore;}
}
export function synchronize(account:LocalAccount){return running??=(async()=>{
  // Pull first: verify remote history, acknowledge our lost responses and mark
  // competing revisions before deciding which exact signed operations to submit.
  await pull(account);
  const outbox=(await getOutbox()).filter(op=>!('conflict' in op));
  for(let offset=0;offset<outbox.length;offset+=100){const operations=outbox.slice(offset,offset+100);const response=await post<{results:{operationId:string;status:'applied'|'conflict';record:RemoteRecord|null}[]}>('/sync/operations',{operations});
    for(const result of response.results){const submitted=operations.find(op=>op.operationId===result.operationId);if(!submitted)throw Error('服务端操作响应不匹配');if(result.record){check(account,result.record);if(result.record.id!==submitted.id)throw Error('服务端记录 ID 不匹配');}if(result.status!=='applied'&&result.status!=='conflict')throw Error('无效同步状态');if(result.status==='applied'&&(!result.record||result.record.operationId!==submitted.operationId||result.record.signature!==submitted.signature))throw Error('已应用的操作与本地签名不匹配');await acknowledge(result.operationId,result.status,result.record);}
  }
  // Close the race with other devices and advance cursor over our own commits.
  await pull(account);
})().finally(()=>{running=null;});}
