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

  // Add early route for verification
  app.get('/', (req, res) => {
    console.log('Root endpoint accessed');
    res.status(200).send('Service Online');
  });

  // Add container startup verification
  let isReady = false;
  setTimeout(() => {
    isReady = true;
    console.log('Container initialization complete');
  }, 5000);

  console.log('Setting up health check endpoint...');
  app.get('/health', (req, res) => {
    console.log('Health check requested');
    res.status(isReady ? 200 : 503).json({ 
      status: isReady ? 'OK' : 'INITIALIZING',
      dependencies: {
        express: !!express
      }
    });
  });
  
  // Add POST endpoint to handle PDF-to-JPEG conversion requests
  app.post('/', async (req, res) => {
    console.log('PDF to JPEG conversion requested');
    
    try {
      const { folderId, accessToken, fileName } = req.body;
      
      if (!folderId || !accessToken || !fileName) {
        return res.status(400).json({
          success: false,
          error: 'Missing required parameters'
        });
      }
      
      // Instead of actual conversion, return a mock successful response
      console.log(`Mock conversion of ${fileName} completed successfully`);
      
      return res.status(200).json({
        success: true,
        jpegs: []  // Empty array since we're not actually creating JPEGs
      });
    } catch (error) {
      console.error('Error in PDF to JPEG conversion:', error.message);
      return res.status(500).json({
        success: false,
        error: error.message
      });
    }
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

process.on('SIGTERM', () => {
  console.log('Received SIGTERM');
  process.exit(0);
});