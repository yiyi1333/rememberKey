import 'fake-indexeddb/auto';
import {beforeEach,describe,expect,it} from 'vitest';
import {acknowledge,applyChanges,clearLocal,getCursor,getOutbox,getRecords,queueOperation,resolveConflict} from './store';
import type {Operation,RemoteRecord} from './types';
const op=(id='record-1'):Operation=>({id,operationId:crypto.randomUUID(),baseRevision:0,deleted:false,envelope:'ciphertext-only',signature:'signed'});
beforeEach(clearLocal);
describe('transactional encrypted outbox',()=>{
 it('persists record and exact signed operation together and forbids double pending edits',async()=>{const a=op();await queueOperation(a);expect(await getOutbox()).toEqual([a]);expect((await getRecords())[0].envelope).toBe(a.envelope);await expect(queueOperation({...a,operationId:crypto.randomUUID()})).rejects.toThrow();expect(await getOutbox()).toHaveLength(1);});
 it('keeps both sides of conflict until explicit user resolution',async()=>{const a=op();await queueOperation(a);const remote:RemoteRecord={...op(),revision:1};await acknowledge(a.operationId,'conflict',remote);expect((await getOutbox())[0].conflict).toEqual(remote);expect((await getRecords())[0].operationId).toBe(a.operationId);await resolveConflict((await getOutbox())[0],null);expect(await getOutbox()).toHaveLength(0);expect(await getRecords()).toEqual([remote]);});
 it('pull never overwrites pending data and atomically updates cursor',async()=>{const a=op();await queueOperation(a);const remote:RemoteRecord={...op(),revision:1};await applyChanges([remote],12);expect((await getRecords())[0].operationId).toBe(a.operationId);expect((await getOutbox())[0].conflict).toEqual(remote);expect(await getCursor()).toBe(12);});
 it('recognizes an already-applied operation after a dropped response',async()=>{const a=op();await queueOperation(a);const remote={...a,revision:1};await applyChanges([remote],3);expect(await getOutbox()).toHaveLength(0);expect(await getRecords()).toEqual([remote]);});
 it('applied acknowledgments remove outbox only together with remote record',async()=>{const a=op();await queueOperation(a);await expect(acknowledge(a.operationId,'applied',null)).rejects.toThrow();expect(await getOutbox()).toHaveLength(1);await acknowledge(a.operationId,'applied',{...a,revision:1});expect(await getOutbox()).toHaveLength(0);expect((await getRecords())[0].revision).toBe(1);});
});
