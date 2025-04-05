const { Storage } = require('@google-cloud/storage');
const { google } = require('googleapis');
const { PDFDocument } = require('pdf-lib');
const { fromBuffer } = require('pdf2pic');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const express = require('express');

const app = express();
app.use(express.json());

const storage = new Storage();
const drive = google.drive({ version: 'v3' });

app.post('/', async (req, res) => {
  try {
    const { fileId, folderId, accessToken, fileName } = req.body;

    if (!fileId || !folderId || !accessToken || !fileName) {
      console.error('Missing required parameters:', { fileId, folderId, accessToken, fileName });
      return res.status(400).json({ success: false, error: 'Missing required parameters' });
    }

    const auth = new google.auth.OAuth2();
    auth.setCredentials({ access_token: accessToken });

    console.log('Fetching file from Drive with fileId:', fileId);
    const driveResponse = await drive.files.get(
      { fileId, alt: 'media' },
      { auth, responseType: 'arraybuffer' }
    );

    console.log('Drive response status:', driveResponse.status);
    console.log('Drive response headers:', driveResponse.headers);
    if (!driveResponse.data) {
      console.error('Drive response data is undefined');
      return res.status(500).json({ success: false, error: 'Failed to fetch file from Drive: data is undefined' });
    }

    const pdfBuffer = Buffer.from(driveResponse.data);
    if (!pdfBuffer || pdfBuffer.length === 0) {
      console.error('PDF buffer is empty or invalid');
      return res.status(500).json({ success: false, error: 'PDF buffer is empty or invalid' });
    }

    const pdfDoc = await PDFDocument.load(pdfBuffer);
    const pageCount = pdfDoc.getPageCount();
    console.log('PDF page count:', pageCount);

    const convert = fromBuffer(pdfBuffer, {
      format: 'jpeg',
      width: 600,
      height: 600,
      density: 100,
    });

    const jpegs = [];
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
    console.error('Error in Cloud Run function:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});