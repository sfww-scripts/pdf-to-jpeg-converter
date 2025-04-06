const express = require('express');

const app = express();
app.use(express.json());

// Health check endpoint for Cloud Run
app.get('/health', (req, res) => {
  console.log('Health check requested');
  res.status(200).json({ status: 'OK' });
});

app.get('/', (req, res) => {
  console.log('Root endpoint requested');
  res.status(200).json({ message: 'Server is running' });
});

const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log(`Server started and listening on port ${port}`);
});