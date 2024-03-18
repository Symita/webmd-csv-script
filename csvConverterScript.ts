import axios from "axios";
import csv from "csv-parser";
import fs from "fs";
import path from "path";
import * as AWS from "aws-sdk";
import { pipeline } from "stream";
import { promisify } from "util";

const streamPipeline = promisify(pipeline);

// Update AWS config
// AWS.config.update({
//   accessKeyId: "AKIAQ7DJ4T4VGXDHQMLU",
//   secretAccessKey: "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",
//   region: "us-east-1",
// });

///prod
AWS.config.update({
  accessKeyId: "AKIA6LMX4PH6H2KQVCU4",
  secretAccessKey: "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",
  region: "us-east-1",
});

const s3 = new AWS.S3();

async function uploadFile(filePath: string, mimeType: string): Promise<string> {
  const fileStream = fs.createReadStream(filePath);
  const bucketName = "patients-education";
  const objectKey = `${Date.now()}_${path.basename(filePath)}`;

  const params = {
    Bucket: bucketName,
    Key: objectKey,
    Body: fileStream,
    ContentType: mimeType,
  };

  try {
    const { Location } = await s3.upload(params).promise();
    console.log("File uploaded successfully:", Location);

    // Delete the local file after successful upload
    fs.unlink(filePath, (err: any) => {
      if (err) {
        console.error("Error deleting local file:", err);
      } else {
        console.log(`Local file deleted successfully: ${filePath}`);
      }
    });

    return Location;
  } catch (error) {
    console.error("Error uploading file:", error);
    return "";
  }
}

export async function uploadImage(imagePath: string): Promise<string> {
  console.log("Uploading started... " + imagePath);
  return uploadFile(imagePath, "image/jpeg");
}

export async function uploadVideo(videoPath: string): Promise<string> {
  return uploadFile(videoPath, "video/mp4");
}

async function downloadMediaWithAxios(url: string, outputPath: string) {
  try {
    const response = await axios({
      url,
      method: "GET",
      responseType: "stream",
    });
    console.log(`Download Started... ${url}`);
    await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
    await streamPipeline(response.data, fs.createWriteStream(outputPath));
    console.log(`Download completed and saved to ${outputPath}`);
  } catch (error) {
    console.error(`Failed to download: ${url}`, error);
  }
}

async function processMedia(row: any): Promise<void> {
  if (row.mediaType === "Video" && row.formats) {
    let formats = [];
    try {
      formats = JSON.parse(row.formats.replace(/'/g, '"'));
      for (let format of formats) {
        if (format.mimeType === "video/mp4") {
          const tempVideoPath = path.join(
            __dirname,
            "tempVideos",
            `${Date.now()}_video.mp4`
          );
          await downloadMediaWithAxios(format.url, tempVideoPath);
          format.url = await uploadVideo(tempVideoPath);
        }
      }
      row.formats = JSON.stringify(formats); // Update the formats field with new URLs
    } catch (error) {
      console.error("Error processing video URLs:", error);
    }
  }

  // Process Images within the body
  if (row.body) {
    const imgRegex = /https?:\/\/\S+\.img/g;
    const matches = row.body.match(imgRegex) || [];
    for (let url of matches) {
      try {
        const tempImagePath = path.join(
          __dirname,
          "tempImages",
          `${Date.now()}_image.jpg`
        );
        await downloadMediaWithAxios(url, tempImagePath);
        const newImageUrl = await uploadImage(tempImagePath); // Make sure this function returns the new S3 URL
        row.body = row.body.replace(url, newImageUrl); // Replace the old URL in the body
      } catch (error) {
        console.error(`Error processing image URL ${url}:`, error);
      }
    }
  }
}

async function uploadCsvToServer(): Promise<void> {
  const csvFilePath = path.join(
    __dirname,
    "./content_library_krames_dump_full.csv"
  );
  const jsonFilePath = path.join(__dirname, "./output.json");

  let jsonData: any[] = [];
  let rowCount = 0; // Initialize row count

  // Safely read and parse the existing JSON file
  try {
    if (fs.existsSync(jsonFilePath)) {
      const content = fs.readFileSync(jsonFilePath, "utf8");
      jsonData = content ? JSON.parse(content) : [];
    }
  } catch (error) {
    console.error(
      "Error reading or parsing existing JSON file, starting with an empty array:",
      error
    );
    jsonData = [];
  }

  const rows: any[] = await new Promise((resolve, reject) => {
    const accumulator: any[] = [];
    fs.createReadStream(csvFilePath)
      .pipe(csv())
      .on("data", (row) => accumulator.push(row))
      .on("end", () => resolve(accumulator))
      .on("error", reject);
  });

  for (const row of rows) {
    rowCount++; // Increment row count for each row processed

    try {
      await processMedia(row);
      jsonData.push(row);
      // Append to the JSON file after each successful processing
      fs.writeFileSync(jsonFilePath, JSON.stringify(jsonData, null, 2));
      console.log(
        `Successfully processed and saved row: ${rowCount}`,
        row?.kramesContentTypeAndContentID
      );
    } catch (error) {
      console.error(
        `Error processing row, continuing with the next. Details: ${error}`
      );
    }
  }

  console.log("CSV file processing completed. All data has been saved.");

  // Exit the script successfully
  console.log("Exiting script after successful completion.");
  process.exit(0);
}

uploadCsvToServer().catch((error) =>
  console.error("Failed to upload CSV to server:", error)
);
