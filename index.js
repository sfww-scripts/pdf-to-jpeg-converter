const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { PDFImage } = require('pdf-to-img');
const { google } = require('googleapis');

const app = express();
app.use(bodyParser.json({ limit: '50mb' }));

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
    const { folderId, accessToken, fileName, fileData } = req.body;
    if (!folderId || !accessToken || !fileName || !fileData) {
      console.error('Missing required parameters');
      return res.status(400).json({ success: false, error: 'Missing required fields' });
    }

    // Save PDF temporarily
    const tempDir = os.tmpdir();
    const tempPdfPath = path.join(tempDir, `${fileName}.pdf`);
    fs.writeFileSync(tempPdfPath, Buffer.from(fileData, 'base64'));
    console.log(`Saved PDF to ${tempPdfPath}`);

    // Convert PDF to JPEG
    const outputDir = path.join(tempDir, `${fileName}-images`);
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir);
    const images = await PDFImage.convert(tempPdfPath, { outputdir: outputDir, format: 'jpg', scale: 2 });
    console.log(`Converted PDF to ${images.length} JPEGs`);

    // Authenticate with Google Drive
    const auth = new google.auth.OAuth2();
    auth.setCredentials({ access_token: accessToken });
    const drive = google.drive({ version: 'v3', auth });

    // Upload JPEGs to Drive
    const jpegResults = [];
    for (let i = 0; i < images.length; i++) {
      const imagePath = images[i];
      const imageStream = fs.createReadStream(imagePath);
      const uploaded = await drive.files.create({
        requestBody: {
          name: `${fileName}_page${i + 1}.jpg`,
          parents: [folderId],
          mimeType: 'image/jpeg'
        },
        media: {
          mimeType: 'image/jpeg',
          body: imageStream
        },
        fields: 'id'
      });
      console.log(`Uploaded page ${i + 1} to Drive, fileId: ${uploaded.data.id}`);
      jpegResults.push({
        page: i + 1,
        fileId: uploaded.data.id
      });
      fs.unlinkSync(imagePath); // Clean up
    }
    fs.unlinkSync(tempPdfPath); // Clean up PDF

    res.status(200).json({ success: true, jpegs: jpegResults });
  } catch (error) {
    console.error('❌ Error in PDF-to-JPEG conversion:', error.message);
    console.error('Stack trace:', error.stack);
    res.status(500).json({ success: false, error: error.message, stack: error.stack });
  }
});

const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log(`🚀 Server started and listening on port ${port}`);
});

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