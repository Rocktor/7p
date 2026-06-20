import http from 'node:http';
import express from 'express';
import { WebSocketServer, type WebSocket } from 'ws';
import type { GameIntent } from '@zpy7/rules';
import { AppDb, type UserRecord } from './db.js';
import { redactRoom, RoomManager } from './rooms.js';

const PORT = Number(process.env.PORT ?? 8787);
const app = express();
const server = http.createServer(app);
const db = new AppDb();
type Client = { socket: WebSocket; user: UserRecord };
const clients = new Map<string, Set<Client>>();
const rooms = new RoomManager(db, broadcastRoom);

app.use(express.json({ limit: '1mb' }));

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.post('/api/register', (req, res) => {
  handle(res, () => db.createUser(String(req.body.name ?? ''), String(req.body.password ?? '')));
});

app.post('/api/login', (req, res) => {
  handle(res, () => db.login(String(req.body.name ?? ''), String(req.body.password ?? '')));
});

app.get('/api/me', (req, res) => {
  const user = auth(req);
  res.json({ user });
});

app.get('/api/rooms', (_req, res) => {
  res.json({ rooms: rooms.listRooms() });
});

app.post('/api/rooms', (req, res) => {
  handle(res, () => {
    auth(req);
    return { room: rooms.createRoom(String(req.body.name ?? '找朋友牌桌')) };
  });
});

app.get('/api/rooms/:id', (req, res) => {
  handle(res, () => {
    const user = optionalAuth(req);
    const room = rooms.getRoom(req.params.id);
    rooms.scheduleBots(req.params.id);
    return { room: redactRoom(room, user) };
  });
});

app.post('/api/rooms/:id/intent', (req, res) => {
  handle(res, () => {
    const user = auth(req);
    const result = rooms.applyIntent(req.params.id, user, req.body.intent as GameIntent);
    return { room: redactRoom(result.state, user), events: result.events };
  });
});

app.get('/api/rooms/:id/replay', (req, res) => {
  handle(res, () => {
    rooms.scheduleBots(req.params.id);
    return { analysis: rooms.getReplay(req.params.id), room: redactRoom(rooms.getRoom(req.params.id), optionalAuth(req)) };
  });
});

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (socket, request) => {
  const url = new URL(request.url ?? '', `http://${request.headers.host}`);
  const roomId = url.searchParams.get('roomId') ?? '';
  const token = url.searchParams.get('token') ?? '';
  const user = db.getUserByToken(token);
  if (!roomId || !user) {
    socket.close(1008, 'unauthorized');
    return;
  }
  const client = addClient(roomId, socket, user);
  const room = rooms.getRoom(roomId);
  rooms.scheduleBots(roomId);
  send(socket, { type: 'state', room: redactRoom(room, user) });

  socket.on('message', (raw) => {
    try {
      const msg = JSON.parse(String(raw)) as { type: string; intent?: GameIntent };
      if (msg.type !== 'intent' || !msg.intent) throw new Error('消息格式错误');
      rooms.applyIntent(roomId, user, msg.intent);
    } catch (error) {
      send(socket, { type: 'error', message: error instanceof Error ? error.message : String(error) });
    }
  });

  socket.on('close', () => {
    clients.get(roomId)?.delete(client);
  });
});

server.listen(PORT, () => {
  console.log(`ZPY7 server listening on http://localhost:${PORT}`);
});

function handle(res: express.Response, fn: () => unknown) {
  try {
    res.json(fn());
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
}

function auth(req: express.Request): UserRecord {
  const user = optionalAuth(req);
  if (!user) throw new Error('未登录');
  return user;
}

function optionalAuth(req: express.Request): UserRecord | null {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
  return token ? db.getUserByToken(token) : null;
}

function addClient(roomId: string, socket: WebSocket, user: UserRecord) {
  const set = clients.get(roomId) ?? new Set<Client>();
  const client = { socket, user };
  set.add(client);
  clients.set(roomId, set);
  return client;
}

function broadcastRoom(roomId: string) {
  const sockets = clients.get(roomId);
  if (!sockets) return;
  const room = rooms.getRoom(roomId);
  for (const client of sockets) {
    send(client.socket, { type: 'state', room: redactRoom(room, client.user) });
  }
}

function send(socket: WebSocket, payload: unknown) {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(payload));
}
