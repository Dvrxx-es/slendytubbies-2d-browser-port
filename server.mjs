import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const maps = new Set(['mainland','mainland_s3','caves','mountains','lair','station','outskirts','outskirts_dawn','lake','school','reject','dream','maze','blue']);
const rooms = new Map();
const mime = {'.html':'text/html; charset=utf-8','.png':'image/png','.ogg':'audio/ogg','.ttf':'font/ttf','.js':'text/javascript; charset=utf-8'};
const server = http.createServer(async (req,res) => {
  if (req.url === '/health') { res.writeHead(200, {'Content-Type':'application/json'}); return res.end('{"ok":true,"transport":"websocket"}'); }
  if (!['GET','HEAD'].includes(req.method)) { res.writeHead(405); return res.end(); }
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!file.startsWith(root + path.sep)) throw Error();
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
  sockets.handleUpgrade(req,socket,head,ws=>sockets.emit('connection',ws));
});
const pos = p => p && Number.isFinite(p.x) && Number.isFinite(p.y) && p.x>=0 && p.x<=5120 && p.y>=0 && p.y<=5120 && Number.isInteger(p.direction) && p.direction>=0 && p.direction<=3;
function world(w) {
  if (!w || !['lobby','play','won','lost'].includes(w.status) || !Array.isArray(w.taken) || w.taken.length!==10 || !w.taken.every(x=>typeof x==='boolean') || !Array.isArray(w.foes) || w.foes.length>4 || !w.foes.every(pos) || !Array.isArray(w.dead) || w.dead.length>4 || !w.dead.every(x=>typeof x==='string'&&x.length<=36) || !Number.isFinite(w.time) || w.time<0 || w.time>86400) throw Error('Estado de partida inválido');
  return {status:w.status,taken:w.taken,foes:w.foes.map(p=>({x:p.x,y:p.y,direction:p.direction})),dead:w.dead,time:w.time};
}
function send(ws,data) { if(ws.readyState===WebSocket.OPEN && ws.bufferedAmount<256000) ws.send(JSON.stringify(data)); }
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
      if (b.action==='create' || b.action==='join') {
        if (ws.member) throw Error('Sal de la sala actual primero');
        let room;
        if (b.action==='create') {
          if (!maps.has(b.map)) throw Error('Mapa inválido');
          if (rooms.size>=100) throw Error('Servidor lleno. Intenta más tarde.');
          let code; do { code=randomBytes(4).toString('hex').toUpperCase(); } while(rooms.has(code));
          room={code,map:b.map,host:null,members:new Map(),world:{status:'lobby',taken:Array(10).fill(false),foes:[],dead:[],time:0}};
          rooms.set(code,room);
        } else {
          room=rooms.get(String(b.code||'').trim().toUpperCase());
          if (!room) throw Error('La sala no existe o el anfitrión se desconectó');
          if (room.world.status!=='lobby') throw Error('La partida ya comenzó');
          if (room.members.size>=4) throw Error('La sala está llena');
        }
        const m={id:randomUUID(),token:randomUUID(),code:room.code,name:typeof b.name==='string'?b.name.trim().slice(0,20)||'Guardián':'Guardián',position:null,socket:ws};
        room.members.set(m.id,m); ws.member=m;
        if (!room.host) room.host=m.id;
        result={code:room.code,id:m.id,token:m.token,host:room.host===m.id,map:room.map};
      } else {
        const m=ws.member,room=m&&rooms.get(m.code);
        if (!room || b.token!==m.token || b.code!==m.code) throw Error('La sesión de sala terminó');
        if (b.action==='leave') { leave(ws); result={ok:true}; }
        else if (b.action==='sync') {
          if (b.position!=null && !pos(b.position)) throw Error('Posición inválida');
          const nextWorld=room.host===m.id?world(b.world):null;
          m.position=b.position?{x:b.position.x,y:b.position.y,direction:b.position.direction,walking:!!b.position.walking}:null;
          if (nextWorld) room.world=nextWorld;
          result={map:room.map,host:room.host,world:room.world,players:[...room.members.values()].map(p=>({id:p.id,name:p.name,position:p.position}))};
        } else throw Error('Acción inválida');
      }
      send(ws,{requestId:b.requestId,data:result});
    } catch(e) { send(ws,{requestId:b?.requestId,error:e.message||'Solicitud inválida'}); }
  });
});
const heartbeat=setInterval(()=>{for(const ws of sockets.clients){if(!ws.alive){ws.terminate();continue;}ws.alive=false;ws.ping();}},15000);
const port=Number(process.env.PORT)||10000;
server.listen(port,'0.0.0.0',()=>console.log(`Slendytubbies 2D Browser Port listening on ${port}`));
function shutdown(){clearInterval(heartbeat);for(const ws of sockets.clients)ws.close(1012,'Servidor reiniciándose');server.close(()=>process.exit(0));setTimeout(()=>process.exit(0),3000).unref();}
process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
