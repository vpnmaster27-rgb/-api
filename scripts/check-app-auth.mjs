import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { authRouter } from '../src/routes/auth.js';
import { withDb,shutdown } from '../src/db.js';
import { tokenHash } from '../src/authSessions.js';

// Uses one temporary account; finally deletes it and all dependent rows.
let userId;
const app=express(); app.use(express.json()); app.use('/api',authRouter);
app.use((e,_req,res,_next)=>{console.error(e.message);res.status(500).json({message:'check failed'});});
const server=app.listen(0,'127.0.0.1');
await new Promise(resolve=>server.on('listening',resolve));
const call=async(path,body,token)=>{
  const r=await fetch(`http://127.0.0.1:${server.address().port}/api${path}`,{method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},body:JSON.stringify(body)});
  return {status:r.status,data:await r.json()};
};
try {
  const account=2000000000+Math.floor(Math.random()*100000000);
  const [u]=await withDb(c=>c.query("INSERT INTO public.users(account,username,password,group_label) VALUES($1,$2,'1234','一般機電') RETURNING id",[account,`auth-check-${randomUUID()}`]));
  userId=u.id;
  assert.equal((await call('/login',{account,password:'wrong'})).status,401);
  const first=await call('/login',{account,password:'1234'});
  assert.equal(first.status,200); assert.equal(first.data.mustChangePassword,true); assert.ok(first.data.token);
  assert.equal((await call('/session/resume',{})).status,401);
  for (const [password,confirmation] of [['123','123'],['12345678901','12345678901'],['1234','5678']]) {
    assert.equal((await call('/password/change',{password,confirmation},first.data.token)).status,400);
  }
  // Initial password may be reused.
  const changed=await call('/password/change',{password:'1234',confirmation:'1234'},first.data.token);
  assert.equal(changed.status,200); assert.equal(changed.data.mustChangePassword,false);
  assert.equal((await call('/session/resume',{},first.data.token)).status,401);
  const [stored]=await withDb(c=>c.query('SELECT password,must_change_password FROM public.users WHERE id=$1',[userId]));
  assert.equal(stored.password,'1234'); assert.equal(stored.must_change_password,false);
  const login=await call('/login',{account,password:'1234'}); assert.equal(login.status,200);
  const second=await call('/password/change',{password:'1234567890',confirmation:'1234567890'},login.data.token);
  assert.equal(second.status,200);
  assert.equal((await call('/login',{account,password:'1234'})).status,401);
  const newLogin=await call('/login',{account,password:'1234567890'}); assert.equal(newLogin.status,200);
  const deviceId=randomUUID();
  assert.equal((await call('/devices/bind',{deviceId,pushToken:'ExpoPushToken[auth-check]',enabled:true},newLogin.data.token)).status,200);
  // An older in-flight bind cannot overwrite a newer session's notification settings.
  assert.equal((await call('/devices/bind',{deviceId,pushToken:null,enabled:false},second.data.token)).status,200);
  const [bound]=await withDb(c=>c.query('SELECT enabled FROM public.app_devices WHERE device_id=$1',[deviceId]));
  assert.equal(bound.enabled,true);
  assert.equal((await call('/session/logout',{},newLogin.data.token)).status,200);
  assert.equal((await call('/session/resume',{},newLogin.data.token)).status,401);
  const [device]=await withDb(c=>c.query('SELECT last_user_id FROM public.app_devices WHERE device_id=$1',[deviceId]));
  assert.equal(Number(device.last_user_id),Number(userId));
  await withDb(c=>c.query("UPDATE public.app_sessions SET last_active_at=NOW()-INTERVAL '11 minutes' WHERE token_hash=$1",[tokenHash(second.data.token)]));
  assert.equal((await call('/session/resume',{},second.data.token)).status,401);
  console.log('PASS: login, mandatory change, 4–10 bounds, confirmation, initial reuse, plaintext writeback, new login, token rotation, expiry, logout keeps device owner');
} finally {
  if(userId) await withDb(c=>c.query('DELETE FROM public.users WHERE id=$1',[userId]));
  await new Promise(resolve=>server.close(resolve)); await shutdown();
}
