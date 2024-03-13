import axios from 'axios';
import csv from 'csv-parser';
import fs from 'fs';
import path from 'path';
import * as AWS from 'aws-sdk';
import { pipeline } from 'stream';
import { promisify } from 'util';

const streamPipeline = promisify(pipeline);
// Update AWS config
AWS.config.update({
    accessKeyId: 'AKIAQ7DJ4T4VGXDHQMLU',
    secretAccessKey: '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',
    region: 'us-east-1'
});

// Initialize S3 instance
const s3 = new AWS.S3();

/**
 * Uploads a file to AWS S3 and returns the URL of the uploaded file.
 * @param {string} filePath The path to the file to upload.
 * @param {string} mimeType The MIME type of the file.
 * @returns {Promise<string>} The URL of the uploaded file on S3.
 */
async function uploadFile(filePath: string, mimeType: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const fileStream = fs.createReadStream(filePath);
        const bucketName = 'symita-webmd-media'; // Change to your bucket name
        const objectKey = `${Date.now()}_${path.basename(filePath)}`;

        const params = {
            Bucket: bucketName,
            Key: objectKey,
            Body: fileStream,
            ContentType: mimeType
        };

        s3.upload(params, (err: any, data: any) => {
            if (err) {
                console.error('Error uploading file:', err);
                reject(err);
            } else {
                console.log('File uploaded successfully:', data.Location);
                resolve(data.Location);
            }
        });
    });
}

/**
 * Wrapper function for uploading images, setting the MIME type accordingly.
 * @param {string} imagePath Path to the image file.
 * @returns {Promise<string>} The URL of the uploaded image on S3.
 */
export async function uploadImage(imagePath: any): Promise<string> {
    const mimeType = 'image/jpeg'; // Adjust based on your image's format
    console.log('Uploading started... ' + imagePath);
    return uploadFile(imagePath, mimeType);
}

/**
 * Wrapper function for uploading videos, setting the MIME type to 'video/mp4'.
 * @param {string} videoPath Path to the video file.
 * @returns {Promise<string>} The URL of the uploaded video on S3.
 */
export async function uploadVideo(videoPath: any): Promise<string> {
    return uploadFile(videoPath, 'video/mp4');
}

async function downloadMediaWithAxios(url: string, outputPath: string) {
    try {
        const response = await axios({
            url,
            method: 'GET',
            responseType: 'stream',
            timeout: 0
        });
        console.log(`Download Started... ${url}`);
        await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
        await streamPipeline(response.data, fs.createWriteStream(outputPath));
        console.log(`Download completed and saved to ${outputPath}`);
    } catch (error) {
        console.error(`Failed to download: ${url}`, error);
        throw error;
    }
}

async function processMedia(row: any): Promise<void> {
    if (row.mediaType === 'Video' && row.formats) {
        let formats = [];
        try {
            formats = JSON.parse(row.formats.replace(/'/g, '"'));
            for (let format of formats) {
                if (format.mimeType === 'video/mp4') {
                    const tempVideoPath = path.join(__dirname, 'tempVideos', `${Date.now()}_video.mp4`);
                    await downloadMediaWithAxios(format.url, tempVideoPath);
                    format.url = await uploadVideo(tempVideoPath);
                }
            }
            row.formats = JSON.stringify(formats); // Update the formats field with new URLs
        } catch (error) {
            console.error('Error processing video URLs:', error);
        }
    }

    // Process Images within the body
    if (row.body) {
        const imgRegex = /https?:\/\/\S+\.img/g;
        const matches = row.body.match(imgRegex) || [];
        for (let url of matches) {
            try {
                const tempImagePath = path.join(__dirname, 'tempImages', `${Date.now()}_image.jpg`);
                await downloadMediaWithAxios(url, tempImagePath);
                const newImageUrl = await uploadImage(tempImagePath); // Make sure this function returns the new S3 URL
                row.body = row.body.replace(url, newImageUrl); // Replace the old URL in the body
            } catch (error) {
                console.error(`Error processing image URL ${url}:`, error);
            }
        }
    }
}

async function writeToJsonFile(filePath: string, data: any[]): Promise<void> {
    fs.writeFile(filePath, JSON.stringify(data, null, 2), (err) => {
        if (err) {
            console.error('Failed to save JSON:', err);
        } else {
            console.log('CSV file has been processed and saved.');
        }
    });
}

async function uploadCsvToServer(): Promise<void> {
    const csvFilePath = path.join(__dirname, './content_library_krames_dump.csv');
    const jsonFilePath = path.join(__dirname, './output.json');
    let jsonData: any[] = [];

    const rows: any = []; // Temporarily store rows to process them later
    fs.createReadStream(csvFilePath)
        .pipe(csv())
        .on('data', (row) => {
            rows.push(row); // Accumulate rows for sequential processing
        })
        .on('end', async () => {
            for (let row of rows) {
                await processMedia(row); // Process each row sequentially
                jsonData.push(row); // Add the processed row to jsonData
            }
            // Write the modified jsonData to a new JSON file
            await writeToJsonFile(jsonFilePath, jsonData);
            console.log('CSV processing completed.');
        });
}

uploadCsvToServer();
