import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const entry = path.join(path.dirname(fileURLToPath(import.meta.url)), 'index-live.html');
const maps = new Set(['mainland','mainland_s3','caves','mountains','lair','station','outskirts','outskirts_dawn','lake','school','reject','dream','maze','blue']);
const rooms = new Map();
const adminAttempts=new Map();
const accountDigests={Dvrxx:{role:'owner',digest:process.env.OWNER_PASSWORD?createHash('sha256').update(process.env.OWNER_PASSWORD).digest():null},Chiflis3:{role:'admin',ownerPowers:true,digest:process.env.ADMIN_PASSWORD?createHash('sha256').update(process.env.ADMIN_PASSWORD).digest():null}};
const enemyKinds=new Set(['default','none','tinky','tank','dipsy','laalaa','ghost','shadow','crawler','yeti','cave','po','spider','newborn']);
const isAdmin=ws=>ws.adminUntil>Date.now()&&['owner','admin'].includes(ws.role);
const roleOf=ws=>isAdmin(ws)?ws.role:null;
function roomConfig(room){return {map:room.map,custardCount:room.custardCount,enemy:room.enemy||'default',mapScale:room.mapScale||1,revision:room.revision||0};}
function closeRoom(room){rooms.delete(room.code);for(const m of room.members.values()){m.socket.member=null;send(m.socket,{event:'closed',error:'El administrador cerró la sala.'});}}
function adminAction(ws,b){
 if(b.action==='adminAuth'){
  const now=Date.now(),attempt=adminAttempts.get(ws.adminIp)||{since:now,count:0};if(now-attempt.since>60000){attempt.since=now;attempt.count=0;}if(++attempt.count>5)throw Error('Demasiados intentos. Espera un minuto.');adminAttempts.set(ws.adminIp,attempt);
  const digest=createHash('sha256').update(typeof b.key==='string'?b.key:'').digest();const account=Object.hasOwn(accountDigests,b.username||'')?accountDigests[b.username]:null;if(!account?.digest||!timingSafeEqual(account.digest,digest))throw Error('Clave de administrador incorrecta o no configurada');ws.adminUntil=now+3600000;ws.role=account.role;ws.ownerPowers=account.role==='owner'||account.ownerPowers===true;ws.username=b.username;if(ws.member)ws.member.name=ws.username;return {ok:true,role:ws.role,ownerPowers:ws.ownerPowers,username:ws.username};
 }
 if(!isAdmin(ws))throw Error('Inicia sesión como administrador');
 if(b.action==='adminLogout'){ws.adminUntil=0;ws.invincible=false;return {ok:true};}
 if(b.action==='adminList')return {rooms:[...rooms.values()].map(r=>({id:r.code,name:r.name,...roomConfig(r),players:[...r.members.values()].map(m=>({id:m.id,name:m.name,host:m.id===r.host}))}))};
 if(b.action==='adminInvincible'){ws.invincible=b.enabled===true;return {enabled:ws.invincible};}
 const room=rooms.get(b.roomId);if(!room)throw Error('La sala ya no existe');
 if(b.action==='adminClose'){closeRoom(room);return {ok:true};}
 if(b.action==='adminKick'){const member=room.members.get(b.playerId);if(!member)throw Error('Jugador no encontrado');if(!ws.ownerPowers&&roleOf(member.socket)==='owner')throw Error('Un ADMIN no puede expulsar al OWNER');if(member.id===room.host){closeRoom(room);}else{room.members.delete(member.id);member.socket.member=null;send(member.socket,{event:'closed',error:'El administrador te expulsó de la sala.'});}return {ok:true};}
 if(b.action==='adminSpawn'){
  if(!ws.ownerPowers)throw Error('Solo permisos OWNER pueden generar objetos');if(ws.member?.code!==room.code||room.world.status!=='play')throw Error('Debes estar jugando en esa sala');
  if(!pos({...b.position,direction:0},room.map,room.mapScale||1))throw Error('Posición inválida');
  if(b.kind==='custard'){if(room.custardCount>=25)throw Error('Máximo 25 papillas');room.custardCount++;room.world.taken.push(false);}else{if(!enemyKinds.has(b.kind)||['default','none'].includes(b.kind))throw Error('Monstruo inválido');if(room.world.foes.length>=12)throw Error('Máximo 12 monstruos');room.world.foes.push({...b.position,direction:0,kind:b.kind});}
  room.revision=(room.revision||0)+1;for(const m of room.members.values())send(m.socket,{event:'adminSpawn',kind:b.kind,position:b.position,revision:room.revision,custardCount:room.custardCount});return {ok:true};
 }
 if(b.action==='adminConfig'){
  if(!ws.ownerPowers&&(b.custardCount!==room.custardCount||(b.mapScale??1)!==(room.mapScale||1)))throw Error('Solo OWNER puede cambiar el tamaño o las papillas');
  if(![0.75,1,1.25,1.5,2].includes(b.mapScale??1))throw Error('Tamaño inválido');
  if(!maps.has(b.map)||!Number.isInteger(b.custardCount)||b.custardCount<1||b.custardCount>25||!enemyKinds.has(b.enemy))throw Error('Configuración inválida');
  room.map=b.map;room.mapScale=b.mapScale??1;room.custardCount=b.custardCount;room.enemy=b.enemy;room.revision=(room.revision||0)+1;room.world={status:'lobby',taken:Array(b.custardCount).fill(false),foes:[],dead:[],time:0};for(const m of room.members.values()){m.position=null;send(m.socket,{event:'adminConfig',config:roomConfig(room)});}return {ok:true};
 }
 throw Error('Acción de administrador inválida');
}
const mime = {'.html':'text/html; charset=utf-8','.png':'image/png','.ogg':'audio/ogg','.ttf':'font/ttf','.js':'text/javascript; charset=utf-8'};
const server = http.createServer(async (req,res) => {
  if (req.url === '/health') { res.writeHead(200, {'Content-Type':'application/json'}); return res.end('{"ok":true,"transport":"websocket"}'); }
  if (!['GET','HEAD'].includes(req.method)) { res.writeHead(405); return res.end(); }
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const file = pathname === '/' ? entry : path.resolve(root, '.' + pathname);
    if (pathname !== '/' && !file.startsWith(root + path.sep)) throw Error();
    const info = await stat(file); if (!info.isFile()) throw Error();
    res.writeHead(200, {'Content-Type':mime[path.extname(file)]||'application/octet-stream','Content-Length':info.size,'Cache-Control':file.endsWith('.html')?'no-cache':'public, max-age=3600','X-Content-Type-Options':'nosniff','Referrer-Policy':'strict-origin-when-cross-origin'});
    if (req.method === 'HEAD') res.end(); else createReadStream(file).on('error',()=>res.destroy()).pipe(res);
  } catch { res.writeHead(404); res.end('Not found'); }
});
const sockets = new WebSocketServer({noServer:true,maxPayload:12000,perMessageDeflate:false});
server.on('upgrade',(req,socket,head)=>{
  let allowed = false;
  try { const origin = req.headers.origin; allowed = req.url === '/rooms' && (!origin || new URL(origin).host === req.headers.host || (process.env.ALLOWED_ORIGINS||'').split(',').includes(origin)); } catch {}
  if (!allowed || sockets.clients.size >= 400) { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
  sockets.handleUpgrade(req,socket,head,ws=>{ws.adminIp=req.socket.remoteAddress;sockets.emit('connection',ws)});
});
// Mainland scenery and collision geometry are enlarged by the same 1.4 scale
// used by the browser client. Keep the server boundary in that coordinate
// space so a player can sync from the spawn point and reach the full map.
const mapSize = map => (map==='mainland' || map==='mainland_s3') ? 35.84*1.4*160 : 5120;
const pos = (p,map,scale=1) => p && Number.isFinite(p.x) && Number.isFinite(p.y) && p.x>=0 && p.x<=mapSize(map)*scale && p.y>=0 && p.y<=mapSize(map)*scale && Number.isInteger(p.direction) && p.direction>=0 && p.direction<=3;
function world(w,total,map,scale=1) {
  if (!w || !['lobby','play','won','lost'].includes(w.status) || !Array.isArray(w.taken) || w.taken.length!==total || !w.taken.every(x=>typeof x==='boolean') || !Array.isArray(w.foes) || w.foes.length>12 || !w.foes.every(p=>pos(p,map,scale)&&(p.kind===undefined||enemyKinds.has(p.kind)&&p.kind!=='default')) || !Array.isArray(w.dead) || w.dead.length>4 || !w.dead.every(x=>typeof x==='string'&&x.length<=36) || !Number.isFinite(w.time) || w.time<0 || w.time>86400) throw Error('Estado de partida inválido');
  return {status:w.status,taken:w.taken,foes:w.foes.map(p=>({x:p.x,y:p.y,direction:p.direction,...(p.kind?{kind:p.kind}:{})})),dead:w.dead,time:w.time};
}
function send(ws,data) { if(ws.readyState===WebSocket.OPEN && ws.bufferedAmount<256000) ws.send(JSON.stringify(data)); }
function publicRooms() {
  return [...rooms.values()].map(room=>({
    id:room.code,name:room.name,map:room.map,custardCount:room.custardCount,
    players:room.members.size,maxPlayers:4,hostName:room.host?[...room.members.values()].find(p=>p.id===room.host)?.name||'Guardián':'Guardián',status:room.world.status
  }));
}
function leave(ws) {
  const member = ws.member; ws.member = null;
  if (!member) return;
  const room = rooms.get(member.code); if (!room) return;
  room.members.delete(member.id);
  if (room.host === member.id) {
    rooms.delete(room.code);
    for (const m of room.members.values()) { m.socket.member=null; send(m.socket,{event:'closed',error:'El anfitrión cerró la sala.'}); }
  }
}
sockets.on('connection',ws=>{
  ws.alive=true; ws.rateTime=Date.now(); ws.rate=0;
  ws.on('pong',()=>ws.alive=true);
  ws.on('error',()=>{});
  ws.on('close',()=>leave(ws));
  ws.on('message',raw=>{
    let b;
    try {
      if (Date.now()-ws.rateTime>=1000) { ws.rateTime=Date.now(); ws.rate=0; }
      if (++ws.rate>30) return ws.close(1008,'Too many messages');
      b=JSON.parse(raw.toString());
      if (!b || !Number.isInteger(b.requestId)) throw Error('Solicitud inválida');
      let result;
      if (typeof b.action==='string'&&b.action.startsWith('admin')) { result=adminAction(ws,b);
      } else if (b.action==='list') {
        result={rooms:publicRooms()};
      } else if (b.action==='create' || b.action==='join') {
        if (ws.member) throw Error('Sal de la sala actual primero');
        let room;
        if (b.action==='create') {
          if (!maps.has(b.map)) throw Error('Mapa inválido');
          const custardCount=b.custardCount??10;
          if(!Number.isInteger(custardCount)||custardCount<1||custardCount>25)throw Error('Elige entre 1 y 25 papillas');
          if (rooms.size>=100) throw Error('Servidor lleno. Intenta más tarde.');
          let code; do { code=randomBytes(4).toString('hex').toUpperCase(); } while(rooms.has(code));
          const roomName=typeof b.roomName==='string'?b.roomName.trim().slice(0,28)||'Partida de Guardián':'Partida de Guardián';
          room={code,name:roomName,map:b.map,custardCount,host:null,members:new Map(),world:{status:'lobby',taken:Array(custardCount).fill(false),foes:[],dead:[],time:0}};
          rooms.set(code,room);
        } else {
          room=rooms.get(String(b.roomId||b.code||'').trim().toUpperCase());
          if (!room) throw Error('La sala no existe o el anfitrión se desconectó');
          if (room.world.status!=='lobby') throw Error('La partida ya comenzó');
          if (room.members.size>=4) throw Error('La sala está llena');
        }
        const m={id:randomUUID(),token:randomUUID(),code:room.code,name:roleOf(ws)?ws.username:typeof b.name==='string'?b.name.trim().slice(0,20)||'Guardián':'Guardián',position:null,socket:ws};
        room.members.set(m.id,m); ws.member=m;
        if (!room.host) room.host=m.id;
        result={roomId:room.code,code:room.code,roomName:room.name,id:m.id,token:m.token,host:room.host===m.id,map:room.map,custardCount:room.custardCount,revision:room.revision||0,enemy:room.enemy||'default',mapScale:room.mapScale||1};
      } else {
        const m=ws.member,room=m&&rooms.get(m.code);
        if (!room || b.token!==m.token || b.code!==m.code) throw Error('La sesión de sala terminó');
        if (b.action==='leave') { leave(ws); result={ok:true}; }
        else if (b.action==='sync') {
          if((b.revision||0)!==(room.revision||0)){send(ws,{requestId:b.requestId,data:{reconfigure:roomConfig(room)}});return;}
          if (b.position!=null && !pos(b.position,room.map,room.mapScale||1)) throw Error('Posición inválida');
          const nextWorld=room.host===m.id?world(b.world,room.custardCount,room.map,room.mapScale||1):null;
          m.position=b.position?{x:b.position.x,y:b.position.y,direction:b.position.direction,walking:!!b.position.walking}:null;
          if (nextWorld) {nextWorld.dead=nextWorld.dead.filter(id=>{const member=room.members.get(id);return !(member&&isAdmin(member.socket)&&member.socket.invincible)});room.world=nextWorld;}
          result={map:room.map,host:room.host,world:room.world,players:[...room.members.values()].map(p=>({id:p.id,name:p.name,role:roleOf(p.socket),position:p.position,invincible:!!(isAdmin(p.socket)&&p.socket.invincible)}))};
        } else throw Error('Acción inválida');
      }
      send(ws,{requestId:b.requestId,data:result});
    } catch(e) { send(ws,{requestId:b?.requestId,error:e.message||'Solicitud inválida'}); }
  });
});
const heartbeat=setInterval(()=>{for(const [ip,a]of adminAttempts)if(Date.now()-a.since>60000)adminAttempts.delete(ip);for(const ws of sockets.clients){if(!ws.alive){ws.terminate();continue;}ws.alive=false;ws.ping();}},15000);
const port=Number(process.env.PORT)||10000;
server.listen(port,'0.0.0.0',()=>console.log(`Slendytubbies 2D Browser Edition listening on ${port}`));
function shutdown(){clearInterval(heartbeat);for(const ws of sockets.clients)ws.close(1012,'Servidor reiniciándose');server.close(()=>process.exit(0));setTimeout(()=>process.exit(0),3000).unref();}
process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
