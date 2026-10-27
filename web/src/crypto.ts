import sodium from 'libsodium-wrappers-sumo';
import type {Account,KeyBundle,Keys,LocalAccount,Operation,SecretRecord,Wrap} from './types';
export const ready = () => sodium.ready;
export const b64 = (v:Uint8Array) => sodium.to_base64(v,sodium.base64_variants.URLSAFE_NO_PADDING);
export const unb64 = (v:string) => sodium.from_base64(v,sodium.base64_variants.URLSAFE_NO_PADDING);
const utf8 = (v:string) => sodium.from_string(v);
export const random = (n=32) => sodium.randombytes_buf(n);
const aadRoot = (id:string) => `rememberKey:root:1:${id}`;
export function seal(data:Uint8Array,key:Uint8Array,aad:string):Wrap {
  const nonce=random(24); return {nonce:b64(nonce),ciphertext:b64(sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(data,utf8(aad),null,nonce,key))};
}
export function open(w:Wrap,key:Uint8Array,aad:string):Uint8Array {return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null,unb64(w.ciphertext),utf8(aad),unb64(w.nonce),key);}
function derive(password:string,salt:string){return sodium.crypto_pwhash(32,password,unb64(salt),3,67108864,sodium.crypto_pwhash_ALG_ARGON2ID13);}
export function wipe(keys:Keys|null){if(keys) for(const value of Object.values(keys)) sodium.memzero(value);}
export function validateBundle(value:unknown):asserts value is KeyBundle {
  const b=value as KeyBundle;
  if(!b || b.version!==1 || typeof b.salt!=='string' || unb64(b.salt).length!==16) throw Error('不支持的密钥包');
  for(const w of [b.passwordWrap,b.recoveryWrap,b.privateWrap]) if(!w || unb64(w.nonce).length!==24 || unb64(w.ciphertext).length<16 || unb64(w.ciphertext).length>16384) throw Error('密钥包损坏');
}
export function newDevice(account:Account,root:Uint8Array,signPrivate:Uint8Array){
  const deviceId=crypto.randomUUID(),pair=sodium.crypto_sign_keypair(),devicePublicKey=b64(pair.publicKey);
  const deviceName=`${navigator.platform || 'Web'} · ${new Date().toLocaleDateString('zh-CN')}`;
  const deviceWrap=seal(pair.privateKey,root,`rememberKey:device:1:${account.accountId}:${deviceId}`);
  const proof=b64(sodium.crypto_sign_detached(utf8(`rememberKey:device:1:${account.accountId}:${deviceId}:${devicePublicKey}`),signPrivate));
  return {local:{...account,deviceId,deviceName,devicePublicKey,deviceWrap},devicePrivate:pair.privateKey,registration:{accountId:account.accountId,id:deviceId,name:deviceName,publicKey:devicePublicKey,proof}};
}
export async function createAccount(username:string,password:string){
  await ready(); const accountId=crypto.randomUUID(),root=random(),salt=b64(random(16)),recoveryCode=b64(random());
  const sign=sodium.crypto_sign_keypair(),box=sodium.crypto_box_keypair(),derived=derive(password,salt);
  const keyBundle:KeyBundle={version:1,salt,passwordWrap:seal(root,derived,aadRoot(accountId)),recoveryWrap:seal(root,unb64(recoveryCode),aadRoot(accountId)),privateWrap:seal(utf8(JSON.stringify({signPrivateKey:b64(sign.privateKey),boxPrivateKey:b64(box.privateKey)})),root,`rememberKey:private:1:${accountId}`)};
  sodium.memzero(derived);
  const account:Account={accountId,username,signPublicKey:b64(sign.publicKey),boxPublicKey:b64(box.publicKey),keyBundle,bundleVersion:1};
  const device=newDevice(account,root,sign.privateKey);
  return {...device,recoveryCode,keys:{root,signPrivate:sign.privateKey,boxPrivate:box.privateKey,devicePrivate:device.devicePrivate} satisfies Keys};
}
export async function unlock(account:Account,credential:string,recovery=false):Promise<Omit<Keys,'devicePrivate'>> {
  await ready();validateBundle(account.keyBundle);
  const derived=recovery?unb64(credential):derive(credential,account.keyBundle.salt);
  let root:Uint8Array|undefined;
  try {
    root=open(recovery?account.keyBundle.recoveryWrap:account.keyBundle.passwordWrap,derived,aadRoot(account.accountId));
    const raw=open(account.keyBundle.privateWrap,root,`rememberKey:private:1:${account.accountId}`);
    let priv:{signPrivateKey:string;boxPrivateKey:string};try {priv=JSON.parse(sodium.to_string(raw));} finally{sodium.memzero(raw);}
    const signPrivate=unb64(priv.signPrivateKey),boxPrivate=unb64(priv.boxPrivateKey);
    if(b64(sodium.crypto_sign_ed25519_sk_to_pk(signPrivate))!==account.signPublicKey || b64(sodium.crypto_scalarmult_base(boxPrivate))!==account.boxPublicKey) throw Error('账户公钥校验失败');
    return {root,signPrivate,boxPrivate};
  }catch(error){if(root)sodium.memzero(root);throw error;}finally{sodium.memzero(derived);}
}
export function unlockDevice(local:LocalAccount,root:Uint8Array){return open(local.deviceWrap,root,`rememberKey:device:1:${local.accountId}:${local.deviceId}`);}
export function signMessage(message:string,privateKey:Uint8Array){return b64(sodium.crypto_sign_detached(utf8(message),privateKey));}
export function hash(value:string){return sodium.to_hex(sodium.crypto_hash_sha256(utf8(value)));}
export function opMessage(accountId:string,op:Omit<Operation,'signature'>){return `rememberKey:op:1:${accountId}:${op.operationId}:${op.id}:${op.baseRevision}:${op.deleted?'1':'0'}:${hash(op.envelope??'')}`;}
export function verifyOperation(account:Account,op:Operation){try{return sodium.crypto_sign_verify_detached(unb64(op.signature),utf8(opMessage(account.accountId,op)),unb64(account.signPublicKey));}catch{return false;}}
export function encryptRecord(account:Account,id:string,value:SecretRecord):string {
  const key=random();try {return JSON.stringify({version:1,...seal(utf8(JSON.stringify(value)),key,`rememberKey:record:1:${account.accountId}:${id}`),wrappedKey:b64(sodium.crypto_box_seal(key,unb64(account.boxPublicKey)))});}finally{sodium.memzero(key);}
}
export function decryptRecord(account:Account,keys:Keys,id:string,envelope:string):SecretRecord {
  const env=JSON.parse(envelope);if(env.version!==1)throw Error('不支持的记录版本');
  const key=sodium.crypto_box_seal_open(unb64(env.wrappedKey),unb64(account.boxPublicKey),keys.boxPrivate);
  try {const bytes=open(env,key,`rememberKey:record:1:${account.accountId}:${id}`);try{return validateRecord(JSON.parse(sodium.to_string(bytes)));}finally{sodium.memzero(bytes);}}finally{sodium.memzero(key);}
}
export function validateRecord(value:unknown):SecretRecord {
  const r=value as SecretRecord;
  if(!r || typeof r.name!=='string'|| !r.name.trim() || r.name.length>200 || typeof r.secret!=='string' || r.secret.length>32000 || typeof r.provider!=='string' || r.provider.length>200 || typeof r.url!=='string' || r.url.length>2000 || typeof r.notes!=='string' || r.notes.length>8000 || typeof r.expiresAt!=='string' || (r.expiresAt!==''&&!/^\d{4}-\d{2}-\d{2}(T.*)?$/.test(r.expiresAt)) || !Array.isArray(r.tags) || r.tags.some(t=>typeof t!=='string'||t.length>200) || r.tags.length>50 || utf8(JSON.stringify(r)).length>80000) throw Error('记录格式或长度不合法');
  return {name:r.name,provider:r.provider,secret:r.secret,url:r.url,notes:r.notes,expiresAt:r.expiresAt,tags:r.tags};
}
export function makeOperation(account:Account,keys:Keys,id:string,baseRevision:number,value:SecretRecord|null):Operation{
  const op={operationId:crypto.randomUUID(),id,baseRevision,deleted:value===null,envelope:value===null?null:encryptRecord(account,id,value)};
  return {...op,signature:signMessage(opMessage(account.accountId,op),keys.signPrivate)};
}
export function changePassword(account:Account,root:Uint8Array,password:string):KeyBundle {
  const salt=b64(random(16)),key=derive(password,salt);try{return {...account.keyBundle,salt,passwordWrap:seal(root,key,aadRoot(account.accountId))};}finally{sodium.memzero(key);}
}
export function safeUrl(value:string){try{const url=new URL(value);return ['https:','http:'].includes(url.protocol)?url.href:null;}catch{return null;}}
export function encryptedExport(local:LocalAccount,records:unknown[]){return {format:'rememberKey-encrypted-backup',version:1,exportedAt:new Date().toISOString(),account:{accountId:local.accountId,username:local.username,signPublicKey:local.signPublicKey,boxPublicKey:local.boxPublicKey,keyBundle:local.keyBundle,bundleVersion:local.bundleVersion??1},records};}
