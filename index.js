const { google } = require('googleapis');
const express = require('express');

console.log('Starting application...');

try {
  const app = express();
  app.use(express.json());

  // Health check endpoint for Cloud Run
  app.get('/health', (req, res) => {
    console.log('Health check requested');
    res.status(200).json({ status: 'OK' });
  });

  app.post('/', (req, res) => {
    console.log('POST request received:', req.body);
    res.status(200).json({ success: true, message: 'Test endpoint' });
  });

  const port = process.env.PORT || 8080;
  app.listen(port, () => {
    console.log(`Server started and listening on port ${port}`);
  });
} catch (error) {
  console.error('Fatal error during server startup:', error.message);
  console.error('Error details:', JSON.stringify(error, null, 2));
  process.exit(1);
}

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error.message);
  console.error('Error details:', JSON.stringify(error, null, 2));
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise);
  console.error('Reason:', reason);
  process.exit(1);
});