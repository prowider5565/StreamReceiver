const { WebSocket } = require('ws');
const { spawn } = require('child_process');

const RTSP_URL = process.argv[2] || null;
const CAM_ID = process.argv[3] || 'cam2';
const WS_URL = process.argv[4] || 'ws://localhost:2343/ingest/' + CAM_ID;

if (!RTSP_URL) {
  console.log('Usage: node rtsp-to-ws.js <rtsp-url> [camId] [ws-url]');
  console.log('');
  console.log('Examples:');
  console.log('  node rtsp-to-ws.js rtsp://admin:password@192.168.1.64:554/Streaming/Channels/101');
  console.log('  node rtsp-to-ws.js rtsp://admin:pass@10.0.0.5:554/Streaming/Channels/101 cam3');
  console.log('  node rtsp-to-ws.js rtsp://user:pass@camera-ip:554/stream cam2 ws://localhost:2343/ingest/cam2');
  process.exit(1);
}

console.log(`RTSP:    ${RTSP_URL}`);
console.log(`Camera:  ${CAM_ID}`);
console.log(`Target:  ${WS_URL}`);
console.log('');

const ws = new WebSocket(WS_URL);

ws.on('open', () => {
  console.log('WebSocket connected, starting ffmpeg...');

  const ffmpeg = spawn('ffmpeg', [
    '-rtsp_transport', 'tcp',
    '-i', RTSP_URL,
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-tune', 'zerolatency',
    '-vf', 'scale=640:360',
    '-g', '30',
    '-f', 'mp4',
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
    '-frag_duration', '500000',
    '-an',
    'pipe:1'
  ]);

  ffmpeg.stdout.on('data', (chunk) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(chunk);
    }
  });

  ffmpeg.stderr.on('data', (data) => {
    const line = data.toString();
    if (line.includes('frame=') || line.includes('Error') || line.includes('Stream') || line.includes('Input')) {
      process.stderr.write(line);
    }
  });

  ffmpeg.on('close', (code) => {
    console.log(`\nffmpeg exited with code ${code}`);
    ws.close();
    process.exit(code);
  });

  process.on('SIGINT', () => {
    console.log('\nStopping...');
    ffmpeg.kill('SIGTERM');
    ws.close();
  });
});

ws.on('error', (err) => {
  console.error('WebSocket error:', err.message);
  process.exit(1);
});

ws.on('close', () => {
  console.log('WebSocket closed');
});
