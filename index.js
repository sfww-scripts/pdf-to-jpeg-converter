const express = require('express');

console.log('Starting container initialization...');
console.log('Loading dependencies...');

try {
  console.log('Loading express...');
  const expressModule = require('express');
  console.log('Loaded express');
} catch (error) {
  console.error('Error loading dependencies:', error.message);
  console.error('Error details:', JSON.stringify(error, null, 2));
  process.exit(1);
}

console.log('Starting application...');

try {
  const app = express();
  
  console.log('Configuring Express middleware...');
  app.use(express.json({ limit: '50mb' }));
  
  app.use((err, req, res, next) => {
    if (err.type === 'entity.too.large') {
      console.error('Request entity too large');
      return res.status(413).json({
        success: false,
        error: 'Request entity too large',
        message: 'The file is too large to process.'
      });
    }
    next(err);
  });

  console.log('Setting up health check endpoint...');
  app.get('/health', (req, res) => {
    console.log('Health check requested');
    res.status(200).json({ status: 'OK' });
  });

  const port = process.env.PORT || 8080;
  console.log(`Starting server on port ${port}...`);
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