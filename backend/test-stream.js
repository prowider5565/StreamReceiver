const { WebSocket } = require('ws');
const { spawn } = require('child_process');
const path = require('path');

const CAM_ID = process.argv[2] || 'cam1';
const INPUT = process.argv[3] || null;
const WS_URL = process.argv[4] || 'ws://localhost:2343/ingest/' + CAM_ID;

if (!INPUT) {
  console.log('Usage: node test-stream.js <camId> <video-file> [ws-url]');
  console.log('');
  console.log('Examples:');
  console.log('  node test-stream.js cam1 /home/mateo/Downloads/sample-video.mp4');
  console.log('  node test-stream.js cam2 ./myvideo.mkv');
  console.log('  node test-stream.js cam1 /path/to/video.mp4 ws://localhost:2343/ingest/cam1');
  process.exit(1);
}

const resolvedInput = path.resolve(INPUT);
console.log(`Camera:  ${CAM_ID}`);
console.log(`File:    ${resolvedInput}`);
console.log(`Target:  ${WS_URL}`);
console.log('');

const ws = new WebSocket(WS_URL);

ws.on('open', () => {
  console.log('WebSocket connected, starting ffmpeg...');

  const ffmpeg = spawn('ffmpeg', [
    '-re',                    // real-time playback speed
    '-stream_loop', '-1',     // loop forever
    '-i', resolvedInput,
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-tune', 'zerolatency',
    '-vf', 'scale=640:360',  // scale down for testing
    '-g', '30',              // keyframe every 30 frames
    '-f', 'mp4',
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
    '-frag_duration', '500000',
    '-an',                   // no audio
    'pipe:1'
  ]);

  ffmpeg.stdout.on('data', (chunk) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(chunk);
    }
  });

  ffmpeg.stderr.on('data', (data) => {
    const line = data.toString();
    if (line.includes('frame=') || line.includes('Error') || line.includes('Stream')) {
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
