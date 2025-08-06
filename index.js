require('dotenv').config();

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const { MongoClient } = require('mongodb');
const { OAuth2Client } = require('google-auth-library');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const mongoUri = process.env.MONGO_URI;
const dbName = 'webhookReceiverDB'; // Choose any name you want

let db;
let endpointsCollection;
let requestsCollection;

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

// Connect to MongoDB Atlas
async function connectMongo() {
  const client = new MongoClient(mongoUri);
  await client.connect();
  db = client.db(dbName);
  endpointsCollection = db.collection('endpoints');
  requestsCollection = db.collection('requests');
  console.log('Connected to MongoDB Atlas');
}

// Google Authentication route
app.post('/auth/google', async (req, res) => {
  const { token } = req.body;
  if (!token) {
    return res.status(400).json({ error: 'Token is required' });
  }
  try {
    // Verify Google ID token
    const ticket = await googleClient.verifyIdToken({
      idToken: token,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();

    // Optional: Find or create user in your database here
    // Example: const user = await usersCollection.findOne({ googleId: payload.sub });

    // Return user info and success message
    res.json({ success: true, user: payload });
  } catch (err) {
    console.error('Google auth error:', err);
    res.status(401).json({ error: 'Invalid Google ID token' });
  }
});

// Middleware to protect routes
async function authenticateGoogleToken(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).send('Unauthorized: No token provided');

  const token = authHeader.split(' ')[1];
  if (!token) return res.status(401).send('Unauthorized: Invalid token format');

  try {
    const ticket = await googleClient.verifyIdToken({
      idToken: token,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    req.user = ticket.getPayload();
    next();
  } catch (err) {
    console.error('Token verification failed:', err);
    res.status(401).send('Unauthorized: Invalid token');
  }
}

// Example: Protect your /new endpoint with authentication if you want
app.get('/new', authenticateGoogleToken, async (req, res) => {
  const id = uuidv4();
  try {
    await endpointsCollection.insertOne({
      _id: id,
      createdAt: new Date(),
      createdBy: req.user.email // Optionally save creator info
    });
    res.json({
      url: `${req.protocol}://${req.get('host')}/${id}`,
      id
    });
  } catch (err) {
    console.error('Error creating endpoint:', err);
    res.status(500).json({ error: 'Failed to create endpoint.' });
  }
});

// List all created endpoints for your frontend endpoint list
// You can also protect this route if needed
app.get('/endpoints', authenticateGoogleToken, async (req, res) => {
  try {
    const endpoints = await endpointsCollection
      .find({})
      .sort({ createdAt: -1 })
      .project({ _id: 1, createdAt: 1, createdBy: 1 })
      .toArray();

    res.json(
      endpoints.map(ep => ({
        id: ep._id,
        createdAt: ep.createdAt.toISOString(),
        createdBy: ep.createdBy || null
      }))
    );
  } catch (err) {
    console.error('Error fetching endpoints:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Delete an endpoint and its requests (protected route)
app.delete('/endpoints/:id', authenticateGoogleToken, async (req, res) => {
  const endpointId = req.params.id;
  try {
    await endpointsCollection.deleteOne({ _id: endpointId });
    await requestsCollection.deleteMany({ endpointId }); // remove related requests
    res.json({ success: true });
  } catch (err) {
    console.error('Error deleting endpoint:', err);
    res.status(500).json({ error: 'Failed to delete endpoint.' });
  }
});

// Catch all webhook requests to dynamic endpoints (public access)
app.all('/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const endpointExists = await endpointsCollection.findOne({ _id: id });
    if (!endpointExists) {
      return res.status(404).send('Endpoint not found');
    }

    const data = {
      endpointId: id,
      method: req.method,
      headers: req.headers,
      body: req.body,
      query: req.query,
      timestamp: new Date()
    };

    await requestsCollection.insertOne(data);

    io.to(id).emit('new_request', {
      method: data.method,
      headers: data.headers,
      body: data.body,
      query: data.query,
      timestamp: data.timestamp.toISOString()
    });

    res.status(200).send('Received');
  } catch (err) {
    console.error('Error handling webhook request:', err);
    res.status(500).send('Internal Server Error');
  }
});

// Serve static frontend files (assumes your UI files are in 'public' folder)
app.use(express.static('public'));

// Socket.IO connection handling
io.on('connection', (socket) => {
  console.log('Client connected');

  socket.on('join', async (endpointId) => {
    try {
      const endpointExists = await endpointsCollection.findOne({ _id: endpointId });
      if (!endpointExists) {
        socket.emit('error', 'Endpoint not found');
        return;
      }
      socket.join(endpointId);

      const recentRequests = await requestsCollection
        .find({ endpointId })
        .sort({ timestamp: -1 })
        .limit(100)
        .toArray();

      const formattedRequests = recentRequests.map(r => ({
        method: r.method,
        headers: r.headers,
        body: r.body,
        query: r.query,
        timestamp: r.timestamp.toISOString()
      }));

      socket.emit('init_requests', formattedRequests);
    } catch (err) {
      console.error('Error during socket join:', err);
      socket.emit('error', 'Internal server error');
    }
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected');
  });
});

// Start server after connecting to MongoDB
connectMongo()
  .then(() => {
    const PORT = process.env.PORT || 3000;
    server.listen(PORT, () => {
      console.log(`Server started on port ${PORT}`);
    });
  })
  .catch((error) => {
    console.error('Failed to connect to MongoDB Atlas:', error);
    process.exit(1);
  });
