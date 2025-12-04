require('dotenv').config();

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const { MongoClient } = require('mongodb');
const { OAuth2Client } = require('google-auth-library');
const nodemailer = require('nodemailer');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const mongoUri = process.env.MONGO_URI;
const dbName = 'webhookReceiverDB';

let db, endpointsCollection, requestsCollection;
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

async function connectMongo() {
  const client = new MongoClient(mongoUri);
  await client.connect();
  db = client.db(dbName);
  endpointsCollection = db.collection('endpoints');
  requestsCollection = db.collection('requests');
  console.log('Connected to MongoDB Atlas');
}

app.post('/auth/google', async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'Token is required' });
  try {
    const ticket = await googleClient.verifyIdToken({
      idToken: token,
      audience: process.env.GOOGLE_CLIENT_ID,
      clockTolerance: 300, // 5 minutes tolerance for clock skew
    });
    const payload = ticket.getPayload();
    res.json({ success: true, user: payload });
  } catch (err) {
    console.error('Google auth error:', err.message);
    // Provide more specific error messages
    if (err.message.includes('Token used too late') || err.message.includes('Token used too early')) {
      res.status(401).json({ error: 'Token timing issue. Please try signing in again.' });
    } else if (err.message.includes('invalid_token') || err.message.includes('Invalid token')) {
      res.status(401).json({ error: 'Invalid Google ID token' });
    } else {
      res.status(401).json({ error: 'Authentication failed. Please try again.' });
    }
  }
});

// Auth middleware
async function authenticateGoogleToken(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).send('Unauthorized: No token provided');
  const token = authHeader.split(' ')[1];
  if (!token) return res.status(401).send('Unauthorized: Invalid token format');
  try {
    const ticket = await googleClient.verifyIdToken({
      idToken: token,
      audience: process.env.GOOGLE_CLIENT_ID,
      clockTolerance: 300, // 5 minutes tolerance for clock skew
    });
    req.user = ticket.getPayload();
    next();
  } catch (err) {
    console.error('Token verification failed:', err.message);
    if (err.message.includes('Token used too late') || err.message.includes('Token used too early')) {
      res.status(401).send('Unauthorized: Token expired. Please sign in again.');
    } else {
      res.status(401).send('Unauthorized: Invalid token');
    }
  }
}

// Create new endpoint
app.post('/new', authenticateGoogleToken, async (req, res) => {
  const id = uuidv4();
  const { name } = req.body;
  try {
    await endpointsCollection.insertOne({
      _id: id,
      name: name ? name.trim() : undefined,
      createdAt: new Date(),
      createdBy: req.user.email
    });
    res.json({
      url: `${req.protocol}://${req.get('host')}/${id}`,
      id,
      name: name ? name.trim() : undefined,
    });
  } catch (err) {
    console.error('Error creating endpoint:', err);
    res.status(500).json({ error: 'Failed to create endpoint.' });
  }
});

// Get endpoints for user
app.get('/endpoints', authenticateGoogleToken, async (req, res) => {
  try {
    const endpoints = await endpointsCollection
      .find({ createdBy: req.user.email })
      .sort({ createdAt: -1 })
      .project({ _id: 1, createdAt: 1, createdBy: 1, name: 1 })
      .toArray();
    res.json(
      endpoints.map(ep => ({
        id: ep._id,
        createdAt: ep.createdAt.toISOString(),
        createdBy: ep.createdBy || null,
        name: ep.name || null
      }))
    );
  } catch (err) {
    console.error('Error fetching endpoints:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Delete endpoint
app.delete('/endpoints/:id', authenticateGoogleToken, async (req, res) => {
  const endpointId = req.params.id;
  try {
    await endpointsCollection.deleteOne({ _id: endpointId });
    await requestsCollection.deleteMany({ endpointId });
    res.json({ success: true });
  } catch (err) {
    console.error('Error deleting endpoint:', err);
    res.status(500).json({ error: 'Failed to delete endpoint.' });
  }
});

// Webhook receiver route
app.all('/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const endpointExists = await endpointsCollection.findOne({ _id: id });
    if (!endpointExists) return res.status(404).send('Endpoint not found');
    const data = {
      endpointId: id,
      method: req.method,
      headers: req.headers,
      body: req.body,
      query: req.query,
      timestamp: new Date()
    };
    const result = await requestsCollection.insertOne(data);
    const requestId = result.insertedId;
    io.to(id).emit('new_request', {
      _id: requestId.toString(),
      method: data.method,
      headers: data.headers,
      body: data.body,
      query: data.query,
      timestamp: data.timestamp.toISOString()
    });

    // Send email notification if enabled
    if (endpointExists.createdBy) {
      sendWebhookNotification(
        endpointExists.createdBy, // notification email (fallback)
        endpointExists._id, // endpoint ID
        {
          method: data.method,
          headers: data.headers,
          query: data.query,
          body: data.body,
          timestamp: data.timestamp
        },
        req,  // Pass the request object to access host information
        null   // No Google user ID available at webhook time
      );
    }

    // Redirect browser GET requests to the web app
    const userAgent = req.headers['user-agent'] || '';
    if (req.method === 'GET' && userAgent.includes('Mozilla')) {
      return res.redirect(`/?highlight=${requestId}`);
    }

    res.status(200).send('Received');
  } catch (err) {
    console.error('Error handling webhook request:', err);
    res.status(500).send('Internal Server Error');
  }
});

// Serve frontend (public folder)
app.use(express.static('public'));

// Socket.IO live connection handler (supports reconnection via the frontend)
io.on('connection', (socket) => {
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
        _id: r._id.toString(),
        method: r.method,
        headers: r.headers,
        body: r.body,
        query: r.query,
        timestamp: r.timestamp.toISOString()
      }));
      socket.emit('init_requests', formattedRequests);
    } catch (err) {
      socket.emit('error', 'Internal server error');
    }
  });

  // OPTIONAL: Heartbeat ping to allow frontend to detect stale connection (uncomment if needed)
  /*
  const heartbeatInterval = setInterval(() => {
    socket.emit('heartbeat', { time: Date.now() });
  }, 60000);
  socket.on('disconnect', () => clearInterval(heartbeatInterval));
  */
});

// Email notification endpoints
app.post('/api/notifications/enable', authenticateGoogleToken, async (req, res) => {
  try {
    const { email } = req.body;
    const notificationEmail = email || req.user.email;
    
    // Update Google user ID settings
    await db.collection('userSettings').updateOne(
      { userId: req.user.sub },
      { $set: { emailNotifications: true, notificationEmail: notificationEmail } },
      { upsert: true }
    );

    // Also update work email settings if user has work email endpoints
    if (req.user.email && req.user.email !== req.user.sub) {
      await db.collection('userSettings').updateOne(
        { userId: req.user.email },
        { $set: { emailNotifications: true, notificationEmail: notificationEmail } },
        { upsert: true }
      );
    }
    
    res.json({ success: true });
  } catch (error) {
    console.error('Error enabling notifications:', error);
    res.status(500).json({ error: 'Failed to enable notifications' });
  }
});

app.post('/api/notifications/disable', authenticateGoogleToken, async (req, res) => {
  try {
    // Update Google user ID settings
    await db.collection('userSettings').updateOne(
      { userId: req.user.sub },
      { $set: { emailNotifications: false } },
      { upsert: true }
    );

    // Also update work email settings if user has work email endpoints
    if (req.user.email && req.user.email !== req.user.sub) {
      await db.collection('userSettings').updateOne(
        { userId: req.user.email },
        { $set: { emailNotifications: false } },
        { upsert: true }
      );
    }
    
    res.json({ success: true });
  } catch (error) {
    console.error('Error disabling notifications:', error);
    res.status(500).json({ error: 'Failed to disable notifications' });
  }
});

app.get('/api/notifications/status', authenticateGoogleToken, async (req, res) => {
  try {
    const settings = await db.collection('userSettings').findOne({ userId: req.user.sub });
    res.json({
      enabled: settings?.emailNotifications || false,
      email: settings?.notificationEmail || req.user.email
    });
  } catch (error) {
    console.error('Error getting notification status:', error);
    res.status(500).json({ error: 'Failed to get notification status' });
  }
});

app.post('/api/notifications/email', authenticateGoogleToken, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || !email.includes('@')) {
      return res.status(400).json({ error: 'Invalid email address' });
    }

    // Clean up old entries with different emails for both user IDs
    await db.collection('userSettings').deleteMany({
      userId: { $in: [req.user.sub, req.user.email].filter(Boolean) },
      notificationEmail: { $ne: email }
    });

    // Update Google user ID settings
    await db.collection('userSettings').updateOne(
      { userId: req.user.sub },
      { $set: { notificationEmail: email } },
      { upsert: true }
    );

    // Also update work email settings if user has work email endpoints
    if (req.user.email && req.user.email !== req.user.sub) {
      await db.collection('userSettings').updateOne(
        { userId: req.user.email },
        { $set: { notificationEmail: email } },
        { upsert: true }
      );
    }

    res.json({ success: true, email });
  } catch (error) {
    console.error('Error saving notification email:', error);
    res.status(500).json({ error: 'Failed to save notification email' });
  }
});

app.get('/api/verify-token', authenticateGoogleToken, (req, res) => {
  res.json({ user: req.user });
});

// Email notification function
async function sendWebhookNotification(creatorEmail, endpointId, requestData, req, googleUserId) {
  try {
    // Find user settings - try multiple approaches since we don't have Google user ID at webhook time
    let userSettings = null;
    
    if (googleUserId) {
      // If we have Google user ID, use that
      userSettings = await db.collection('userSettings').findOne({ userId: googleUserId });
    }
    
    if (!userSettings) {
      // Fallback 1: Look for user settings by notificationEmail
      userSettings = await db.collection('userSettings').findOne({ notificationEmail: creatorEmail });
    }
    
    if (!userSettings) {
      // Fallback 2: Look for user settings by creator email (for backwards compatibility)
      userSettings = await db.collection('userSettings').findOne({ userId: creatorEmail });
    }
    
    if (!userSettings?.emailNotifications) {
      console.log('Email notifications not enabled for', creatorEmail);
      console.log('User settings found:', !!userSettings, 'Notifications enabled:', userSettings?.emailNotifications);
      return;
    }

    const notificationEmail = userSettings.notificationEmail || creatorEmail;

    // Fetch endpoint details for the email
    const endpoint = await endpointsCollection.findOne({ _id: endpointId });
    const endpointName = endpoint?.name || endpointId;
    const hostUrl = req ? `${req.protocol}://${req.get('host')}` : (process.env.BASE_URL || 'http://localhost:3000');
    const endpointUrl = `${hostUrl}/${endpointId}`;

    // If transporter is not configured, just log and return
    if (!transporter) {
      console.log('Email notification would be sent to:', notificationEmail);
      console.log('Endpoint:', endpointId, 'Name:', endpointName);
      console.log('Request data:', requestData);
      console.log('Email configuration not set up. Notification not sent.');
      return;
    }

    // Format the request data for email
    const formattedData = {
      method: requestData.method,
      headers: requestData.headers,
      query: requestData.query,
      body: requestData.body,
      timestamp: requestData.timestamp
    };

    // Create email content with enhanced details and redirect button
    const mailOptions = {
      from: process.env.EMAIL_FROM || 'Webhook Receiver <noreply@webhookreceiver.com>',
      to: notificationEmail,
      subject: `New Webhook Received on "${endpointName}"`,
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <style>
            body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px; }
            .header { background-color: #667eea; color: white; padding: 20px; text-align: center; border-radius: 8px 8px 0 0; }
            .content { background-color: #f9f9f9; padding: 20px; border-radius: 0 0 8px 8px; }
            .details { background-color: white; padding: 15px; border-radius: 4px; margin: 15px 0; }
            .endpoint-info { background-color: #e8f5e9; padding: 15px; border-radius: 4px; margin: 15px 0; border-left: 4px solid #4caf50; }
            pre { background-color: #f5f5f5; padding: 10px; border-radius: 4px; overflow-x: auto; }
            .btn { display: inline-block; background-color: #667eea; color: white; padding: 12px 24px; text-decoration: none; border-radius: 4px; font-weight: bold; margin-top: 15px; }
            .btn:hover { background-color: #5a67d8; }
            .footer { font-size: 0.8em; color: #666; margin-top: 20px; text-align: center; }
          </style>
        </head>
        <body>
          <div class="header">
            <h2>New Webhook Received</h2>
          </div>
          <div class="content">
            <p>Hello,</p>
            <p>A new webhook request has been received on your endpoint:</p>

            <div class="endpoint-info">
              <h3>Endpoint Details</h3>
              <p><strong>Name:</strong> ${endpointName}</p>
              <p><strong>Endpoint ID:</strong> ${endpointId}</p>
              <p><strong>URL:</strong> <a href="${endpointUrl}">${endpointUrl}</a></p>
            </div>

            <div class="details">
              <h3>Request Details</h3>
              <p><strong>Method:</strong> ${formattedData.method}</p>
              <p><strong>Timestamp:</strong> ${new Date(formattedData.timestamp).toLocaleString()}</p>

              <h4>Headers:</h4>
              <pre>${JSON.stringify(formattedData.headers, null, 2)}</pre>

              <h4>Query Parameters:</h4>
              <pre>${JSON.stringify(formattedData.query, null, 2)}</pre>

              <h4>Body:</h4>
              <pre>${JSON.stringify(formattedData.body, null, 2)}</pre>
            </div>

            <p>Click the button below to view this request and manage your webhooks:</p>

            <a href="${endpointUrl}" class="btn" style="color: white; text-decoration: none;">View Webhook in Dashboard</a>

            <div class="footer">
              <p>This is an automated notification from Webhook Receiver.</p>
              <p>© ${new Date().getFullYear()} Webhook Receiver. All rights reserved.</p>
            </div>
          </div>
        </body>
        </html>
      `
    };

    // Send the email
    await transporter.sendMail(mailOptions);
    console.log(`Email notification sent successfully to ${notificationEmail} for endpoint ${endpointName}`);

  } catch (error) {
    console.error('Error sending notification email:', error);
    // Don't throw the error to avoid breaking the webhook flow
  }
}

// Setup email transporter
let transporter = null;
if (process.env.EMAIL_SERVICE && process.env.EMAIL_USER && process.env.EMAIL_PASS) {
  transporter = nodemailer.createTransport({
    service: process.env.EMAIL_SERVICE,
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS
    }
  });
  console.log('Email transporter configured successfully');
} else {
  console.log('Email configuration not found. Email notifications will be logged but not sent.');
}

connectMongo().then(() => {
  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => console.log(`Server started on port ${PORT}`));
}).catch((error) => {
  console.error('Failed to connect to MongoDB Atlas:', error);
  process.exit(1);
});
