import 'dotenv/config';
import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import mime from 'mime-types';
import Redis from 'ioredis';

const publisher = new Redis(process.env.REDIS_URL ?? '');

const s3Client = new S3Client({
  region: process.env.AWS_REGION ?? '',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? '',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? '',
  },
});

const PROJECT_ID = process.env.PROJECT_ID ?? '';

function publishLog(log: string): void {
  void publisher.publish(`logs:${PROJECT_ID}`, JSON.stringify({ log }));
}

async function runBuild(outDirPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const buildProcess = exec(`cd ${outDirPath} && npm install && npm run build`);

    buildProcess.stdout?.on('data', (data: Buffer | string) => {
      const log = data.toString();
      console.log(log);
      publishLog(log);
    });

    buildProcess.stderr?.on('data', (data: Buffer | string) => {
      const errorLog = data.toString();
      console.error(errorLog);
      publishLog(`error: ${errorLog}`);
    });

    buildProcess.on('close', (code: number | null) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`Build failed with exit code: ${code}`));
    });
  });
}

async function uploadBuildArtifacts(distFolderPath: string): Promise<void> {
  const distFolderContents = fs.readdirSync(distFolderPath, { recursive: true }) as string[];

  publishLog('Starting to upload');
  for (const file of distFolderContents) {
    const filePath = path.join(distFolderPath, file);
    if (fs.lstatSync(filePath).isDirectory()) {
      continue;
    }

    console.log('uploading', filePath);
    publishLog(`uploading ${file}`);

    const contentType = mime.lookup(filePath);
    const command = new PutObjectCommand({
      Bucket: process.env.S3_BUCKET_NAME ?? 'vercel-clone-outputs',
      Key: `__outputs/${PROJECT_ID}/${file}`,
      Body: fs.createReadStream(filePath),
      ContentType: contentType || undefined,
    });

    await s3Client.send(command);
    publishLog(`uploaded ${file}`);
    console.log('uploaded', filePath);
  }
}

async function init(): Promise<void> {
  console.log('Executing script.ts');
  publishLog('Build Started...');
  const outDirPath = path.join(__dirname, 'output');

  try {
    await runBuild(outDirPath);
    console.log('Build Complete');
    publishLog('Build Complete');

    const distFolderPath = path.join(__dirname, 'output', 'dist');
    await uploadBuildArtifacts(distFolderPath);

    publishLog('Done');
    console.log('Done...');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    publishLog(`Build process failed: ${message}`);
    console.error('Build process failed:', message);
    process.exitCode = 1;
  }
}

void init();
