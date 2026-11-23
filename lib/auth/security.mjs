import {createHash,randomBytes,scrypt as scryptCallback,timingSafeEqual} from 'node:crypto';
import {promisify} from 'node:util';
const scrypt=promisify(scryptCallback);
export const sha256=value=>createHash('sha256').update(value,'utf8').digest('hex');
export const randomSecret=()=>randomBytes(32).toString('base64url');
export async function passwordHash(password) {
  if (typeof password!=='string' || [...password].length<12 || password.length>1024) throw new Error('管理员密码需为12至1024字符，请在本机终端设置');
  const salt=randomBytes(16).toString('hex');
  const key=await scrypt(password,salt,64,{N:16384,r:8,p:1,maxmem:64*1024*1024});
  return `scrypt:16384:8:1:${salt}:${key.toString('hex')}`;
}
export async function verifyPassword(password, encoded) {
  if (typeof password!=='string' || password.length>1024 || !/^scrypt:16384:8:1:[a-f0-9]{32}:[a-f0-9]{128}$/.test(encoded || '')) return false;
  const [,n,r,p,salt,expected]=encoded.split(':');
  const key=await scrypt(password,salt,64,{N:Number(n),r:Number(r),p:Number(p),maxmem:64*1024*1024});
  return timingSafeEqual(key,Buffer.from(expected,'hex'));
}
export function equalHash(left,right) {
  return /^[a-f0-9]{64}$/.test(left || '') && /^[a-f0-9]{64}$/.test(right || '') && timingSafeEqual(Buffer.from(left,'hex'),Buffer.from(right,'hex'));
}
