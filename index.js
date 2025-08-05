const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// In-memory storage of endpoints and requests
// { endpointId: [ { method, headers, body, query, timestamp } ] }
const endpoints = {};

// Route to create new endpoint IDs
app.get('/new', (req, res) => {
  const id = uuidv4();
  endpoints[id] = [];
  res.json({ url: `${req.protocol}://${req.get('host')}/${id}`, id });
});

// Catch all methods for dynamic endpoints
app.all('/:id', (req, res) => {
  const { id } = req.params;

  if (!endpoints[id]) {
    return res.status(404).send('Endpoint not found');
  }

  const data = {
    method: req.method,
    headers: req.headers,
    body: req.body,
    query: req.query,
    timestamp: new Date().toISOString()
  };

  // Store request
  endpoints[id].push(data);

  // Emit to websocket that a new request was received
  io.to(id).emit('new_request', data);

  // Send generic response
  res.status(200).send('Received');
});

// Serve static files (web UI)
app.use(express.static('public'));

// Websocket connection to send real-time updates to UI
io.on('connection', (socket) => {
  console.log('Client connected');

  // Client joins a room with the endpoint id they want to monitor
  socket.on('join', (endpointId) => {
    if (endpoints[endpointId]) {
      socket.join(endpointId);
      // Send existing requests to client
      socket.emit('init_requests', endpoints[endpointId]);
    } else {
      socket.emit('error', 'Endpoint not found');
    }
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected');
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});