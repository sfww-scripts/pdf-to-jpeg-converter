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
const axios = require('axios');

// Configure gm to use GraphicsMagick
const gmWithPath = gm.subClass({ imageMagick: false });

// CloudConvert API Key (replace with your actual key)
const CLOUDCONVERT_API_KEY = 'your-cloudconvert-api-key-here'; // Replace with your CloudConvert API key

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
  console.log('File to JPEG conversion requested');
  
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

    // Determine file type based on extension
    const fileExtension = path.extname(fileName).toLowerCase();
    const isPDF = fileExtension === '.pdf';
    const isExcel = ['.xlsx', '.xls'].includes(fileExtension);
    const isWord = ['.docx', '.doc'].includes(fileExtension);

    if (!isPDF && !isExcel && !isWord) {
      throw new Error(`Unsupported file type: ${fileExtension}. Only PDF, Excel, and Word files are supported.`);
    }

    // Save the file temporarily
    const tempDir = os.tmpdir();
    const tempFilePath = path.join(tempDir, `${fileName}`);
    let tempPdfPath = tempFilePath;

    try {
      console.log(`Writing file to ${tempFilePath}`);
      fs.writeFileSync(tempFilePath, Buffer.from(fileData, 'base64'));
      console.log(`Saved file to ${tempFilePath}`);
    } catch (writeError) {
      console.error('Error writing file:', writeError.message);
      console.error('Write error stack:', writeError.stack);
      throw new Error(`Failed to write file: ${writeError.message}`);
    }

    // If the file is Excel or Word, convert it to PDF first using CloudConvert
    if (isExcel || isWord) {
      console.log(`Converting ${fileExtension} file to PDF using CloudConvert`);
      try {
        const inputFormat = isExcel ? 'xlsx' : 'docx';
        const outputFormat = 'pdf';
        const tempPdfFilePath = path.join(tempDir, `${path.basename(fileName, fileExtension)}.pdf`);

        // Create CloudConvert job to convert Excel/Word to PDF
        const jobResponse = await axios.post('https://api.cloudconvert.com/v2/jobs', {
          tasks: {
            'import-file': {
              operation: 'import/base64',
              file: fileData,
              filename: fileName
            },
            'convert-file': {
              operation: 'convert',
              input: 'import-file',
              output_format: outputFormat,
              some_option: 'value'
            },
            'export-file': {
              operation: 'export/url',
              input: 'convert-file'
            }
          }
        }, {
          headers: {
            Authorization: `Bearer ${CLOUDCONVERT_API_KEY}`,
            'Content-Type': 'application/json'
          }
        });

        const jobId = jobResponse.data.data.id;

        // Wait for the job to complete
        let jobStatus;
        do {
          await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second
          const statusResponse = await axios.get(`https://api.cloudconvert.com/v2/jobs/${jobId}`, {
            headers: { Authorization: `Bearer ${CLOUDCONVERT_API_KEY}` }
          });
          jobStatus = statusResponse.data.data.status;
        } while (jobStatus !== 'finished' && jobStatus !== 'error');

        if (jobStatus === 'error') {
          throw new Error('CloudConvert job failed to convert file to PDF');
        }

        // Get the converted PDF URL
        const exportTask = jobResponse.data.data.tasks.find(task => task.operation === 'export/url');
        const pdfUrl = exportTask.result.files[0].url;

        // Download the PDF
        const pdfResponse = await axios.get(pdfUrl, { responseType: 'arraybuffer' });
        fs.writeFileSync(tempPdfFilePath, Buffer.from(pdfResponse.data));
        console.log(`Converted ${fileExtension} to PDF at ${tempPdfFilePath}`);

        tempPdfPath = tempPdfFilePath;
      } catch (cloudConvertError) {
        console.error('CloudConvert conversion to PDF failed:', cloudConvertError.message);
        throw new Error(`Failed to convert ${fileExtension} to PDF: ${cloudConvertError.message}`);
      }
    }

    // Convert PDF to JPEG using multiple methods with fallbacks
    const outputDir = path.join(tempDir, `${path.basename(fileName, path.extname(fileName))}-images`);
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

          try {
            // Method 4: CloudConvert API (third fallback)
            console.log('Falling back to CloudConvert API');
            conversionMethod = 'cloudconvert';

            const jobResponse = await axios.post('https://api.cloudconvert.com/v2/jobs', {
              tasks: {
                'import-file': {
                  operation: 'import/base64',
                  file: fileData,
                  filename: fileName
                },
                'convert-file': {
                  operation: 'convert',
                  input: 'import-file',
                  output_format: 'jpg',
                  some_option: 'value'
                },
                'export-file': {
                  operation: 'export/url',
                  input: 'convert-file'
                }
              }
            }, {
              headers: {
                Authorization: `Bearer ${CLOUDCONVERT_API_KEY}`,
                'Content-Type': 'application/json'
              }
            });

            const jobId = jobResponse.data.data.id;

            // Wait for the job to complete
            let jobStatus;
            do {
              await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second
              const statusResponse = await axios.get(`https://api.cloudconvert.com/v2/jobs/${jobId}`, {
                headers: { Authorization: `Bearer ${CLOUDCONVERT_API_KEY}` }
              });
              jobStatus = statusResponse.data.data.status;
            } while (jobStatus !== 'finished' && jobStatus !== 'error');

            if (jobStatus === 'error') {
              throw new Error('CloudConvert job failed to convert file to JPEG');
            }

            // Get the converted JPEG URLs
            const exportTask = jobResponse.data.data.tasks.find(task => task.operation === 'export/url');
            const jpegUrls = exportTask.result.files.map(file => file.url);

            // Download each JPEG
            for (let i = 0; i < jpegUrls.length; i++) {
              const jpegResponse = await axios.get(jpegUrls[i], { responseType: 'arraybuffer' });
              const outputPath = path.join(outputDir, `page-${i + 1}.jpg`);
              fs.writeFileSync(outputPath, Buffer.from(jpegResponse.data));
              images.push(outputPath);
            }

            console.log(`Successfully converted file to ${images.length} JPEGs with CloudConvert`);
          } catch (error4) {
            console.error('CloudConvert conversion failed:', error4.message);
            console.error('CloudConvert error stack:', error4.stack);

            try {
              // Method 5: PDFBox (fourth fallback, for PDFs only; Excel/Word already converted to PDF)
              console.log('Falling back to PDFBox');
              conversionMethod = 'pdfbox';

              // Use PDFBox to convert PDF to JPEGs
              const cmd = `java -jar /usr/local/lib/pdfbox-app-2.0.27.jar PDFToImage -imageType jpg -dpi 200 "${tempPdfPath}"`;
              await execPromise(cmd);

              // PDFBox outputs files with the pattern <filename>-<page>.jpg
              const pdfBaseName = path.basename(tempPdfPath, '.pdf');
              images = fs.readdirSync(tempDir)
                .filter(file => file.startsWith(pdfBaseName) && file.endsWith('.jpg'))
                .map(file => path.join(tempDir, file))
                .sort((a, b) => {
                  const pageA = parseInt(path.basename(a).match(/\d+/)[0] || '0');
                  const pageB = parseInt(path.basename(b).match(/\d+/)[0] || '0');
                  return pageA - pageB;
                });

              // Move files to outputDir
              images = images.map((imgPath, index) => {
                const newPath = path.join(outputDir, `page-${index + 1}.jpg`);
                fs.renameSync(imgPath, newPath);
                return newPath;
              });

              console.log(`Successfully converted PDF to ${images.length} JPEGs with PDFBox`);
            } catch (error5) {
              console.error('PDFBox conversion failed:', error5.message);
              console.error('PDFBox error stack:', error5.stack);
              throw new Error(`All conversion methods failed. Last error: ${error5.message}`);
            }
          }
        }
      }
    }

    if (images.length === 0) {
      throw new Error('No JPEGs were generated from the file');
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
            name: `${path.basename(fileName, path.extname(fileName))}_page${i + 1}.jpg`,
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
      console.log(`Cleaning up original file: ${tempFilePath}`);
      fs.unlinkSync(tempFilePath);
      if (tempPdfPath !== tempFilePath) {
        console.log(`Cleaning up converted PDF file: ${tempPdfPath}`);
        fs.unlinkSync(tempPdfPath);
      }
    } catch (unlinkError) {
      console.error(`Error cleaning up files: ${unlinkError.message}`);
    }

    res.status(200).json({ success: true, jpegs: jpegResults });
  } catch (error) {
    console.error('❌ Error in file-to-JPEG conversion:', error.message);
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