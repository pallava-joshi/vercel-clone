import 'dotenv/config';
import express, { type Request, type Response } from 'express';
import { generateSlug } from 'random-word-slugs';
import { ECSClient, RunTaskCommand } from '@aws-sdk/client-ecs';
import { Server } from 'socket.io';
import Redis from 'ioredis';

interface CreateProjectRequestBody {
  gitURL?: string;
  slug?: string;
}

const app = express();
const PORT = Number(process.env.PORT ?? 9000);

const subscriber = new Redis(process.env.REDIS_URL ?? '');

const io = new Server({
  cors: {
    origin: '*',
  },
});

io.on('connection', (socket) => {
  socket.on('subscribe', (channel: string) => {
    socket.join(channel);
    socket.emit('message', `Joined ${channel}`);
  });
});

io.listen(9002);
console.log('Socket Server 9002');

const ecsClient = new ECSClient({
  region: process.env.AWS_REGION ?? '',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? '',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? '',
  },
});

const config = {
  CLUSTER: process.env.ECS_CLUSTER_ARN ?? '',
  TASK: process.env.ECS_TASK_ARN ?? '',
};

app.use(express.json());

app.post(
  '/project',
  async (req: Request<{}, {}, CreateProjectRequestBody>, res: Response) => {
    const { gitURL, slug } = req.body;

    if (!gitURL) {
      return res.status(400).json({ status: 'error', message: 'gitURL is required' });
    }

    const projectSlug = slug ?? generateSlug();

    const command = new RunTaskCommand({
      cluster: config.CLUSTER,
      taskDefinition: config.TASK,
      launchType: 'FARGATE',
      count: 1,
      networkConfiguration: {
        awsvpcConfiguration: {
          assignPublicIp: 'ENABLED',
          subnets: process.env.ECS_SUBNETS?.split(',') ?? [],
          securityGroups: process.env.ECS_SECURITY_GROUPS?.split(',') ?? [],
        },
      },
      overrides: {
        containerOverrides: [
          {
            name: 'builder-image',
            environment: [
              { name: 'GIT_REPOSITORY__URL', value: gitURL },
              { name: 'PROJECT_ID', value: projectSlug },
            ],
          },
        ],
      },
    });

    await ecsClient.send(command);

    return res.json({
      status: 'queued',
      data: { projectSlug, url: `http://${projectSlug}.localhost:8000` },
    });
  }
);

async function initRedisSubscribe(): Promise<void> {
  console.log('Subscribed to logs....');
  await subscriber.psubscribe('logs:*');
  subscriber.on('pmessage', (_pattern: string, channel: string, message: string) => {
    io.to(channel).emit('message', message);
  });
}

void initRedisSubscribe();

app.listen(PORT, () => console.log(`API Server Running..${PORT}`));
