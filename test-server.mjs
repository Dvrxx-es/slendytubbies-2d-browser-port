import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
const base=process.env.TEST_SERVER||'http://127.0.0.1:10001';
const processServer=process.env.TEST_SERVER?null:spawn(process.execPath,['server.mjs'],{env:{...process.env,PORT:'10001'},stdio:['ignore','pipe','inherit']});
if(processServer)await once(processServer.stdout,'data');
const opened=[];
async function client(){const s=new WebSocket(base.replace(/^http/,'ws')+'/rooms',{origin:base});opened.push(s);await once(s,'open');let serial=0;const pending=new Map();s.on('message',raw=>{const b=JSON.parse(raw);const p=pending.get(b.requestId);if(p){pending.delete(b.requestId);clearTimeout(p.timer);b.error?p.reject(Error(b.error)):p.resolve(b.data)}});return {s,call(payload){return new Promise((resolve,reject)=>{const requestId=++serial;const timer=setTimeout(()=>reject(Error('Timeout')),10000);pending.set(requestId,{resolve,reject,timer});s.send(JSON.stringify({...payload,requestId}))})}};}
try{
 const health=await fetch(base+'/health');assert.equal(health.status,200);assert.equal((await health.json()).transport,'websocket');
 const home=await fetch(base);assert.equal(home.status,200);const homeText=await home.text();assert.match(homeText,/Character Customization/);assert.match(homeText,/public-room-list/);
 const host=await client(),hostRoom=await host.call({action:'create',map:'mainland',roomName:'Partida pública',name:'Anfitrión'});
 const listing=await host.call({action:'list'});assert.equal(listing.rooms.length,1);assert.equal(listing.rooms[0].name,'Partida pública');assert.equal(listing.rooms[0].players,1);
 const guests=await Promise.all([client(),client(),client(),client()]);
 const joined=await Promise.allSettled(guests.map((g,i)=>g.call({action:'join',roomId:hostRoom.roomId,name:'Jugador '+i})));
 assert.equal(joined.filter(r=>r.status==='fulfilled').length,3);assert.equal(joined.filter(r=>r.status==='rejected').length,1);
 const guestIndex=joined.findIndex(r=>r.status==='fulfilled'),guest=guests[guestIndex],guestRoom=joined[guestIndex].value;
 const world={status:'play',time:12,taken:[true,...Array(9).fill(false)],foes:[{x:300,y:300,direction:2}],dead:[]};
 await host.call({...hostRoom,action:'sync',position:{x:100,y:100,direction:0},world});
 const state=await guest.call({...guestRoom,action:'sync',position:{x:150,y:100,direction:2},world:{...world,status:'won',taken:Array(10).fill(true)}});
 assert.equal(state.world.status,'play');assert.equal(state.world.taken.filter(Boolean).length,1);assert.equal(state.players.length,4);
 await assert.rejects(guest.call({...guestRoom,action:'sync',position:{x:-1,y:1,direction:0}}),/Posición/);
 await host.call({...hostRoom,action:'sync',position:{x:5600,y:5600,direction:0},world:{...world,foes:[{x:5500,y:5500,direction:0}]}});
 await assert.rejects(guest.call({...guestRoom,action:'sync',position:{x:5735,y:100,direction:0}}),/Posición/);
 await assert.rejects(guest.call({...guestRoom,token:'invalid',action:'sync',position:null}),/sesión/);
 const extra=await client();await assert.rejects(extra.call({action:'join',roomId:hostRoom.roomId,name:'Late'}),/comenzó/);
 await guest.call({...guestRoom,action:'leave'});const left=await host.call({...hostRoom,action:'sync',position:null,world});assert.equal(left.players.length,3);
 await host.call({...hostRoom,action:'leave'});await assert.rejects(extra.call({action:'join',roomId:hostRoom.roomId}),/no existe/);
 await assert.rejects(host.call({action:'create',map:'caves',custardCount:26}),/1 y 25/);
 const host2=await host.call({action:'create',map:'caves',custardCount:25});const extra2=await extra.call({action:'join',roomId:host2.roomId});assert.equal(extra2.custardCount,25);await assert.rejects(host.call({...host2,action:'sync',position:null,world}),/Estado/);await host.call({...host2,action:'sync',position:null,world:{...world,taken:Array(25).fill(false)}});
 const closeNotice=once(extra.s,'message');host.s.close();const [notice]=await closeNotice;assert.equal(JSON.parse(notice).event,'closed');
 console.log('PASS real WebSocket rooms: four-player limit, shared progress, host authority, validation, late joins, leave and host disconnect.');
}finally{for(const s of opened)s.close();if(processServer)processServer.kill();}


