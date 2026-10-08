import assert from 'node:assert/strict';
import {WebSocket} from 'ws';import {spawn} from 'node:child_process';import {once} from 'node:events';
const child=spawn(process.execPath,['server.mjs'],{env:{...process.env,PORT:'10002',OWNER_PASSWORD:'test-owner',ADMIN_PASSWORD:'test-admin'},stdio:['ignore','pipe','inherit']});await once(child.stdout,'data');const sockets=[];
async function client(){const s=new WebSocket('ws://127.0.0.1:10002/rooms');sockets.push(s);await once(s,'open');let n=0;const calls=new Map();s.on('message',raw=>{const d=JSON.parse(raw),p=calls.get(d.requestId);if(p){calls.delete(d.requestId);d.error?p.reject(Error(d.error)):p.resolve(d.data)}});return {s,call:b=>new Promise((resolve,reject)=>{const requestId=++n;calls.set(requestId,{resolve,reject});s.send(JSON.stringify({...b,requestId}))})};}

try{
 const host=await client(),guest=await client(),outsider=await client();
 const hr=await host.call({action:'create',map:'blue',name:'Host'}),gr=await guest.call({action:'join',roomId:hr.code,name:'Guest'});await outsider.call({action:'create',map:'blue',name:'Other'});
 const received=[],other=[];guest.s.on('message',r=>{const m=JSON.parse(r);if(m.event==='chat')received.push(m)});outsider.s.on('message',r=>{const m=JSON.parse(r);if(m.event==='chat')other.push(m)});
 await assert.rejects(outsider.call({...hr,action:'chat',text:'wrong room'}),/sesión/);
 await host.call({...hr,action:'chat',text:'Hola <img src=x onerror=alert(1)>',name:'Dvrxx',role:'owner'});
 await new Promise(r=>setTimeout(r,50));assert.equal(received.length,1);assert.equal(other.length,0);assert.equal(received[0].message.name,'Host');assert.equal(received[0].message.role,null);assert.match(received[0].message.text,/<img/);
 await assert.rejects(host.call({...hr,action:'chat',text:'spam'}),/Espera/);await assert.rejects(guest.call({...gr,action:'chat',text:' '}),/Escribe/);await assert.rejects(guest.call({...gr,action:'chat',text:'x'.repeat(241)}),/240/);
 await host.call({action:'adminAuth',username:'Dvrxx',key:'test-owner'});await new Promise(r=>setTimeout(r,760));await host.call({...hr,action:'chat',text:'Owner message'});
 const late=await client(),lr=await late.call({action:'join',roomId:hr.code});assert.equal(lr.chat.length,2);assert.equal(lr.chat[1].role,'owner');assert.equal(lr.chat[1].name,'Dvrxx');await guest.call({...gr,action:'leave'});await assert.rejects(guest.call({...gr,action:'chat',text:'after leave'}),/sesión/);
 console.log('PASS room-only delivery, verified names/roles, history, limits, spam protection and membership checks');
}finally{for(const s of sockets)s.close();child.kill();}
