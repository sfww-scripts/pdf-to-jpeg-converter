const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { fromPath } = require('pdf2pic');
const { google } = require('googleapis');

const app = express();
app.use(bodyParser.json({ limit: '100mb' }));

// Health Check Endpoint
app.get('/', (req, res) => {
  console.log('Root endpoint accessed');
  res.status(200).send('Service Online');
});

app.get('/health', (req, res) => {
  console.log('Health check requested');
  res.status(200).json({ status: 'OK' });
});

app.post('/', async (req, res) => {
  console.log('PDF to JPEG conversion requested');
  
  try {
    // Log the incoming request size
    console.log(`Request body size: ${JSON.stringify(req.body).length} bytes`);
    
    // Validate request body
    const { folderId, accessToken, fileName, fileData } = req.body;
    if (!folderId || !accessToken || !fileName || !fileData) {
      console.error('Missing required parameters');
      return res.status(400).json({ success: false, error: 'Missing required fields' });
    }

    console.log(`Received file: ${fileName}, fileData length: ${fileData.length}`);

    // Save PDF temporarily
    const tempDir = os.tmpdir();
    const tempPdfPath = path.join(tempDir, `${fileName}.pdf`);
    try {
      console.log(`Writing PDF to ${tempPdfPath}`);
      fs.writeFileSync(tempPdfPath, Buffer.from(fileData, 'base64'));
      console.log(`Saved PDF to ${tempPdfPath}`);
    } catch (writeError) {
      console.error('Error writing PDF file:', writeError.message);
      console.error('Write error stack:', writeError.stack);
      throw new Error(`Failed to write PDF file: ${writeError.message}`);
    }

    // Convert PDF to JPEG using pdf2pic
    const outputDir = path.join(tempDir, `${fileName}-images`);
    try {
      console.log(`Creating output directory: ${outputDir}`);
      if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir);
    } catch (mkdirError) {
      console.error('Error creating output directory:', mkdirError.message);
      console.error('Mkdir error stack:', mkdirError.stack);
      throw new Error(`Failed to create output directory: ${mkdirError.message}`);
    }

    let images = [];
    try {
      console.log('Starting PDF to JPEG conversion');
      const convert = fromPath(tempPdfPath, {
        format: 'jpg',
        outputDir: outputDir,
        outputFormat: 'page-%d',
        density: 200,
        scale: 2
      });
      const result = await convert.bulk(-1); // Convert all pages
      images = result.map((page, index) => path.join(outputDir, `page-${index + 1}.jpg`));
      console.log(`Converted PDF to ${images.length} JPEGs`);
    } catch (convertError) {
      console.error('Error converting PDF to JPEG:', convertError.message);
      console.error('Convert error stack:', convertError.stack);
      throw new Error(`PDF conversion failed: ${convertError.message}`);
    }

    // Authenticate with Google Drive
    console.log('Authenticating with Google Drive');
    const auth = new google.auth.OAuth2();
    auth.setCredentials({ access_token: accessToken });
    const drive = google.drive({ version: 'v3', auth });

    // Upload JPEGs to Drive
    const jpegResults = [];
    for (let i = 0; i < images.length; i++) {
      const imagePath = images[i];
      let imageStream;
      try {
        console.log(`Creating stream for page ${i + 1}: ${imagePath}`);
        imageStream = fs.createReadStream(imagePath);
      } catch (streamError) {
        console.error(`Error creating stream for page ${i + 1}:`, streamError.message);
        console.error('Stream