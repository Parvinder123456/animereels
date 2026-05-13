import { Router } from 'express';
import { progressEmitter } from '../jobs/processor.js';

const router = Router();

router.get('/:projectId', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // Send initial heartbeat
  res.write(`data: ${JSON.stringify({ step: 'connected', message: 'SSE connected', percent: 0 })}\n\n`);

  // Keep-alive: send a comment every 15s so proxies/browsers don't close the connection
  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 15000);

  const onProgress = (data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  progressEmitter.on(req.params.projectId, onProgress);

  req.on('close', () => {
    clearInterval(heartbeat);
    progressEmitter.off(req.params.projectId, onProgress);
  });
});

export default router;
