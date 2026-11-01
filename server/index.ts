/**
 * Entry point: Express (built client + REST + pack media)
 * and Socket.io on one port.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import qrcode from 'qrcode-terminal';
import { Server } from 'socket.io';
import { config } from './config.ts';
import { Room } from './game/Room.ts';
import { persistRoom, restoreRoom } from './game/persistence.ts';
import { ensureIosCompatibleMedia } from './packs/mediaTranscoder.ts';
import { listPacks, pruneCache } from './packs/packManager.ts';
import { canUpload, MAX_UPLOAD_BYTES, saveUploadedPack, UploadError } from './packs/upload.ts';
import { errorHandler, originMiddleware, securityHeaders } from './http/httpSafety.ts';
import { pickInviteUrl } from './http/invite.ts';
import { registerSocketHandlers } from './socket/handlers.ts';
import { logRefusal, policyFromEnv, refusalReason } from './socket/originGuard.ts';
import { createSocketLimits } from './socket/socketLimits.ts';
import { ensureDir, safeJoin } from './utils/fsx.ts';
import { getLanAddresses } from './utils/network.ts';
import { qrSvg } from './utils/qrSvg.ts';

await Promise.all([ensureDir(config.packsDir), ensureDir(config.cacheDir)]);

const app = express();
const server = http.createServer(app);
const originPolicy = policyFromEnv();
const io = new Server(server, {
  pingInterval: 10_000,
  pingTimeout: 8_000,
  maxHttpBufferSize: 1e6,
  // Foreign pages and unexpected Host names cannot open a game socket (audit SEC-3).
  allowRequest: (req, callback) => {
    const reason = refusalReason(req.headers, originPolicy);
    if (reason) logRefusal(req.headers, reason);
    callback(reason, !reason);
  },
});
const socketLimits = createSocketLimits();
io.use(socketLimits.middleware);

const room = new Room();
await restoreRoom(room);
const flushRoomState = persistRoom(room);
// Extracted media for packs unused for 30 days is deleted; the restored pack stays (audit CONN-8).
// Awaited before listening, so no pack load can race a folder being deleted.
await pruneCache(room.loadedPack ? [room.loadedPack.packId] : [], 30 * 24 * 60 * 60 * 1000)
  .catch((err: Error) => console.warn(`[packs] Cache cleanup skipped: ${err.message}`));
registerSocketHandlers(io, room, socketLimits);

/* ------------------------------------------------------------------ HTTP */

app.disable('x-powered-by');
app.use(originMiddleware(originPolicy));
app.use(securityHeaders);

app.get('/api/info', (_req: Request, res: Response) => {
  res.json({
    port: config.port,
    urls: getLanAddresses().map((a) => `http://${a.address}:${config.port}`),
  });
});

// The lobby shows this so phones can join by camera instead of typing the LAN address.
app.get('/api/invite.svg', (req: Request, res: Response) => {
  const fallback = getLanAddresses().map((a) => `http://${a.address}:${config.port}`)[0] ?? `http://localhost:${config.port}`;
  // Only encode this server's own address, never an arbitrary caller-supplied link (audit SEC-9).
  const ownHosts = [...getLanAddresses().map((a) => `${a.address}:${config.port}`), req.headers.host ?? ''];
  const url = pickInviteUrl(req.query.url, ownHosts, fallback);
  res.type('image/svg+xml').set('Cache-Control', 'no-store').send(qrSvg(url));
});

// No unauthenticated pack listing (audit SEC-2): the client lists packs over the socket
// (`packs:list`), and an open GET let anyone on the LAN re-parse every broken pack on demand.

/** Hosts and room owners may add a pack without exposing an unfinished archive to players. */
app.post('/api/packs/upload', async (req, res) => {
  if (!canUpload(room, req.headers.authorization)) return res.status(403).json({ error: 'Only a connected host may upload packs' });
  if (!req.is('application/octet-stream')) return res.status(415).json({ error: 'Upload a .siq file as application/octet-stream' });
  if (Number(req.headers['content-length']) > MAX_UPLOAD_BYTES) return res.status(413).json({ error: 'Pack exceeds the 200 MB limit' });
  try {
    const result = await saveUploadedPack(req, req.headers['x-pack-name'], config.packsDir,
      MAX_UPLOAD_BYTES, () => canUpload(room, req.headers.authorization));
    res.status(201).json(result);
    listPacks().then((packs) => {
      for (const socket of io.sockets.sockets.values()) {
        if (room.canManage(socket.data.pid)) socket.emit('packs:changed', { packs });
      }
    }).catch((err) => console.warn(`[packs] Refresh after upload failed: ${err.message}`));
  } catch (err) {
    if (err instanceof UploadError) return res.status(err.status).json({ error: err.message });
    console.error('[packs] Upload failed:', err);
    res.status(500).json({ error: 'Pack upload failed' });
  }
});

/**
 * Extracted pack media: /media/<packId>/Images/foo.jpg (supports range requests for audio/video).
 * Before serving video/audio, ensures the file is transcoded to H.264/AAC (MP4) or MP3
 * so iPhone & iPad Safari can play packs encoded with AV1/VP9/Opus.
 */
const mediaTranscode = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const decoded = req.path.split('/').filter(Boolean).map(decodeURIComponent);
    if (decoded.length >= 2) {
      const folder = decoded[1].toLowerCase();
      if (folder === 'video' || folder === 'audio') {
        const filePath = safeJoin(config.cacheDir, ...decoded);
        const packCacheDir = safeJoin(config.cacheDir, decoded[0]);
        const playable = await ensureIosCompatibleMedia(filePath, packCacheDir);
        if (playable !== filePath) {
          // Redirect to the derivative so Express supplies the correct media MIME type.
          const relative = path.relative(config.cacheDir, playable).split(path.sep).map(encodeURIComponent).join('/');
          const htmlRoute = req.baseUrl.startsWith('/media-html/');
          res.redirect(307, htmlRoute ? `${req.baseUrl}/${relative}`
            : `/media/${relative}?ticket=${encodeURIComponent(String(req.query.ticket))}`);
          return;
        }
      }
    }
  } catch {
    /* let express.static handle 404 / invalid paths */
  }
  next();
};

const mediaFiles = express.static(config.cacheDir, {
    fallthrough: false, dotfiles: 'deny', index: false,
    setHeaders: (res, filePath) => {
      res.setHeader('Cache-Control', 'private, no-store');
      // HTML may render in an iframe, but must not run scripts or contact other origins.
      res.setHeader('Content-Security-Policy', /\.html?$/i.test(filePath)
        ? "sandbox allow-same-origin; default-src 'none'; script-src 'none'; img-src 'self' data:; media-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; frame-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none'"
        : 'sandbox');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Referrer-Policy', 'no-referrer');
    },
  });

// The ticket is in the path so relative HTML images and styles keep it.
app.use('/media-html/:ticket', (req: Request, res: Response, next: NextFunction) => {
  if (!room.canAccessMedia(req.params.ticket, `/media${req.path}`)) { res.status(403).end(); return; }
  next();
}, mediaTranscode, mediaFiles);

app.use('/media', (req: Request, res: Response, next: NextFunction) => {
  if (!room.canAccessMedia(req.query.ticket, `/media${req.path}`)) { res.status(403).end(); return; }
  next();
}, mediaTranscode, mediaFiles);

/** Static web client assets (index.html, style.css, etc.). */
if (fs.existsSync(config.publicDir)) {
  app.use(express.static(config.publicDir, { index: 'index.html' }));
}

app.use(errorHandler);

/* --------------------------------------------------------------- startup */

/** The launcher never restarts on this code: a taken port stays taken until the user acts. */
const EXIT_PORT_IN_USE = 78;

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  Port ${config.port} is already in use. Close the other app or set PORT=3001 before starting again.\n`);
    process.exit(EXIT_PORT_IN_USE);
  }
  console.error(err);
  process.exit(1);
});

/*
 * Last-resort crash handling (audit CONN-1). A stray rejected promise is logged and the game
 * goes on. A synchronous throw may have left state half-updated, so save what we have and exit;
 * the launcher restarts the server and players resume from the saved room.
 */
process.on('unhandledRejection', (reason) => {
  console.error('[server] Unhandled promise rejection (game continues):', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[server] Uncaught exception, saving the room and exiting:', err);
  setTimeout(() => process.exit(1), 2000).unref();
  flushRoomState().catch(() => {}).finally(() => process.exit(1));
});

server.listen(config.port, config.host, () => {
  const addresses = getLanAddresses();
  const best = addresses[0] ? `http://${addresses[0].address}:${config.port}` : null;

  console.log('\n  ==============================================');
  console.log('   SIGame Local server is running (TypeScript)');
  console.log('  ==============================================\n');
  console.log(`   On this PC:      http://localhost:${config.port}`);
  for (const a of addresses) {
    const note = a.likelyVirtual ? '  (virtual adapter - probably not this one)' : '';
    console.log(`   On your network: http://${a.address}:${config.port}   [${a.iface}]${note}`);
  }
  if (!addresses.length) console.log('   No network adapter found - only this PC can connect.');
  console.log(`\n   Packs folder:    ${config.packsDir}`);
  console.log('   First person to join chooses Host or Player.\n');

  if (best) {
    console.log('   Scan to join:');
    qrcode.generate(best, { small: true }, (qr: string) => console.log(qr.replace(/^/gm, '   ')));
  }
  console.log('   If phones cannot connect, allow Node.js through your firewall.\n');
});

/* Graceful shutdown on Ctrl+C. */
let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('\n  Shutting down...');
    io.close();
    const finish = async () => {
      await flushRoomState();
      process.exit(0);
    };
    server.close(finish);
    setTimeout(finish, 2000).unref();
  });
}
