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
const { DocumentProcessorServiceClient } = require('@google-cloud/documentai').v1;
const { ImageAnnotatorClient } = require('@google-cloud/vision');

// API Keys
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || '';
const ADOBE_CLIENT_ID = process.env.ADOBE_CLIENT_ID || '';
const ADOBE_CLIENT_SECRET = process.env.ADOBE_CLIENT_SECRET || '';

const gmWithPath = gm.subClass({ imageMagick: false });
const CLOUDCONVERT_API_KEY = process.env.CLOUDCONVERT_API_KEY;
if (!CLOUDCONVERT_API_KEY) {
  console.error('CLOUDCONVERT_API_KEY not set');
  throw new Error('CLOUDCONVERT_API_KEY environment variable is not set');
}

const documentaiClient = new DocumentProcessorServiceClient({
  projectId: 'review-plugin-api-421208',
  location: 'us',
});
const visionClient = new ImageAnnotatorClient();

const app = express();
app.use(bodyParser.json({ limit: '100mb' }));

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
    console.log(`Request body size: ${JSON.stringify(req.body).length} bytes`);
    
    // Validate request body
    const { folderId, accessToken, fileName, fileData } = req.body;
    if (!folderId || !accessToken || !fileName || !fileData) {
      console.error('Missing required parameters');
      return res.status(400).json({ success: false, error: 'Missing required fields' });
    }

    // Validate fileData as base64
    if (!/^[A-Za-z0-9+/=]+$/.test(fileData)) {
      console.error('Invalid base64 data');
      return res.status(400).json({ success: false, error: 'Invalid base64 data' });
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

        let jobStatus;
        do {
          await new Promise(resolve => setTimeout(resolve, 1000));
          const statusResponse = await axios.get(`https://api.cloudconvert.com/v2/jobs/${jobId}`, {
            headers: { Authorization: `Bearer ${CLOUDCONVERT_API_KEY}` }
          });
          jobStatus = statusResponse.data.data.status;
        } while (jobStatus !== 'finished' && jobStatus !== 'error');

        if (jobStatus === 'error') {
          throw new Error('CloudConvert job failed to convert file to PDF');
        }

        const exportTask = jobResponse.data.data.tasks.find(task => task.operation === 'export/url');
        const pdfUrl = exportTask.result.files[0].url;

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

    try {
      console.log('Starting PDF to JPEG conversion with pdf2pic (GraphicsMagick)');
      conversionMethod = 'pdf2pic';
      
      const convert = fromPath(tempPdfPath, {
        format: 'jpg',
        outputDir: outputDir,
        outputFormat: 'page-%d',
        density: 200,
        scale: 2
      });
      
      const result = await convert.bulk(-1);
      images = result.map((page, index) => path.join(outputDir, `page-${index + 1}.jpg`));
      console.log(`Successfully converted PDF to ${images.length} JPEGs with pdf2pic`);
    } catch (error1) {
      console.error('pdf2pic conversion failed:', error1.message);
      console.error('pdf2pic error stack:', error1.stack);
      
      try {
        console.log('Falling back to Poppler pdftoppm');
        conversionMethod = 'poppler';
        
        const cmd = `pdftoppm -jpeg -r 200 "${tempPdfPath}" "${path.join(outputDir, 'page')}"`;
        await execPromise(cmd);
        
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
          console.log('Falling back to pdf.js');
          conversionMethod = 'pdfjs';

          const data = new Uint8Array(fs.readFileSync(tempPdfPath));
          const loadingTask = pdfjsLib.getDocument({ data });
          const pdfDocument = await loadingTask.promise;

          for (let i = 1; i <= pdfDocument.numPages; i++) {
            const page = await pdfDocument.getPage(i);
            const viewport = page.getViewport({ scale: 2.0 });

            const canvas = createCanvas(viewport.width, viewport.height);
            const context = canvas.getContext('2d');
            const renderContext = {
              canvasContext: context,
              viewport: viewport
            };

            await page.render(renderContext).promise;

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

            let jobStatus;
            do {
              await new Promise(resolve => setTimeout(resolve, 1000));
              const statusResponse = await axios.get(`https://api.cloudconvert.com/v2/jobs/${jobId}`, {
                headers: { Authorization: `Bearer ${CLOUDCONVERT_API_KEY}` }
              });
              jobStatus = statusResponse.data.data.status;
            } while (jobStatus !== 'finished' && jobStatus !== 'error');

            if (jobStatus === 'error') {
              throw new Error('CloudConvert job failed to convert file to JPEG');
            }

            const exportTask = jobResponse.data.data.tasks.find(task => task.operation === 'export/url');
            const jpegUrls = exportTask.result.files.map(file => file.url);

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
              console.log('Falling back to PDFBox');
              conversionMethod = 'pdfbox';

              const cmd = `java -jar /usr/local/lib/pdfbox-app-2.0.27.jar PDFToImage -imageType jpg -dpi 200 "${tempPdfPath}"`;
              await execPromise(cmd);

              const pdfBaseName = path.basename(tempPdfPath, '.pdf');
              images = fs.readdirSync(tempDir)
                .filter(file => file.startsWith(pdfBaseName) && file.endsWith('.jpg'))
                .map(file => path.join(tempDir, file))
                .sort((a, b) => {
                  const pageA = parseInt(path.basename(a).match(/\d+/)[0] || '0');
                  const pageB = parseInt(path.basename(b).match(/\d+/)[0] || '0');
                  return pageA - pageB;
                });

              images = images.map((imgPath, index) => {
                const newPath = path.join(outputDir, `page-${index + 1}.jpg`);
                fs.renameSync(imgPath, newPath);
                return newPath;
              });

              console.log(`Successfully converted PDF to ${images.length} JPEGs with PDFBox`);
            } catch (error5) {
              console.error('PDFBox conversion failed:', error5.message);
              console.error('PDFBox error stack:', error5.stack);

              try {
                console.log('Falling back to Google Cloud Document AI');
                conversionMethod = 'documentai';

                const projectId = 'review-plugin-api-421208';
                const location = 'us';
                const processorId = 'YOUR_PROCESSOR_ID'; // Replace with your Document AI processor ID

                const name = `projects/${projectId}/locations/${location}/processors/${processorId}`;

                const fileBuffer = fs.readFileSync(tempPdfPath);
                const encodedImage = fileBuffer.toString('base64');

                const request = {
                  name,
                  rawDocument: {
                    content: encodedImage,
                    mimeType: 'application/pdf',
                  },
                };

                const [result] = await documentaiClient.processDocument(request);
                const { document } = result;

                for (let i = 0; i < document.pages.length; i++) {
                  const page = document.pages[i];
                  const imageContent = page.image.content;
                  const outputPath = path.join(outputDir, `page-${i + 1}.jpg`);
                  fs.writeFileSync(outputPath, Buffer.from(imageContent, 'base64'));
                  images.push(outputPath);
                }

                console.log(`Successfully converted PDF to ${images.length} JPEGs with Document AI`);
              } catch (error6) {
                console.error('Document AI conversion failed:', error6.message);
                console.error('Document AI error stack:', error6.stack);

                try {
                  console.log('Falling back to Google Cloud Vision API');
                  conversionMethod = 'visionapi';

                  const fileBuffer = fs.readFileSync(tempPdfPath);
                  const encodedImage = fileBuffer.toString('base64');

                  const [result] = await visionClient.annotateImage({
                    image: { content: encodedImage },
                    features: [{ type: 'DOCUMENT_TEXT_DETECTION' }],
                    imageContext: { pdf: true },
                  });

                  if (result.fullTextAnnotation && result.fullTextAnnotation.pages) {
                    for (let i = 0; i < result.fullTextAnnotation.pages.length; i++) {
                      const page = result.fullTextAnnotation.pages[i];
                      const text = page.blocks.map(block => block.paragraphs.map(paragraph => paragraph.words.map(word => word.symbols.map(symbol => symbol.text).join('')).join(' ')).join('\n')).join('\n');
                      console.log(`Extracted text from page ${i + 1}: ${text.substring(0, 100)}...`);
                    }
                  }

                  throw new Error('Vision API does not support direct image extraction; use other methods for JPEG conversion');
                } catch (error7) {
                  console.error('Vision API conversion failed:', error7.message);
                  console.error('Vision API error stack:', error7.stack);
                  throw new Error(`All conversion methods failed. Last error: ${error7.message}`);
                }
              }
            }
          }
        }
      }
    }

    if (images.length === 0) {
      throw new Error('No JPEGs were generated from the file');
    }

    console.log('Authenticating with Google Drive');
    const auth = new google.auth.OAuth2();
    auth.setCredentials({ access_token: accessToken });
    const drive = google.drive({ version: 'v3', auth });

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
