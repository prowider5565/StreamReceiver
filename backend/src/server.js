const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const url = require('url');

const app = express();
const server = http.createServer(app);

const CAMERA_IDS = ['cam1', 'cam2', 'cam3', 'cam4'];

// Per-camera state
const cameras = {};
CAMERA_IDS.forEach((id) => {
  cameras[id] = {
    // The fMP4 initialization segment (codec config) — needed for late joiners
    initSegment: null,
    // Connected viewer WebSocket clients
    viewers: new Set(),
  };
});

// Ingest WSS — camera sources push H.264 fMP4 segments here
const ingestWss = new WebSocketServer({ noServer: true });

// Broadcast WSS — viewers connect here to receive the stream
const broadcastWss = new WebSocketServer({ noServer: true });

/**
 * Protocol for ingest:
 *  - First binary message: fMP4 init segment (contains codec config, moov box)
 *  - Subsequent binary messages: fMP4 media segments (moof + mdat boxes)
 *
 * The server stores the init segment so late-joining viewers can
 * initialize their MediaSource immediately.
 */
ingestWss.on('connection', (ws, req) => {
  const camId = req.camId;
  const cam = cameras[camId];
  let receivedInit = false;

  console.log(`[ingest] Camera connected: ${camId}`);

  ws.on('message', (data) => {
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);

    if (!receivedInit) {
      // First message is treated as the init segment
      cam.initSegment = buffer;
      receivedInit = true;
      console.log(`[ingest] Init segment received for ${camId} (${buffer.length} bytes)`);

      // Send init segment to any already-connected viewers
      for (const viewer of cam.viewers) {
        if (viewer.readyState === viewer.OPEN) {
          viewer.send(buffer);
        }
      }
      return;
    }

    // Subsequent messages are media segments — relay to all viewers
    for (const viewer of cam.viewers) {
      if (viewer.readyState === viewer.OPEN) {
        viewer.send(buffer);
      }
    }
  });

  ws.on('close', () => {
    console.log(`[ingest] Camera disconnected: ${camId}`);
    // Optionally clear init segment so stale data isn't served
    cam.initSegment = null;
  });

  ws.on('error', (err) => {
    console.error(`[ingest] Error on ${camId}:`, err.message);
  });
});

/**
 * When a viewer connects:
 *  - If an init segment exists, send it immediately so the viewer
 *    can set up its MediaSource/SourceBuffer right away.
 *  - Then relay all subsequent media segments as they arrive.
 */
broadcastWss.on('connection', (ws, req) => {
  const camId = req.camId;
  const cam = cameras[camId];

  console.log(`[broadcast] Viewer connected: ${camId}`);
  cam.viewers.add(ws);

  // Send cached init segment so viewer can start decoding immediately
  if (cam.initSegment) {
    ws.send(cam.initSegment);
  }

  ws.on('close', () => {
    cam.viewers.delete(ws);
    console.log(`[broadcast] Viewer disconnected: ${camId}`);
  });

  ws.on('error', (err) => {
    cam.viewers.delete(ws);
    console.error(`[broadcast] Error on ${camId}:`, err.message);
  });
});

// Route upgrade requests to the correct WSS
server.on('upgrade', (req, socket, head) => {
  const { pathname } = url.parse(req.url);

  // Match /ingest/cam1 .. /ingest/cam4
  const ingestMatch = pathname.match(/^\/ingest\/(cam[1-4])$/);
  if (ingestMatch) {
    req.camId = ingestMatch[1];
    ingestWss.handleUpgrade(req, socket, head, (ws) => {
      ingestWss.emit('connection', ws, req);
    });
    return;
  }

  // Match /broadcast/cam1 .. /broadcast/cam4
  const broadcastMatch = pathname.match(/^\/broadcast\/(cam[1-4])$/);
  if (broadcastMatch) {
    req.camId = broadcastMatch[1];
    broadcastWss.handleUpgrade(req, socket, head, (ws) => {
      broadcastWss.emit('connection', ws, req);
    });
    return;
  }

  // Unknown path — reject
  socket.destroy();
});

// Health check endpoint
app.get('/health', (req, res) => {
  const status = CAMERA_IDS.reduce((acc, camId) => {
    acc[camId] = {
      viewers: cameras[camId].viewers.size,
      hasInitSegment: cameras[camId].initSegment !== null,
    };
    return acc;
  }, {});
  res.json({ status: 'ok', cameras: status });
});

const PORT = 2343;
server.listen(PORT, () => {
  console.log(`Stream Receiver running on port ${PORT}`);
  console.log('');
  console.log('Protocol: fMP4 (fragmented MP4 with H.264)');
  console.log('  Ingest sends init segment first, then media segments.');
  console.log('');
  console.log('Ingest routes:    /ingest/cam1 .. /ingest/cam4');
  console.log('Broadcast routes: /broadcast/cam1 .. /broadcast/cam4');
});
