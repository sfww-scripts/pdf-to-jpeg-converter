const { google } = require('googleapis');
const { PDFDocument } = require('pdf-lib');
const { fromBuffer } = require('pdf2pic');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const express = require('express');

const app = express();
app.use(express.json());

// Health check endpoint for Cloud Run
app.get('/health', (req, res) => {
  console.log('Health check requested');
  res.status(200).json({ status: 'OK' });
});

const drive = google.drive({ version: 'v3' });

app.post('/', async (req, res) => {
  try {
    const { folderId, accessToken, fileName, fileData } = req.body;

    if (!folderId || !accessToken || !fileName || !fileData) {
      console.error('Missing required parameters:', { folderId, accessToken, fileName, fileData: fileData ? 'provided' : 'missing' });
      return res.status(400).json({ success: false, error: 'Missing required parameters' });
    }

    // Decode the base64 file data
    console.log('Decoding base64 file data');
    let pdfBuffer;
    try {
      pdfBuffer = Buffer.from(fileData, 'base64');
    } catch (error) {
      console.error('Failed to decode base64 data:', error.message);
      return res.status(400).json({ success: false, error: 'Invalid base64 file data', details: error.message });
    }

    if (!pdfBuffer || pdfBuffer.length === 0) {
      console.error('PDF buffer is empty or invalid');
      return res.status(400).json({ success: false, error: 'PDF buffer is empty or invalid' });
    }

    // Load the PDF document to get page count
    console.log('Loading PDF document');
    const pdfDoc = await PDFDocument.load(pdfBuffer);
    const pageCount = pdfDoc.getPageCount();
    console.log('PDF page count:', pageCount);

    // Convert PDF pages to JPEG
    console.log('Converting PDF to JPEG');
    const convert = fromBuffer(pdfBuffer, {
      format: 'jpeg',
      width: 600,
      height: 600,
      density: 100,
    });

    const jpegs = [];
    const auth = new google.auth.OAuth2();
    auth.setCredentials({ access_token: accessToken });

    for (let i = 1; i <= pageCount; i++) {
      console.log(`Converting page ${i} to JPEG`);
      const page = await convert.bulk(i);
      const tempFilePath = path.join(os.tmpdir(), `page_${i}.jpeg`);
      await fs.writeFile(tempFilePath, page.buffer);

      const fileMetadata = {
        name: `${fileName}_image_${i}.jpg`,
        parents: [folderId],
      };
      const media = {
        mimeType: 'image/jpeg',
        body: require('fs').createReadStream(tempFilePath),
      };
      console.log(`Uploading JPEG for page ${i} to Drive`);
      const uploadResponse = await drive.files.create(
        { resource: fileMetadata, media, fields: 'id' },
        { auth }
      );
      jpegs.push({ page: i, fileId: uploadResponse.data.id });

      await fs.unlink(tempFilePath);
    }

    res.status(200).json({ success: true, jpegs });
  } catch (error) {
    console.error('Error in Cloud Run function:', error.message);
    console.error('Error details:', JSON.stringify(error, null, 2));
    res.status(500).json({ success: false, error: error.message });
  }
});

const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log(`Server started and listening on port ${port}`);
});