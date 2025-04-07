const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { fromPath } = require('pdf2pic');
const { google } = require('googleapis');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);
const gm = require('gm');
const pdfjsLib = require('pdfjs-dist');
const { createCanvas } = require('canvas');

// Configure gm to use GraphicsMagick
const gmWithPath = gm.subClass({ imageMagick: false });

const app = express();
app.use(bodyParser.json({ limit: '100mb' }));

// Health Check Endpoints
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

    // Convert PDF to JPEG using multiple methods with fallbacks
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
    let conversionMethod = '';

    // Try different conversion methods with fallbacks
    try {
      // Method 1: pdf2pic with GraphicsMagick
      console.log('Starting PDF to JPEG conversion with pdf2pic (GraphicsMagick)');
      conversionMethod = 'pdf2pic';
      
      const convert = fromPath(tempPdfPath, {
        format: 'jpg',
        outputDir: outputDir,
        outputFormat: 'page-%d',
        density: 200,
        scale: 2
      });
      
      const result = await convert.bulk(-1); // Convert all pages
      images = result.map((page, index) => path.join(outputDir, `page-${index + 1}.jpg`));
      console.log(`Successfully converted PDF to ${images.length} JPEGs with pdf2pic`);
    } catch (error1) {
      console.error('pdf2pic conversion failed:', error1.message);
      console.error('pdf2pic error stack:', error1.stack);
      
      try {
        // Method 2: Poppler's pdftoppm (first fallback)
        console.log('Falling back to Poppler pdftoppm');
        conversionMethod = 'poppler';
        
        // Use pdftoppm to convert PDF to JPEGs
        const cmd = `pdftoppm -jpeg -r 200 "${tempPdfPath}" "${path.join(outputDir, 'page')}"`;
        await execPromise(cmd);
        
        // Get all generated JPEG files
        images = fs.readdirSync(outputDir)
          .filter(file => file.endsWith('.jpg'))
          .map(file => path.join(outputDir, file))
          .sort((a, b) => {
            const pageA = parseInt(path.basename(a).match(/\d+/)[0] || '0');
            const pageB = parseInt(path.basename(b).match(/\d+/)[0] || '0');
            return pageA - pageB;
          });
        
        console.log(`Successfully converted PDF to ${images.length} JPEGs with Poppler`);
      } catch (error2) {
        console.error('Poppler conversion failed:', error2.message);
        console.error('Poppler error stack:', error2.stack);

        try {
          // Method 3: pdf.js (second fallback)
          console.log('Falling back to pdf.js');
          conversionMethod = 'pdfjs';

          // Load the PDF document
          const data = new Uint8Array(fs.readFileSync(tempPdfPath));
          const loadingTask = pdfjsLib.getDocument({ data });
          const pdfDocument = await loadingTask.promise;

          // Process each page
          for (let i = 1; i <= pdfDocument.numPages; i++) {
            const page = await pdfDocument.getPage(i);
            const viewport = page.getViewport({ scale: 2.0 });

            // Set up canvas for rendering
            const canvas = createCanvas(viewport.width, viewport.height);
            const context = canvas.getContext('2d');
            const renderContext = {
              canvasContext: context,
              viewport: viewport
            };

            // Render the page to canvas
            await page.render(renderContext).promise;

            // Convert canvas to JPEG and save
            const outputPath = path.join(outputDir, `page-${i}.jpg`);
            const buffer = canvas.toBuffer('image/jpeg', { quality: 0.95 });
            fs.writeFileSync(outputPath, buffer);
            images.push(outputPath);
          }

          console.log(`Successfully converted PDF to ${images.length} JPEGs with pdf.js`);
        } catch (error3) {
          console.error('pdf.js conversion failed:', error3.message);
          console.error('pdf.js error stack:', error3.stack);
          throw new Error(`All PDF conversion methods failed. Last error: ${error3.message}`);
        }
      }
    }

    if (images.length === 0) {
      throw new Error('No JPEGs were generated from the PDF');
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
        console.error('Stream error stack:', streamError.stack);
        throw new Error(`Failed to create stream for page ${i + 1}: ${streamError.message}`);
      }

      try {
        console.log(`Uploading page ${i + 1} to Drive`);
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
      } catch (uploadError) {
        console.error(`Error uploading page ${i + 1} to Drive:`, uploadError.message);
        console.error('Upload error stack:', uploadError.stack);
        throw new Error(`Failed to upload page ${i + 1} to Drive: ${uploadError.message}`);
      }

      try {
        console.log(`Cleaning up JPEG file: ${imagePath}`);
        fs.unlinkSync(imagePath);
      } catch (unlinkError) {
        console.error(`Error cleaning up JPEG file ${imagePath}:`, unlinkError.message);
      }
    }

    try {
      console.log(`Cleaning up PDF file: ${tempPdfPath}`);
      fs.unlinkSync(tempPdfPath);
    } catch (unlinkError) {
      console.error(`Error cleaning up PDF file ${tempPdfPath}:`, unlinkError.message);
    }

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