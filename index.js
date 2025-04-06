const { google } = require('googleapis');
const { PDFDocument } = require('pdf-lib');
const PdfToImg = require('pdf-to-img');
const fs = require('fs');
const fsPromises = fs.promises;
const path = require('path');
const os = require('os');
const express = require('express');

console.log('Loading dependencies...');

// Check that all dependencies are loaded correctly
try {
  console.log('Loaded googleapis');
  console.log('Loaded pdf-lib');
  console.log('Loaded pdf-to-img');
  console.log('Loaded express');
} catch (error) {
  console.error('Error loading dependencies:', error.message);
  console.error('Error details:', JSON.stringify(error, null, 2));
  process.exit(1);
}

console.log('Starting application...');

try {
  const app = express();
  
  // Increase the payload size limit for JSON requests
  app.use(express.json({ limit: '50mb' }));
  
  // Add detailed error handling for large payloads
  app.use((err, req, res, next) => {
    if (err.type === 'entity.too.large') {
      console.error('Request entity too large');
      return res.status(413).json({
        success: false,
        error: 'Request entity too large',
        message: 'The PDF file is too large to process. Please use a smaller file or split it into multiple files.'
      });
    }
    next(err);
  });

  // Health check endpoint for Cloud Run
  app.get('/health', (req, res) => {
    console.log('Health check requested');
    res.status(200).json({ status: 'OK' });
  });

  // Create a Google Drive client
  const drive = google.drive({ version: 'v3' });

  app.post('/', async (req, res) => {
    try {
      const { folderId, accessToken, fileName, fileData } = req.body;

      // Validate required parameters
      if (!folderId) {
        console.error('Missing folderId parameter');
        return res.status(400).json({ success: false, error: 'Missing folderId parameter' });
      }
      
      if (!accessToken) {
        console.error('Missing accessToken parameter');
        return res.status(400).json({ success: false, error: 'Missing accessToken parameter' });
      }
      
      if (!fileName) {
        console.error('Missing fileName parameter');
        return res.status(400).json({ success: false, error: 'Missing fileName parameter' });
      }
      
      if (!fileData) {
        console.error('Missing fileData parameter');
        return res.status(400).json({ success: false, error: 'Missing fileData parameter' });
      }

      // Decode the base64 file data
      console.log('Decoding base64 file data');
      let pdfBuffer;
      try {
        pdfBuffer = Buffer.from(fileData, 'base64');
      } catch (error) {
        console.error('Failed to decode base64 data:', error.message);
        return res.status(400).json({ 
          success: false, 
          error: 'Invalid base64 file data', 
          details: error.message 
        });
      }

      if (!pdfBuffer || pdfBuffer.length === 0) {
        console.error('PDF buffer is empty or invalid');
        return res.status(400).json({ 
          success: false, 
          error: 'PDF buffer is empty or invalid' 
        });
      }

      // Save the PDF to a temporary file
      const tempPdfPath = path.join(os.tmpdir(), `${fileName}_temp.pdf`);
      await fsPromises.writeFile(tempPdfPath, pdfBuffer);

      // Load the PDF document to get page count
      console.log('Loading PDF document');
      let pdfDoc;
      try {
        pdfDoc = await PDFDocument.load(pdfBuffer);
      } catch (error) {
        console.error('Failed to load PDF document:', error.message);
        return res.status(400).json({ 
          success: false, 
          error: 'Failed to load PDF document', 
          details: error.message 
        });
      }
      
      const pageCount = pdfDoc.getPageCount();
      console.log('PDF page count:', pageCount);

      // Set up Google Drive authentication
      const auth = new google.auth.OAuth2();
      auth.setCredentials({ access_token: accessToken });

      // Convert each page to JPEG using pdf-to-img
      const jpegs = [];
      for (let i = 1; i <= pageCount; i++) {
        console.log(`Converting page ${i} to JPEG`);
        
        try {
          // Convert the page to JPEG
          const outputPath = path.join(os.tmpdir(), `${fileName}_page_${i}`);
          await PdfToImg.convert(tempPdfPath, {
            outputDir: os.tmpdir(),
            outputFormat: 'jpeg',
            baseName: `${fileName}_page_${i}`,
            page: i,
            width: 1200,
            height: 1600,
            density: 150
          });

          const tempJpegPath = `${outputPath}.jpg`;
          if (!fs.existsSync(tempJpegPath)) {
            throw new Error(`JPEG file not created at ${tempJpegPath}`);
          }

          // Upload the JPEG to Google Drive
          console.log(`Uploading JPEG for page ${i} to Drive`);
          const fileMetadata = {
            name: `${fileName}_page_${i}.jpg`,
            parents: [folderId]
          };

          const media = {
            mimeType: 'image/jpeg',
            body: fs.createReadStream(tempJpegPath)
          };

          const uploadResponse = await drive.files.create({
            resource: fileMetadata,
            media: media,
            fields: 'id',
            auth: auth
          });

          jpegs.push({ 
            page: i, 
            fileId: uploadResponse.data.id 
          });

          // Clean up temporary file
          await fsPromises.unlink(tempJpegPath);
        } catch (pageError) {
          console.error(`Error processing page ${i}:`, pageError.message);
          // Continue with other pages instead of failing completely
        }
      }

      // Clean up the temporary PDF file
      try {
        await fsPromises.unlink(tempPdfPath);
      } catch (unlinkError) {
        console.error('Error cleaning up temporary PDF file:', unlinkError.message);
      }

      // Return the results
      if (jpegs.length === 0) {
        console.error('No pages were successfully converted');
        return res.status(500).json({ 
          success: false, 
          error: 'No pages were successfully converted to JPEG' 
        });
      }

      console.log(`Successfully converted ${jpegs.length} pages to JPEGs`);
      return res.status(200).json({ 
        success: true, 
        jpegs: jpegs 
      });
    } catch (error) {
      console.error('Error in Cloud Run function:', error.message);
      console.error('Error details:', JSON.stringify(error, null, 2));
      return res.status(500).json({ 
        success: false, 
        error: error.message 
      });
    }
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

// Global error handlers
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