import http from 'node:http';

const port = Number(process.env.DM_PULSE_CAPTURE_PORT) || 47322;

const server = http.createServer((request, response) => {
  response.setHeader('Access-Control-Allow-Origin', '*');
  if (request.method !== 'POST') {
    response.writeHead(404);
    response.end('not found');
    return;
  }

  let body = '';
  request.on('data', (chunk) => {
    body += chunk;
  });
  request.on('end', () => {
    response.writeHead(200, { 'Content-Type': 'text/plain' });
    response.end('ok');
    console.log(body);
    server.close(() => process.exit(0));
  });
});

server.listen(port, '127.0.0.1', () => {
  console.log('capture listening on 127.0.0.1:' + port);
});

setTimeout(() => {
  console.log('capture timeout');
  server.close(() => process.exit(2));
}, 180000);
