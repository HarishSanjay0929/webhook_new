# 📧 Email Notification Testing Guide

## 🚀 Quick Start Testing

### 1. **Start the Application**
```bash
node index.js
```

### 2. **Open the Application**
- Navigate to: `http://localhost:3000`
- Sign in with your Google account

### 3. **Create a Test Endpoint**
- Click "Create New Endpoint"
- Name it "Test Webhook" (or any name)

### 4. **Enable Email Notifications**
- Click your profile icon (top-right corner)
- Find "Email Notifications" toggle
- Turn it ON
- Enter your email address
- Click save

### 5. **Test Email Sending**
- Copy your webhook URL from the dashboard
- Send a test webhook to that URL using any HTTP client

**Using curl (example):**
```bash
curl -X POST http://localhost:3000/YOUR_ENDPOINT_ID \
  -H "Content-Type: application/json" \
  -d '{"message":"Test webhook","test":true}'
```

**Using Postman or any API tool:**
- Method: POST
- URL: `http://localhost:3000/YOUR_ENDPOINT_ID`
- Body: `{"message":"Test webhook","test":true}`

### 6. **Check Email**
- Check the email address you configured
- You should receive an email with:
  - Endpoint name and details
  - Request information
  - "View Webhook in Dashboard" button

## 🧪 Testing Without Email Configuration

### If you haven't set up email credentials:
1. The application will log email notifications to the console
2. Check the terminal/command prompt for email content
3. You'll see messages like:
   ```
   Email notification would be sent to: your-email@example.com
   Endpoint: test-endpoint-123
   Request data: {...}
   ```

## ⚙️ Setting Up Email Configuration (Optional)

To actually send emails, add these to your `.env` file:

```
EMAIL_SERVICE=gmail
EMAIL_USER=your-email@gmail.com
EMAIL_PASS=your-app-specific-password
EMAIL_FROM=noreply@yourdomain.com
```

**Note:** For Gmail, you need to use an App Password, not your regular password.

## 🔍 Verification Steps

### ✅ Check Database Storage
1. Email notification state should persist in MongoDB
2. Settings should remain after page refresh
3. Email address should be saved correctly

### ✅ Check Email Content
Email should contain:
- [ ] Endpoint name (e.g., "Test Webhook")
- [ ] Endpoint URL
- [ ] Request method (POST/GET/etc.)
- [ ] Timestamp
- [ ] Request headers
- [ ] Request body
- [ ] "View Webhook in Dashboard" button

### ✅ Check Persistence
1. Enable notifications
2. Refresh the page
3. Notifications should still be enabled
4. Email should still be configured

## 🐛 Troubleshooting

### If emails aren't sending:
1. Check console logs for error messages
2. Verify email credentials in `.env`
3. Check if SMTP service allows your server
4. Ensure you're using App Password for Gmail

### If notifications don't persist:
1. Check MongoDB connection
2. Verify user is authenticated
3. Check network tab in browser dev tools

## 📝 Test Scenarios

1. **Enable notifications** → Check they're enabled in profile
2. **Save custom email** → Check it persists after refresh
3. **Send webhook** → Check console for email content
4. **Disable notifications** → Check emails stop sending
5. **Multiple endpoints** → Check notifications work for all
