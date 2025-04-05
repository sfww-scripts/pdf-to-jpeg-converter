const { Storage } = require('@google-cloud/storage');
const { google } = require('googleapis');
const { PDFDocument } = require('pdf-lib');
const { fromBuffer } = require('pdf2pic');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');

const storage = new Storage();
const drive = google.drive({ version: 'v3' });

exports.convertPdfToJpeg = async (req, res) => {
  try {
    const { fileId, folderId, accessToken, fileName } = req.body;

    const auth = new google.auth.OAuth2();
    auth.setCredentials({ access_token: accessToken });

    const driveResponse = await drive.files.get(
      { fileId, alt: 'media' },
      { auth, responseType: 'arraybuffer' }
    );
    const pdfBuffer = Buffer.from(driveResponse.data);

    const pdfDoc = await PDFDocument.load(pdfBuffer);
    const pageCount = pdfDoc.getPageCount();

    const convert = fromBuffer(pdfBuffer, {
      format: 'jpeg',
      width: 600,
      height: 600,
      density: 100,
    });

    const jpegs = [];
    for (let i = 1; i <= pageCount; i++) {
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
      const uploadResponse = await drive.files.create(
        { resource: fileMetadata, media, fields: 'id' },
        { auth }
      );
      jpegs.push({ page: i, fileId: uploadResponse.data.id });

      await fs.unlink(tempFilePath);
    }

    res.status(200).json({ success: true, jpegs });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};